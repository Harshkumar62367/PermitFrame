"use client";

import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { DURATION_CHIPS, type TemplateMeta } from "./template-panel.types";
import type { ModelChoice } from "@/server/livepeer/catalogue";
import { MODEL_AUTOMATIC } from "./template-selection";

/** Value shown for a saved pin that is no longer selectable - never submitted. */
const STALE_MODEL_VALUE = "__previously-selected-unavailable__";

export interface ModelChoices {
  conceptImage: ModelChoice[];
  imageToVideo: ModelChoice[];
}

interface TemplateCustomizationProps {
  campaignId: string;
  template: TemplateMeta;
  customizeOpen: boolean;
  onToggleCustomize: () => void;
  customizeSummary: string;
  motionOn: boolean;
  onToggleMotion: () => void;
  formats: string[];
  onToggleFormat: (format: string) => void;
  motionSeconds: number | null;
  onMotionSeconds: (seconds: number | null) => void;
  advancedOpen: boolean;
  onToggleAdvanced: () => void;
  durationError: string | null;
  /** Exact notice for a persisted legacy length (e.g. 40s) - blocks apply until corrected. */
  legacyClipMessage: string | null;
  durationUnverified: boolean;
  profile: string;
  onProfile: (profile: string) => void;
  cap: string;
  onCap: (cap: string) => void;
  showDetails: boolean;
  onToggleDetails: () => void;
  imageModel: string;
  motionModel: string;
  onImageModel: (model: string) => void;
  onMotionModel: (model: string) => void;
  modelChoices: ModelChoices | null;
  modelsLoading: boolean;
  modelsError: string | null;
  onRefreshModels: () => void;
  hasImageRole: boolean;
  hasMotionRole: boolean;
  imageModelStale: boolean;
  motionModelStale: boolean;
  modelsOpen: boolean;
  onToggleModels: () => void;
}

/** Per-role expert model selector. Values and callback only - no state, no API. */
function ModelRoleSelect({
  id,
  label,
  value,
  stale,
  choices,
  onChange
}: {
  id: string;
  label: string;
  value: string;
  stale: boolean;
  choices: ModelChoice[];
  onChange: (model: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      <select
        id={id}
        value={stale ? STALE_MODEL_VALUE : value}
        onChange={(e) => {
          if (e.target.value !== STALE_MODEL_VALUE) onChange(e.target.value);
        }}
        aria-label={`${label} choice`}
        className="mt-0.5 w-full rounded-lg border border-border bg-card px-2.5 py-1.5 text-[12.5px] focus:border-emerald-500/50 focus:outline-none"
      >
        <option value={MODEL_AUTOMATIC}>Automatic (recommended)</option>
        {choices.map((c) => (
          <option key={c.name} value={c.name} title={c.description || undefined}>
            {c.name}
          </option>
        ))}
        {stale && <option value={STALE_MODEL_VALUE} disabled>Previously selected — unavailable</option>}
      </select>
      {stale && (
        <span className="mt-0.5 block break-words text-[11px] text-amber-700 dark:text-amber-300">
          &ldquo;{value}&rdquo; is no longer selectable.
        </span>
      )}
    </label>
  );
}
/** Optional pack customization disclosure. Values and callbacks only - no state, no API. */
export function TemplateCustomization({
  campaignId,
  template,
  customizeOpen,
  onToggleCustomize,
  customizeSummary,
  motionOn,
  onToggleMotion,
  formats,
  onToggleFormat,
  motionSeconds,
  onMotionSeconds,
  advancedOpen,
  onToggleAdvanced,
  durationError,
  legacyClipMessage,
  durationUnverified,
  profile,
  onProfile,
  cap,
  onCap,
  showDetails,
  onToggleDetails,
  imageModel,
  motionModel,
  onImageModel,
  onMotionModel,
  modelChoices,
  modelsLoading,
  modelsError,
  onRefreshModels,
  hasImageRole,
  hasMotionRole,
  imageModelStale,
  motionModelStale,
  modelsOpen,
  onToggleModels
}: TemplateCustomizationProps) {
  return (
    <div className="rounded-xl border border-border">
      <button
        type="button"
        onClick={onToggleCustomize}
        aria-expanded={customizeOpen}
        className="flex w-full items-center justify-between gap-2 px-3.5 py-2.5 text-left"
      >
        <span className="text-[13px] font-semibold">
          Customize this pack <span className="font-normal text-muted-foreground">(optional)</span>
        </span>
        <span className="flex min-w-0 items-center gap-2">
          {!customizeOpen && (
            <span className="hidden truncate text-[11.5px] text-muted-foreground sm:inline">{customizeSummary}</span>
          )}
          <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition", customizeOpen && "rotate-180")} aria-hidden />
        </span>
      </button>
      {customizeOpen && (
        <div className="space-y-4 border-t border-border px-4 py-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-[12px] font-medium text-muted-foreground">Media</p>
              <p className="mt-1.5 text-[12.5px]">Images <span className="text-muted-foreground">· always included</span></p>
              <button
                type="button"
                role="checkbox"
                aria-checked={motionOn}
                onClick={onToggleMotion}
                className={cn(
                  "mt-1.5 flex items-center gap-2 rounded-full px-3 py-1.5 text-[12px] font-medium ring-1 transition",
                  motionOn
                    ? "bg-emerald-600/10 text-emerald-800 ring-emerald-600/40 dark:text-emerald-200"
                    : "bg-card text-muted-foreground ring-border hover:ring-emerald-600/40"
                )}
              >
                <span aria-hidden className={cn(
                  "grid h-4 w-4 place-items-center rounded ring-1",
                  motionOn ? "bg-emerald-600 text-white ring-emerald-600 dark:bg-emerald-500 dark:text-emerald-950" : "ring-border"
                )}>
                  {motionOn && <Check className="h-3 w-3" aria-hidden />}
                </span>
                Include a short motion clip
              </button>
              <div className="mt-3 rounded-lg bg-muted/60 p-3 ring-1 ring-border">
                <p className="text-[11.5px] font-medium">Short-clip finishing</p>
                <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">
                  This pack generates images and an optional 3–15 second motion clip. Narration and burned captions
                  are available after a Campaign Film reel is delivered. Music and soundtrack mixing are not available
                  yet.
                </p>
              </div>
            </div>
            <div>
              <p className="text-[12px] font-medium text-muted-foreground">Formats</p>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {["9:16", "4:5", "1:1", "16:9"].map((f) => {
                  const on = formats.includes(f);
                  return (
                    <button
                      key={f}
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      aria-label={`Format ${f}`}
                      onClick={() => {
                        onToggleFormat(f);
                      }}
                      className={cn(
                        "rounded-full px-3 py-1.5 font-mono text-[12px] ring-1 transition",
                        on
                          ? "bg-emerald-600/10 text-emerald-800 ring-emerald-600/40 dark:text-emerald-200"
                          : "bg-card text-muted-foreground ring-border hover:ring-emerald-600/40"
                      )}
                    >
                      {f}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {motionOn && (
            <div>
              <p id={`motion-secs-label-${campaignId}`} className="text-[12px] font-medium text-muted-foreground">
                Short video
              </p>
              <p className="mt-0.5 text-[11.5px] text-muted-foreground">
                Each motion deliverable is one 3-15 second clip.
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1.5" role="radiogroup" aria-labelledby={`motion-secs-label-${campaignId}`}>
                {DURATION_CHIPS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    role="radio"
                    aria-checked={motionSeconds === s}
                    onClick={() => {
                      onMotionSeconds(s);
                    }}
                    className={cn(
                      "rounded-lg px-2.5 py-1.5 font-mono text-[12px] ring-1 transition",
                      motionSeconds === s
                        ? "bg-emerald-600 text-white ring-emerald-600 dark:bg-emerald-500 dark:text-emerald-950"
                        : "bg-card text-muted-foreground ring-border hover:ring-emerald-600/40"
                    )}
                  >
                    {s}s
                  </button>
                ))}
                {motionSeconds !== null && !DURATION_CHIPS.includes(motionSeconds) && !legacyClipMessage && (
                  <span className="rounded-lg bg-sky-100 px-2.5 py-1.5 font-mono text-[12px] text-sky-800 ring-1 ring-sky-300 dark:bg-sky-950 dark:text-sky-200 dark:ring-sky-800" title="Kept from the existing plan - pick a chip to change it">
                    {motionSeconds}s current plan
                  </span>
                )}
              </div>
              {legacyClipMessage && (
                <p role="alert" className="mt-1.5 break-words text-[12.5px] text-amber-700 dark:text-amber-300">
                  {legacyClipMessage}
                </p>
              )}
              <button
                type="button"
                onClick={onToggleAdvanced}
                aria-expanded={advancedOpen}
                className="mt-1.5 inline-flex items-center gap-1 text-[11.5px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                <ChevronDown className={cn("h-3 w-3 transition", advancedOpen && "rotate-180")} aria-hidden />
                Advanced duration
              </button>
              {advancedOpen && (
                <div className="mt-1.5">
                  <label htmlFor={`motion-secs-${campaignId}`} className="sr-only">Clip length in seconds, 3 to 15</label>
                  <input
                    id={`motion-secs-${campaignId}`}
                    type="number"
                    min={3}
                    max={15}
                    step={1}
                    value={motionSeconds ?? ""}
                    placeholder="3-15"
                    onChange={(e) => {
                      const raw = e.target.value;
                      if (raw.trim() === "") {
                        onMotionSeconds(null);
                      } else {
                        const n = Number(raw);
                        onMotionSeconds(Number.isFinite(n) ? n : null);
                      }
                    }}
                    aria-invalid={durationError !== null}
                    aria-describedby={`motion-secs-hint-${campaignId}`}
                    className="w-full max-w-40 rounded-lg border border-border bg-card px-3 py-1.5 font-mono text-[13px] focus:border-emerald-500/50 focus:outline-none"
                  />
                <p id={`motion-secs-hint-${campaignId}`} className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  For a longer ad, create several short approved scenes and assemble them in your editor.
                </p>
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  In-product scene sequencing and final video assembly are planned next.
                </p>
                  {durationError && (
                    <p role="alert" className="mt-1 break-words text-[12px] text-rose-600 dark:text-rose-300">
                      {durationError}
                    </p>
                  )}
                </div>
              )}
              {durationUnverified && (
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  Model duration limits are unverified for this pack - PermitFrame requests the lengths above; provider validation still applies.
                </p>
              )}
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-[12px] font-medium text-muted-foreground">Quality profile</p>
              <div className="mt-1.5 flex gap-1.5" role="radiogroup" aria-label="Quality profile">
                {["draft", "balanced", "premium"].map((p) => (
                  <button
                    key={p}
                    type="button"
                    role="radio"
                    aria-checked={profile === p}
                    onClick={() => {
                      onProfile(p);
                    }}
                    className={cn(
                      "flex-1 rounded-lg px-2 py-1.5 text-[12px] font-medium capitalize ring-1 transition",
                      profile === p
                        ? "bg-emerald-600 text-white ring-emerald-600 dark:bg-emerald-500 dark:text-emerald-950"
                        : "bg-card text-muted-foreground ring-border hover:ring-emerald-600/40"
                    )}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label htmlFor={`spend-cap-${campaignId}`} className="text-[12px] font-medium text-muted-foreground">
                Max spend cap (USD, optional)
              </label>
              <input
                id={`spend-cap-${campaignId}`}
                type="number"
                min={0.1}
                step={0.5}
                value={cap}
                placeholder="No cap"
                onChange={(e) => {
                  onCap(e.target.value);
                }}
                className="mt-1.5 w-full rounded-lg border border-border bg-card px-3 py-1.5 text-[13px] focus:border-emerald-500/50 focus:outline-none"
              />
            </div>
          </div>

          <div>
            <button
              type="button"
              onClick={onToggleModels}
              aria-expanded={modelsOpen}
              className="inline-flex items-center gap-1 text-[12px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              <ChevronDown className={cn("h-3.5 w-3.5 transition", modelsOpen && "rotate-180")} aria-hidden />
              Model choice (advanced)
              {!modelsOpen && (
                <span className="font-normal">
                  {imageModel !== MODEL_AUTOMATIC || motionModel !== MODEL_AUTOMATIC ? " · Custom" : " · Automatic"}
                </span>
              )}
            </button>
            {modelsOpen && (
              <div className="mt-2 rounded-xl border border-border p-3">
                <p className="text-[11.5px] leading-relaxed text-muted-foreground">
                  Automatic uses the selected quality profile and Livepeer&apos;s available rendering path. A manual
                  choice pins that model for this deliverable and may become unavailable.
                </p>
                {modelsLoading && !modelChoices && (
                  <p className="mt-2 text-[12px] text-muted-foreground">Loading model choices…</p>
                )}
                {modelsError && !modelChoices && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <p className="text-[12px] text-muted-foreground">{modelsError}</p>
                    <button
                      type="button"
                      onClick={onRefreshModels}
                      className="rounded-full px-2.5 py-1 text-[11.5px] ring-1 ring-border transition hover:ring-emerald-600/40"
                    >
                      Refresh
                    </button>
                  </div>
                )}
                {modelChoices && (
                  <div className="mt-2 grid gap-3 sm:grid-cols-2">
                    {hasImageRole && (
                      <ModelRoleSelect
                        id={`image-model-${campaignId}`}
                        label="Image model"
                        value={imageModel}
                        stale={imageModelStale}
                        choices={modelChoices.conceptImage}
                        onChange={onImageModel}
                      />
                    )}
                    {hasMotionRole && (
                      <ModelRoleSelect
                        id={`motion-model-${campaignId}`}
                        label="Motion model"
                        value={motionModel}
                        stale={motionModelStale}
                        choices={modelChoices.imageToVideo}
                        onChange={onMotionModel}
                      />
                    )}
                    {!hasImageRole && !hasMotionRole && (
                      <p className="text-[12px] text-muted-foreground">
                        No image or motion deliverable is selected in this pack.
                      </p>
                    )}
                  </div>
                )}
                <div className="mt-2">
                  <button
                    type="button"
                    onClick={onRefreshModels}
                    disabled={modelsLoading}
                    aria-busy={modelsLoading}
                    className="rounded-full px-2.5 py-1 text-[11.5px] ring-1 ring-border transition hover:ring-emerald-600/40 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {modelsLoading ? "Refreshing…" : "Refresh model list"}
                  </button>
                </div>
                {(imageModelStale || motionModelStale) && (
                  <p role="alert" className="mt-1.5 break-words text-[12px] text-amber-700 dark:text-amber-300">
                    A previously selected model is unavailable. Choose Automatic or an available model to apply.
                  </p>
                )}
              </div>
            )}
          </div>

          <div>
            <button
              type="button"
              onClick={onToggleDetails}
              aria-expanded={showDetails}
              className="inline-flex items-center gap-1 text-[12px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              <ChevronDown className={cn("h-3.5 w-3.5 transition", showDetails && "rotate-180")} aria-hidden />
              Quality checks, disclosures & tool strategy
            </button>
            {showDetails && (
              <div className="mt-2 grid gap-3 text-[12.5px] leading-relaxed lg:grid-cols-3">
                <div className="rounded-xl border border-border p-3">
                  <p className="font-medium">Quality checks</p>
                  <ul className="mt-1.5 list-disc space-y-1 pl-4 text-muted-foreground">
                    {template.qualityChecks.map((q, i) => <li key={i}>{q}</li>)}
                  </ul>
                </div>
                <div className="rounded-xl border border-border p-3">
                  <p className="font-medium">Disclosure rules</p>
                  <ul className="mt-1.5 list-disc space-y-1 pl-4 text-muted-foreground">
                    {template.disclosureRules.map((q, i) => <li key={i}>{q}</li>)}
                  </ul>
                </div>
                <div className="rounded-xl border border-border p-3">
                  <p className="font-medium">Tool strategy</p>
                  <dl className="mt-1.5 space-y-1 text-muted-foreground">
                    <div><dt className="inline font-medium text-foreground">Image: </dt><dd className="inline">{template.toolStrategy.image}</dd></div>
                    <div><dt className="inline font-medium text-foreground">Motion: </dt><dd className="inline">{template.toolStrategy.motion}</dd></div>
                    <div><dt className="inline font-medium text-foreground">Audio: </dt><dd className="inline">{template.toolStrategy.audio}</dd></div>
                    <div><dt className="inline font-medium text-foreground">Finishing: </dt><dd className="inline">{template.toolStrategy.finishing}</dd></div>
                  </dl>
                  <p className="mt-2 text-[11.5px]">Anchor: {template.anchorPolicy}</p>
                  <p className="mt-1 text-[11.5px]">Requires: {template.requiredInputs.join("; ")}</p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
