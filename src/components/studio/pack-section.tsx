"use client";

import Link from "next/link";
import { useState } from "react";
import { Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiPost } from "@/lib/api";
import { useInvalidateWorkspaceSnapshot } from "@/lib/use-workspace-snapshot";
import type { Campaign } from "@/server/types";

interface PackSectionProps {
  campaign: Campaign;
  onChanged: () => Promise<void>;
}

const PLATFORMS = ["instagram", "tiktok", "youtube", "linkedin"];

/**
 * Asset pack: platform expansion as one coherent workflow. Each added
 * platform clones this brief into its own campaign through the existing
 * variants endpoint - rights-checked independently for that platform, with
 * its own studio. Nothing generates here; this section only organizes.
 */
export function PackSection({ campaign, onChanged }: PackSectionProps) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [variants, setVariants] = useState<{ id: string; title: string }[] | null>(null);
  // Which platform button is mid-creation. Buttons share the `busy` lock so
  // two variants can never be created concurrently, but only the clicked one
  // reads "Creating…" - the others keep their labels.
  const [pendingPlatform, setPendingPlatform] = useState<string | null>(null);
  const invalidateSnapshot = useInvalidateWorkspaceSnapshot();

  const others = PLATFORMS.filter((p) => p !== campaign.request.platform);

  async function addPlatforms(platforms: string[]) {
    if (busy) return;
    setBusy(true);
    setPendingPlatform(platforms[0] ?? null);
    setMessage(null);
    setError(null);
    try {
      // Variant creation runs a full permission check (DKG reads), which can
      // take well over the default 30s budget - allow two minutes.
      const j = await apiPost<{ campaigns: { id: string; title: string }[] }>(
        `/api/campaigns/${campaign.id}/variants`,
        { platforms },
        undefined,
        120000
      );
      setVariants(j.campaigns);
      setMessage(
        j.campaigns.length > 0
          ? `${j.campaigns.length} variant${j.campaigns.length === 1 ? "" : "s"} created - each is permission-checked independently for its platform before it can generate.`
          : "No variants created - that platform matches this campaign."
      );
      if (j.campaigns.length > 0) invalidateSnapshot();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Variant creation failed.");
    } finally {
      setBusy(false);
      setPendingPlatform(null);
    }
  }

  return (
    <section aria-label="Asset pack" className="rounded-2xl border border-dashed border-border bg-card p-5 sm:p-6">
      <p className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
        <Layers className="h-3.5 w-3.5" aria-hidden /> Asset pack - one brief, every platform
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-secondary px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.08em] text-secondary-foreground">
          {campaign.request.platform} · this campaign
        </span>
        {others.map((p) => (
          <Button
            key={p}
            variant="outline"
            size="sm"
            onClick={() => void addPlatforms([p])}
            disabled={busy}
            aria-busy={pendingPlatform === p}
            title={pendingPlatform === p ? `Creating the ${p} variant - permission check runs first` : `Clone this brief for ${p}`}
            className="rounded-full capitalize"
          >
            {pendingPlatform === p ? "Creating…" : `+ ${p}`}
          </Button>
        ))}
      </div>
      {message && <p role="status" className="mt-3 break-words text-[12.5px] text-muted-foreground">{message}</p>}
      {error && <p role="alert" className="mt-3 break-words text-[12px] text-rose-600 dark:text-rose-300">{error}</p>}
      {variants && variants.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {variants.map((v) => (
            <li key={v.id}>
              <Link href={`/campaigns/${v.id}`} className="text-[12.5px] font-medium text-emerald-700 hover:underline dark:text-emerald-300">
                {v.title} →
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
