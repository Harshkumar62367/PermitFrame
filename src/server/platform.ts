import type {
  Campaign,
  CampaignCaption,
  PermissionPassport,
  Platform,
  PreflightDecision,
  ProductFacts,
  SourceMedia
} from "./types";
import { CAPABILITY_PRICE_MAP } from "./types";
import { loadDb, newId, nowIso, sha256, updateDb } from "./store";
import { getDkg } from "./dkg";
import { amendmentKa, passportKa, productFactsKa, sourceMediaKa } from "./dkg/schemas";
import { preflight } from "./policy/engine";

/**
 * Platform services: the product surfaces around the core demo loop —
 * facts management, media registry, passport lifecycle (revoke/amend),
 * claims-safe captions, cost estimation, client share links, comments.
 */

function campaigns(): Campaign[] {
  return loadDb().campaigns;
}

function normalize(c: Campaign): Campaign {
  return { ...c, comments: c.comments ?? [], captions: c.captions ?? [] };
}

export function findCampaign(id: string): Campaign | undefined {
  const c = campaigns().find((x) => x.id === id);
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
  const db = loadDb();
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
  updateDb((d) => {
    const at = d.productFacts.findIndex((f) => f.id === facts.id);
    if (at >= 0) d.productFacts[at] = { ...facts, ual };
    else d.productFacts.push({ ...facts, ual });
    d.events.push({
      id: newId("evt"),
      at: nowIso(),
      kind: "facts.updated",
      summary: `Product facts published for ${facts.brand} ${facts.productName}${ual ? ` (${ual})` : ""}.`,
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
  updateDb((d) => {
    d.sourceMedia.push({ ...media, ual });
    d.events.push({
      id: newId("evt"),
      at: nowIso(),
      kind: "media.registered",
      summary: `Source media "${media.title}" registered${ual ? ` (${ual})` : ""}.`,
      refs: [media.id]
    });
  });
  return { ...media, ual };
}

/* ------------------------- passport revoke / amend ------------------------ */

export async function revokePassport(passportId: string, note: string): Promise<{ revoked: boolean; blockedCampaigns: string[] }> {
  const db = loadDb();
  const passport = db.passports.find((p) => p.id === passportId);
  if (!passport) throw new Error("Passport not found");
  if (passport.status === "revoked") return { revoked: false, blockedCampaigns: [] };

  const change = { kind: "revoked" as const, note: note.trim() || "Permission revoked by the creator/agency.", at: nowIso() };
  let ual: string | undefined;
  try {
    ual = (await getDkg().publish(amendmentKa(passport, change), "public")).ual;
  } catch {
    // amendment stored locally; still enforceable in the app layer
  }

  updateDb((d) => {
    const p = d.passports.find((x) => x.id === passportId);
    if (p) {
      p.status = "revoked";
      p.ual = p.ual; // keep existing passport UAL; the amendment KA is the evidence
    }
    d.events.push({
      id: newId("evt"),
      at: nowIso(),
      kind: "passport.revoked",
      summary: `Permission passport ${passportId} revoked${ual ? ` — amendment ${ual}` : ""}: ${change.note}`,
      refs: [passportId]
    });
  });

  // Re-run preflight on every campaign of this creator — revocation takes effect immediately.
  const affected = campaigns().filter((c) => c.creatorId === passport.creatorId && c.status !== "approved");
  const blocked: string[] = [];
  for (const c of affected) {
    const decision = await preflight(normalize(c));
    updateDb((d) => {
      const t = d.campaigns.find((x) => x.id === c.id);
      if (t) {
        t.preflight = decision;
        t.status = decision.decision === "block" ? "blocked" : t.status;
        t.updatedAt = nowIso();
      }
    });
    if (decision.decision === "block") blocked.push(c.id);
  }
  return { revoked: true, blockedCampaigns: blocked };
}

export async function renewPassport(passportId: string, validUntil: string): Promise<PermissionPassport | undefined> {
  const db = loadDb();
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
  updateDb((d) => {
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

export function expiryWarnings(withinDays = 30): ExpiryWarning[] {
  const db = loadDb();
  const today = new Date();
  return db.passports
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
        affectedCampaigns: db.campaigns.filter((c) => c.passportId === p.id).map((c) => c.id)
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
export function generateCaptions(campaignId: string): CampaignCaption[] {
  const campaign = findCampaign(campaignId);
  if (!campaign) throw new Error("Campaign not found");
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
  updateDb((d) => {
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
  const spent = campaign.jobs.filter((j) => j.status === "succeeded").reduce((sum, j) => sum + (j.costUsd ?? 0), 0);
  const byStage = campaign.jobs
    .filter((j) => j.status === "succeeded")
    .map((j) => ({ label: j.stageId, usd: j.costUsd ?? 0 }));
  const estimated = campaign.preflight ? estimateCost(campaign.preflight) : 0;
  return { spent, estimated, byStage };
}

/* ------------------------- share links + comments ------------------------- */

export function createShareLink(campaignId: string): string {
  const token = newId("share");
  updateDb((d) => {
    const c = d.campaigns.find((x) => x.id === campaignId);
    if (!c) throw new Error("Campaign not found");
    c.shareToken = token;
  });
  return token;
}

export function resolveShare(token: string): Campaign | undefined {
  return campaigns().find((c) => c.shareToken === token);
}

export function clientReview(
  token: string,
  input: { decision: "approved" | "changes_requested"; clientName?: string; comment?: string }
): Campaign {
  const campaign = resolveShare(token);
  if (!campaign) throw new Error("Share link not found");
  updateDb((d) => {
    const c = d.campaigns.find((x) => x.id === campaign.id);
    if (!c) return;
    c.comments = [...(c.comments ?? []), {
      id: newId("cmt"),
      author: input.clientName?.trim() || "client",
      text: `[${input.decision}] ${input.comment?.trim() || ""}`.trim(),
      at: nowIso()
    }];
    if (input.decision === "approved" && c.status === "review") c.status = "approved";
    if (input.decision === "changes_requested") c.status = "review";
    c.updatedAt = nowIso();
    d.events.push({
      id: newId("evt"),
      at: nowIso(),
      kind: `share.${input.decision}`,
      summary: `Client review: ${input.decision} on "${c.title}".`,
      refs: [c.id]
    });
  });
  return findCampaign(campaign.id)!;
}

export function addComment(campaignId: string, author: string, text: string): Campaign {
  updateDb((d) => {
    const c = d.campaigns.find((x) => x.id === campaignId);
    if (!c) throw new Error("Campaign not found");
    c.comments = [...(c.comments ?? []), { id: newId("cmt"), author, text: text.trim(), at: nowIso() }];
  });
  return findCampaign(campaignId)!;
}

export function campaignTimeline(campaign: Campaign) {
  const events = loadDb().events.filter((e) => e.refs.includes(campaign.id));
  const comments = (campaign.comments ?? []).map((c) => ({ kind: "comment", at: c.at, summary: `${c.author}: ${c.text}`, id: c.id }));
  const evts = events.map((e) => ({ kind: e.kind, at: e.at, summary: e.summary, id: e.id }));
  return [...evts, ...comments].sort((a, b) => a.at.localeCompare(b.at)).reverse();
}

/* --------------------------- platform variants ---------------------------- */

export async function cloneForPlatforms(campaignId: string, platforms: Platform[]): Promise<Campaign[]> {
  const base = findCampaign(campaignId);
  if (!base) throw new Error("Campaign not found");
  const created: Campaign[] = [];
  for (const platform of platforms) {
    if (platform === base.request.platform) continue;
    const { createCampaign } = await import("./campaigns");
    const variant = await createCampaign({
      title: `${base.title.replace(/ \(.*\)$/, "")} — ${platform} variant`,
      brand: base.brand,
      productName: base.productName,
      creatorId: base.creatorId,
      sourceMediaId: base.sourceMediaId,
      passportId: base.passportId,
      productFactsId: base.productFactsId,
      request: { ...base.request, platform },
      demoNote: `Platform variant of ${base.id} — preflighted independently for ${platform}.`
    });
    created.push(variant);
  }
  return created;
}
