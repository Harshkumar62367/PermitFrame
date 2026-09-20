"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { ArrowLeft, BadgeCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FadeIn } from "@/components/motion-primitives";
import { PermitFrameMark } from "@/components/logo";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { CopyableIdentifier } from "@/components/ui/identifier";
import { apiGet, apiPost, describeRecord } from "@/lib/api";
import { cn } from "@/lib/utils";

interface ConsentData {
  status: "pending" | "completed";
  draft: {
    platforms: string[];
    countries: string[];
    allowedTransformations: string[];
    validUntil: string;
  };
  creator: { name: string; handle: string } | null;
}

const ALL_PLATFORMS = ["instagram", "tiktok", "youtube", "linkedin"];
const ALL_COUNTRIES = ["US", "GR", "DE", "IN", "GB"];
const ALL_TRANSFORMS = ["edit", "animate", "crop", "upscale"];

export default function ConsentPage() {
  const params = useParams<{ token: string }>();
  const uid = useId();
  const [data, setData] = useState<ConsentData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [result, setResult] = useState<{ passportId: string; ual?: string; explorerUrl?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ platforms: [] as string[], countries: [] as string[], transforms: [] as string[], validUntil: "" });
  const [fieldErrors, setFieldErrors] = useState<{ platforms?: string; countries?: string; validUntil?: string }>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  function requestConsent(signal?: AbortSignal) {
    return apiGet<ConsentData>(`/api/consent/${params.token}`, signal);
  }

  useEffect(() => {
    const controller = new AbortController();
    requestConsent(controller.signal).then(
      (d: ConsentData) => {
        setData(d);
        setForm({
          platforms: d.draft.platforms,
          countries: d.draft.countries,
          transforms: d.draft.allowedTransformations,
          validUntil: d.draft.validUntil
        });
        setLoadError(null);
      },
      (e: unknown) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setLoadError(e instanceof Error ? e.message : "Consent link failed to load.");
      }
    );
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.token]);

  async function reloadConsent() {
    try {
      const d = await requestConsent();
      setData(d);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Consent link failed to load.");
    }
  }

  function toggle(key: "platforms" | "countries" | "transforms", value: string) {
    setForm((f) => ({
      ...f,
      [key]: f[key].includes(value) ? f[key].filter((v) => v !== value) : [...f[key], value]
    }));
    setFieldErrors((p) => ({ ...p, [key === "transforms" ? "platforms" : key]: undefined }));
  }

  async function attest() {
    if (busy) return;
    const errors: typeof fieldErrors = {};
    if (form.platforms.length === 0) errors.platforms = "Choose at least one platform — otherwise the passport permits nothing.";
    if (form.countries.length === 0) errors.countries = "Choose at least one territory.";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.validUntil)) errors.validUntil = "Pick an expiry date from the calendar.";
    else if (form.validUntil <= new Date().toISOString().slice(0, 10)) errors.validUntil = "Expiry must be in the future.";
    setFieldErrors(errors);
    setSubmitError(null);
    if (errors.platforms || errors.countries || errors.validUntil) return;

    setBusy(true);
    try {
      const j = await apiPost<{ passportId: string; ual?: string; explorerUrl?: string }>(`/api/consent/${params.token}`, {
        platforms: form.platforms,
        countries: form.countries,
        allowedTransformations: form.transforms,
        validUntil: form.validUntil
      });
      setResult({ passportId: j.passportId, ual: j.ual, explorerUrl: j.explorerUrl });
    } catch (e) {
      // Selections are preserved for retry.
      setSubmitError(e instanceof Error ? e.message : "Attestation failed. Your selections are preserved.");
    } finally {
      setBusy(false);
    }
  }

  if (loadError && !data) {
    return (
      <div className="pf-page mx-auto w-full max-w-xl px-4 py-24 sm:px-6">
        <ErrorState message={loadError} onRetry={reloadConsent} />
        <Link href="/" className="mt-5 inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to PermitFrame
        </Link>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="pf-page mx-auto w-full max-w-xl px-4 py-24 sm:px-6">
        <LoadingSkeleton rows={2} />
      </div>
    );
  }

  if (result || data.status === "completed") {
    const record = describeRecord(result?.ual);
    return (
      <div className="pf-page mx-auto w-full max-w-xl px-4 py-14 sm:px-6">
        <FadeIn>
          <div className="pf-dark-scope grain relative overflow-hidden rounded-3xl bg-[#0c110f] p-6 text-center text-white sm:p-10">
            <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-emerald-400/15 ring-1 ring-emerald-400/40">
              <BadgeCheck className="h-7 w-7 text-emerald-300" aria-hidden />
            </span>
            <h1 className="font-display mt-5 text-2xl font-semibold tracking-tight">Permission attested</h1>
            <p className="mx-auto mt-2 max-w-sm text-[13.5px] leading-relaxed text-white/55">
              Your Permission Passport is live. Agencies can now produce campaigns inside
              exactly the rights you granted — nothing more.
            </p>
            <p role="status" className="mx-auto mt-4 max-w-sm text-[12px] leading-relaxed text-white/70">
              {record.headline}. {record.detail}
            </p>
            {result && (
              <div className="mx-auto mt-3 max-w-sm">
                <CopyableIdentifier value={result.passportId} label="Copy passport ID" className="justify-center text-[11px]" />
              </div>
            )}
            {result?.ual && (
              <p className="mt-2 font-mono text-[11px] text-emerald-300/90">
                {result.explorerUrl ? (
                  <a href={result.explorerUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">view in explorer</a>
                ) : (
                  <span title={result.ual}>Working Memory record — no explorer anchor yet</span>
                )}
              </p>
            )}
            {data.status === "completed" && !result && (
              <p className="mx-auto mt-4 max-w-sm text-[12px] text-white/55">
                This link was already used — the passport is recorded in the evidence layer.
              </p>
            )}
          </div>
        </FadeIn>
      </div>
    );
  }

  const canSubmit = form.platforms.length > 0 && form.countries.length > 0;
  const dateId = `${uid}-valid-until`;

  return (
    <div className="pf-page min-h-screen bg-background">
      <div className="mx-auto w-full max-w-xl px-4 py-14 sm:px-6">
        <FadeIn>
          <div className="flex items-center gap-2.5">
            <PermitFrameMark className="h-7 w-7 text-emerald-700 dark:text-emerald-300" />
            <span className="text-[15px] font-semibold tracking-tight">Permit<span className="text-emerald-600 dark:text-emerald-400">Frame</span></span>
          </div>
          <p className="mt-6 font-mono text-[10.5px] uppercase tracking-[0.18em] text-emerald-700 dark:text-emerald-300">Creator consent link</p>
          <h1 className="font-display mt-1.5 text-3xl font-semibold tracking-tight">
            {data.creator?.name} <span className="text-muted-foreground">{data.creator?.handle}</span>
          </h1>
          <p className="mt-2.5 text-[13.5px] leading-relaxed text-muted-foreground">
            Choose exactly what the agency may do with your content. This attests your
            declaration and its integrity — minimized data is published, never your personal
            details.
          </p>
        </FadeIn>

        <FadeIn delay={0.08}>
          <div className="mt-7 space-y-6 rounded-3xl border border-border bg-card p-5 sm:p-7">
            <ChoiceGroup
              label="Platforms"
              hint="Where your content may appear as paid campaigns."
              options={ALL_PLATFORMS}
              selected={form.platforms}
              error={fieldErrors.platforms}
              onToggle={(v) => toggle("platforms", v)}
            />
            <ChoiceGroup
              label="Territories"
              hint="Countries the campaigns may target."
              options={ALL_COUNTRIES}
              selected={form.countries}
              error={fieldErrors.countries}
              onToggle={(v) => toggle("countries", v)}
            />
            <ChoiceGroup
              label="Allowed transformations"
              hint="What the agency may do to your content. Optional — empty means display only."
              options={ALL_TRANSFORMS}
              selected={form.transforms}
              onToggle={(v) => toggle("transforms", v)}
            />
            <div>
              <Label htmlFor={dateId} className="text-[12px] text-muted-foreground">Valid until</Label>
              <Input
                id={dateId}
                type="date"
                value={form.validUntil}
                min={new Date().toISOString().slice(0, 10)}
                aria-invalid={Boolean(fieldErrors.validUntil)}
                aria-describedby={fieldErrors.validUntil ? `${dateId}-error` : undefined}
                onChange={(e) => {
                  setForm((f) => ({ ...f, validUntil: e.target.value }));
                  setFieldErrors((p) => ({ ...p, validUntil: undefined }));
                }}
                className="mt-1.5 rounded-xl"
              />
              {fieldErrors.validUntil && (
                <p id={`${dateId}-error`} role="alert" className="mt-1 text-[12px] text-rose-600 dark:text-rose-300">{fieldErrors.validUntil}</p>
              )}
            </div>
            <div>
              <Button
                onClick={attest}
                disabled={busy || !canSubmit}
                aria-busy={busy}
                aria-describedby={`${uid}-attest-hint`}
                title={!canSubmit ? "Choose at least one platform and one territory to enable attestation" : undefined}
                className="w-full rounded-full bg-emerald-700 py-2.5 font-medium text-emerald-50 hover:bg-emerald-600 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
              >
                {busy ? "Attesting…" : "Attest & publish my Permission Passport"}
              </Button>
              <p id={`${uid}-attest-hint`} className="mt-2 text-[11.5px] text-muted-foreground">
                {!canSubmit
                  ? "Attestation is disabled until at least one platform and one territory are chosen."
                  : busy
                    ? "Attesting — duplicate clicks are ignored and your selections are preserved on failure."
                    : "One click, one passport. Re-attesting the same link is rejected by the server."}
              </p>
            </div>
            {submitError && <p role="alert" className="break-words text-[13px] text-rose-600 dark:text-rose-300">{submitError}</p>}
          </div>
        </FadeIn>
        <Link href="/workspace" className="mt-5 inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to PermitFrame
        </Link>
      </div>
    </div>
  );
}

function ChoiceGroup({
  label,
  hint,
  options,
  selected,
  error,
  onToggle
}: {
  label: string;
  hint: string;
  options: string[];
  selected: string[];
  error?: string;
  onToggle: (value: string) => void;
}) {
  const groupId = useId();
  return (
    <fieldset>
      <legend className="text-[12px] text-muted-foreground">{label}</legend>
      <p id={`${groupId}-hint`} className="mt-0.5 text-[11px] text-muted-foreground/80">{hint}</p>
      <div className="mt-2 flex flex-wrap gap-2" role="group" aria-describedby={`${groupId}-hint${error ? ` ${groupId}-error` : ""}`}>
        {options.map((option) => {
          const active = selected.includes(option);
          return (
            <button
              key={option}
              type="button"
              onClick={() => onToggle(option)}
              aria-pressed={active}
              className={cn(
                "rounded-full px-4 py-1.5 text-[12.5px] ring-1 transition-all",
                active
                  ? "bg-emerald-700 font-medium text-emerald-50 ring-emerald-700 dark:bg-emerald-500 dark:text-emerald-950 dark:ring-emerald-500"
                  : "bg-muted/60 text-muted-foreground ring-border hover:text-foreground"
              )}
            >
              {option}
            </button>
          );
        })}
      </div>
      {error && <p id={`${groupId}-error`} role="alert" className="mt-1.5 text-[12px] text-rose-600 dark:text-rose-300">{error}</p>}
    </fieldset>
  );
}
