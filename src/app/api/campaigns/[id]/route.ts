import { NextRequest, NextResponse } from "next/server";
import { AuthenticationRequiredError } from "@/server/auth";
import { loadDb } from "@/server/store";
import { reconcileCampaignStatus } from "@/server/campaign-status";
import { findCampaign } from "@/server/platform";
import { deleteCampaign, updateCampaignBrief, type BriefPatch } from "@/server/campaigns";
import {
  CampaignDeletedError,
  CampaignNotFoundError,
  CampaignProtectedError,
  deletionEligibility,
  forceDeleteEligibility,
  WorkspaceOwnerRequiredError
} from "@/server/deletion";

export const dynamic = "force-dynamic";

function authError() {
  return NextResponse.json({ error: "Authentication required" }, { status: 401 });
}

function deletionError(error: unknown): NextResponse | null {
  if (error instanceof WorkspaceOwnerRequiredError) {
    return NextResponse.json({ error: error.message }, { status: 403 });
  }
  if (error instanceof CampaignNotFoundError) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
  if (error instanceof CampaignDeletedError) {
    return NextResponse.json({ error: error.message }, { status: 410 });
  }
  if (error instanceof CampaignProtectedError) {
    return NextResponse.json(
      { error: error.message, reasons: error.reasons, archiveAvailable: error.archiveAvailable },
      { status: 409 }
    );
  }
  return null;
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let campaign;
  try {
    campaign = await findCampaign(id);
  } catch (error) {
    // Signed-out reads are 401 ("sign in again"), not a 500. The 404 below
    // stays reserved for signed-in reads of a genuinely missing campaign.
    if (error instanceof AuthenticationRequiredError) return authError();
    throw error;
  }
  if (!campaign) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  // Self-healing read: a stored status that drifted from the live preflight
  // verdict is corrected here, so badges can never contradict the verdict.
  await reconcileCampaignStatus(campaign).catch(() => undefined);
  const db = await loadDb();
  return NextResponse.json({
    campaign,
    sourceMedia: db.sourceMedia.find((m) => m.id === campaign.sourceMediaId) ?? null,
    passport: db.passports.find((p) => p.id === campaign.passportId) ?? null,
    productFacts: db.productFacts.find((f) => f.id === campaign.productFactsId) ?? null,
    // Single source of truth for the danger zone: computed server-side from
    // the same rules that enforce deletion, so the UI can never offer an
    // action the server would reject (and vice versa). `force` carries the
    // last-resort archived-removal warnings for the hidden confirm flow.
    deletion: { ...deletionEligibility(campaign), force: forceDeleteEligibility(campaign) }
  });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as BriefPatch;
  const allowed: (keyof BriefPatch)[] = [
    "title",
    "creativeBrief",
    "objective",
    "primaryMessage",
    "visualDirection",
    "requestedClaims",
    "platform",
    "country",
    "transformation",
    "sourceMediaId"
  ];
  const patch: BriefPatch = {};
  for (const key of allowed) {
    const value = body[key];
    if (value !== undefined) (patch as Record<string, unknown>)[key] = value;
  }
  if (patch.requestedClaims !== undefined && !Array.isArray(patch.requestedClaims)) {
    return NextResponse.json({ error: "requestedClaims must be an array of strings." }, { status: 400 });
  }
  let result;
  try {
    result = await updateCampaignBrief(id, patch);
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) return authError();
    throw error;
  }
  if (!result.campaign) return NextResponse.json({ error: result.error ?? "Update failed." }, { status: 400 });
  return NextResponse.json({ campaign: result.campaign });
}

/**
 * Hard-delete a workspace-local draft campaign (owner only). Idempotent: a
 * retry for an already-deleted id succeeds with alreadyDeleted instead of an
 * error. Protected campaigns (assets, share link, anchored proof) get a 409
 * pointing at archive; unknown ids get a 404.
 *
 * Archived records are refused UNLESS `?force=true` is passed explicitly —
 * the hidden last-resort path (owner only, type-to-confirm UI). Even force
 * never deletes while jobs run.
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const force = new URL(request.url).searchParams.get("force") === "true";
  try {
    const result = await deleteCampaign(id, { force });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) return authError();
    const mapped = deletionError(error);
    if (mapped) return mapped;
    throw error;
  }
}
