import crypto from "node:crypto";
import { getDb } from "./db/client";
import { workspaceState } from "./db/schema";
import type { Campaign } from "./types";
import { deliveryBlockReason } from "./types";

/**
 * Public client-review reads and writes. Session-free by design: share links
 * must work logged out, so this module NEVER touches cookies, sessions, or
 * session-scoped workspace reads. The share token is the sole capability -
 * it must be valid and opaque, and every response is built from an explicit
 * whitelist (PublicShareView). Internal data (workspace ids, source URLs,
 * prompts, notes, contracts, costs, credentials) cannot leak because it is
 * never selected into the view.
 */

const SHARE_TOKEN_PATTERN = /^share_[0-9a-f]{12}$/;

export interface PublicShareOutput {
  id: string;
  label: string;
  mediaType: "image" | "video";
  format: string;
  outputUrl: string;
  claimsUsed: string[];
  /** Verification deep-link once the pack is approved; null until then. */
  verifyUrl: string | null;
}

export interface PublicShareCaption {
  platform: string;
  text: string;
  disclosure: string;
}

/** The ONLY campaign data ever exposed on public share surfaces. */
export interface PublicShareView {
  title: string;
  brand: string;
  productName: string;
  platform: string;
  country: string;
  allowedClaims: string[];
  captions: PublicShareCaption[];
  outputs: PublicShareOutput[];
  verificationRef: string | null;
}

export type ShareLookup = { found: false } | { found: true; view: PublicShareView };

export class ShareNotFoundError extends Error {
  constructor() {
    super("Share link not found. It may have been removed - ask the campaign owner for a fresh link.");
    this.name = "ShareNotFoundError";
  }
}

function toPublicView(campaign: Campaign): PublicShareView {
  const verificationRef = campaign.verificationRef ?? null;
  return {
    title: campaign.title,
    brand: campaign.brand,
    productName: campaign.productName,
    platform: campaign.request.platform,
    country: campaign.request.country,
    allowedClaims: campaign.preflight?.allowedClaims ?? [],
    captions: (campaign.captions ?? []).map((c) => ({
      platform: c.platform,
      text: c.text,
      disclosure: c.disclosure
    })),
    outputs: publicOutputsForShare(campaign, verificationRef),
    verificationRef
  };
}

/**
 * Client-delivery outputs (pure): every receipt except private ones and
 * delivery-blocked ones. Private derivatives (e.g. burn-caption outputs)
 * never reach client delivery; ratio-mismatched outputs (stored reason or
 * legacy `aspectVerdict: "mismatch"`) are excluded on read even when their
 * historical job state says ready_to_share - so newly generated,
 * already-approved, and legacy campaigns all behave the same with no
 * migration. Shared and legacy durable outputs keep their current behavior.
 * The share API and page both read through here; excluded URLs are never
 * selected into the view, so they cannot leak.
 */
export function publicOutputsForShare(campaign: Campaign, verificationRef: string | null): PublicShareOutput[] {
  return campaign.receipts
    .filter((r) => r.visibility !== "private" && deliveryBlockReason(r) === null)
    .map((r) => ({
      id: r.id,
      label: r.label,
      mediaType: r.mediaType,
      format: r.format,
      outputUrl: r.outputUrl,
      ...(r.actualWidth !== undefined && r.actualHeight !== undefined
        ? { actualWidth: r.actualWidth, actualHeight: r.actualHeight }
        : {}),
      ...(r.aspectVerdict ? { aspectVerdict: r.aspectVerdict } : {}),
      claimsUsed: r.claimsUsed,
      verifyUrl: verificationRef ? `/verify/${verificationRef}#output-${r.id}` : null
    }));
}

/**
 * Anonymous share lookup: scans workspace states for the token without any
 * session. Malformed (non-opaque) tokens miss immediately - legacy or guessed
 * identifiers can never resolve to workspace data.
 */
export async function lookupShare(token: string): Promise<ShareLookup> {
  if (!SHARE_TOKEN_PATTERN.test(token)) return { found: false };
  const rows = await getDb().select({ data: workspaceState.data }).from(workspaceState);
  for (const row of rows) {
    const campaign = row.data.campaigns.find((c) => c.shareToken === token);
    if (campaign) return { found: true, view: toPublicView(campaign) };
  }
  return { found: false };
}

export interface ShareReviewInput {
  decision: "approved" | "changes_requested";
  clientName?: string;
  comment?: string;
}

/**
 * Anonymous client review submit. Token-gated, campaign-scoped, comments-only:
 * appends one client note (and the same status transitions as the signed-in
 * path) to exactly the workspace row holding the token. No session, no
 * workspace enumeration, no other fields touched.
 */
export async function appendShareReview(token: string, input: ShareReviewInput): Promise<{ status: string }> {
  if (!SHARE_TOKEN_PATTERN.test(token)) throw new ShareNotFoundError();
  const db = getDb();
  const rows = await db.select({ workspaceId: workspaceState.workspaceId, data: workspaceState.data }).from(workspaceState);
  const hit = rows.find((r) => r.data.campaigns.some((c) => c.shareToken === token));
  if (!hit) throw new ShareNotFoundError();
  const data = hit.data;
  const campaign = data.campaigns.find((c) => c.shareToken === token);
  if (!campaign) throw new ShareNotFoundError();
  // Archived records stay readable (the link promise) but read-only: reviews
  // on history would silently mutate what archiving froze.
  if (campaign.status === "archived") {
    throw new Error("This campaign is archived - reviews are closed, but the record stays readable.");
  }
  const entry = {
    id: `cmt_${crypto.randomBytes(6).toString("hex")}`,
    author: input.clientName?.trim().slice(0, 80) || "client",
    text: `[${input.decision}] ${(input.comment ?? "").trim().slice(0, 2000)}`.trim(),
    at: new Date().toISOString()
  };
  campaign.comments = [...(campaign.comments ?? []), entry];
  if (input.decision === "approved" && campaign.status === "review") campaign.status = "approved";
  if (input.decision === "changes_requested") campaign.status = "review";
  campaign.updatedAt = entry.at;
  data.events.push({
    id: `evt_${crypto.randomBytes(6).toString("hex")}`,
    at: entry.at,
    kind: `share.${input.decision}`,
    summary: `Client review: ${input.decision} on "${campaign.title}".`,
    refs: [campaign.id]
  });
  await db
    .insert(workspaceState)
    .values({ workspaceId: hit.workspaceId, data, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: workspaceState.workspaceId,
      set: { data, updatedAt: new Date() }
    });
  return { status: campaign.status };
}
