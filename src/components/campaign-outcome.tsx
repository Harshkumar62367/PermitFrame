import { CheckCircle2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { STATUS_TONE_STYLES, statusToneFor, type StatusTone } from "@/components/ui/status-badge";
import { cn } from "@/lib/utils";
import type { PublicationStatus } from "@/server/types";

export interface CampaignOutcome {
  label: string;
  explanation?: string;
  tone: StatusTone;
}

export interface OutcomeInput {
  status: string;
  /** Live preflight verdict, or null before the first check. */
  decision: "allow" | "block" | "pending" | null;
  hasOutputs: boolean;
  /**
   * Explicit persisted publication state of the campaign record.
   * Missing (legacy rows) means non-public - never inferred from ID shape.
   */
  publicationStatus?: PublicationStatus | null;
  /** Evidence record id, when approval published one. */
  campaignUAL?: string | null;
}

/**
 * True only for an explicitly persisted anchored state plus a real record
 * reference. Never guesses from ID/URI shape: a local-looking identifier on
 * a genuinely anchored record still counts as public, and any UAL-shaped
 * string without anchored state never does.
 */
export function isPublicRecord(input: Pick<OutcomeInput, "publicationStatus" | "campaignUAL">): boolean {
  return input.publicationStatus === "anchored" && !!input.campaignUAL;
}

/**
 * Plain, outcome-based campaign status. Works for full Campaign rows and
 * snapshot rows alike - callers pass primitives, never raw domain labels.
 * Technical identifiers never appear here; they belong in the optional
 * "Technical details for verification" section, and only when the record
 * genuinely exists.
 */
export function campaignOutcome(input: OutcomeInput): CampaignOutcome {
  if (input.status === "archived") {
    return {
      label: "Archived",
      explanation: "Kept for audit history. It no longer appears in lists and cannot be edited, produced, or approved.",
      tone: "neutral"
    };
  }
  if (!input.decision || input.decision === "pending") {
    return { label: "Ready for permission check", tone: "pending" };
  }
  if (input.decision === "block") {
    return { label: "Changes needed before creation", tone: "blocked" };
  }
  if (input.status === "approved" && isPublicRecord(input)) {
    return {
      label: "Public verification ready",
      explanation: "A tamper-evident verification record is available to share with your client.",
      tone: "attested"
    };
  }
  if (input.status === "approved") {
    return {
      label: "Campaign record saved",
      explanation: "The approval and production details were recorded; private media remains private.",
      tone: "approved"
    };
  }
  if (input.hasOutputs) {
    return { label: "Asset created", tone: "review" };
  }
  return {
    label: "Approved to create",
    explanation: "Creator permissions and brand rules allow this campaign.",
    tone: "ready"
  };
}

/** Theme-safe outcome pill. Visual only - the label comes from campaignOutcome. */
export function OutcomeBadge({ outcome, className }: { outcome: CampaignOutcome; className?: string }) {
  const tone = statusToneFor(outcome.tone);
  return (
    <Badge variant="outline" className={cn("rounded-full font-medium", STATUS_TONE_STYLES[tone], className)}>
      {(tone === "approved" || tone === "attested") && <CheckCircle2 className="h-3 w-3" aria-hidden />}
      {outcome.label}
    </Badge>
  );
}
