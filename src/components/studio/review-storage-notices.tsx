import { Button } from "@/components/ui/button";

interface ReviewStorageNoticesProps {
  legacyCount: number;
  pendingCount: number;
  retrying: boolean;
  message: string | null;
  onRetry: () => void;
}

/**
 * Durable-storage status banners: provider-hosted legacy assets and
 * in-flight secure saves, both with the same retry action. View-only:
 * counts, busy flag, message, and the retry callback come from the parent.
 */
export function ReviewStorageNotices({ legacyCount, pendingCount, retrying, message, onRetry }: ReviewStorageNoticesProps) {
  return (
    <>
      {legacyCount > 0 && (
        <div
          role="status"
          className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-sky-50 px-4 py-3 text-[12.5px] text-sky-800 ring-1 ring-sky-200 dark:bg-sky-950/40 dark:text-sky-200 dark:ring-sky-900"
        >
          <span className="min-w-0 flex-1 break-words">
            Provider-hosted legacy asset{legacyCount === 1 ? "" : "s"} - store securely before sharing or publishing proof.
            Previews stay visible; share, download, and proof unlock once stored.
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void onRetry()}
            disabled={retrying}
            aria-busy={retrying}
            className="shrink-0 rounded-full"
          >
            {retrying ? "Storing…" : "Store securely"}
          </Button>
          {message && <span className="w-full break-words text-[12px]">{message}</span>}
        </div>
      )}
      {pendingCount > 0 && (
        <div
          role="status"
          className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-amber-50 px-4 py-3 text-[12.5px] text-amber-800 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900"
        >
          <span className="min-w-0 flex-1 break-words">
            {pendingCount} output{pendingCount === 1 ? "" : "s"} generated - saving securely. {pendingCount === 1 ? "It" : "They"} will
            appear for review once stored; the provider result is safe meanwhile.
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void onRetry()}
            disabled={retrying}
            aria-busy={retrying}
            className="shrink-0 rounded-full"
          >
            {retrying ? "Retrying…" : "Retry storage"}
          </Button>
          {message && <span className="w-full break-words text-[12px]">{message}</span>}
        </div>
      )}
    </>
  );
}
