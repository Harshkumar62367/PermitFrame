import { Ban, CheckCircle2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type StatusTone = "blocked" | "draft" | "ready" | "generating" | "review" | "approved" | "active" | "revoked" | "pending" | "attested" | "neutral";

/** Shared tone styles so outcome badges match status badges exactly. */
export const STATUS_TONE_STYLES: Record<StatusTone, string> = {
  blocked: "bg-rose-50 text-rose-700 ring-rose-600/20 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-800",
  revoked: "bg-rose-50 text-rose-700 ring-rose-600/20 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-800",
  draft: "bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-950/40 dark:text-sky-300 dark:ring-sky-800",
  ready: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-800",
  generating: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-800",
  pending: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-800",
  review: "bg-violet-50 text-violet-700 ring-violet-600/20 dark:bg-violet-950/40 dark:text-violet-300 dark:ring-violet-800",
  approved: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-800",
  active: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-800",
  attested: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-800",
  neutral: "bg-secondary text-secondary-foreground ring-border"
};

/** Map raw domain statuses to a visual tone. Visual only — no domain logic. */
export function statusToneFor(status: string): StatusTone {
  const s = status.toLowerCase();
  if (s in STATUS_TONE_STYLES) return s as StatusTone;
  if (s === "completed") return "attested";
  if (s === "failed" || s === "expired") return "blocked";
  return "neutral";
}

/**
 * Theme-safe status pill used across workspace, campaigns, consents.
 * Every tone declares both light and dark classes (contrast in both).
 */
export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const tone = statusToneFor(status);
  return (
    <Badge variant="outline" className={cn("rounded-full font-medium capitalize", STATUS_TONE_STYLES[tone], className)}>
      {tone === "blocked" && <Ban className="h-3 w-3" aria-hidden />}
      {(tone === "approved" || tone === "attested") && <CheckCircle2 className="h-3 w-3" aria-hidden />}
      {status}
    </Badge>
  );
}
