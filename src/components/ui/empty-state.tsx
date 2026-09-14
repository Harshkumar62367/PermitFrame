import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Centered empty-collection placeholder. No fetching, no routing. */
export function EmptyState({
  title,
  body,
  actions,
  className
}: {
  title: string;
  body?: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-2xl border border-dashed border-border bg-card px-6 py-10 text-center", className)}>
      <p className="text-[14px] font-semibold tracking-tight">{title}</p>
      {body && <p className="mx-auto mt-1.5 max-w-md text-pretty text-[12.5px] leading-relaxed text-muted-foreground">{body}</p>}
      {actions && <div className="mt-4 flex flex-wrap items-center justify-center gap-2">{actions}</div>}
    </div>
  );
}
