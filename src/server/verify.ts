import { loadDb } from "./store";
import { explorerUrlFor } from "./dkg/adapter";

/** Resolve any PermitFrame reference (receipt id, UAL, campaign id) to public verification data. */
export async function lookupVerification(ref: string) {
  const db = await loadDb();

  const receipt = db.campaigns.flatMap((c) => c.receipts).find((r) => r.id === ref || r.ual === ref);
  if (receipt) {
    const campaign = db.campaigns.find((c) => c.id === receipt.campaignId);
    const passport = db.passports.find((p) => p.id === receipt.derivedFrom.passportId);
    const facts = db.productFacts.find((f) => f.id === receipt.derivedFrom.productFactsId);
    return {
      found: true as const,
      kind: "DerivativeReceipt",
      ref: receipt.id,
      ual: receipt.ual ?? null,
      explorerUrl: receipt.ual ? explorerUrlFor(receipt.ual) : null,
      published: Boolean(receipt.ual),
      label: receipt.label,
      media: { type: receipt.mediaType, url: receipt.outputUrl, hash: receipt.outputHash, format: receipt.format },
      generation: { capability: receipt.capability, promptHash: receipt.promptHash, generatedAt: receipt.generatedAt },
      claimsUsed: receipt.claimsUsed,
      lineage: {
        campaign: campaign ? { id: campaign.id, title: campaign.title, ual: campaign.campaignUAL ?? null } : null,
        permissionPassport: passport
          ? {
              id: passport.id,
              creator: passport.creatorName,
              ual: passport.ual ?? null,
              validUntil: passport.validUntil,
              status: passport.status,
              platforms: passport.platforms,
              countries: passport.countries
            }
          : null,
        productFacts: facts
          ? {
              id: facts.id,
              brand: facts.brand,
              productName: facts.productName,
              ual: facts.ual ?? null,
              approvedClaims: facts.approvedClaims,
              prohibitedClaims: facts.prohibitedClaims
            }
          : null
      }
    };
  }

  const campaign = db.campaigns.find((c) => c.id === ref || c.campaignUAL === ref);
  if (campaign) {
    return {
      found: true as const,
      kind: "Campaign",
      ref: campaign.id,
      ual: campaign.campaignUAL ?? null,
      explorerUrl: campaign.campaignUAL ? explorerUrlFor(campaign.campaignUAL) : null,
      published: Boolean(campaign.campaignUAL),
      label: campaign.title,
      media: null,
      generation: null,
      claimsUsed: campaign.preflight?.allowedClaims ?? [],
      lineage: {
        campaign: { id: campaign.id, title: campaign.title, ual: campaign.campaignUAL ?? null },
        permissionPassport: null,
        productFacts: null,
        receipts: campaign.receipts.map((r) => ({ id: r.id, label: r.label, ual: r.ual ?? null }))
      }
    };
  }

  return { found: false as const, ref };
}

export type VerificationResult = Awaited<ReturnType<typeof lookupVerification>>;
