"use client";

import { useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * "Start with this brief" navigation only: routes to Campaigns with the demo id.
 * No fetching, no writes, no external calls, no spend - the campaigns page
 * resolves the id against the same local definitions and prefills only the
 * allow-listed brief fields.
 */
export function DemoBriefButton({ demoId, demoTitle }: { demoId: string; demoTitle: string }) {
  const router = useRouter();
  return (
    <Button
      onClick={() => router.push(`/campaigns?demo=${encodeURIComponent(demoId)}`)}
      aria-label={`Start with this brief: open a campaign draft from ${demoTitle}`}
      className="rounded-full bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
    >
      Start with this brief <ArrowRight className="h-4 w-4" aria-hidden />
    </Button>
  );
}
