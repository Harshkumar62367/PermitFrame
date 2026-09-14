"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { apiPost } from "@/lib/api";
import { cn } from "@/lib/utils";

const PLATFORMS = ["instagram", "tiktok", "youtube", "linkedin"];

interface FieldErrors {
  country?: string;
  brief?: string;
}

export function NewCampaignForm({ onCreated }: { onCreated?: (id: string) => void }) {
  const router = useRouter();
  const uid = useId();
  const countryRef = useRef<HTMLInputElement>(null);
  const briefRef = useRef<HTMLTextAreaElement>(null);
  const [form, setForm] = useState({
    title: "",
    platform: "instagram",
    country: "",
    claims: "",
    transformation: "video",
    creativeBrief: ""
  });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function validate(): FieldErrors {
    const errors: FieldErrors = {};
    if (form.country.trim().length !== 2) errors.country = "Use a 2-letter country code (e.g. GR for Greece, DE for Germany).";
    if (!form.creativeBrief.trim()) errors.brief = "Describe the shot — the agent generates from this brief.";
    else if (form.creativeBrief.trim().length < 12) errors.brief = "Give the agent a little more to work with (12+ characters).";
    return errors;
  }

  async function submit() {
    if (busy) return;
    const errors = validate();
    setFieldErrors(errors);
    setSubmitError(null);
    if (errors.country) {
      countryRef.current?.focus();
      return;
    }
    if (errors.brief) {
      briefRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      const json = await apiPost<{ campaign: { id: string } }>("/api/campaigns", {
        title: form.title.trim() || `${form.platform} campaign — ${form.country.trim().toUpperCase()}`,
        platform: form.platform,
        country: form.country.trim().toUpperCase(),
        requestedClaims: form.claims.split(",").map((c) => c.trim()).filter(Boolean),
        transformation: form.transformation,
        creativeBrief: form.creativeBrief.trim()
      });
      if (onCreated) onCreated(json.campaign.id);
      else router.push(`/campaigns/${json.campaign.id}`);
    } catch (e) {
      // Input is preserved; only the error is shown.
      setSubmitError(e instanceof Error ? e.message : "Failed to create campaign.");
      setBusy(false);
    }
  }

  const countryId = `${uid}-country`;
  const briefId = `${uid}-brief`;

  return (
    <div className="rounded-2xl border border-border bg-card p-6">
      <h3 className="text-[15px] font-semibold tracking-tight">New campaign request</h3>
      <p className="mt-1 text-[12.5px] text-muted-foreground">
        It runs through DKG preflight the moment you create it — allowed or blocked, with reasons.
      </p>
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${uid}-title`} className="text-[12px] text-muted-foreground">Title (optional)</Label>
          <Input
            id={`${uid}-title`}
            placeholder="Summer launch — reels"
            value={form.title}
            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            className="rounded-xl"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${uid}-platform`} className="text-[12px] text-muted-foreground">Platform</Label>
          <Select value={form.platform} onValueChange={(v) => setForm((f) => ({ ...f, platform: v }))}>
            <SelectTrigger id={`${uid}-platform`} className="w-full rounded-xl"><SelectValue /></SelectTrigger>
            <SelectContent>
              {PLATFORMS.map((p) => (
                <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={countryId} className="text-[12px] text-muted-foreground">Country (2-letter code)</Label>
          <Input
            ref={countryRef}
            id={countryId}
            placeholder="GR"
            maxLength={2}
            value={form.country}
            aria-invalid={Boolean(fieldErrors.country)}
            aria-describedby={fieldErrors.country ? `${countryId}-error` : undefined}
            onChange={(e) => {
              setForm((f) => ({ ...f, country: e.target.value.toUpperCase() }));
              setFieldErrors((prev) => ({ ...prev, country: undefined }));
            }}
            className={cn("rounded-xl", fieldErrors.country && "border-rose-500")}
          />
          {fieldErrors.country && (
            <p id={`${countryId}-error`} role="alert" className="text-[12px] text-rose-600 dark:text-rose-300">
              {fieldErrors.country}
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${uid}-claims`} className="text-[12px] text-muted-foreground">Claims to advertise (comma-separated)</Label>
          <Input
            id={`${uid}-claims`}
            placeholder="made with recycled materials"
            value={form.claims}
            onChange={(e) => setForm((f) => ({ ...f, claims: e.target.value }))}
            className="rounded-xl"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${uid}-output`} className="text-[12px] text-muted-foreground">Output</Label>
          <Select value={form.transformation} onValueChange={(v) => setForm((f) => ({ ...f, transformation: v }))}>
            <SelectTrigger id={`${uid}-output`} className="w-full rounded-xl"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="video">Video pack (9:16 + 1:1 + 16:9 + motion)</SelectItem>
              <SelectItem value="image">Image pack (9:16 + 1:1 + 16:9)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor={briefId} className="text-[12px] text-muted-foreground">Creative brief</Label>
          <Textarea
            ref={briefRef}
            id={briefId}
            placeholder="Golden-hour rooftop shot of the TerraRunner with the Athens skyline behind…"
            rows={3}
            value={form.creativeBrief}
            aria-invalid={Boolean(fieldErrors.brief)}
            aria-describedby={fieldErrors.brief ? `${briefId}-error` : undefined}
            onChange={(e) => {
              setForm((f) => ({ ...f, creativeBrief: e.target.value }));
              setFieldErrors((prev) => ({ ...prev, brief: undefined }));
            }}
            className={cn("rounded-xl", fieldErrors.brief && "border-rose-500")}
          />
          {fieldErrors.brief && (
            <p id={`${briefId}-error`} role="alert" className="text-[12px] text-rose-600 dark:text-rose-300">
              {fieldErrors.brief}
            </p>
          )}
        </div>
      </div>
      {submitError && (
        <p role="alert" className="mt-3 break-words text-[12.5px] text-rose-600 dark:text-rose-300">
          {submitError} Your input is preserved — fix and retry.
        </p>
      )}
      <Button
        onClick={submit}
        disabled={busy}
        aria-busy={busy}
        aria-describedby={`${uid}-submit-hint`}
        className="mt-5 rounded-full bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
      >
        {busy ? "Running preflight…" : "Create & run policy check"}
      </Button>
      <p id={`${uid}-submit-hint`} className="mt-2 text-[11.5px] text-muted-foreground">
        {busy ? "Policy check running — duplicate clicks are ignored." : "Country and creative brief are required."}
      </p>
    </div>
  );
}
