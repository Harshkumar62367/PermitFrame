"use client";

import { useId, useState } from "react";
import { Check, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiPost } from "@/lib/api";
import { cn } from "@/lib/utils";

export function ClientReviewForm({ token }: { token: string }) {
  const uid = useId();
  const [decision, setDecision] = useState<"approved" | "changes_requested" | null>(null);
  const [name, setName] = useState("");
  const [comment, setComment] = useState("");
  const [done, setDone] = useState<"approved" | "changes_requested" | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!decision || busy) return;
    if (decision === "changes_requested" && !comment.trim()) {
      setSubmitError("Describe what should change - the agency needs your notes to revise.");
      return;
    }
    setSubmitError(null);
    setBusy(true);
    try {
      await apiPost(`/api/share/${token}`, { decision, clientName: name, comment });
      setDone(decision);
    } catch (e) {
      // Name, decision and comment are preserved for retry.
      setSubmitError(e instanceof Error ? e.message : "Review failed to send. Your input is preserved.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div role="status" className="rounded-2xl bg-emerald-50 p-5 text-center ring-1 ring-emerald-200 dark:bg-emerald-950/40 dark:ring-emerald-900">
        <p className="text-[14px] font-semibold text-emerald-800 dark:text-emerald-300">
          {done === "approved" ? "Approved - the agency has been notified." : "Changes requested - the agency will revise."}
        </p>
      </div>
    );
  }

  const nameId = `${uid}-name`;
  const commentId = `${uid}-comment`;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2" role="group" aria-label="Review decision">
        <button
          type="button"
          onClick={() => {
            setDecision("approved");
            setSubmitError(null);
          }}
          aria-pressed={decision === "approved"}
          className={cn(
            "rounded-2xl border p-4 text-left transition",
            decision === "approved"
              ? "border-emerald-500 bg-emerald-50 ring-2 ring-emerald-500/30 dark:bg-emerald-950/40"
              : "border-border hover:border-emerald-400"
          )}
        >
          <Check className="h-5 w-5 text-emerald-600 dark:text-emerald-400" aria-hidden />
          <p className="mt-2 text-[14px] font-semibold">Approve the pack</p>
          <p className="mt-0.5 text-[12px] text-muted-foreground">Signs off this campaign as final.</p>
        </button>
        <button
          type="button"
          onClick={() => {
            setDecision("changes_requested");
            setSubmitError(null);
          }}
          aria-pressed={decision === "changes_requested"}
          className={cn(
            "rounded-2xl border p-4 text-left transition",
            decision === "changes_requested"
              ? "border-amber-500 bg-amber-50 ring-2 ring-amber-500/30 dark:bg-amber-950/40"
              : "border-border hover:border-amber-400"
          )}
        >
          <RotateCcw className="h-5 w-5 text-amber-600 dark:text-amber-400" aria-hidden />
          <p className="mt-2 text-[14px] font-semibold">Request changes</p>
          <p className="mt-0.5 text-[12px] text-muted-foreground">Sends it back with your notes.</p>
        </button>
      </div>
      {decision && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor={nameId} className="text-[12px] text-muted-foreground">Your name (optional)</Label>
            <Input id={nameId} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada" className="rounded-xl" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={commentId} className="text-[12px] text-muted-foreground">
              {decision === "changes_requested" ? "What should change? (required)" : "Anything to note? (optional)"}
            </Label>
            <Textarea
              id={commentId}
              value={comment}
              onChange={(e) => {
                setComment(e.target.value);
                setSubmitError(null);
              }}
              placeholder={decision === "changes_requested" ? "What should change?" : "Anything to note?"}
              rows={3}
              aria-invalid={Boolean(submitError)}
              aria-describedby={submitError ? `${commentId}-error` : undefined}
              className="rounded-xl"
            />
          </div>
          {submitError && (
            <p id={`${commentId}-error`} role="alert" className="break-words text-[13px] text-rose-600 dark:text-rose-300">
              {submitError}
            </p>
          )}
          <Button
            onClick={submit}
            disabled={busy}
            aria-busy={busy}
            className="w-full rounded-full bg-emerald-700 py-2.5 font-medium text-emerald-50 hover:bg-emerald-600 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
          >
            {busy ? "Sending…" : decision === "approved" ? "Confirm approval" : "Send change request"}
          </Button>
        </>
      )}
    </div>
  );
}
