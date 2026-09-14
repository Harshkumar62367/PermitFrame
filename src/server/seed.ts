import type { Campaign, PermissionPassport, ProductFacts, SourceMedia } from "./types";
import { loadDb, newId, nowIso, sha256, updateDb } from "./store";
import { getDkg } from "./dkg";
import { passportKa, productFactsKa, sourceMediaKa } from "./dkg/schemas";
import { preflight } from "./policy/engine";

/**
 * Demo workspace: fictional sustainable shoe brand + UGC creator.
 * Campaign A is intentionally blocked (TikTok/Germany/waterproof).
 * Campaign B is fully permitted (Instagram/Greece/recycled materials).
 */

export const DEMO = {
  creatorId: "creator_maya",
  creatorName: "Maya Chen",
  creatorHandle: "@mayawalks",
  brand: "Verdi Steps",
  productName: "TerraRunner",
  sourceMediaId: "media_maya_01",
  passportId: "passport_maya_01",
  productFactsId: "facts_verdi_01",
  sourceImageUrl:
    "https://images.unsplash.com/photo-1595950653106-6c9ebd614d3a?w=1200&q=80&fm=jpg",
  campaignAId: "campaign_blocked_demo",
  campaignBId: "campaign_approved_demo"
};

const PASSPORT: PermissionPassport = {
  id: DEMO.passportId,
  creatorId: DEMO.creatorId,
  creatorName: DEMO.creatorName,
  sourceMediaIds: [DEMO.sourceMediaId],
  platforms: ["instagram", "youtube"],
  countries: ["GR", "US"],
  allowedTransformations: ["edit", "animate", "crop", "upscale"],
  validFrom: "2026-09-01",
  validUntil: "2027-03-01",
  status: "active",
  attestation: {
    method: "creator-consent-link",
    consentedAt: "2026-09-05T10:24:00.000Z",
    declaration:
      "I, Maya Chen, grant Verdi Steps permission to use and transform my content for paid social campaigns on the listed platforms and territories until the expiry date. Attested through the PermitFrame creator consent link."
  },
  visibility: "public"
};

const FACTS: ProductFacts = {
  id: DEMO.productFactsId,
  brand: DEMO.brand,
  productName: DEMO.productName,
  approvedClaims: ["made with recycled materials", "carbon-neutral shipping"],
  prohibitedClaims: ["waterproof", "machine washable", "medical grade"],
  guidelines: [
    "Earthy, natural palette - forest greens and warm sand tones.",
    "Real urban environments, natural light; no studio chrome.",
    "Calm confident tone; avoid aggressive superlatives."
  ],
  evidenceNotes:
    "Product spec sheet v3.2 (March 2026); recycled-content certification FR-0921. Waterproofing is NOT certified - do not imply water resistance.",
  visibility: "shared"
};

const MEDIA: SourceMedia = {
  id: DEMO.sourceMediaId,
  creatorId: DEMO.creatorId,
  title: "Maya - TerraRunner street walk (vertical)",
  type: "image",
  url: DEMO.sourceImageUrl,
  hash: ""
};

const LEO_MEDIA: SourceMedia = {
  id: "media_leo_01",
  creatorId: "creator_leo",
  title: "Leo - TerraRunner unboxing vertical",
  type: "image",
  url: "https://images.unsplash.com/photo-1608231387042-66d1773070a5?w=1200&q=80&fm=jpg",
  hash: ""
};

export async function ensureSeed(): Promise<{ seeded: boolean }> {
  const db = await loadDb();
  if (db.campaigns.length > 0 && db.passports.length > 0) return { seeded: false };

  MEDIA.hash = sha256(MEDIA.url);

  await updateDb((d) => {
    if (!d.creators.some((c) => c.id === DEMO.creatorId)) {
      d.creators.push({ id: DEMO.creatorId, name: DEMO.creatorName, handle: DEMO.creatorHandle });
    }
    if (!d.creators.some((c) => c.id === "creator_leo")) {
      d.creators.push({ id: "creator_leo", name: "Leo Okafor", handle: "@leoshoots" });
    }
    if (!d.sourceMedia.some((m) => m.id === LEO_MEDIA.id)) {
      LEO_MEDIA.hash = sha256(LEO_MEDIA.url);
      d.sourceMedia.push(LEO_MEDIA);
    }
    if (!d.consentInvites.some((i) => i.token === "demo-leo")) {
      d.consentInvites.push({
        token: "demo-leo",
        creatorId: "creator_leo",
        draft: {
          creatorId: "creator_leo",
          platforms: ["tiktok", "youtube"],
          countries: ["US", "GB"],
          allowedTransformations: ["edit", "crop"],
          validUntil: "2027-01-31",
          sourceMediaIds: [LEO_MEDIA.id]
        },
        status: "pending"
      });
    }
    if (!d.passports.some((p) => p.id === PASSPORT.id)) d.passports.push(PASSPORT);
    if (!d.productFacts.some((f) => f.id === FACTS.id)) d.productFacts.push(FACTS);
    if (!d.sourceMedia.some((m) => m.id === MEDIA.id)) d.sourceMedia.push(MEDIA);
    if (!d.consentInvites.some((i) => i.token === "demo-maya")) {
      d.consentInvites.push({
        token: "demo-maya",
        creatorId: DEMO.creatorId,
        draft: {
          creatorId: DEMO.creatorId,
          platforms: PASSPORT.platforms,
          countries: PASSPORT.countries,
          allowedTransformations: PASSPORT.allowedTransformations,
          validUntil: PASSPORT.validUntil,
          sourceMediaIds: PASSPORT.sourceMediaIds
        },
        status: "completed"
      });
    }
  });

  // Publish the base Knowledge Assets through the configured DKG adapter
  const dkg = getDkg();
  const published: Record<string, string | undefined> = {};
  try {
    published.passport = (await dkg.publish(passportKa(PASSPORT), "public")).ual;
    published.facts = (await dkg.publish(productFactsKa(FACTS), "shared")).ual;
    published.media = (await dkg.publish(sourceMediaKa(MEDIA), "private")).ual;
  } catch {
    // local mode writes succeed; real-mode failures surface in the health panel
  }
  await updateDb((d) => {
    const p = d.passports.find((x) => x.id === PASSPORT.id);
    if (p) p.ual = published.passport;
    const f = d.productFacts.find((x) => x.id === FACTS.id);
    if (f) f.ual = published.facts;
    const m = d.sourceMedia.find((x) => x.id === MEDIA.id);
    if (m) m.ual = published.media;
  });

  // Campaign A: the blocked demo
  const blocked = baseCampaign({
    id: DEMO.campaignAId,
    title: "TikTok push - Germany (blocked demo)",
    request: {
      platform: "tiktok",
      country: "DE",
      requestedClaims: ["waterproof"],
      transformation: "video",
      creativeBrief:
        "Creator-style close-up of the TerraRunner splashing through a rainy street at dusk, slow motion puddle impacts."
    },
    demoNote:
      "Requested for TikTok in Germany with the claim \"waterproof\" - the DKG blocks all three: platform not permitted, country not covered, claim not supported by verified facts."
  });
  // Campaign B: the approved demo
  const approved = baseCampaign({
    id: DEMO.campaignBId,
    title: "Instagram Reels - Greece launch",
    request: {
      platform: "instagram",
      country: "GR",
      requestedClaims: ["made with recycled materials"],
      transformation: "video",
      creativeBrief:
        "Golden-hour rooftop shot of the TerraRunner with the Athens skyline behind; natural creator-made feel, gentle motion."
    },
    demoNote:
      "Requested for Instagram in Greece highlighting recycled materials - permitted and claim-supported, so the agent may generate."
  });

  updateDb((d) => {
    if (!d.campaigns.some((c) => c.id === blocked.id)) d.campaigns.push(blocked);
    if (!d.campaigns.some((c) => c.id === approved.id)) d.campaigns.push(approved);
  });

  // Run preflight immediately so the demo opens with decisions ready
  for (const id of [blocked.id, approved.id]) {
    const { loadCampaign } = await import("./campaigns");
    const campaign = await loadCampaign(id);
    if (!campaign) continue;
    const decision = await preflight(campaign);
    await updateDb((d) => {
      const c = d.campaigns.find((x) => x.id === id);
      if (c) {
        c.preflight = decision;
        c.status = decision.decision === "allow" ? "draft" : "blocked";
        c.updatedAt = nowIso();
      }
    });
  }

  return { seeded: true };
}

function baseCampaign(input: {
  id: string;
  title: string;
  request: Campaign["request"];
  demoNote: string;
}): Campaign {
  return {
    id: input.id,
    title: input.title,
    brand: DEMO.brand,
    productName: DEMO.productName,
    request: input.request,
    status: "draft",
    jobs: [],
    receipts: [],
    comments: [],
    captions: [],
    creatorId: DEMO.creatorId,
    sourceMediaId: DEMO.sourceMediaId,
    passportId: DEMO.passportId,
    productFactsId: DEMO.productFactsId,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    demoNote: input.demoNote
  };
}
