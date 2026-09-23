import type {
  Campaign,
  CampaignCaption,
  Database,
  PermissionPassport,
  Platform,
  PreflightDecision,
  ProductFacts,
  SourceMedia,
  Transformation
} from "./types";
import { CAPABILITY_PRICE_MAP, hasSharableReceipt } from "./types";
import { loadDb, loadWorkspaceDb, newId, nowIso, sha256, updateDb, updateWorkspaceDb } from "./store";
import { preflightEvent } from "./campaign-status";
import { getDkg } from "./dkg";
import { amendmentKa, passportKa, productFactsKa, sourceMediaKa } from "./dkg/schemas";
import { preflight } from "./policy/engine";

/**
 * Platform services around the core production workflow -
 * facts management, media registry, passport lifecycle (revoke/amend),
 * claims-safe captions, cost estimation, client share links, comments.
 */

async function campaigns(): Promise<Campaign[]> {
  return (await loadDb()).campaigns;
}
function normalize(c: Campaign): Campaign {
  return { ...c, comments: c.comments ?? [], captions: c.captions ?? [] };
}

export async function findCampaign(id: string): Promise<Campaign | undefined> {
  const c = (await campaigns()).find((x) => x.id === id);
  return c ? normalize(c) : undefined;
}

/* ---------------------------------- facts --------------------------------- */

export async function upsertProductFacts(input: {
  id?: string;
  brand: string;
  productName: string;
  approvedClaims: string[];
  prohibitedClaims: string[];
  guidelines: string[];
  evidenceNotes: string;
}): Promise<ProductFacts> {
  const db = await loadDb();
  const existing = input.id ? db.productFacts.find((f) => f.id === input.id) : undefined;
  const facts: ProductFacts = {
    id: existing?.id ?? newId("facts"),
    brand: input.brand.trim(),
    productName: input.productName.trim(),
    approvedClaims: input.approvedClaims.map((c) => c.trim().toLowerCase()).filter(Boolean),
    prohibitedClaims: input.prohibitedClaims.map((c) => c.trim().toLowerCase()).filter(Boolean),
    guidelines: input.guidelines.map((g) => g.trim()).filter(Boolean),
    evidenceNotes: input.evidenceNotes.trim(),
    visibility: "shared"
  };
  let ual = existing?.ual;
  try {
    ual = (await getDkg().publish(productFactsKa(facts), facts.visibility)).ual;
  } catch {
    // local mode writes succeed; real-mode failures surface in health panel
  }
  await updateDb((d) => {
    const at = d.productFacts.findIndex((f) => f.id === facts.id);
    if (at >= 0) d.productFacts[at] = { ...facts, ual };
    else d.productFacts.push({ ...facts, ual });
    d.events.push({
      id: newId("evt"),
      at: nowIso(),
      kind: "facts.updated",
      summary: `Product facts published for ${facts.brand} ${facts.productName}.`,
      refs: [facts.id]
    });
  });
  return { ...facts, ual };
}

/* ---------------------------------- media --------------------------------- */

export async function registerSourceMedia(input: {
  creatorId: string;
  title: string;
  url: string;
  type?: "image" | "video";
}): Promise<SourceMedia> {
  const media: SourceMedia = {
    id: newId("media"),
    creatorId: input.creatorId,
    title: input.title.trim() || "Untitled creator asset",
    type: input.type ?? "image",
    url: input.url.trim(),
    hash: sha256(input.url.trim())
  };
  let ual: string | undefined;
  try {
    ual = (await getDkg().publish(sourceMediaKa(media), "private")).ual;
  } catch {
    // keep the record locally if publication fails
  }
  await updateDb((d) => {
    d.sourceMedia.push({ ...media, ual });
    d.events.push({
      id: newId("evt"),
      at: nowIso(),
      kind: "media.registered",
      summary: `Source media "${media.title}" registered.`,
      refs: [media.id]
    });
  });
  return { ...media, ual };
}

/* ------------------------- consent requests ------------------------ */

import {
  CONSENT_LINK_LIFETIME_DAYS,
  DECLINE_NOTE_MAX,
  attestGuard,
  cancelGuard,
  consentLifecycle,
  declineGuard,
  validateConsentRequest
} from "./consent-validation";

/** YYYY-MM-DD plus N days (request-link lifetime). */
function addDays(dateIso: string, days: number): string {
  const d = new Date(`${dateIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Create a source-linked Creator Consent Request. The agency picks existing
 * approved media of exactly one existing creator - no Creator record is
 * ever minted here - plus explicit scope, permission expiry, and purpose.
 * Scope is immutable once sent; creators may only narrow it at attest
 * time. Optionally supersedes an older link (replacement). No DKG write
 * happens here, so this works fully offline.
 */
export async function createConsentRequest(input: {
  creatorId: string;
  sourceMediaIds: string[];
  platforms: Platform[];
  countries: string[];
  allowedTransformations: Transformation[];
  validUntil: string;
  purpose: string;
  replacesToken?: string;
}): Promise<{ token: string; creatorId: string }> {
  const db = await loadDb();
  // Replacement clones the superseded row's creator, scope, and purpose -
  // the caller sends only the old token; a fresh link lifetime applies.
  const effective = input.replacesToken
    ? (() => {
        const old = db.consentInvites.find((i) => i.token === input.replacesToken);
        if (!old) throw new Error("Request to replace was not found.");
        return {
          creatorId: old.creatorId,
          sourceMediaIds: old.draft.sourceMediaIds ?? [],
          platforms: old.draft.platforms,
          countries: old.draft.countries,
          allowedTransformations: old.draft.allowedTransformations,
          validUntil: old.draft.validUntil,
          purpose: old.purpose ?? ""
        };
      })()
    : input;
  const validated = validateConsentRequest(effective, db);
  if (!validated.ok) throw new Error(validated.error);
  const v = validated.value;
  const creator = db.creators.find((c) => c.id === v.creatorId);
  if (!creator) throw new Error("Creator not found - the selected media has no known creator.");
  const today = new Date().toISOString().slice(0, 10);
  const token = newId("invite");
  await updateDb((d) => {
    if (input.replacesToken) {
      const old = d.consentInvites.find((i) => i.token === input.replacesToken);
      if (!old) throw new Error("Request to replace was not found.");
      if (old.creatorId !== v.creatorId) throw new Error("A replacement link must stay with the same creator.");
      const oldLifecycle = consentLifecycle(old, today);
      if (oldLifecycle !== "pending" && oldLifecycle !== "viewed" && oldLifecycle !== "expired" && oldLifecycle !== "cancelled") {
        throw new Error("Only pending, viewed, expired, or cancelled requests can be replaced.");
      }
      if (oldLifecycle !== "cancelled") old.status = "cancelled";
      old.replacedBy = token;
    }
    d.consentInvites.push({
      token,
      creatorId: v.creatorId,
      draft: {
        creatorId: v.creatorId,
        platforms: v.platforms,
        countries: v.countries,
        allowedTransformations: v.allowedTransformations,
        validUntil: v.validUntil,
        sourceMediaIds: v.sourceMediaIds
      },
      status: "pending",
      purpose: v.purpose,
      linkExpiresAt: addDays(today, CONSENT_LINK_LIFETIME_DAYS),
      createdAt: nowIso(),
      version: 1
    });
    d.events.push({
      id: newId("evt"),
      at: nowIso(),
      kind: "consent.invited",
      summary: `Consent request created for ${creator.name} (${v.platforms.join(", ")} · ${v.countries.join(", ")} · ${v.sourceMediaIds.length} asset${v.sourceMediaIds.length === 1 ? "" : "s"}).`,
      refs: [v.creatorId]
    });
  });
  return { token, creatorId: v.creatorId };
}

/**
 * Owner cancellation of a live request. Approved/declined rows are terminal
 * (revocation / fresh requests are the controls); cancelled rows stay for
 * audit and can be replaced.
 */
export async function cancelConsentRequest(token: string): Promise<void> {
  const db = await loadDb();
  const invite = db.consentInvites.find((i) => i.token === token);
  if (!invite) throw new Error("Consent request not found.");
  const guard = cancelGuard(consentLifecycle(invite));
  if (!guard.ok) throw new Error(guard.error);
  await updateDb((d) => {
    const row = d.consentInvites.find((i) => i.token === token);
    if (!row) throw new Error("Consent request not found.");
    const inner = cancelGuard(consentLifecycle(row));
    if (!inner.ok) throw new Error(inner.error);
    row.status = "cancelled";
    d.events.push({
      id: newId("evt"),
      at: nowIso(),
      kind: "consent.cancelled",
      summary: `Consent request for ${row.creatorId} cancelled by the agency.`,
      refs: [row.creatorId]
    });
  });
}

/* ----------------- sessionless consent lifecycle writes ----------------- */

/**
 * Explicit workspace-scoped store for the public consent lifecycle writes
 * (viewed-marking, decline). Production resolves the workspace from the
 * token itself (loadInviteContext) - no agency session involved. Tests
 * inject an in-memory implementation.
 */
export interface ConsentWorkspaceStore {
  loadWorkspace(workspaceId: string): Promise<Database>;
  writeWorkspace(workspaceId: string, mutator: (db: Database) => void): Promise<void>;
}

const liveConsentStore: ConsentWorkspaceStore = {
  loadWorkspace: (workspaceId: string) => loadWorkspaceDb(workspaceId),
  writeWorkspace: (workspaceId: string, mutator: (db: Database) => void) =>
    updateWorkspaceDb(workspaceId, mutator).then(() => undefined)
};

const consentTransitionLocks = new Map<string, Promise<void>>();

/**
 * Serialize consent terminal transitions (attest vs decline) per token
 * within this server instance. Unlike the idempotency single-flight - which
 * shares one result between duplicate same-operation calls - each waiter
 * runs its own work in turn, so the loser re-checks the lifecycle and
 * returns its own honest outcome instead of the winner's payload.
 */
export async function withConsentTransitionLock<T>(token: string, work: () => Promise<T>): Promise<T> {
  const previous = consentTransitionLocks.get(token) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  consentTransitionLocks.set(token, current);
  await previous.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
    if (consentTransitionLocks.get(token) === current) consentTransitionLocks.delete(token);
  }
}

/**
 * Idempotent viewed-marking for token reads. First open flips
 * pending → viewed (with timestamp); every other state is untouched and
 * nothing is ever published here. Explicitly workspace-scoped so the
 * sessionless public token route can persist it - never loadDb/updateDb.
 */
export async function markConsentViewed(
  token: string,
  workspaceId: string,
  store: ConsentWorkspaceStore = liveConsentStore
): Promise<void> {
  await store.writeWorkspace(workspaceId, (d) => {
    const row = d.consentInvites.find((i) => i.token === token);
    if (!row || row.status !== "pending") return;
    row.status = "viewed";
    row.viewedAt = nowIso();
  });
}

/**
 * Creator decline with optional local note. Creates no passport and never
 * touches DKG - the note stays local audit data, out of public proof.
 * Explicitly workspace-scoped so the sessionless public decline route can
 * persist it - never loadDb/updateDb.
 */
export async function declineConsentRequest(
  token: string,
  note: string | undefined,
  workspaceId: string,
  store: ConsentWorkspaceStore = liveConsentStore
): Promise<void> {
  const db = await store.loadWorkspace(workspaceId);
  const invite = db.consentInvites.find((i) => i.token === token);
  if (!invite) throw new Error("Consent link not found");
  const guard = declineGuard(consentLifecycle(invite));
  if (!guard.ok) throw new Error(guard.error);
  const clean = typeof note === "string" ? note.trim().slice(0, DECLINE_NOTE_MAX) : "";
  await store.writeWorkspace(workspaceId, (d) => {
    const row = d.consentInvites.find((i) => i.token === token);
    if (!row) throw new Error("Consent link not found");
    const inner = declineGuard(consentLifecycle(row));
    if (!inner.ok) throw new Error(inner.error);
    row.status = "declined";
    row.decision = { outcome: "declined", ...(clean ? { note: clean } : {}), at: nowIso() };
    d.events.push({
      id: newId("evt"),
      at: nowIso(),
      kind: "consent.declined",
      summary: `Consent request declined by the creator.`,
      refs: [row.creatorId]
    });
  });
}

/** Guard helpers re-exported for the token routes (single source of truth). */
export { attestGuard, declineGuard };

/* ------------------------- passport revoke / amend ------------------------ */

export async function revokePassport(passportId: string, note: string): Promise<{ revoked: boolean; blockedCampaigns: string[] }> {
  const db = await loadDb();
  const passport = db.passports.find((p) => p.id === passportId);
  if (!passport) throw new Error("Passport not found");
  if (passport.status === "revoked") return { revoked: false, blockedCampaigns: [] };

  const change = { kind: "revoked" as const, note: note.trim() || "Permission revoked by the creator/agency.", at: nowIso() };
  try {
    await getDkg().publish(amendmentKa(passport, change), "public");
  } catch {
    // amendment stored locally; still enforceable in the app layer
  }

  await updateDb((d) => {
    const p = d.passports.find((x) => x.id === passportId);
    if (p) {
      p.status = "revoked";
      p.ual = p.ual; // keep existing passport UAL; the amendment KA is the evidence
    }
    d.events.push({
      id: newId("evt"),
      at: nowIso(),
      kind: "passport.revoked",
      summary: `Permission ${passportId} revoked: ${change.note}`,
      refs: [passportId]
    });
  });

  // Re-run preflight on every campaign of this creator - revocation takes effect immediately.
  const affected = (await campaigns()).filter((c) => c.creatorId === passport.creatorId && c.status !== "approved");
  const blocked: string[] = [];
  for (const c of affected) {
    const decision = await preflight(normalize(c));
    await updateDb((d) => {
      const t = d.campaigns.find((x) => x.id === c.id);
      if (t) {
        // Keep stored status in sync with the fresh verdict in both
        // directions: a stale "blocked" must clear when rights allow again.
        t.preflight = decision;
        t.status = decision.decision === "block" ? "blocked" : t.status === "blocked" ? "draft" : t.status;
        t.updatedAt = nowIso();
      }
      if (decision.decision === "block") {
        d.events.push(preflightEvent(c, decision));
      }
    });
    if (decision.decision === "block") blocked.push(c.id);
  }
  return { revoked: true, blockedCampaigns: blocked };
}

export async function renewPassport(passportId: string, validUntil: string): Promise<PermissionPassport | undefined> {
  const db = await loadDb();
  const passport = db.passports.find((p) => p.id === passportId);
  if (!passport) return undefined;
  const renewed: PermissionPassport = {
    ...passport,
    validUntil,
    status: "active",
    attestation: {
      ...passport.attestation,
      consentedAt: nowIso(),
      declaration: `${passport.attestation.declaration} Renewed through PermitFrame on ${nowIso().slice(0, 10)} until ${validUntil}.`
    }
  };
  let ual = passport.ual;
  try {
    ual = (await getDkg().publish(passportKa(renewed), renewed.visibility)).ual;
  } catch {
    // keep old UAL on failure
  }
  await updateDb((d) => {
    const p = d.passports.find((x) => x.id === passportId);
    if (p) {
      p.validUntil = validUntil;
      p.status = "active";
      if (ual) p.ual = ual;
    }
    d.events.push({
      id: newId("evt"),
      at: nowIso(),
      kind: "passport.renewed",
      summary: `Permission passport ${passportId} renewed until ${validUntil}.`,
      refs: [passportId]
    });
  });
  return renewed;
}

export interface ExpiryWarning {
  passportId: string;
  creatorName: string;
  validUntil: string;
  daysLeft: number;
  level: "expired" | "critical" | "soon" | "ok";
  affectedCampaigns: string[];
}

export async function expiryWarnings(withinDays = 30, db?: Database): Promise<ExpiryWarning[]> {
  const data = db ?? (await loadDb());
  const today = new Date();
  return data.passports
    .filter((p) => p.status === "active")
    .map((p) => {
      const daysLeft = Math.ceil((new Date(p.validUntil + "T23:59:59Z").getTime() - today.getTime()) / 86_400_000);
      const level: "expired" | "critical" | "soon" | "ok" = daysLeft < 0 ? "expired" : daysLeft <= 7 ? "critical" : daysLeft <= withinDays ? "soon" : "ok";
      return {
        passportId: p.id,
        creatorName: p.creatorName,
        validUntil: p.validUntil,
        daysLeft,
        level,
        affectedCampaigns: data.campaigns.filter((c) => c.passportId === p.id && c.status !== "archived").map((c) => c.id)
      };
    })
    .filter((w) => w.level !== "ok");
}

/* -------------------------------- captions -------------------------------- */

const DISCLOSURE = "#ad";

/**
 * Deterministic, claims-safe captions: only verified claims
 * (campaign.preflight.allowedClaims) may appear, always with disclosure.
 */
export async function generateCaptions(campaignId: string): Promise<CampaignCaption[]> {
  const campaign = await findCampaign(campaignId);
  if (!campaign) throw new Error("Campaign not found");
  const { throwIfArchived } = await import("./campaigns");
  throwIfArchived(campaign, "captioned");
  const decision = campaign.preflight;
  if (decision?.decision !== "allow") throw new Error("Captions are only generated for policy-approved campaigns");
  const claims = decision.allowedClaims;
  const product = `${campaign.brand} ${campaign.productName}`;
  const claimSentence = claims.length > 0 ? ` ${capitalize(claims.join(" and "))}.` : "";
  const brandTag = campaign.brand.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();

  const captions: CampaignCaption[] = [
    {
      platform: campaign.request.platform,
      claimsUsed: claims,
      disclosure: DISCLOSURE,
      text: `${campaign.request.creativeBrief.split(/[,.]/)[0].trim()} ✨${claimSentence} Link in bio. ${DISCLOSURE} #${brandTag} #${campaign.productName.toLowerCase().replace(/[^a-z0-9]/g, "")}`
    }
  ];
  // companion variants for the other major platforms in the pack
  if (campaign.request.platform !== "instagram") {
    captions.push({
      platform: "instagram",
      claimsUsed: claims,
      disclosure: DISCLOSURE,
      text: `New drop ${product}.${claimSentence} ${DISCLOSURE} #${brandTag}`
    });
  }
  captions.push({
    platform: "linkedin",
    claimsUsed: claims,
    disclosure: DISCLOSURE,
    text: `Proud to launch ${product}.${claimSentence} Built with verified product claims and creator permissions. ${DISCLOSURE}`
  });
  await updateDb((d) => {
    const c = d.campaigns.find((x) => x.id === campaignId);
    if (c) {
      c.captions = captions;
      c.updatedAt = nowIso();
    }
  });
  return captions;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* ----------------------------- cost estimation ---------------------------- */

export function estimateCost(decision: PreflightDecision): number {
  let total = 0;
  for (const stage of decision.plan) {
    const price = CAPABILITY_PRICE_MAP[stage.capability];
    if (!price) continue;
    total += price.unit === "second" ? price.usd * 5 : price.usd; // video stages default to 5s
  }
  return total;
}

export function campaignCostRollup(campaign: Campaign): { spent: number; estimated: number; byStage: { label: string; usd: number }[] } {
  const spent = campaign.jobs.filter((j) => j.status === "ready_to_share").reduce((sum, j) => sum + (j.costUsd ?? 0), 0);
  const byStage = campaign.jobs
    .filter((j) => j.status === "ready_to_share")
    .map((j) => ({ label: j.stageId, usd: j.costUsd ?? 0 }));
  const estimated = campaign.preflight ? estimateCost(campaign.preflight) : 0;
  return { spent, estimated, byStage };
}

/* ------------------------- share links + comments ------------------------- */
// NOTE: public share reads/writes live in ./public-share (session-free,
// whitelisted). The session-gated resolveShare/clientReview used to serve the
// public routes and 500'd logged-out visitors - removed so no future caller
// can reintroduce the session dependency on a public path.

export async function createShareLink(campaignId: string): Promise<string> {
  const campaign = await findCampaign(campaignId);
  if (!campaign) throw new Error("Campaign not found");
  const { throwIfArchived } = await import("./campaigns");
  throwIfArchived(campaign, "shared");
  if (!campaign.receipts.some((r) => hasSharableReceipt(r))) {
    throw new Error("Share links need a ready-to-share output - previews and unsaved outputs stay private until durable storage confirms them.");
  }
  const token = newId("share");
  await updateDb((d) => {
    const c = d.campaigns.find((x) => x.id === campaignId);
    if (!c) throw new Error("Campaign not found");
    c.shareToken = token;
  });
  return token;
}

export async function addComment(campaignId: string, author: string, text: string): Promise<Campaign> {
  const campaign = await findCampaign(campaignId);
  if (!campaign) throw new Error("Campaign not found");
  const { throwIfArchived } = await import("./campaigns");
  throwIfArchived(campaign, "commented on");
  await updateDb((d) => {
    const c = d.campaigns.find((x) => x.id === campaignId);
    if (!c) throw new Error("Campaign not found");
    c.comments = [...(c.comments ?? []), { id: newId("cmt"), author, text: text.trim(), at: nowIso() }];
  });
  return (await findCampaign(campaignId))!;
}

export async function campaignTimeline(campaign: Campaign) {
  const events = (await loadDb()).events.filter((e) => e.refs.includes(campaign.id));
  const comments = (campaign.comments ?? []).map((c) => ({ kind: "comment", at: c.at, summary: `${c.author}: ${c.text}`, id: c.id }));
  const evts = events.map((e) => ({ kind: e.kind, at: e.at, summary: e.summary, id: e.id }));
  return [...evts, ...comments].sort((a, b) => a.at.localeCompare(b.at)).reverse();
}

/* --------------------------- platform variants ---------------------------- */

export async function cloneForPlatforms(campaignId: string, platforms: Platform[]): Promise<Campaign[]> {
  const base = await findCampaign(campaignId);
  if (!base) throw new Error("Campaign not found");
  const { createCampaign, throwIfArchived } = await import("./campaigns");
  throwIfArchived(base, "cloned into platform variants");
  const created: Campaign[] = [];
  for (const platform of platforms) {
    if (platform === base.request.platform) continue;
    const variant = await createCampaign({
      title: `${base.title.replace(/ \(.*\)$/, "")} - ${platform} variant`,
      brand: base.brand,
      productName: base.productName,
      creatorId: base.creatorId,
      sourceMediaId: base.sourceMediaId,
      passportId: base.passportId,
      productFactsId: base.productFactsId,
      request: { ...base.request, platform },
      contextNote: `Platform variant of ${base.id}, preflighted independently for ${platform}.`
    });
    created.push(variant);
  }
  return created;
}
