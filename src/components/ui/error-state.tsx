import type { ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

/** Inline error with optional retry. Role=alert for AT. */
export function ErrorState({
  message,
  retryLabel = "Try again",
  onRetry,
  actions,
  className
}: {
  message: string;
  retryLabel?: string;
  onRetry?: () => void;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-wrap items-center gap-2.5 rounded-xl bg-rose-50 px-4 py-3 text-[13px] text-rose-800 ring-1 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-200 dark:ring-rose-900",
        className
      )}
    >
      <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 break-words">{message}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 rounded-full px-3 py-1 text-[12px] font-medium underline underline-offset-2 hover:no-underline"
        >
          {retryLabel}
        </button>
      )}
      {actions}
    </div>
  );
}
