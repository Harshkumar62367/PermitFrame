import type {
  Creator,
  Database,
  PermissionPassport,
  ProductFacts,
  SourceMedia
} from "./types";

export interface CampaignSelectionInput {
  creatorId?: unknown;
  passportId?: unknown;
  sourceMediaId?: unknown;
  productFactsId?: unknown;
}

export interface ResolvedSelection {
  creator: Creator;
  passport: PermissionPassport;
  media: SourceMedia;
  facts: ProductFacts;
}

export type SelectionResolution =
  | { ok: true; value: ResolvedSelection }
  | { ok: false; error: string };

/**
 * Resolve an explicit campaign-creation selection. Every id is required -
 * the server never falls back to "the first workspace record", which is
 * unsafe once a workspace holds multiple creators, media, or brand rules.
 * Pure (no session, no I/O) so all combinations are unit-testable.
 */
export function resolveCampaignSelection(
  db: Database,
  sel: CampaignSelectionInput,
  today: string = new Date().toISOString().slice(0, 10)
): SelectionResolution {
  const fail = (error: string): SelectionResolution => ({ ok: false, error });

  const creatorId = typeof sel.creatorId === "string" ? sel.creatorId : "";
  if (!creatorId) return fail("Choose a creator permission to create a campaign.");
  const creator = db.creators.find((c) => c.id === creatorId);
  if (!creator) return fail("The chosen creator no longer exists. Pick another permission.");

  const passportId = typeof sel.passportId === "string" ? sel.passportId : "";
  if (!passportId) return fail("Choose a creator permission to create a campaign.");
  const passport = db.passports.find((p) => p.id === passportId);
  if (!passport) return fail("The chosen permission no longer exists. Pick another one.");
  if (passport.creatorId !== creator.id) {
    return fail("The chosen permission belongs to a different creator. Pick a matching pair.");
  }
  if (passport.status !== "active") {
    return fail("The chosen permission is not active. Pick an active permission or renew it.");
  }
  if (passport.validUntil < today) {
    return fail("The chosen permission has expired. Renew it or pick another one.");
  }

  const sourceMediaId = typeof sel.sourceMediaId === "string" ? sel.sourceMediaId : "";
  if (!sourceMediaId) return fail("Choose the source media for this campaign.");
  const media = db.sourceMedia.find((m) => m.id === sourceMediaId);
  if (!media) return fail("The chosen media no longer exists. Pick another item.");
  if (media.creatorId !== creator.id) {
    return fail("The chosen media belongs to a different creator. Only that creator's media may be used.");
  }

  const productFactsId = typeof sel.productFactsId === "string" ? sel.productFactsId : "";
  if (!productFactsId) return fail("Choose a brand rule for this campaign.");
  const facts = db.productFacts.find((f) => f.id === productFactsId);
  if (!facts) return fail("The chosen brand rule no longer exists. Pick another one.");

  return { ok: true, value: { creator, passport, media, facts } };
}
