"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
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
import { stableAttemptKey } from "@/lib/idempotency-key";
import { useInvalidateWorkspaceSnapshot, useWorkspaceSnapshot } from "@/lib/use-workspace-snapshot";
import { cn } from "@/lib/utils";

const PLATFORMS = ["instagram", "tiktok", "youtube", "linkedin"];

interface FieldErrors {
  country?: string;
  brief?: string;
  permission?: string;
  media?: string;
  facts?: string;
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
    creativeBrief: "",
    passportId: "",
    sourceMediaId: "",
    productFactsId: ""
  });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const invalidateSnapshot = useInvalidateWorkspaceSnapshot();
  const workspace = useWorkspaceSnapshot();
  const today = new Date().toISOString().slice(0, 10);
  // Only active, unexpired permissions are offerable — expired or revoked
  // rows never reach the selector, so they cannot be submitted.
  const offerablePassports = (workspace.data?.passports ?? []).filter(
    (p) => p.status === "active" && p.validUntil >= today
  );
  const creatorName = (id: string) =>
    workspace.data?.creators.find((c) => c.id === id)?.name ?? id;
  const chosenPassport = offerablePassports.find((p) => p.id === form.passportId) ?? null;
  // Media is always scoped to the chosen permission's creator — other
  // creators' items are excluded, never silently substituted.
  const mediaForCreator = (workspace.data?.sourceMedia ?? []).filter(
    (m) => chosenPassport && m.creatorId === chosenPassport.creatorId
  );
  const brandRules = workspace.data?.productFacts ?? [];
  const workspaceLoading = workspace.isPending;
  const readyToSubmit =
    !workspaceLoading && form.passportId !== "" && form.sourceMediaId !== "" && form.productFactsId !== "";
  // Idempotency key for the current submission attempt. Reused only while the
  // payload is byte-identical (a retry of the same submission replays the
  // original campaign server-side instead of creating a duplicate); any edit
  // mints a fresh key so an intentional new submission always creates anew.
  const attemptRef = useRef<{ payload: string; key: string } | null>(null);
  function validate(): FieldErrors {
    const errors: FieldErrors = {};
    if (!form.passportId) errors.permission = "Choose a creator permission — campaigns never pick one automatically.";
    if (!form.sourceMediaId) errors.media = "Choose the source media for this campaign.";
    if (!form.productFactsId) errors.facts = "Choose a brand rule for this campaign.";
    if (form.country.trim().length !== 2) errors.country = "Use a 2-letter country code (e.g. GR for Greece, DE for Germany).";
    if (!form.creativeBrief.trim()) errors.brief = "Describe the shot — the studio generates from this brief.";
    else if (form.creativeBrief.trim().length < 12) errors.brief = "Give the brief a little more to work with (12+ characters).";
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
      const payload = {
        title: form.title.trim() || `${form.platform} campaign — ${form.country.trim().toUpperCase()}`,
        platform: form.platform,
        country: form.country.trim().toUpperCase(),
        requestedClaims: form.claims.split(",").map((c) => c.trim()).filter(Boolean),
        transformation: form.transformation,
        creativeBrief: form.creativeBrief.trim(),
        creatorId: chosenPassport?.creatorId ?? "",
        passportId: form.passportId,
        sourceMediaId: form.sourceMediaId,
        productFactsId: form.productFactsId
      };
      const serialized = JSON.stringify(payload);
      attemptRef.current = stableAttemptKey(attemptRef.current, serialized, () => crypto.randomUUID());
      // Creation consults the live ledger (rights + facts reads) before the
      // permission check returns, so it legitimately takes longer than an
      // ordinary write — budget two minutes, still abortable. A client abort
      // after server-side persistence is safe: retrying with the same key
      // replays the original campaign instead of duplicating it.
      const json = await apiPost<{ campaign: { id: string }; deduplicated?: boolean }>(
        "/api/campaigns",
        { ...payload, idempotencyKey: attemptRef.current.key },
        undefined,
        120_000
      );
      // The new campaign changes visible workspace data — refresh the
      // shared snapshot in the background before navigating.
      invalidateSnapshot();
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
        Every campaign is checked against approved rights and brand rules the moment you create it — cleared or blocked, with reasons.
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
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor={`${uid}-permission`} className="text-[12px] text-muted-foreground">Creator permission</Label>
          <Select
            value={form.passportId}
            disabled={workspaceLoading}
            onValueChange={(v) => {
              setForm((f) => ({ ...f, passportId: v, sourceMediaId: "" }));
              setFieldErrors((prev) => ({ ...prev, permission: undefined }));
            }}
          >
            <SelectTrigger id={`${uid}-permission`} className="w-full rounded-xl"><SelectValue placeholder={workspaceLoading ? "Loading workspace…" : "Choose whose permission applies"} /></SelectTrigger>
            <SelectContent>
              {offerablePassports.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.creatorName} — {p.platforms.join(", ")} · {p.countries.join(", ")} · until {p.validUntil}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {chosenPassport ? (
            <p className="text-[11.5px] text-muted-foreground">
              Allows {chosenPassport.allowedTransformations.join(", ")} · expires {chosenPassport.validUntil}
            </p>
          ) : (
            !workspaceLoading && offerablePassports.length === 0 && (
              <p className="text-[12px] text-muted-foreground">
                No active permissions yet. <Link href="/consents" className="font-medium text-emerald-700 hover:underline dark:text-emerald-300">Invite a creator</Link> first.
              </p>
            )
          )}
          {fieldErrors.permission && (
            <p role="alert" className="text-[12px] text-rose-600 dark:text-rose-300">{fieldErrors.permission}</p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${uid}-media`} className="text-[12px] text-muted-foreground">Source media</Label>
          <Select
            value={form.sourceMediaId}
            disabled={workspaceLoading || !chosenPassport}
            onValueChange={(v) => {
              setForm((f) => ({ ...f, sourceMediaId: v }));
              setFieldErrors((prev) => ({ ...prev, media: undefined }));
            }}
          >
            <SelectTrigger id={`${uid}-media`} className="w-full rounded-xl"><SelectValue placeholder={chosenPassport ? "Choose approved media" : "Pick a permission first"} /></SelectTrigger>
            <SelectContent>
              {mediaForCreator.map((m) => (
                <SelectItem key={m.id} value={m.id}>{m.title} ({m.type})</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {chosenPassport && (
            <p className="text-[11.5px] text-muted-foreground">
              Only {creatorName(chosenPassport.creatorId)}&apos;s approved media is listed.{" "}
              {mediaForCreator.length === 0 && (
                <Link href="/media" className="font-medium text-emerald-700 hover:underline dark:text-emerald-300">Register media</Link>
              )}
            </p>
          )}
          {fieldErrors.media && (
            <p role="alert" className="text-[12px] text-rose-600 dark:text-rose-300">{fieldErrors.media}</p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${uid}-facts`} className="text-[12px] text-muted-foreground">Brand rule</Label>
          <Select
            value={form.productFactsId}
            disabled={workspaceLoading}
            onValueChange={(v) => {
              setForm((f) => ({ ...f, productFactsId: v }));
              setFieldErrors((prev) => ({ ...prev, facts: undefined }));
            }}
          >
            <SelectTrigger id={`${uid}-facts`} className="w-full rounded-xl"><SelectValue placeholder={workspaceLoading ? "Loading workspace…" : "Choose a brand rule"} /></SelectTrigger>
            <SelectContent>
              {brandRules.map((f) => (
                <SelectItem key={f.id} value={f.id}>{f.brand} — {f.productName} ({f.approvedClaims.length} approved claims)</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!workspaceLoading && brandRules.length === 0 && (
            <p className="text-[12px] text-muted-foreground">
              No brand rules yet. <Link href="/products" className="font-medium text-emerald-700 hover:underline dark:text-emerald-300">Define one</Link> first.
            </p>
          )}
          {fieldErrors.facts && (
            <p role="alert" className="text-[12px] text-rose-600 dark:text-rose-300">{fieldErrors.facts}</p>
          )}
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
        disabled={busy || !readyToSubmit}
        aria-busy={busy}
        aria-describedby={`${uid}-submit-hint`}
        title={!readyToSubmit && !busy ? "Choose a permission, media, and brand rule first" : undefined}
        className="mt-5 rounded-full bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
      >
        {busy ? "Running permission check…" : "Create & run permission check"}
      </Button>
      <p id={`${uid}-submit-hint`} className="mt-2 text-[11.5px] text-muted-foreground">
        {busy ? "Permission check running — duplicate clicks are ignored, and a retry of this same submission reuses its result. Checking the ledger can take up to a minute." : "Country, creative brief, permission, media, and brand rule are required."}
      </p>
    </div>
  );
}
