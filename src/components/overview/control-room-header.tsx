"use client";

import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";

/** Product-aware header: workspace identity, control-room title, primary CTA. */
export function CampaignControlHeader({
  workspaceName,
  formOpen,
  onToggleForm
}: {
  workspaceName: string | null;
  formOpen: boolean;
  onToggleForm: () => void;
}) {
  return (
    <PageHeader
      eyebrow={workspaceName ? `Workspace / ${workspaceName}` : "Workspace"}
      title="Campaign control room"
      description="Review rights, approve production and track verifiable campaign outputs."
      actions={
        <Button
          onClick={onToggleForm}
          aria-expanded={formOpen}
          className="rounded-full bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
        >
          <Plus className="h-4 w-4" aria-hidden /> {formOpen ? "Close form" : "New campaign"}
        </Button>
      }
    />
  );
}
