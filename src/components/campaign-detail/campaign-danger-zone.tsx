"use client";

import { Archive, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface CampaignDangerZoneProps {
  disabled: boolean;
  deletable: boolean;
  reasons: string[];
  archiveAvailable: boolean;
  onDelete: () => void;
  onArchive: () => void;
}

/** Danger zone for live campaigns - delete drafts, archive the rest. Display only. */
export function CampaignDangerZone({
  disabled,
  deletable,
  reasons,
  archiveAvailable,
  onDelete,
  onArchive
}: CampaignDangerZoneProps) {
  return (
    <section aria-label="Danger zone" className="rounded-2xl border border-border p-6">
      <h2 className="text-[15px] font-semibold tracking-tight">Danger zone</h2>
      {deletable ? (
        <>
          <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-muted-foreground">
            This campaign has no generated assets, no share link, and no public proof - it exists only in this
            workspace. Deleting removes the draft, its permission-check record, and its ungenerated plan items.
            Workspace activity entries that mention it stay. Nothing on the shared ledger is touched.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={onDelete}
            disabled={disabled}
            className="mt-4 rounded-full border-rose-300 text-rose-700 hover:bg-rose-50 dark:border-rose-900 dark:text-rose-300 dark:hover:bg-rose-950/40"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete campaign
          </Button>
        </>
      ) : (
        <>
          <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-muted-foreground">
            This campaign cannot be deleted:
          </p>
          <ul className="mt-2 max-w-2xl list-disc space-y-1 pl-5 text-[13px] leading-relaxed text-muted-foreground">
            {reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          {archiveAvailable ? (
            <>
              <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-muted-foreground">
                Archive it instead: the full record stays readable here and in history, but it leaves Campaigns and Overview.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={onArchive}
                disabled={disabled}
                className="mt-4 rounded-full"
              >
                <Archive className="h-3.5 w-3.5" aria-hidden /> Archive campaign
              </Button>
            </>
          ) : (
            <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-muted-foreground">
              Neither option is available right now - wait until production settles, then come back.
            </p>
          )}
        </>
      )}
    </section>
  );
}
