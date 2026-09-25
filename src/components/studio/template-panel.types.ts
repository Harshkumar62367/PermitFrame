/** View-model contracts and display-only constants for the production pack UI. */
export interface TemplateRecipeMeta {
  id: string;
  label: string;
  kind: string;
  role: string;
  format: string;
  assetType: string;
  optional: boolean;
  quickPick: boolean;
  execution: string;
}

export interface TemplateMeta {
  id: string;
  title: string;
  description: string;
  useCase: string;
  requiredInputs: string[];
  platforms: string[];
  recipes: TemplateRecipeMeta[];
  qualityChecks: string[];
  disclosureRules: string[];
  compatibleProfiles: string[];
  toolStrategy: { image: string; motion: string; audio: string; finishing: string; notes: string };
  anchorPolicy: string;
}

export interface PreviewStage {
  id: string;
  label: string;
  kind: string;
  role: string;
  format: string;
  capability: string;
  /** Exact user-pinned model for this stage, or null for Automatic resolution. */
  requestedCapability: string | null;
  durationSeconds: number | null;
  requestedDurationSeconds: number | null;
  durationAdjusted: boolean;
  durationNote: string | null;
  dependsOn: string[];
  inputSource: string;
  requiredFor: string[];
}

export interface TemplatePreview {
  templateId: string;
  packSize: string;
  stages: PreviewStage[];
  deferred: { id: string; label: string; reason: string }[];
  outputCount: number;
  executableCount: number;
  estimateUsd: number | null;
  estimateExact: boolean;
  estimateMinutes: number;
  durationUnverified: boolean;
  qualityChecks: string[];
  disclosureRules: string[];
}

export const RECIPE_LINES: Record<string, string> = {
  "creator-campaign": "Social launch assets from approved creator media",
  "product-launch": "Product imagery, ads, and a short reveal",
  "real-estate": "Listings, portal imagery, and a property tour",
  hospitality: "Booking and experience-led assets",
  automotive: "Vehicle launch and retail campaign assets"
};

export const RECIPE_OUTCOMES: Record<string, string> = {
  "creator-campaign": "Social posts, banner, and one short clip.",
  "product-launch": "Packshot, lifestyle set, and ads. Motion is planned but not dispatched.",
  "real-estate": "Listing cover, portal hero, and detail cards. Motion is planned but not dispatched.",
  hospitality: "Room hero, experience shots, reel, and booking banner.",
  automotive: "Studio hero, road scenes, details, and a motion reveal."
};

export const SCOPES = [
  { id: "quick", title: "Quick", blurb: "3 essentials" },
  { id: "campaign", title: "Campaign", blurb: "Recommended · 5-8 assets", recommended: true },
  { id: "full", title: "Full launch", blurb: "8-16 assets" },
  { id: "custom", title: "Custom", blurb: "Choose deliverables" }
] as const;

export const SCOPE_TITLES: Record<string, string> = {
  quick: "Quick",
  campaign: "Campaign",
  full: "Full launch",
  custom: "Custom"
};

export const FORMAT_LABELS: Record<string, string> = {
  "9:16": "9:16 social",
  "4:3": "4:3 standard",
  "1:1": "1:1 feed",
  "16:9": "16:9 banner"
};

export const DURATION_CHIPS = [3, 5, 8, 10, 15];
export const ALL_FORMATS = ["9:16", "4:3", "1:1", "16:9"];
