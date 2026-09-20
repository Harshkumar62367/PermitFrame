import { NextRequest, NextResponse } from "next/server";
import { AuthenticationRequiredError, requireCurrentSession } from "@/server/auth";
import { effectiveCampaignStatus } from "@/server/campaign-status";
import { loadCampaignDetailNormalized } from "@/server/campaign-store";
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
  let workspaceId: string;
  try {
    ({ workspaceId } = await requireCurrentSession());
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) return authError();
    throw error;
  }
  // Hot path: indexed single-campaign + 3 single-row lookups, one RTT each
  // (parallel). No blob transfer, no DKG calls. Status drift is corrected
  // in memory only — reads never write, so GETs stay fast and contention-free.
  // The normalized mirror is authoritative (backfilled + mirrored on every
  // write, deletes included): a miss is an immediate 404, never a slow
  // whole-blob fallback scan.
  const normalized = await loadCampaignDetailNormalized(workspaceId, id).catch(() => null);
  if (!normalized) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  const campaign = { ...normalized.campaign, status: effectiveCampaignStatus(normalized.campaign) };
  return NextResponse.json({
    campaign,
    sourceMedia: normalized.sourceMedia,
    passport: normalized.passport,
    productFacts: normalized.productFacts,
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
