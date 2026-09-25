"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SCOPES, type TemplateRecipeMeta } from "./template-panel.types";

interface TemplateScopeSelectorProps {
  packSize: string;
  onPackSize: (next: string) => void;
  stageIds: string[];
  onToggleStage: (id: string) => void;
  onUseRecommended: () => void;
  onClearStages: () => void;
  recipes: TemplateRecipeMeta[];
}

/** Pack-size radiogroup plus the custom-stage picker. Stateless: no API, no selection state. */
export function TemplateScopeSelector({
  packSize,
  onPackSize,
  stageIds,
  onToggleStage,
  onUseRecommended,
  onClearStages,
  recipes
}: TemplateScopeSelectorProps) {
  const outputCount = (scope: string) => {
    const executable = recipes.filter((recipe) => recipe.execution === "create_media");
    const selected = scope === "quick"
      ? executable.filter((recipe) => recipe.quickPick)
      : scope === "campaign"
        ? executable.filter((recipe) => !recipe.optional)
        : executable;
    return `${selected.length} asset${selected.length === 1 ? "" : "s"}`;
  };

  return (
    <>
      <div>
        <p className="text-[12px] font-medium text-muted-foreground">How much do you need?</p>
        <div className="mt-1.5 grid grid-cols-2 gap-1.5 xl:grid-cols-4" role="radiogroup" aria-label="Pack size">
          {SCOPES.map((opt) => {
            const active = packSize === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => {
                  onPackSize(opt.id);
                }}
                className={cn(
                  "rounded-xl border px-3 py-2 text-left transition",
                  active
                    ? "border-emerald-600 bg-emerald-600 text-white dark:border-emerald-500 dark:bg-emerald-500 dark:text-emerald-950"
                    : "border-border hover:border-emerald-600/40"
                )}
              >
                <span className="flex items-center gap-1.5 text-[12.5px] font-semibold">
                  {opt.title}
                  {"recommended" in opt && opt.recommended && (
                    <span className={cn(
                      "rounded-full px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide",
                      active ? "bg-white/25 text-white dark:bg-emerald-950/20 dark:text-emerald-950" : "bg-emerald-600/10 text-emerald-700 dark:text-emerald-300"
                    )}>
                      Recommended
                    </span>
                  )}
                </span>
                <span className={cn("mt-0.5 block text-[11.5px]", active ? "opacity-85" : "text-muted-foreground")}>
                  {opt.id === "custom" ? opt.blurb : outputCount(opt.id)}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {packSize === "custom" && (
        <div className="rounded-xl bg-muted/40 p-3.5 ring-1 ring-border">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[12.5px] font-semibold" role="status">
              {stageIds.length === 0 ? "No outputs selected yet." : `${stageIds.length} output${stageIds.length === 1 ? "" : "s"} selected.`}
            </p>
            <div className="flex gap-1.5">
              <Button variant="ghost" size="sm" onClick={onUseRecommended} className="h-7 rounded-full px-2.5 text-[11.5px]">
                Use recommended set
              </Button>
              <Button variant="ghost" size="sm" onClick={onClearStages} className="h-7 rounded-full px-2.5 text-[11.5px]">
                Clear selection
              </Button>
            </div>
          </div>
          <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {recipes.filter((r) => r.execution === "create_media").map((r) => {
              const on = stageIds.includes(r.id);
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    onClick={() => {
                      onToggleStage(r.id);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] ring-1 transition",
                      on ? "bg-emerald-600/10 ring-emerald-600/40" : "ring-border hover:ring-emerald-600/30"
                    )}
                  >
                    <span className="font-mono text-[10px] text-muted-foreground">{r.format}</span>
                    <span className="min-w-0 flex-1 truncate">{r.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </>
  );
}
