/**
 * Demo Campaigns gallery definitions for hackathon evaluation. Pure local
 * data only - no fetching, no session, no workspace reads, no provider or
 * ledger calls. Demo cards are descriptive walkthroughs: they never create,
 * seed, or reference real creators, media, permissions, passports,
 * receipts, approvals, jobs, evidence, or proof. "Use this brief" carries
 * only the allow-listed brief fields below - never creator, media,
 * permission, passport, receipt, approval, proof, job, or history data.
 */

/** Image formats PermitFrame template flows accept. "4:5" is intentionally absent. */
export type DemoFormatRatio = "16:9" | "4:3" | "1:1" | "9:16";

export interface DemoFormat {
  ratio: DemoFormatRatio;
  placement: string;
}

/**
 * Brief prefill allow-list. Exactly these keys may travel from a demo card
 * to the campaign form - nothing else. Template and formats are suggestions
 * shown as guidance; the form itself only takes title, brief, and platform.
 */
export interface DemoBriefPrefill {
  title: string;
  brief: string;
  platform: string;
  suggestedTemplate: string;
  suggestedFormats: DemoFormatRatio[];
}

export interface DemoCampaign {
  id: string;
  title: string;
  tagline: string;
  formats: DemoFormat[];
  /** Planned-but-undispatchable motion note, shown verbatim when present. */
  motionNote?: string;
  workflow: string[];
  requiredInputs: string[];
  preSpendChecks: string[];
  prefill: DemoBriefPrefill;
}

export const DEMO_ONLY_LABEL = "Demo for hackathon evaluation only";
export const DEMO_READONLY_LABEL = "Read-only";
export const DEMO_NO_EVIDENCE_LABEL = "No generation, evidence, or proof exists for this demo.";
export const DEMO_BOUNDARY_NOTICE =
  "You will still need to choose a creator permission, approved media, and a brand rule, then pass the permission check before production.";

export const DEMO_CAMPAIGNS: readonly DemoCampaign[] = [
  {
    id: "premium-listing-launch",
    title: "Premium residential listing launch",
    tagline: "A realistic property-marketing walkthrough: portal hero, feature details, and honest review gates.",
    formats: [
      { ratio: "16:9", placement: "Listing header - portal hero and wide campaign banner" },
      { ratio: "4:3", placement: "Property feature detail - one verified feature per still" }
    ],
    motionNote: "Planned - identity-safe property motion is not available for dispatch yet.",
    workflow: [
      "Start from approved property media - the listing photographs the owner provided, never stock swaps.",
      "Attach verified facts: address, area, bedrooms, and the features the stills may show.",
      "Run permission review: the platform, territory, expiry, and allowed transformations are checked before any spend.",
      "Generate the header and feature stills, review claims and format fit, then deliver the approved pack."
    ],
    requiredInputs: [
      "Approved property photographs",
      "Verified listing facts (address, area, features)",
      "Creator-attested permission covering platform, territory, and expiry"
    ],
    preSpendChecks: [
      "Permission scope matches platform, territory, and transformations",
      "Claims limited to verified listing facts",
      "Identity-safe property motion stays planned, never dispatched"
    ],
    prefill: {
      title: "Hillside residence - listing launch",
      brief: "Twilight portal hero of the hillside residence with warm interior light, plus true-to-photo feature details of the kitchen stone and terrace view. No invented surroundings, no staged furniture.",
      platform: "instagram",
      suggestedTemplate: "Real Estate Launch Pack",
      suggestedFormats: ["16:9", "4:3"]
    }
  },
  {
    id: "creator-sneaker-launch",
    title: "Creator-approved sneaker launch",
    tagline: "A creator-led product walkthrough: consent first, reference-true social stills, then review.",
    formats: [
      { ratio: "9:16", placement: "Vertical social hero - full-product reveal" },
      { ratio: "1:1", placement: "Feed post - centered product square" },
      { ratio: "4:3", placement: "Standard post - detail and lifestyle support" }
    ],
    motionNote: "Short motion clip planned as a conceptual render from the approved stills.",
    workflow: [
      "The creator attests a consent link covering the shoe photo, platforms, and expiry - no campaign exists before this.",
      "Register the approved reference media under that creator; every still stays guided by it.",
      "Attach product claims from the brand rule - cushioning, materials, and colors actually verified.",
      "Review the social stills for likeness and claims, approve the pack, then deliver."
    ],
    requiredInputs: [
      "Creator-attested consent for the shoe photograph",
      "Approved reference media under the same creator",
      "Brand rule with verified product claims"
    ],
    preSpendChecks: [
      "Active permission from the appearing creator, within expiry",
      "Media ownership matches the permission creator",
      "Requested claims stay inside the approved brand rule"
    ],
    prefill: {
      title: "Velocity Runner - creator launch",
      brief: "Studio hero of the red Velocity Runner on a clean backdrop for vertical social, plus feed-square and standard-post variations. True to the reference photo: no colorway changes, no invented logos.",
      platform: "tiktok",
      suggestedTemplate: "Creator Campaign Pack",
      suggestedFormats: ["9:16", "1:1", "4:3"]
    }
  },
  {
    id: "skincare-launch",
    title: "Sustainable skincare launch",
    tagline: "A brand-rule-driven product walkthrough: verified claims in, marketing superlatives out.",
    formats: [
      { ratio: "1:1", placement: "Feed post - hero product square" },
      { ratio: "4:3", placement: "Standard post - texture and packaging detail" },
      { ratio: "16:9", placement: "Wide banner - campaign header with copy space" }
    ],
    workflow: [
      "Define brand rules first: approved claims such as fragrance-free and vegan, plus prohibited superlatives.",
      "Attach verified product facts - ingredients, packaging, and certifications with evidence notes.",
      "Generate the product stills against those rules; anything outside the approved claims is blocked before spend.",
      "Review, approve, and deliver. Public verification becomes available only after a genuine publication - never for a demo."
    ],
    requiredInputs: [
      "Brand rule with approved and prohibited claims",
      "Verified product facts with evidence notes",
      "Approved product photographs and an attested permission"
    ],
    preSpendChecks: [
      "Requested claims stay inside approved brand claims",
      "Prohibited superlatives are refused before spend",
      "Public verification stays unavailable until genuine publication"
    ],
    prefill: {
      title: "Botanica day cream - sustainable launch",
      brief: "Clean feed-square hero of the Botanica day cream jar with soft daylight, plus packaging-detail and wide-banner variations. Show the true jar and label; claim only fragrance-free, vegan, and recyclable packaging.",
      platform: "instagram",
      suggestedTemplate: "Product Launch Pack",
      suggestedFormats: ["1:1", "4:3", "16:9"]
    }
  }
];

export function getDemoCampaign(id: string): DemoCampaign | undefined {
  return DEMO_CAMPAIGNS.find((d) => d.id === id);
}

/** Brief prefill for a demo id, or null for unknown ids. Only allow-listed keys. */
export function demoPrefillFor(id: string): DemoBriefPrefill | null {
  const demo = getDemoCampaign(id);
  return demo ? { ...demo.prefill, suggestedFormats: [...demo.prefill.suggestedFormats] } : null;
}
