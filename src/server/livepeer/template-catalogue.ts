import type { QualityProfile, StageRole } from "../types";

/**
 * Template-driven production plans. A typed in-code catalogue (no database
 * migration): each template is a set of real stage recipes with explicit
 * DAG edges, role-routed capabilities, prompt scaffolds, quality checks,
 * and disclosure rules - never decorative cards.
 *
 * Only create_media-backed recipes execute today (image + motion + upscale).
 * Narration/music/subtitle recipes are fully specified (role, tool strategy,
 * prompt scaffold) but resolve as deferred: the builder lists them with an
 * honest reason instead of dispatching speculative paid calls.
 */

export type TemplateId =
  | "creator-campaign"
  | "product-launch"
  | "real-estate"
  | "hospitality"
  | "automotive";

export type PackSize = "quick" | "campaign" | "full" | "custom";

export type TemplateAssetType = "image" | "motion" | "narration" | "music" | "subtitle";

export type TemplateFormat = "9:16" | "4:5" | "1:1" | "16:9";

export const TEMPLATE_IDS: TemplateId[] = [
  "creator-campaign",
  "product-launch",
  "real-estate",
  "hospitality",
  "automotive"
];

export const PACK_SIZES: PackSize[] = ["quick", "campaign", "full", "custom"];

export const TEMPLATE_ASSET_TYPES: TemplateAssetType[] = ["image", "motion", "narration", "music", "subtitle"];

export const TEMPLATE_FORMATS: TemplateFormat[] = ["9:16", "4:5", "1:1", "16:9"];

/** Suggested pack output bands. Custom is bounded server-side (entitlements). */
export const PACK_SIZE_GUIDANCE: Record<Exclude<PackSize, "custom">, { min: number; max: number; blurb: string }> = {
  quick: { min: 3, max: 3, blurb: "Quick - 3 outputs" },
  campaign: { min: 6, max: 8, blurb: "Campaign - 6-8 outputs" },
  full: { min: 10, max: 16, blurb: "Full launch - 10-16 outputs" }
};

export interface TemplateSelection {
  templateId: TemplateId;
  packSize: PackSize;
  assetTypes: TemplateAssetType[];
  formats?: TemplateFormat[];
  /** Custom pack only: explicit recipe ids, bounded by entitlements. */
  stageIds?: string[];
  /** Requested motion clip length in seconds (validated 3-15, never clamped). */
  motionSeconds?: number;
  /**
   * Server-resolved clip length. Never trusted from the client - recomputed
   * on preview/apply/produce/dispatch. Stored so rows show what was decided.
   */
  resolvedMotionSeconds?: number;
  qualityProfile: QualityProfile;
  /** Optional run spend ceiling in USD, enforced at produce time. */
  maxSpendCapUsd?: number;
  /**
   * Optional expert model choice per deliverable role. Absent (or an empty
   * entry) means Automatic: existing profile → live discovery → default
   * resolution with fallback recording. A present entry pins that exact
   * capability for every matching selected stage and is never substituted.
   * Legacy selections omit this and behave exactly as before.
   */
  modelOverrides?: Partial<Record<ModelOverrideRole, string>>;
}

/**
 * Deliverable roles a user may pin a model for. Only the concept-image
 * family and image-to-video motion: never critic, preservation or
 * product-photo tooling, upscale, deferred audio, captions, narration, or
 * music.
 */
export type ModelOverrideRole = "conceptImage" | "imageToVideo";

export const MODEL_OVERRIDE_ROLES: ModelOverrideRole[] = ["conceptImage", "imageToVideo"];

/**
 * Stage roles each override key pins. The concept choice covers the concept
 * family: source-guided variations resolve from the concept pick so
 * siblings stay on one model per run (mirrors plan resolution).
 */
export const MODEL_OVERRIDE_STAGE_ROLES: Record<ModelOverrideRole, StageRole[]> = {
  conceptImage: ["conceptImage", "sourceGuidedImage"],
  imageToVideo: ["imageToVideo"]
};

/** Static user-safe refusal when a pinned model cannot be honored. */
export const MODEL_OVERRIDE_UNAVAILABLE =
  "Selected model is not currently available for this deliverable. Refresh the model list or choose Automatic.";

export type RecipeExecution = "create_media" | "deferred";

export interface TemplateStageRecipe {
  id: string;
  label: string;
  kind: "text-to-image" | "image-to-image" | "image-to-video" | "upscale";
  role: StageRole;
  format: TemplateFormat;
  inputSource: "approved-source" | "stage-output";
  /** Recipe ids (same template) whose outputs must be ready first. */
  dependsOn: string[];
  assetType: TemplateAssetType;
  optional: boolean;
  quickPick: boolean;
  execution: RecipeExecution;
  deferredReason?: string;
  defaultDurationSeconds?: number;
  promptKey: string;
}

export interface PromptContext {
  brand: string;
  productName: string;
  brief: string;
  constraints: string[];
}

export interface ToolStrategy {
  image: string;
  motion: string;
  audio: string;
  finishing: string;
  notes: string;
}

export interface ProductionTemplate {
  id: TemplateId;
  title: string;
  description: string;
  useCase: string;
  requiredInputs: string[];
  platforms: string[];
  recipes: TemplateStageRecipe[];
  promptScaffolds: Record<string, (ctx: PromptContext) => string>;
  qualityChecks: string[];
  disclosureRules: string[];
  compatibleProfiles: QualityProfile[];
  toolStrategy: ToolStrategy;
  /**
   * Canonical-anchor policy. Until the approve-keyframe action exists, every
   * recipe uses approved-source or explicit stage-output - a generated
   * output is never treated as an approval.
   */
  anchorPolicy: string;
}

function still(
  id: string,
  label: string,
  kind: "text-to-image" | "image-to-image",
  role: StageRole,
  format: TemplateFormat,
  opts: { optional?: boolean; quickPick?: boolean; promptKey: string }
): TemplateStageRecipe {
  return {
    id,
    label,
    kind,
    role,
    format,
    inputSource: "approved-source",
    dependsOn: [],
    assetType: "image",
    optional: opts.optional ?? false,
    quickPick: opts.quickPick ?? false,
    execution: "create_media",
    promptKey: opts.promptKey
  };
}

function motion(
  id: string,
  label: string,
  format: TemplateFormat,
  dependsOn: string[],
  opts: { optional?: boolean; quickPick?: boolean; duration?: number; promptKey: string }
): TemplateStageRecipe {
  return {
    id,
    label,
    kind: "image-to-video",
    role: "imageToVideo",
    format,
    inputSource: "stage-output",
    dependsOn,
    assetType: "motion",
    optional: opts.optional ?? false,
    quickPick: opts.quickPick ?? false,
    execution: "create_media",
    defaultDurationSeconds: opts.duration ?? 6,
    promptKey: opts.promptKey
  };
}

function upscaleMaster(id: string, label: string, dependsOn: string[]): TemplateStageRecipe {
  return {
    id,
    label,
    kind: "upscale",
    role: "upscale",
    format: "9:16",
    inputSource: "stage-output",
    dependsOn,
    assetType: "image",
    optional: true,
    quickPick: false,
    execution: "create_media",
    promptKey: "upscale"
  };
}

function deferredAudio(id: string, label: string, assetType: TemplateAssetType, reason: string): TemplateStageRecipe {
  const role: StageRole = assetType === "narration" ? "tts" : assetType === "music" ? "music" : "subtitle";
  return {
    id,
    label,
    kind: "text-to-image",
    role,
    format: "9:16",
    inputSource: "approved-source",
    dependsOn: [],
    assetType,
    optional: true,
    quickPick: false,
    execution: "deferred",
    deferredReason: reason,
    promptKey: "deferred-audio"
  };
}

const DEFERRED_AUDIO_REASON =
  "Audio/subtitle production is specified but not dispatched yet - no speculative paid calls. The recipe, role, and tool strategy are recorded and it is listed as planned.";

function guidedStills(ctx: PromptContext, what: string): string {
  return `${what} for ${ctx.brand} ${ctx.productName}, independently composed from the approved source and campaign brief (${ctx.brief}), guided by the approved source - never derived from another output. ${ctx.constraints.join(" ")}`;
}

const UPSCALE_PROMPT = (ctx: PromptContext): string =>
  `Fidelity upscale of the approved keyframe for ${ctx.brand} ${ctx.productName}: preserve composition, identity, and detail exactly; no reinterpretation. ${ctx.constraints.join(" ")}`;

const DEFERRED_AUDIO_PROMPT = (ctx: PromptContext): string =>
  `Planned audio/subtitle production for ${ctx.brand} ${ctx.productName} (not dispatched): brief context - ${ctx.brief}. ${ctx.constraints.join(" ")}`;

const TEMPLATES: ProductionTemplate[] = [
  {
    id: "creator-campaign",
    title: "Creator Campaign Pack",
    description: "Creator-led social pack anchored on approved creator media: hero, feed posts, banner, and a short motion cut.",
    useCase: "Agencies running a creator-fronted campaign across Reels, TikTok, and feed placements.",
    requiredInputs: ["approved creator media", "permitted platforms, territories, and transformations"],
    platforms: ["Reels / TikTok", "Instagram feed", "YouTube thumbnail"],
    recipes: [
      still("cc-hero-916", "Creator hero (9:16)", "text-to-image", "conceptImage", "9:16", { quickPick: true, promptKey: "hero" }),
      still("cc-feed-45", "4:5 feed post", "image-to-image", "sourceGuidedImage", "4:5", { quickPick: true, promptKey: "feed45" }),
      still("cc-feed-11", "1:1 feed post", "image-to-image", "sourceGuidedImage", "1:1", { quickPick: true, promptKey: "feed11" }),
      still("cc-banner-169", "16:9 banner / thumbnail", "image-to-image", "sourceGuidedImage", "16:9", { promptKey: "banner" }),
      still("cc-lifestyle-45", "Creator lifestyle (4:5)", "image-to-image", "sourceGuidedImage", "4:5", { promptKey: "lifestyle" }),
      motion("cc-motion-916", "Motion asset (9:16)", "9:16", ["cc-hero-916"], { duration: 6, promptKey: "motion" }),
      still("cc-detail-11", "Product detail (1:1)", "image-to-image", "sourceGuidedImage", "1:1", { optional: true, promptKey: "detail" }),
      still("cc-story-916", "Story variant (9:16)", "image-to-image", "sourceGuidedImage", "9:16", { optional: true, promptKey: "story" }),
      motion("cc-motion-reveal", "Motion reveal (9:16)", "9:16", ["cc-hero-916"], { optional: true, duration: 5, promptKey: "motion" }),
      upscaleMaster("cc-hero-master", "Hero master, hi-res (upscale)", ["cc-hero-916"]),
      deferredAudio("cc-motion-captioned", "Captioned motion version", "subtitle", DEFERRED_AUDIO_REASON)
    ],
    promptScaffolds: {
      hero: (ctx) => `Advertising hero keyframe for ${ctx.brand} ${ctx.productName}: ${ctx.brief}. Vertical 9:16 composition. Preserve creator identity, wardrobe, and the approved product exactly. ${ctx.constraints.join(" ")}`,
      feed45: (ctx) => guidedStills(ctx, "Square-portrait 4:5 social post"),
      feed11: (ctx) => guidedStills(ctx, "Square 1:1 social post with balanced centered composition"),
      banner: (ctx) => guidedStills(ctx, "Wide 16:9 banner/thumbnail with breathing room for headlines"),
      lifestyle: (ctx) => guidedStills(ctx, "Creator lifestyle 4:5 moment, natural setting, product clearly visible"),
      detail: (ctx) => guidedStills(ctx, "Close product detail 1:1, sharp focus, honest materials"),
      story: (ctx) => guidedStills(ctx, "Vertical 9:16 story variant with headroom for stickers and captions"),
      motion: (ctx) => `Smooth cinematic motion on the approved creator keyframe: gentle camera push-in, natural light. Keep the creator and product sharp and central; preserve identity throughout. ${ctx.constraints.join(" ")}`,
      upscale: UPSCALE_PROMPT,
      "deferred-audio": DEFERRED_AUDIO_PROMPT
    },
    qualityChecks: [
      "Creator identity and wardrobe match the approved source in every still.",
      "The approved product is present and recognizable wherever shown.",
      "Motion is derived only from the hero keyframe, never from a sibling variation."
    ],
    disclosureRules: ["Paid-partnership disclosure travels with every caption.", "Retouching beyond color and light must be disclosed."],
    compatibleProfiles: ["draft", "balanced", "premium"],
    toolStrategy: {
      image: "create_media generate (concept + source-guided image-to-image)",
      motion: "create_media animate from the hero keyframe",
      audio: "deferred - subtitle burn reserved, no dispatch yet",
      finishing: "deterministic (Prompt 4)",
      notes: "Approved creator source is the canonical anchor; no generated output substitutes for approval."
    },
    anchorPolicy: "Approved creator source media anchors all stills; motion anchors on the hero stage output."
  },
  {
    id: "product-launch",
    title: "Product Launch Pack",
    description: "Catalog-grade launch set: clean packshot, lifestyle, detail, social ads, banner, and an optional motion reveal.",
    useCase: "Brands launching a physical product across store, social, and video placements.",
    requiredInputs: ["clean product reference image", "approved claims and brand rules"],
    platforms: ["Instagram feed", "Stories / Reels", "YouTube / retail banner"],
    recipes: [
      still("pl-packshot-11", "Clean packshot (1:1)", "text-to-image", "productPackshot", "1:1", { quickPick: true, promptKey: "packshot" }),
      still("pl-lifestyle-45", "Lifestyle image (4:5)", "image-to-image", "sourceGuidedImage", "4:5", { quickPick: true, promptKey: "lifestyle" }),
      still("pl-story-916", "Story / reel keyframe (9:16)", "text-to-image", "conceptImage", "9:16", { quickPick: true, promptKey: "story" }),
      still("pl-detail-11", "Detail / feature image (1:1)", "image-to-image", "sourceGuidedImage", "1:1", { promptKey: "detail" }),
      still("pl-social-45", "Social ad (4:5)", "image-to-image", "sourceGuidedImage", "4:5", { promptKey: "social" }),
      still("pl-banner-169", "Launch banner (16:9)", "image-to-image", "sourceGuidedImage", "16:9", { promptKey: "banner" }),
      motion("pl-motion-reveal", "Motion reveal (9:16)", "9:16", ["pl-story-916"], { duration: 7, promptKey: "motion" }),
      upscaleMaster("pl-packshot-master", "Packshot master, hi-res (upscale)", ["pl-packshot-11"]),
      still("pl-lifestyle-169", "Lifestyle wide (16:9)", "image-to-image", "sourceGuidedImage", "16:9", { optional: true, promptKey: "lifestyle-wide" }),
      motion("pl-motion-alt", "Motion alt clip (9:16)", "9:16", ["pl-story-916"], { optional: true, duration: 5, promptKey: "motion" })
    ],
    promptScaffolds: {
      packshot: (ctx) => `Clean studio packshot of ${ctx.brand} ${ctx.productName} on a neutral background, 1:1: preserve shape, material, color, and recognizable marks exactly. Never invent logo text - leave marks clean for the deterministic finishing step. ${ctx.constraints.join(" ")}`,
      lifestyle: (ctx) => guidedStills(ctx, "Lifestyle 4:5 scene with the product in natural use"),
      story: (ctx) => `Story/reel keyframe for ${ctx.brand} ${ctx.productName}: ${ctx.brief}. Vertical 9:16, product heroically framed. ${ctx.constraints.join(" ")}`,
      detail: (ctx) => guidedStills(ctx, "Macro detail/feature 1:1 showing materials and craftsmanship honestly"),
      social: (ctx) => guidedStills(ctx, "Social ad 4:5 with clear product focus and space for headline copy"),
      banner: (ctx) => guidedStills(ctx, "Launch banner 16:9 with breathing room for headlines on both sides"),
      "lifestyle-wide": (ctx) => guidedStills(ctx, "Lifestyle wide 16:9 environmental scene"),
      motion: (ctx) => `Product reveal motion on the approved story keyframe: slow orbital drift, studio light sweep, product sharp and central throughout. ${ctx.constraints.join(" ")}`,
      upscale: UPSCALE_PROMPT,
      "deferred-audio": DEFERRED_AUDIO_PROMPT
    },
    qualityChecks: [
      "Shape, material, color, and recognizable marks match the reference in every still.",
      "No invented logo text or packaging copy - marks stay clean for finishing.",
      "Only approved claims appear in or around the creative."
    ],
    disclosureRules: ["Render vs photography must be labeled wherever a still is CGI.", "Retouching beyond color and light must be disclosed."],
    compatibleProfiles: ["draft", "balanced", "premium"],
    toolStrategy: {
      image: "create_media generate (product-photo tooling via role routing when available)",
      motion: "create_media animate from the story keyframe",
      audio: "none specified",
      finishing: "deterministic logo/copy overlay (Prompt 4) - never model-rendered text",
      notes: "place_subject wires in when its schema is validated against paid-call safety."
    },
    anchorPolicy: "Clean product reference anchors all stills; motion anchors on the story keyframe output."
  },
  {
    id: "real-estate",
    title: "Real Estate Launch Pack",
    description: "Listing pack from real property photography: cover, listing post, portal hero, detail cards, and a short property tour clip.",
    useCase: "Agents launching a listing across portals, social, and video tours.",
    requiredInputs: ["real property photographs", "verified property facts"],
    platforms: ["Instagram feed", "Portal listings", "Reels / TikTok"],
    recipes: [
      still("re-cover-916", "Social tour cover (9:16)", "image-to-image", "subjectPreservingImage", "9:16", { quickPick: true, promptKey: "cover" }),
      still("re-listing-11", "Listing post (1:1)", "image-to-image", "subjectPreservingImage", "1:1", { quickPick: true, promptKey: "listing" }),
      still("re-hero-169", "Portal hero (16:9)", "image-to-image", "subjectPreservingImage", "16:9", { quickPick: true, promptKey: "hero" }),
      still("re-detail-45", "Feature detail I (4:5)", "image-to-image", "subjectPreservingImage", "4:5", { promptKey: "detail" }),
      still("re-detail-11", "Feature detail II (1:1)", "image-to-image", "subjectPreservingImage", "1:1", { promptKey: "detail2" }),
      motion("re-tour-motion", "Property tour (9:16)", "9:16", ["re-hero-169"], { duration: 8, promptKey: "motion" }),
      still("re-detail-169", "Feature detail III (16:9)", "image-to-image", "subjectPreservingImage", "16:9", { optional: true, promptKey: "detail3" }),
      still("re-dusk-916", "Dusk-grade exterior (9:16, conceptual)", "image-to-image", "subjectPreservingImage", "9:16", { optional: true, promptKey: "dusk" }),
      upscaleMaster("re-cover-master", "Cover master, hi-res (upscale)", ["re-cover-916"]),
      motion("re-tour-alt", "Tour alt clip (9:16)", "9:16", ["re-hero-169"], { optional: true, duration: 5, promptKey: "motion" }),
      deferredAudio("re-narration", "Tour narration", "narration", DEFERRED_AUDIO_REASON),
      deferredAudio("re-music", "Tour music bed", "music", DEFERRED_AUDIO_REASON),
      deferredAudio("re-subtitles", "Tour subtitles", "subtitle", DEFERRED_AUDIO_REASON)
    ],
    promptScaffolds: {
      cover: (ctx) => `Listing cover from the approved property photograph for ${ctx.productName}: ${ctx.brief}. Vertical 9:16. Preserve the actual property - geometry, finishes, light - exactly; do not add rooms, views, or amenities. ${ctx.constraints.join(" ")}`,
      listing: (ctx) => `Square listing post from the approved property photograph for ${ctx.productName}, guided by the approved source: show only real, verified spaces and finishes. ${ctx.constraints.join(" ")}`,
      hero: (ctx) => `Portal hero from the approved property photograph for ${ctx.productName}: ${ctx.brief}. Wide 16:9, honest wide angle, no invented surroundings. ${ctx.constraints.join(" ")}`,
      detail: (ctx) => `Feature detail from the approved property photograph for ${ctx.productName}, 4:5: one verified feature, true materials. ${ctx.constraints.join(" ")}`,
      detail2: (ctx) => `Feature detail from the approved property photograph for ${ctx.productName}, 1:1: one verified feature, true materials. ${ctx.constraints.join(" ")}`,
      detail3: (ctx) => `Feature detail from the approved property photograph for ${ctx.productName}, 16:9: one verified feature, true materials. ${ctx.constraints.join(" ")}`,
      dusk: (ctx) => `Conceptual dusk lighting grade of the approved property photograph for ${ctx.productName}, 9:16: identical geometry and finishes, sky and light only. MUST be labeled conceptual/virtual in delivery. ${ctx.constraints.join(" ")}`,
      motion: (ctx) => `Slow property tour motion on the approved portal hero: gentle lateral glide, hold on verified features. Never invent rooms, views, or amenities. ${ctx.constraints.join(" ")}`,
      upscale: UPSCALE_PROMPT,
      "deferred-audio": DEFERRED_AUDIO_PROMPT
    },
    qualityChecks: [
      "Every still matches the real photographs - no invented views, rooms, amenities, locations, or finishes.",
      "Captions and overlays use only verified property facts.",
      "Conceptual grades are labeled as virtual staging / conceptual imagery."
    ],
    disclosureRules: ["Virtual staging and conceptual grades labeled on the asset.", "Only verified facts in captions and overlays."],
    compatibleProfiles: ["draft", "balanced", "premium"],
    toolStrategy: {
      image: "create_media image-to-image (subject-preserving role) from real photographs",
      motion: "create_media animate from the portal hero",
      audio: "deferred - narration (tts), music bed, subtitles reserved",
      finishing: "deterministic fact overlays (Prompt 4)",
      notes: "Photographs are evidence, not inspiration - deviation is a defect."
    },
    anchorPolicy: "Real property photographs anchor all stills; motion anchors on the portal hero output."
  },
  {
    id: "hospitality",
    title: "Hospitality / Destination Pack",
    description: "Property story set: room hero, experience, dining, reel, feed post, and booking banner from verified media.",
    useCase: "Hotels and destinations filling rooms and tables across social and booking placements.",
    requiredInputs: ["property/destination media", "verified facilities and location facts"],
    platforms: ["Instagram feed", "Reels", "Booking banners"],
    recipes: [
      still("ho-hero-916", "Room / venue hero (9:16)", "text-to-image", "conceptImage", "9:16", { quickPick: true, promptKey: "hero" }),
      still("ho-feed-11", "Feed post (1:1)", "image-to-image", "sourceGuidedImage", "1:1", { quickPick: true, promptKey: "feed" }),
      motion("ho-reel-916", "Reel (9:16)", "9:16", ["ho-hero-916"], { quickPick: true, duration: 6, promptKey: "motion" }),
      still("ho-experience-45", "Experience / lifestyle (4:5)", "image-to-image", "sourceGuidedImage", "4:5", { promptKey: "experience" }),
      still("ho-dining-11", "Food / amenity (1:1)", "image-to-image", "sourceGuidedImage", "1:1", { promptKey: "dining" }),
      still("ho-banner-169", "Booking banner (16:9)", "image-to-image", "sourceGuidedImage", "16:9", { promptKey: "banner" }),
      still("ho-venue-169", "Venue wide (16:9)", "image-to-image", "sourceGuidedImage", "16:9", { optional: true, promptKey: "venue" }),
      still("ho-detail-45", "Detail (4:5)", "image-to-image", "sourceGuidedImage", "4:5", { optional: true, promptKey: "detail" }),
      motion("ho-reel-alt", "Reel alt clip (9:16)", "9:16", ["ho-hero-916"], { optional: true, duration: 6, promptKey: "motion" }),
      upscaleMaster("ho-hero-master", "Hero master, hi-res (upscale)", ["ho-hero-916"])
    ],
    promptScaffolds: {
      hero: (ctx) => `Room/venue hero for ${ctx.brand} ${ctx.productName}: ${ctx.brief}. Vertical 9:16. Show only real, verified spaces and facilities; maintain property identity. ${ctx.constraints.join(" ")}`,
      feed: (ctx) => guidedStills(ctx, "Square 1:1 feed post of a verified property moment"),
      experience: (ctx) => guidedStills(ctx, "Experience/lifestyle 4:5 scene with verified amenities only"),
      dining: (ctx) => guidedStills(ctx, "Food/amenity 1:1, true presentation, no invented dishes"),
      banner: (ctx) => guidedStills(ctx, "Booking banner 16:9 with space for dates and rates copy"),
      venue: (ctx) => guidedStills(ctx, "Venue wide 16:9 establishing shot of verified spaces"),
      detail: (ctx) => guidedStills(ctx, "Detail 4:5 of a verified facility or finish"),
      motion: (ctx) => `Destination reel motion on the approved hero: slow push through the verified space, hold on real amenities. Never invent facilities, landmarks, or availability. ${ctx.constraints.join(" ")}`,
      upscale: UPSCALE_PROMPT,
      "deferred-audio": DEFERRED_AUDIO_PROMPT
    },
    qualityChecks: [
      "No invented facilities, landmarks, or availability in any asset.",
      "Property identity is consistent across the whole set.",
      "Food and amenity shots match verified offerings."
    ],
    disclosureRules: ["Seasonal imagery labeled with the season.", "Only verified facts in captions and overlays."],
    compatibleProfiles: ["draft", "balanced", "premium"],
    toolStrategy: {
      image: "create_media generate (concept hero + source-guided set)",
      motion: "create_media animate from the hero",
      audio: "none specified",
      finishing: "deterministic rate/date overlays (Prompt 4)",
      notes: "Verified media anchors the set; the hero is composed, the rest guided."
    },
    anchorPolicy: "Verified property media anchors guided stills; motion anchors on the hero output."
  },
  {
    id: "automotive",
    title: "Automotive Launch Pack",
    description: "Launch set from an approved vehicle reference: studio hero, road scene, details, social clips, and a motion reveal.",
    useCase: "OEM and dealer launches across social, video, and retail placements.",
    requiredInputs: ["approved vehicle reference", "verified model/trim/specification facts"],
    platforms: ["Instagram feed", "Reels", "Launch / retail"],
    recipes: [
      still("au-studio-916", "Studio hero (9:16)", "text-to-image", "conceptImage", "9:16", { quickPick: true, promptKey: "hero" }),
      still("au-social-45", "Social asset (4:5)", "image-to-image", "sourceGuidedImage", "4:5", { quickPick: true, promptKey: "social" }),
      still("au-road-169", "Road / lifestyle scene (16:9)", "image-to-image", "sourceGuidedImage", "16:9", { quickPick: true, promptKey: "road" }),
      still("au-detail-11", "Feature detail (1:1)", "image-to-image", "sourceGuidedImage", "1:1", { promptKey: "detail" }),
      still("au-launch-169", "Launch asset (16:9)", "image-to-image", "sourceGuidedImage", "16:9", { promptKey: "launch" }),
      motion("au-motion-reveal", "Motion reveal (9:16)", "9:16", ["au-studio-916"], { duration: 7, promptKey: "motion" }),
      still("au-night-916", "Night grade (9:16)", "image-to-image", "sourceGuidedImage", "9:16", { optional: true, promptKey: "night" }),
      still("au-interior-45", "Interior (4:5)", "image-to-image", "sourceGuidedImage", "4:5", { optional: true, promptKey: "interior" }),
      upscaleMaster("au-studio-master", "Studio master, hi-res (upscale)", ["au-studio-916"]),
      motion("au-motion-alt", "Motion alt clip (9:16)", "9:16", ["au-studio-916"], { optional: true, duration: 5, promptKey: "motion" })
    ],
    promptScaffolds: {
      hero: (ctx) => `Studio hero of ${ctx.brand} ${ctx.productName}: ${ctx.brief}. Vertical 9:16. Preserve body, trim, paint, and badges exactly against the approved reference. ${ctx.constraints.join(" ")}`,
      social: (ctx) => guidedStills(ctx, "Vertical social 4:5 with the vehicle faithfully reproduced"),
      road: (ctx) => guidedStills(ctx, "Road/lifestyle 16:9 scene, vehicle true to reference, plausible legal driving context"),
      detail: (ctx) => guidedStills(ctx, "Feature detail 1:1 - one verified trim or equipment feature, true materials"),
      launch: (ctx) => guidedStills(ctx, "Launch asset 16:9 with space for model and offer copy"),
      night: (ctx) => guidedStills(ctx, "Night lighting grade 9:16, identical body and trim, light only"),
      interior: (ctx) => guidedStills(ctx, "Interior 4:5 matching the verified trim specification"),
      motion: (ctx) => `Launch reveal motion on the approved studio hero: slow orbital drift with a light sweep, body lines and badges preserved throughout. Never imply performance or safety beyond verified facts. ${ctx.constraints.join(" ")}`,
      upscale: UPSCALE_PROMPT,
      "deferred-audio": DEFERRED_AUDIO_PROMPT
    },
    qualityChecks: [
      "Body, trim, paint, and badges match the approved reference in every still.",
      "No fabricated performance, safety, or efficiency claims in or around the creative.",
      "Driving contexts are plausible and lawful."
    ],
    disclosureRules: ["Pre-production or CGI vehicles labeled as such.", "Only verified specs in captions and overlays."],
    compatibleProfiles: ["draft", "balanced", "premium"],
    toolStrategy: {
      image: "create_media generate (concept hero + source-guided set)",
      motion: "create_media animate from the studio hero",
      audio: "none specified",
      finishing: "deterministic spec overlays (Prompt 4)",
      notes: "The reference is the single source of vehicle truth."
    },
    anchorPolicy: "Approved vehicle reference anchors all stills; motion anchors on the studio hero output."
  }
];

export function listTemplates(): ProductionTemplate[] {
  return TEMPLATES;
}

export function getTemplate(id: string): ProductionTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

export function findRecipe(template: ProductionTemplate, recipeId: string): TemplateStageRecipe | undefined {
  return template.recipes.find((r) => r.id === recipeId);
}

/** Recipe lookup across all templates (stage ids are globally unique). */
export function findRecipeAnywhere(recipeId: string): { template: ProductionTemplate; recipe: TemplateStageRecipe } | undefined {
  for (const template of TEMPLATES) {
    const recipe = findRecipe(template, recipeId);
    if (recipe) return { template, recipe };
  }
  return undefined;
}
