"use client";

import { Check, ChevronDown, Layers } from "lucide-react";
import { cn } from "@/lib/utils";
import { RECIPE_LINES, RECIPE_OUTCOMES, type TemplateMeta } from "./template-panel.types";

interface TemplateRecipeSelectorProps {
  templates: TemplateMeta[];
  template: TemplateMeta;
  templateId: string;
  comboOpen: boolean;
  onToggleCombo: () => void;
  onCloseCombo: () => void;
  onSwitch: (next: TemplateMeta) => void;
}

/** Campaign recipe combobox: values and callbacks only, no selection state. */
export function TemplateRecipeSelector({
  templates,
  template,
  templateId,
  comboOpen,
  onToggleCombo,
  onCloseCombo,
  onSwitch
}: TemplateRecipeSelectorProps) {
  return (
    <>
      <p id="recipe-label" className="text-[12px] font-medium text-muted-foreground">Campaign recipe</p>
      <div
        className="relative mt-1.5"
        onKeyDown={(e) => {
          if (e.key === "Escape") onCloseCombo();
        }}
      >
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={comboOpen}
          aria-labelledby="recipe-label"
          onClick={onToggleCombo}
          className="flex w-full items-center gap-2.5 rounded-xl border border-border bg-card px-3.5 py-2.5 text-left transition hover:border-emerald-600/40"
        >
          <Layers className="h-4 w-4 shrink-0 text-emerald-700 dark:text-emerald-300" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13.5px] font-semibold">{template.title.replace(" Pack", "")}</span>
            <span className="block truncate text-[12px] text-muted-foreground">
              {RECIPE_LINES[template.id] ?? template.useCase}
            </span>
            <span className="mt-0.5 block truncate text-[11.5px] font-medium text-foreground/80">
              {RECIPE_OUTCOMES[template.id] ?? ""}
            </span>
          </span>
          <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition", comboOpen && "rotate-180")} aria-hidden />
        </button>
        {comboOpen && (
          <>
            <button
              type="button"
              aria-hidden
              tabIndex={-1}
              onClick={onCloseCombo}
              className="fixed inset-0 z-10 cursor-default bg-transparent"
            />
            <ul role="listbox" aria-label="Campaign recipe" className="absolute z-20 mt-1.5 max-h-72 w-full overflow-y-auto rounded-xl border border-border bg-card p-1.5 shadow-xl">
              {templates.map((t) => {
                const active = t.id === templateId;
                return (
                  <li key={t.id} role="option" aria-selected={active}>
                    <button
                      type="button"
                      onClick={() => onSwitch(t)}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition",
                        active ? "bg-emerald-600/10" : "hover:bg-muted"
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block text-[12.5px] font-semibold">{t.title.replace(" Pack", "")}</span>
                        <span className="block truncate text-[11.5px] text-muted-foreground">
                          {RECIPE_LINES[t.id] ?? t.useCase}
                        </span>
                        <span className="block truncate text-[11px] font-medium text-foreground/75">
                          {RECIPE_OUTCOMES[t.id] ?? ""}
                        </span>
                      </span>
                      {active && <Check className="h-4 w-4 shrink-0 text-emerald-700 dark:text-emerald-300" aria-hidden />}
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </>
  );
}
