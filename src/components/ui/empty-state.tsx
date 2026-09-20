import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Centered empty-collection placeholder. No fetching, no routing. */
export function EmptyState({
  title,
  body,
  actions,
  icon,
  className
}: {
  title: string;
  body?: string;
  actions?: ReactNode;
  /** Optional Lucide icon rendered in a muted ring above the title. */
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-2xl border border-dashed border-border bg-card px-6 py-10 text-center", className)}>
      {icon && (
        <span aria-hidden className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-full bg-muted text-muted-foreground ring-1 ring-border [&_svg]:h-5 [&_svg]:w-5">
          {icon}
        </span>
      )}
      <p className="text-[14px] font-semibold tracking-tight">{title}</p>
      {body && <p className="mx-auto mt-1.5 max-w-md text-pretty text-[12.5px] leading-relaxed text-muted-foreground">{body}</p>}
      {actions && <div className="mt-4 flex flex-wrap items-center justify-center gap-2">{actions}</div>}
    </div>
  );
}
