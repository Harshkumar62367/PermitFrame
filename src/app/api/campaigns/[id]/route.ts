import { NextRequest, NextResponse } from "next/server";
import { AuthenticationRequiredError, requireCurrentSession } from "@/server/auth";
import { effectiveCampaignStatus } from "@/server/campaign-status";
import { loadWorkspaceDb } from "@/server/store";
import { deleteCampaign, updateCampaignBrief, type BriefPatch } from "@/server/campaigns";
import { logDkgError, sanitizeDkgError, scrubStoredText } from "@/server/dkg/public-errors";
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
  // The workspace record is canonical. Film status changes are saved there
  // before returning to the browser; the normalized campaign copy can lag
  // while its larger mirror finishes. Reading that copy alone made a newly
  // submitted film disappear after refresh.
  const workspace = await loadWorkspaceDb(workspaceId);
  const canonical = workspace.campaigns.find((item) => item.id === id);
  if (!canonical) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  // Persisted job/run diagnostics predate write-time scrubbing in older
  // rows: operational detail is scrubbed at read time so the queue never
  // renders usernames, paths, hosts, or transport internals.
  const campaign = {
    ...canonical,
    status: effectiveCampaignStatus(canonical),
    jobs: (canonical.jobs ?? []).map((j) => ({
      ...j,
      ...(typeof j.error === "string"
        ? { error: scrubStoredText(j.error, "This step failed - diagnostic detail was withheld. Retry the stage.") }
        : {}),
      ...(typeof j.lastTransientError === "string"
        ? { lastTransientError: scrubStoredText(j.lastTransientError, "Submit hiccup - retrying automatically.") }
        : {})
    })),
    runs: (canonical.runs ?? []).map((r) => ({
      ...r,
      ...(typeof r.note === "string"
        ? { note: scrubStoredText(r.note, "Run finished - diagnostic detail was withheld.") }
        : {})
    }))
  };
  return NextResponse.json({
    campaign,
    sourceMedia: workspace.sourceMedia.find((item) => item.id === canonical.sourceMediaId) ?? null,
    passport: workspace.passports.find((item) => item.id === canonical.passportId) ?? null,
    productFacts: workspace.productFacts.find((item) => item.id === canonical.productFactsId) ?? null,
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
    // Brief saves re-check rights inputs against live approvals: raw
    // transport failures must never reach the studio banner.
    logDkgError("brief-save", error);
    const safe = sanitizeDkgError(error, "preflight");
    return NextResponse.json({ error: safe.message, code: safe.code }, { status: safe.status });
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
 * Archived records are refused UNLESS `?force=true` is passed explicitly -
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
