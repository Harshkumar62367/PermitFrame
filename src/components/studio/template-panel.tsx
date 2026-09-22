"use client";

import { cn } from "@/lib/utils";
import type { Campaign } from "@/server/types";
import { useTemplateSelection } from "./use-template-selection";
import type { FilmPlanViewModel } from "./use-film-plan";
import { FilmPanel } from "./film-panel";
import { TemplateRecipeSelector } from "./template-recipe-selector";
import { TemplateScopeSelector } from "./template-scope-selector";
import { TemplateCustomization } from "./template-customization";
import { TemplatePackReview } from "./template-pack-review";

interface TemplatePanelProps {
  campaign: Campaign;
  allowed: boolean;
  /** Film planning state, owned by the studio so sibling panels can react to the selected mode. */
  film: FilmPlanViewModel;
  onChanged: () => Promise<void>;
}

/**
 * Campaign pack configurator: recipe → scope → outcome → customize if
 * needed → apply → generate in Creative Plan below. Compact selectors and
 * one review panel; no card walls. Renders only inside the rights-approved
 * studio - blocked campaigns never reach it, and the server re-checks the
 * verdict on apply. Backend contracts (ids, payloads, routes) unchanged.
 *
 * Composition only: useTemplateSelection owns all draft selection and API
 * lifecycle state; the children below receive values and callbacks.
 *
 * Production mode: "Short clip" keeps the exact short-clip flow above
 * (one 3-15 second motion deliverable). "Campaign film" swaps in the film
 * planner (several short scenes for a later reel) - the 3-15 second
 * picker appears only in Short clip mode.
 */
export function TemplatePanel({ campaign, allowed, film, onChanged }: TemplatePanelProps) {
  const vm = useTemplateSelection({ campaign, allowed, onChanged });

  return (
    <section aria-label="Production template" className="rounded-2xl border border-border bg-card p-4 sm:p-5">
      <h3 className="text-[15px] font-semibold tracking-tight">Build your campaign pack</h3>

      <div className="mt-3 rounded-xl border border-border p-3">
        <p className="text-[12px] font-medium text-muted-foreground">Production mode</p>
        <div className="mt-1.5 grid gap-1.5 sm:grid-cols-2" role="radiogroup" aria-label="Production mode">
          {(
            [
              { id: "short_clip", title: "Short clip", blurb: "One 3–15 second motion deliverable." },
              { id: "campaign_film", title: "Campaign film", blurb: "Several 3–15 second scenes, assembled later into one longer reel." }
            ] as const
          ).map((m) => (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={film.mode === m.id}
              onClick={() => film.setMode(m.id)}
              className={cn(
                "rounded-lg px-3 py-2 text-left ring-1 transition",
                film.mode === m.id
                  ? "bg-emerald-600/10 ring-emerald-600/40"
                  : "bg-card ring-border hover:ring-emerald-600/40"
              )}
            >
              <span className="block text-[13px] font-semibold">{m.title}</span>
              <span className="mt-0.5 block text-[11.5px] leading-snug text-muted-foreground">{m.blurb}</span>
            </button>
          ))}
        </div>
      </div>

      {film.mode === "campaign_film" ? (
        <div className="mt-4">
          <FilmPanel vm={film} allowed={allowed} campaignId={campaign.id} campaign={campaign} onChanged={onChanged} />
        </div>
      ) : (
        <>
          {!vm.templates && <p className="mt-3 text-[12.5px] text-muted-foreground">Loading recipes…</p>}
          {vm.notice && <p role="status" className="mt-3 break-words text-[12.5px] text-amber-700 dark:text-amber-300">{vm.notice}</p>}

          {vm.templates && vm.template && (
            <div className="mt-3 space-y-4">
              <TemplateRecipeSelector
                templates={vm.templates}
                template={vm.template}
                templateId={vm.templateId}
                comboOpen={vm.comboOpen}
                onToggleCombo={() => vm.setComboOpen((v) => !v)}
                onCloseCombo={() => vm.setComboOpen(false)}
                onSwitch={vm.switchTemplate}
              />

              <TemplateScopeSelector
                packSize={vm.packSize}
                onPackSize={vm.setPackSize}
                stageIds={vm.stageIds}
                onToggleStage={vm.toggleStage}
                onUseRecommended={vm.useRecommendedStages}
                onClearStages={() => vm.setStageIds([])}
                recipes={vm.template.recipes}
              />

              <TemplateCustomization
                campaignId={campaign.id}
                template={vm.template}
                customizeOpen={vm.customizeOpen}
                onToggleCustomize={() => vm.setCustomizeOpen((v) => !v)}
                customizeSummary={vm.customizeSummary}
                motionOn={vm.motionOn}
                onToggleMotion={() => vm.setMotionOn((v) => !v)}
                formats={vm.formats}
                onToggleFormat={vm.toggleFormat}
                motionSeconds={vm.motionSeconds}
                onMotionSeconds={vm.setMotionSeconds}
                advancedOpen={vm.advancedOpen}
                onToggleAdvanced={() => vm.setAdvancedOpen((v) => !v)}
                durationError={vm.durationError}
                legacyClipMessage={vm.legacyClipMessage}
                durationUnverified={vm.preview?.durationUnverified === true}
                profile={vm.profile}
                onProfile={vm.setProfile}
                cap={vm.cap}
                onCap={vm.setCap}
                showDetails={vm.showDetails}
                onToggleDetails={() => vm.setShowDetails((v) => !v)}
              />

              <TemplatePackReview
                allowed={allowed}
                applying={vm.applying}
                previewing={vm.previewing}
                hasChanges={vm.hasChanges}
                canApply={vm.canApply}
                appliedTitle={vm.appliedTitle}
                appliedCount={vm.appliedCount}
                packTitle={vm.template.title.replace(" Pack", "")}
                packSize={vm.packSize}
                preview={vm.preview}
                previewError={vm.previewError}
                mediaLine={vm.mediaLine}
                formatLine={vm.formatLine}
                applyError={vm.applyError}
                formatUsd={vm.formatUsd}
                onPrimary={() => {
                  if (!vm.preview || vm.previewError) {
                    vm.refreshPreview();
                    return;
                  }
                  void vm.apply();
                }}
              />
            </div>
          )}
        </>
      )}
    </section>
  );
}
