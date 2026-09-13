"use client";

import { useState } from "react";
import { Check, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export function ClientReviewForm({ token }: { token: string }) {
  const [decision, setDecision] = useState<"approved" | "changes_requested" | null>(null);
  const [name, setName] = useState("");
  const [comment, setComment] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!decision) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/share/${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, clientName: name, comment })
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "failed");
      setDone(decision);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="rounded-2xl bg-emerald-50 p-5 text-center ring-1 ring-emerald-200 dark:bg-emerald-950/40 dark:ring-emerald-900">
        <p className="text-[14px] font-semibold text-emerald-800 dark:text-emerald-300">
          {done === "approved" ? "Approved — the agency has been notified." : "Changes requested — the agency will revise."}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <button
          onClick={() => setDecision("approved")}
          className={cn(
            "rounded-2xl border p-4 text-left transition",
            decision === "approved"
              ? "border-emerald-500 bg-emerald-50 ring-2 ring-emerald-500/30 dark:bg-emerald-950/40"
              : "border-border hover:border-emerald-400"
          )}
        >
          <Check className="h-5 w-5 text-emerald-600" />
          <p className="mt-2 text-[14px] font-semibold">Approve the pack</p>
          <p className="mt-0.5 text-[12px] text-muted-foreground">Signs off this campaign as final.</p>
        </button>
        <button
          onClick={() => setDecision("changes_requested")}
          className={cn(
            "rounded-2xl border p-4 text-left transition",
            decision === "changes_requested"
              ? "border-amber-500 bg-amber-50 ring-2 ring-amber-500/30 dark:bg-amber-950/40"
              : "border-border hover:border-amber-400"
          )}
        >
          <RotateCcw className="h-5 w-5 text-amber-600" />
          <p className="mt-2 text-[14px] font-semibold">Request changes</p>
          <p className="mt-0.5 text-[12px] text-muted-foreground">Sends it back with your notes.</p>
        </button>
      </div>
      {decision && (
        <>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name (optional)" className="rounded-xl" />
          <Textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder={decision === "changes_requested" ? "What should change?" : "Anything to note?"} rows={3} className="rounded-xl" />
          <Button onClick={submit} disabled={busy} className="w-full rounded-full bg-emerald-700 py-2.5 font-medium text-emerald-50 hover:bg-emerald-600">
            {busy ? "Sending…" : decision === "approved" ? "Confirm approval" : "Send change request"}
          </Button>
        </>
      )}
    </div>
  );
}
