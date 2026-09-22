import { cn } from "@/lib/utils";

/**
 * Small health row: colored dot + label + optional detail.
 * Presentational - callers pass already-fetched health values.
 */
export function IntegrationStatus({
  label,
  state,
  detail,
  className
}: {
  label: string;
  state: "healthy" | "degraded" | "down" | "loading";
  detail?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 items-center justify-between gap-3", className)}>
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span
        className={cn(
          "min-w-0 truncate text-right font-mono text-[10px]",
          state === "healthy" && "text-emerald-600 dark:text-emerald-400",
          state === "degraded" && "text-amber-600 dark:text-amber-400",
          state === "down" && "text-rose-600 dark:text-rose-400",
          state === "loading" && "text-muted-foreground"
        )}
        title={detail}
      >
        {detail ?? (state === "loading" ? "…" : state)}
      </span>
    </div>
  );
}

export function HealthDot({ healthy, className }: { healthy: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "h-2.5 w-2.5 shrink-0 rounded-full",
        healthy ? "bg-emerald-500 dark:bg-emerald-400" : "bg-rose-500 dark:bg-rose-400",
        className
      )}
    />
  );
}
