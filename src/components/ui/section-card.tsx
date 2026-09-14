import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Padded content card. Presentational only — no data fetching.
 * Compose a heading + body via children instead of boolean flags.
 */
export function SectionCard({
  title,
  description,
  actions,
  children,
  className
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("min-w-0 rounded-2xl border border-border bg-card p-5 sm:p-6", className)}>
      {(title || description || actions) && (
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            {title && <h2 className="text-balance text-[14.5px] font-semibold tracking-tight">{title}</h2>}
            {description && <p className="mt-1 max-w-2xl text-pretty text-[12.5px] leading-relaxed text-muted-foreground">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}
