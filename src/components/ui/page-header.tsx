import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type PageHeaderWidth = "narrow" | "default" | "wide";

/**
 * Reusable page header: eyebrow, title, description, optional actions.
 * Keeps heading hierarchy consistent; actions are composed, not flagged.
 */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  width = "default",
  className
}: {
  eyebrow: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  width?: PageHeaderWidth;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-end justify-between gap-4",
        width === "narrow" && "max-w-3xl",
        width === "wide" && "max-w-none",
        className
      )}
    >
      <div className="min-w-0">
        <p className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-emerald-700 dark:text-emerald-300">
          {eyebrow}
        </p>
        <h1 className="font-display mt-1.5 text-balance text-3xl font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="mt-1.5 max-w-2xl text-pretty text-[13.5px] leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
