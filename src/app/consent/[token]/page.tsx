"use client";

import { useParams } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { BadgeCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DatePicker } from "@/components/ui/date-picker";
import { Label } from "@/components/ui/label";
import { FadeIn } from "@/components/motion-primitives";
import { PermitFrameMark } from "@/components/logo";
import { CountryMultiSelect } from "@/components/country-multi-select";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { CopyableIdentifier } from "@/components/ui/identifier";
import { apiGet, apiPost } from "@/lib/api";
import { consentCompletionCopy } from "@/server/consent-validation";
import { useLongAction } from "@/lib/use-long-action";
import { cn } from "@/lib/utils";

interface ConsentMedia {
  title: string;
  type: "image" | "video";
  url?: string;
  previewIndex?: number;
  isPrivateUpload: boolean;
}

interface ConsentData {
  status: "pending" | "viewed" | "approved" | "declined" | "expired" | "cancelled";
  draft: {
    platforms: string[];
    countries: string[];
    allowedTransformations: string[];
    validUntil: string;
  };
  purpose: string;
  media: ConsentMedia[];
  linkExpiresAt?: string;
  /** Present on approved links only: proof status of this exact link's passport. */
  publicationStatus?: "published" | "saved" | "unknown";
  creator: { name: string; handle: string } | null;
}
const ALL_PLATFORMS = ["instagram", "tiktok", "youtube", "linkedin"];

// Full ISO territory list (values stay 2-letter codes — the server contract
// is unchanged); the five-country shortlist used to hide valid options.
const ALL_TRANSFORMS = ["edit", "animate", "crop", "upscale"];

export default function ConsentPage() {
  const params = useParams<{ token: string }>();
  const uid = useId();
  const [data, setData] = useState<ConsentData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [result, setResult] = useState<{ passportId: string; ual?: string; explorerUrl?: string } | null>(null);
  // Attestation creates the passport and publishes it, so it can
  // legitimately outlast the default 30s browser budget - 120s with slow
  // status and refresh-first recovery. Selections are preserved either way,
  // and the server rejects a second attestation of the same link.
  const attestAction = useLongAction({
    working: "Recording your permission…",
    slow: "Still recording your permission. Please keep this page open - proof services can take a little longer.",
    timedOut:
      "Recording is taking longer than expected. Refresh this page once before retrying - your permission may already have been recorded."
  });
  const busy = attestAction.busy;
  const [form, setForm] = useState({ platforms: [] as string[], countries: [] as string[], transforms: [] as string[], validUntil: "" });
  const [fieldErrors, setFieldErrors] = useState<{ platforms?: string; countries?: string; validUntil?: string }>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Two explicit acknowledgements, both required before approval.
  const [acks, setAcks] = useState({ rights: false, use: false });
  const [ackError, setAckError] = useState<string | null>(null);
  const [declining, setDeclining] = useState(false);
  const [declineNote, setDeclineNote] = useState("");
  const [declineBusy, setDeclineBusy] = useState(false);
  const [declinedDone, setDeclinedDone] = useState(false);

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
    if (attestAction.busy) return;
    const errors: typeof fieldErrors = {};
    if (form.platforms.length === 0) errors.platforms = "Choose at least one platform - otherwise the passport permits nothing.";
    if (form.countries.length === 0) errors.countries = "Choose at least one territory.";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.validUntil)) errors.validUntil = "Pick an expiry date from the calendar.";
    else if (form.validUntil <= new Date().toISOString().slice(0, 10)) errors.validUntil = "Expiry must be in the future.";
    // Mirror of the authoritative server rule: the offered expiry can only
    // be shortened, never extended. Never silently clamped.
    else if (data && form.validUntil > data.draft.validUntil) errors.validUntil = "Attestation can only shorten the offered expiry, not extend it.";
    setFieldErrors(errors);
    const acksOk = acks.rights && acks.use;
    setAckError(acksOk ? null : "Please confirm both acknowledgement statements to attest.");
    setSubmitError(null);
    if (errors.platforms || errors.countries || errors.validUntil || !acksOk) return;

    const result = await attestAction.execute(() =>
      apiPost<{ passportId: string; ual?: string; explorerUrl?: string }>(`/api/consent/${params.token}`, {
        platforms: form.platforms,
        countries: form.countries,
        allowedTransformations: form.transforms,
        validUntil: form.validUntil,
        acknowledgements: [true, true]
      }, undefined, attestAction.timeoutMs)
    );
    if (!result.ok || !result.value) {
      // Selections are preserved for retry.
      if (result.message) setSubmitError(result.message);
      return;
    }
    setResult({ passportId: result.value.passportId, ual: result.value.ual, explorerUrl: result.value.explorerUrl });
  }

  async function decline() {
    if (declineBusy) return;
    setDeclineBusy(true);
    setSubmitError(null);
    try {
      await apiPost(`/api/consent/${params.token}/decline`, declineNote.trim() ? { note: declineNote.trim() } : {});
      setDeclining(false);
      setDeclinedDone(true);
      await reloadConsent();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "Decline failed - nothing was changed.");
    } finally {
      setDeclineBusy(false);
    }
  }

  if (loadError && !data) {
    return (
      <div className="pf-page mx-auto w-full max-w-xl px-4 py-24 sm:px-6">
        <ErrorState message={loadError} onRetry={reloadConsent} />
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

  if (result || data.status === "approved") {
    // Publication-status-aware wording per exact link: a fresh UAL earns
    // published; a fresh local save is saved; a reload trusts the GET
    // status (derived from this link's passport only), defaulting to
    // unknown for legacy links that carry no proof state.
    const completionState = result?.ual
      ? "published"
      : result
        ? "saved"
        : data.status === "approved"
          ? (data.publicationStatus ?? "unknown")
          : "unknown";
    const copy = consentCompletionCopy(completionState);
    return (
      <div className="pf-page mx-auto w-full max-w-xl px-4 py-14 sm:px-6">
        <FadeIn>
          <div className="pf-dark-scope grain relative overflow-hidden rounded-3xl bg-[#0c110f] p-6 text-center text-white sm:p-10">
            <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-emerald-400/15 ring-1 ring-emerald-400/40">
              <BadgeCheck className="h-7 w-7 text-emerald-300" aria-hidden />
            </span>
            <h1 className="font-display mt-5 text-2xl font-semibold tracking-tight">Permission attested</h1>
            <p className="mx-auto mt-2 max-w-sm text-[13.5px] leading-relaxed text-white/55">
              {copy.lead} Agencies can now produce campaigns inside
              exactly the rights you granted - nothing more.
            </p>
            <p role="status" className="mx-auto mt-4 max-w-sm text-[12px] leading-relaxed text-white/70">
              {copy.status}
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
                  <span title={result.ual}>Working Memory record - no explorer anchor yet</span>
                )}
              </p>
            )}
            {data.status === "approved" && !result && (
              <p className="mx-auto mt-4 max-w-sm text-[12px] text-white/55">
                This link was already used - the passport is recorded in the evidence layer.
              </p>
            )}
          </div>
        </FadeIn>
      </div>
    );
  }

  if (declinedDone || data.status === "declined") {
    return (
      <div className="pf-page mx-auto w-full max-w-xl px-4 py-14 sm:px-6">
        <FadeIn>
          <div className="rounded-3xl border border-border bg-card p-6 text-center sm:p-10">
            <h1 className="font-display text-2xl font-semibold tracking-tight">Request declined</h1>
            <p className="mx-auto mt-2 max-w-sm text-[13.5px] leading-relaxed text-muted-foreground">
              You declined this permission request. No permission was recorded and nothing was published.
            </p>
          </div>
        </FadeIn>
      </div>
    );
  }

  if (data.status === "expired" || data.status === "cancelled") {
    return (
      <div className="pf-page mx-auto w-full max-w-xl px-4 py-14 sm:px-6">
        <FadeIn>
          <div className="rounded-3xl border border-border bg-card p-6 text-center sm:p-10">
            <h1 className="font-display text-2xl font-semibold tracking-tight">
              {data.status === "expired" ? "Request link expired" : "Request cancelled"}
            </h1>
            <p className="mx-auto mt-2 max-w-sm text-[13.5px] leading-relaxed text-muted-foreground">
              {data.status === "expired"
                ? "This request link has expired - ask the agency for a fresh link."
                : "This request was cancelled - ask the agency for a fresh link."}
            </p>
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
            An agency using PermitFrame is requesting permission to use your material.
            Review exactly what is covered below. You may narrow these terms, or decline.
          </p>
        </FadeIn>

        <FadeIn delay={0.05}>
          <div className="mt-5 space-y-2 rounded-3xl border border-border bg-card p-5 sm:p-6">
            <h2 className="text-[14px] font-semibold tracking-tight">Requested use</h2>
            {data.purpose && <p className="text-[13px] leading-relaxed">{data.purpose}</p>}
            {data.media.length > 0 ? (
              <div className="grid grid-cols-3 gap-2 pt-1 sm:grid-cols-4">
                {data.media.map((m, index) => (
                  <div key={`consent-media-${index}`} className="overflow-hidden rounded-lg ring-1 ring-border">
                    {m.isPrivateUpload && m.type === "image" && typeof m.previewIndex === "number" ? (
                      // The invitation token scopes this same-origin preview
                      // to exactly this request; no Cloudinary URL is sent to
                      // the creator's browser.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={`/api/consent/${params.token}/media/${m.previewIndex}/preview`} alt={m.title} loading="lazy" className="aspect-square w-full object-cover" />
                    ) : m.isPrivateUpload || !m.url ? (
                      <span className="grid aspect-square w-full place-items-center bg-muted px-1 text-center font-mono text-[9px] text-muted-foreground" title={`${m.title} (private workspace copy - no preview)`}>
                        Private workspace copy{m.type === "video" ? " - video preview unavailable" : ""}
                      </span>
                    ) : m.type === "image" ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={m.url} alt={m.title} loading="lazy" className="aspect-square w-full object-cover" />
                    ) : (
                      <span className="grid aspect-square w-full place-items-center bg-black font-mono text-[10px] text-white">video</span>
                    )}
                    <p className="truncate bg-card px-1.5 py-1 text-[10.5px] text-muted-foreground" title={m.title}>{m.title}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[12px] font-medium text-muted-foreground">Legacy request - no media was attached.</p>
            )}
            <dl className="space-y-1 pt-1 text-[12.5px]">
              <div className="flex gap-2">
                <dt className="shrink-0 text-muted-foreground">Platforms</dt>
                <dd className="font-medium capitalize">{data.draft.platforms.join(", ")}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="shrink-0 text-muted-foreground">Territories</dt>
                <dd className="font-medium">{data.draft.countries.join(", ")}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="shrink-0 text-muted-foreground">Transformations</dt>
                <dd className="font-medium">{data.draft.allowedTransformations.length > 0 ? data.draft.allowedTransformations.join(", ") : "display only"}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="shrink-0 text-muted-foreground">Permission ends</dt>
                <dd className="font-medium">{data.draft.validUntil}</dd>
              </div>
              {data.linkExpiresAt && (
                <div className="flex gap-2">
                  <dt className="shrink-0 text-muted-foreground">This link expires</dt>
                  <dd className="font-medium">{data.linkExpiresAt}</dd>
                </div>
              )}
            </dl>
            <p className="break-words pt-1 text-[12px] leading-relaxed text-muted-foreground">
              This is a link-based creator attestation. PermitFrame records your declaration and the approved scope; it does not independently verify your identity or legal ownership.
            </p>
          </div>
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
            <CountryMultiSelect
              label="Territories"
              hint="Countries the campaigns may target."
              selected={form.countries}
              allowedCodes={data.draft.countries}
              error={fieldErrors.countries}
              onToggle={(v) => toggle("countries", v)}
              onClear={() => {
                setForm((current) => ({ ...current, countries: [] }));
                setFieldErrors((current) => ({ ...current, countries: undefined }));
              }}
            />
            <ChoiceGroup
              label="Allowed transformations"
              hint="What the agency may do to your content. Optional - empty means display only."
              options={ALL_TRANSFORMS}
              selected={form.transforms}
              onToggle={(v) => toggle("transforms", v)}
            />
            <div>
              <Label htmlFor={dateId} className="text-[12px] text-muted-foreground">Valid until</Label>
              <DatePicker
                id={dateId}
                value={form.validUntil}
                min={new Date().toISOString().slice(0, 10)}
                max={data.draft.validUntil}
                aria-invalid={Boolean(fieldErrors.validUntil)}
                aria-describedby={fieldErrors.validUntil ? `${dateId}-error` : undefined}
                onValueChange={(nextValue) => {
                  setForm((f) => ({ ...f, validUntil: nextValue }));
                  setFieldErrors((p) => ({ ...p, validUntil: undefined }));
                }}
                className="mt-1.5"
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
                {busy ? "Attesting…" : "Attest my permission"}
              </Button>
              <p id={`${uid}-attest-hint`} className={cn("mt-2 text-[11.5px]", busy && attestAction.status ? "text-emerald-700 dark:text-emerald-300" : "text-muted-foreground")}>
                {!canSubmit
                  ? "Attestation is disabled until at least one platform and one territory are chosen."
                  : busy && attestAction.status
                    ? attestAction.status
                    : "One click, one passport. Re-attesting the same link is rejected by the server."}
              </p>
            </div>
            <fieldset>
              <legend className="text-[12px] text-muted-foreground">Before you attest</legend>
              <div className="mt-2 space-y-2">
                {(
                  [
                    ["rights", "I control the rights to the listed material."],
                    ["use", "I approve the selected use until the stated expiry."]
                  ] as const
                ).map(([key, label]) => (
                  <label key={key} className="flex cursor-pointer items-start gap-2.5 text-[12.5px] leading-relaxed">
                    <input
                      type="checkbox"
                      checked={acks[key]}
                      onChange={(e) => {
                        setAcks((a) => ({ ...a, [key]: e.target.checked }));
                        setAckError(null);
                      }}
                      className="mt-0.5 h-4 w-4 shrink-0 accent-emerald-700"
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
              {ackError && <p role="alert" className="mt-1 text-[12px] text-rose-600 dark:text-rose-300">{ackError}</p>}
            </fieldset>
            <div className="border-t border-border pt-4">
              {!declining ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDeclining(true)}
                  disabled={busy || declineBusy}
                  className="h-8 rounded-full px-3 text-[12px] text-muted-foreground hover:text-foreground"
                >
                  Decline request
                </Button>
              ) : (
                <div className="space-y-2">
                  <Label htmlFor={`${uid}-decline-note`} className="text-[12px] text-muted-foreground">
                    Decline note (optional, stays with the agency record)
                  </Label>
                  <Input
                    id={`${uid}-decline-note`}
                    value={declineNote}
                    maxLength={520}
                    onChange={(e) => setDeclineNote(e.target.value)}
                    placeholder="Why this use does not work for you."
                    className="rounded-xl"
                  />
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void decline()}
                      disabled={declineBusy}
                      aria-busy={declineBusy}
                      className="h-8 rounded-full border-rose-300 px-3 text-[12px] text-rose-700 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-300 dark:hover:bg-rose-950"
                    >
                      {declineBusy ? "Declining…" : "Confirm decline"}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setDeclining(false)} disabled={declineBusy} className="h-8 rounded-full px-3 text-[12px]">
                      Back
                    </Button>
                  </div>
                  <p className="text-[11.5px] text-muted-foreground">Declining records no permission and publishes nothing.</p>
                </div>
              )}
            </div>
            {submitError && <p role="alert" className="break-words text-[13px] text-rose-600 dark:text-rose-300">{submitError}</p>}
          </div>
        </FadeIn>
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
  onToggle,
  optionLabel
}: {
  label: string;
  hint: string;
  options: string[];
  selected: string[];
  error?: string;
  onToggle: (value: string) => void;
  optionLabel?: (value: string) => string;
}) {
  const groupId = useId();
  return (
    <fieldset>
      <legend className="text-[12px] text-muted-foreground">{label}</legend>
      <p id={`${groupId}-hint`} className="mt-0.5 text-[11px] text-muted-foreground/80">{hint}</p>
      <div className="mt-2 flex max-h-64 flex-wrap gap-2 overflow-y-auto pr-1" role="group" aria-describedby={`${groupId}-hint${error ? ` ${groupId}-error` : ""}`}>
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
              {optionLabel ? optionLabel(option) : option}
            </button>
          );
        })}
      </div>
      {error && <p id={`${groupId}-error`} role="alert" className="mt-1.5 text-[12px] text-rose-600 dark:text-rose-300">{error}</p>}
    </fieldset>
  );
}
