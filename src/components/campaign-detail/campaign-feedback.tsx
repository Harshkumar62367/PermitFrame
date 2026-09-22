interface CampaignFeedbackProps {
  notice: string | null;
  error: string | null;
  busy: boolean;
  canRetry: boolean;
  onRetry: () => void;
  onDismiss: () => void;
}

/** Mutation feedback is kept beside its route, while the route retains the
 * retry decision and all server actions. */
export function CampaignFeedback({ notice, error, busy, canRetry, onRetry, onDismiss }: CampaignFeedbackProps) {
  return (
    <>
      {notice && <div role="status" className="rounded-xl bg-emerald-50 px-4 py-3 text-[13px] text-emerald-800 ring-1 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-200 dark:ring-emerald-900">{notice}</div>}
      {error && (
        <div role="alert" className="flex flex-wrap items-center gap-2.5 rounded-xl bg-rose-50 px-4 py-3 text-[13px] text-rose-800 ring-1 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-200 dark:ring-rose-900">
          <span className="min-w-0 flex-1 break-words">{error}</span>
          {canRetry && <button type="button" onClick={onRetry} disabled={busy} className="shrink-0 rounded-full px-3 py-1 text-[12px] font-medium underline underline-offset-2 hover:no-underline disabled:opacity-50">Retry{busy ? "…" : ""}</button>}
          <button type="button" onClick={onDismiss} className="shrink-0 rounded-full px-3 py-1 text-[12px] font-medium text-rose-700 underline underline-offset-2 hover:no-underline dark:text-rose-300">Dismiss</button>
        </div>
      )}
    </>
  );
}
