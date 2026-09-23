"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { AlertTriangle, ArrowRight, CalendarClock, ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DatePicker } from "@/components/ui/date-picker";
import { Label } from "@/components/ui/label";
import { FadeIn, Stagger, StaggerItem } from "@/components/motion-primitives";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { PageHeader } from "@/components/ui/page-header";
import { RightsTabs } from "@/components/rights-tabs";
import { StatusBadge } from "@/components/ui/status-badge";
import { CopyableIdentifier } from "@/components/ui/identifier";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { apiPost } from "@/lib/api";
import { CONSENT_PURPOSE_MAX } from "@/server/consent-validation";
import { consentLifecycle } from "@/server/consent-validation";
import type { SnapshotInvite } from "@/lib/use-workspace-snapshot";
import { useLongAction } from "@/lib/use-long-action";
import { useInvalidateDkgGraph } from "@/lib/use-dkg-graph";
import { useInvalidateWorkspaceSnapshot, useWorkspaceSnapshot } from "@/lib/use-workspace-snapshot";
import { cn } from "@/lib/utils";
import { CountryMultiSelect } from "@/components/country-multi-select";

interface Passport {
  id: string;
  creatorId: string;
  creatorName: string;
  status: string;
  validUntil: string;
  ual?: string;
}
interface Warning {
  passportId: string;
  creatorName: string;
  validUntil: string;
  daysLeft: number;
  level: string;
  affectedCampaigns: string[];
}

export default function ConsentsPage() {
  const uid = useId();
  // Invitations, passport summaries, and expiry warnings all read from the
  // shared ["workspace-snapshot"] cache - no separate /api/consents or
  // /api/expiry reads on mount. Cached rows render instantly and stay visible
  // during background refetches; an inline skeleton shows only when no cached
  // snapshot exists at all.
  const snapshot = useWorkspaceSnapshot();
  const invites: SnapshotInvite[] | null = snapshot.data?.consentInvites ?? null;
  const passports: Passport[] | null = snapshot.data?.passports.map((p) => ({ ...p, ual: p.ual ?? undefined })) ?? null;
  const warnings: Warning[] = snapshot.data?.warnings ?? [];
  const allMedia = snapshot.data?.sourceMedia ?? [];
  const allCreators = snapshot.data?.creators ?? [];
  function creatorNameOf(id: string): string {
    return allCreators.find((c) => c.id === id)?.name ?? id;
  }
  const loadError = !snapshot.data && snapshot.isError
    ? (snapshot.error instanceof Error ? snapshot.error.message : "Consents failed to load.")
    : null;
  const [renewFor, setRenewFor] = useState<string | null>(null);
  const [renewDate, setRenewDate] = useState("");
  const [renewError, setRenewError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<Passport | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  // Consent-request composer: 1 media → 2 usage → 3 review/send.
  const [requestOpen, setRequestOpen] = useState(false);
  const [reqStep, setReqStep] = useState<1 | 2 | 3>(1);
  const [reqMedia, setReqMedia] = useState<string[]>([]);
  const [reqPlatforms, setReqPlatforms] = useState<string[]>([]);
  const [reqCountries, setReqCountries] = useState<string[]>([]);
  // No silent defaults: empty means display-only permission.
  const [reqTransforms, setReqTransforms] = useState<string[]>([]);
  const [reqExpiry, setReqExpiry] = useState("");
  const [reqPurpose, setReqPurpose] = useState("");
  const [reqBusy, setReqBusy] = useState(false);
  const [reqError, setReqError] = useState<string | null>(null);
  const [reqLink, setReqLink] = useState<string | null>(null);
  const [reqCopied, setReqCopied] = useState(false);
  const [reqNotice, setReqNotice] = useState<string | null>(null);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [cancelConfirm, setCancelConfirm] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  // Revocation and renewal both await ledger writes (amendment / republished
  // passport) plus permission re-evaluation, so they can legitimately
  // outlast the default 30s browser budget - 120s with slow status and
  // refresh-first recovery. The invite itself is database-only and keeps the
  // normal timeout with no proof wording.
  const revokeAction = useLongAction({
    working: "Revoking permission…",
    slow: "Still revoking and recording the change. Please keep this page open - proof services can take a little longer.",
    timedOut:
      "Revoking is taking longer than expected. Refresh this page once before retrying - the revocation may already have completed."
  });
  const renewAction = useLongAction({
    working: "Renewing permission…",
    slow: "Still renewing and recording the change. Please keep this page open - proof services can take a little longer.",
    timedOut:
      "Renewal is taking longer than expected. Refresh this page once before retrying - the renewal may already have completed."
  });
  const invalidateSnapshot = useInvalidateWorkspaceSnapshot();
  const invalidateDkgGraph = useInvalidateDkgGraph();

  function toggleList(setter: (v: string[]) => void, current: string[], value: string) {
    setter(current.includes(value) ? current.filter((x) => x !== value) : [...current, value]);
    setReqError(null);
  }

  function toggleReqMedia(id: string) {
    const media = allMedia.find((m) => m.id === id);
    if (!media) return;
    if (reqMedia.includes(id)) {
      setReqMedia(reqMedia.filter((x) => x !== id));
      setReqNotice(null);
    } else if (reqMedia.length === 0) {
      setReqMedia([id]);
      setReqNotice(null);
    } else {
      const firstCreator = allMedia.find((m) => m.id === reqMedia[0])?.creatorId;
      if (media.creatorId !== firstCreator) {
        // One request covers exactly one creator - replace, never mix.
        setReqMedia([id]);
        setReqNotice(`Selection replaced - one request covers exactly one creator (${creatorNameOf(media.creatorId)}).`);
      } else {
        setReqMedia([...reqMedia, id]);
        setReqNotice(null);
      }
    }
    setReqError(null);
  }

  const reqCreatorId = allMedia.find((m) => m.id === reqMedia[0])?.creatorId ?? null;

  function resetRequestForm() {
    setReqStep(1);
    setReqMedia([]);
    setReqPlatforms([]);
    setReqCountries([]);
    setReqTransforms([]);
    setReqExpiry("");
    setReqPurpose("");
    setReqError(null);
    setReqNotice(null);
  }

  async function createRequest() {
    if (reqBusy || !reqCreatorId) return;
    if (reqMedia.length === 0) {
      setReqError("Select at least one approved media asset for this request.");
      setReqStep(1);
      return;
    }
    if (reqPlatforms.length === 0 || reqCountries.length === 0) {
      setReqError("Choose at least one platform and one territory.");
      setReqStep(2);
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(reqExpiry) || reqExpiry <= new Date().toISOString().slice(0, 10)) {
      setReqError("Permission expiry must be a future date.");
      setReqStep(2);
      return;
    }
    if (!reqPurpose.trim() || reqPurpose.trim().length > CONSENT_PURPOSE_MAX) {
      setReqError(`Describe the campaign or use purpose (1–${CONSENT_PURPOSE_MAX} characters).`);
      setReqStep(2);
      return;
    }
    setReqBusy(true);
    setReqError(null);
    setReqLink(null);
    setReqCopied(false);
    try {
      const j = await apiPost<{ token: string; url: string }>("/api/consents", {
        creatorId: reqCreatorId,
        sourceMediaIds: reqMedia,
        platforms: reqPlatforms,
        countries: reqCountries,
        allowedTransformations: reqTransforms,
        validUntil: reqExpiry,
        purpose: reqPurpose.trim()
      });
      setReqLink(j.url);
      resetRequestForm();
      await invalidateSnapshot();
    } catch (e) {
      setReqError(e instanceof Error ? e.message : "Request creation failed. Your input is preserved.");
    } finally {
      setReqBusy(false);
    }
  }

  async function copyText(text: string, done: () => void) {
    try {
      await navigator.clipboard.writeText(window.location.origin + text);
      done();
      setTimeout(() => { setReqCopied(false); setCopiedToken(null); }, 1600);
    } catch {
      setReqCopied(false);
      setCopiedToken(null);
    }
  }

  async function cancelRequest(token: string) {
    if (rowBusy) return;
    if (cancelConfirm !== token) {
      setCancelConfirm(token);
      return;
    }
    setCancelConfirm(null);
    setRowBusy(token);
    setNotice(null);
    try {
      await apiPost(`/api/consent/${token}/cancel`, {});
      setNotice({ ok: true, text: "Request cancelled - the link can no longer attest." });
      await invalidateSnapshot();
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : "Cancellation failed." });
    } finally {
      setRowBusy(null);
    }
  }

  async function replaceRequest(token: string) {
    if (rowBusy) return;
    setRowBusy(token);
    setNotice(null);
    try {
      const j = await apiPost<{ token: string; url: string }>("/api/consents", { replacesToken: token });
      setReqLink(j.url);
      setRequestOpen(true);
      setNotice({ ok: true, text: "Replacement link created - the old request was cancelled. Send the new link below." });
      await invalidateSnapshot();
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : "Replacement failed." });
    } finally {
      setRowBusy(null);
    }
  }

  async function confirmRevoke() {
    if (!revokeTarget || busyId || revokeAction.busy) return;
    const id = revokeTarget.id;
    setBusyId(id);
    setNotice(null);
    const result = await revokeAction.execute(() =>
      apiPost<{ revoked: boolean; blockedCampaigns: string[] }>(`/api/passports/${id}/revoke`, {
        note: "Revoked from the PermitFrame consents page."
      }, undefined, revokeAction.timeoutMs)
    );
    setBusyId(null);
    if (!result.ok || !result.value) {
      setNotice({ ok: false, text: result.message ?? "Revocation failed." });
      setRevokeTarget(null);
      return;
    }
    const j = result.value;
      setNotice({
        ok: true,
        text: j.revoked
          ? j.blockedCampaigns.length > 0
            ? `Rights for ${id} revoked - the permission record was updated and ${j.blockedCampaigns.length} dependent campaign(s) are now blocked by the permission check.`
            : `Rights for ${id} revoked - the permission record was updated (no active campaigns affected).`
          : `Rights for ${id} were already revoked - nothing changed.`
      });
      setRevokeTarget(null);
      // Revocation publishes an Amendment Knowledge Asset: refresh the shared
      // snapshot (awaited) and mark the cached graph stale.
      await invalidateSnapshot();
      invalidateDkgGraph();
  }

  async function renew(id: string) {
    if (busyId || renewAction.busy) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(renewDate)) {
      setRenewError("Pick a renewal date from the calendar.");
      return;
    }
    if (renewDate <= new Date().toISOString().slice(0, 10)) {
      setRenewError("Renewal must extend into the future - pick a date after today.");
      return;
    }
    setRenewError(null);
    setNotice(null);
    setBusyId(id);
    const result = await renewAction.execute(() =>
      apiPost(`/api/passports/${id}/renew`, { validUntil: renewDate }, undefined, renewAction.timeoutMs)
    );
    setBusyId(null);
    if (!result.ok) {
      setRenewError(result.message ?? "Renewal failed. The date you picked is preserved.");
      return;
    }
    setNotice({ ok: true, text: `Rights for ${id} renewed until ${renewDate} - status is active again.` });
    setRenewFor(null);
    setRenewDate("");
    // Renewal republishes the passport Knowledge Asset: same treatment.
    await invalidateSnapshot();
    invalidateDkgGraph();
  }

  const revokeWarning = revokeTarget
    ? (warnings.find((w) => w.passportId === revokeTarget.id)?.affectedCampaigns.length ?? null)
    : null;

  return (
    <div className="pf-page space-y-6">
      <FadeIn>
        <PageHeader
          eyebrow="Creator permissions"
          title="Creator permissions"
          description="Consent, territories, expiry, and permitted usage - who can appear, where, and for how long. Campaigns re-check automatically."
          actions={
            <Button onClick={() => setRequestOpen((v) => !v)} aria-expanded={requestOpen} className="rounded-full bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400">
              {requestOpen ? "Close form" : "New consent request"}
            </Button>
          }
        />
      </FadeIn>
      <FadeIn delay={0.02}>
        <RightsTabs />
      </FadeIn>

      {requestOpen && (
        <FadeIn>
          <div className="rounded-2xl border border-border bg-card p-6">
            <h3 className="text-[15px] font-semibold tracking-tight">New consent request</h3>
            <p className="mt-1 text-[12.5px] text-muted-foreground">
              Step {reqStep} of 3: {reqStep === 1 ? "select approved media" : reqStep === 2 ? "review requested usage" : "create and send request"}.
              The creator may accept as-is or narrow the terms - scope never widens after sending.
            </p>
            {reqStep === 1 && (
              <div className="mt-4">
                <p className="text-[12px] text-muted-foreground">
                  Select approved media from one creator{reqCreatorId ? ` - ${creatorNameOf(reqCreatorId)}` : ""}.
                  {reqMedia.length > 0 && ` (${reqMedia.length} selected)`}
                </p>
                {allMedia.length === 0 && (
                  <p className="mt-2 text-[12.5px] text-muted-foreground">
                    No approved media yet - register source media first, then request consent against it.
                  </p>
                )}
                <div className="mt-2 grid max-h-60 grid-cols-4 gap-2 overflow-y-auto rounded-xl border border-border bg-muted/30 p-2.5">
                  {allMedia.map((m) => {
                    const selected = reqMedia.includes(m.id);
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => toggleReqMedia(m.id)}
                        aria-pressed={selected}
                        title={`${m.title} · ${creatorNameOf(m.creatorId)}`}
                        className={cn(
                          "group overflow-hidden rounded-lg ring-1 transition",
                          selected ? "ring-2 ring-emerald-600" : "ring-border hover:ring-emerald-600/50"
                        )}
                      >
                        {m.type === "image" ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={m.url} alt={m.title} loading="lazy" className="h-44 w-full bg-black/40 object-contain" />
                        ) : (
                          <span className="grid h-44 w-full place-items-center bg-black font-mono text-[10px] text-white">video</span>
                        )}
                        <span className="block truncate bg-card px-1.5 py-1 text-left text-[10.5px] text-muted-foreground">{m.title}</span>
                      </button>
                    );
                  })}
                </div>
                {reqNotice && <p role="status" className="mt-2 text-[12px] text-amber-700 dark:text-amber-300">{reqNotice}</p>}
              </div>
            )}
            {reqStep === 2 && (
              <div className="mt-5 grid gap-x-5 gap-y-6 sm:grid-cols-2">
                <div className="space-y-2">
                  <span className="text-[12px] text-muted-foreground">Platforms</span>
                  <div className="flex flex-wrap gap-2" role="group" aria-label="Requested platforms">
                    {["instagram", "tiktok", "youtube", "linkedin"].map((p) => {
                      const selected = reqPlatforms.includes(p);
                      return (
                        <button
                          key={p}
                          type="button"
                          onClick={() => toggleList(setReqPlatforms, reqPlatforms, p)}
                          aria-pressed={selected}
                          className={cn(
                            "rounded-md px-3 py-1.5 text-[12px] font-medium capitalize ring-1 transition",
                            selected
                              ? "bg-foreground text-background ring-foreground dark:bg-white dark:text-black dark:ring-white"
                              : "bg-card text-muted-foreground ring-border hover:text-foreground"
                          )}
                        >
                          {p}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="space-y-2">
                  <span className="text-[12px] text-muted-foreground">Transformations (optional - empty means display only)</span>
                  <div className="flex flex-wrap gap-2" role="group" aria-label="Requested transformations">
                    {["edit", "animate", "crop", "upscale"].map((t) => {
                      const selected = reqTransforms.includes(t);
                      return (
                        <button
                          key={t}
                          type="button"
                          onClick={() => toggleList(setReqTransforms, reqTransforms, t)}
                          aria-pressed={selected}
                          className={cn(
                            "rounded-md px-3 py-1.5 text-[12px] font-medium capitalize ring-1 transition",
                            selected
                              ? "bg-foreground text-background ring-foreground dark:bg-white dark:text-black dark:ring-white"
                              : "bg-card text-muted-foreground ring-border hover:text-foreground"
                          )}
                        >
                          {t}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <CountryMultiSelect
                  className="max-w-xl"
                  label="Territories"
                  selected={reqCountries}
                  onToggle={(value) => toggleList(setReqCountries, reqCountries, value)}
                  onClear={() => setReqCountries([])}
                />
                <div className="space-y-2">
                  <Label htmlFor={`${uid}-req-purpose`} className="text-[12px] text-muted-foreground">
                    Campaign / use purpose{reqPurpose.trim().length > 0 && ` (${reqPurpose.trim().length}/${CONSENT_PURPOSE_MAX})`}
                  </Label>
                  <Input
                    id={`${uid}-req-purpose`}
                    value={reqPurpose}
                    maxLength={CONSENT_PURPOSE_MAX + 20}
                    onChange={(e) => { setReqPurpose(e.target.value); setReqError(null); }}
                    placeholder="Spring footwear launch across Instagram and TikTok."
                    className="h-9 rounded-md"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`${uid}-req-expiry`} className="text-[12px] text-muted-foreground">Permission expiry</Label>
                  <DatePicker
                    id={`${uid}-req-expiry`}
                    value={reqExpiry}
                    min={new Date().toISOString().slice(0, 10)}
                    onValueChange={(nextValue) => { setReqExpiry(nextValue); setReqError(null); }}
                  />
                </div>
              </div>
            )}
            {reqStep === 3 && (
              <div className="mt-4 space-y-1.5 rounded-xl bg-muted/40 p-3 text-[12.5px] ring-1 ring-border">
                <p><span className="text-muted-foreground">Creator: </span><span className="font-medium">{reqCreatorId ? creatorNameOf(reqCreatorId) : "—"}</span></p>
                <p><span className="text-muted-foreground">Media: </span>{reqMedia.length} asset{reqMedia.length === 1 ? "" : "s"}</p>
                <p><span className="text-muted-foreground">Scope: </span>{reqPlatforms.join(", ") || "—"} · {reqCountries.join(", ") || "—"} · {reqTransforms.length > 0 ? reqTransforms.join(", ") : "display only"} · to {reqExpiry || "—"}</p>
                <p><span className="text-muted-foreground">Purpose: </span>{reqPurpose.trim() || "—"}</p>
                <p className="text-muted-foreground">Request link expires 14 days after sending. Scope is frozen once sent.</p>
              </div>
            )}
            {reqError && <p role="alert" className="mt-3 break-words text-[12px] text-rose-600 dark:text-rose-300">{reqError}</p>}
            {reqLink && (
              <div role="status" className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-emerald-50 px-4 py-3 ring-1 ring-emerald-200 dark:bg-emerald-950/40 dark:ring-emerald-900">
                <Link href={reqLink} className="min-w-0 flex-1 truncate font-mono text-[12px] text-emerald-700 hover:underline dark:text-emerald-300">
                  {reqLink}
                </Link>
                <Button variant="outline" size="sm" onClick={() => void copyText(reqLink, () => setReqCopied(true))} className="h-7 rounded-full px-2.5 text-[11.5px]">
                  {reqCopied ? "Copied" : "Copy link"}
                </Button>
              </div>
            )}
            {reqLink && (
              <p role="status" className="mt-2 text-[12px] font-medium text-emerald-800 dark:text-emerald-200">
                Send this secure request link to the creator.
              </p>
            )}
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              {reqStep > 1 && (
                <Button variant="outline" size="sm" onClick={() => { setReqStep((reqStep - 1) as 1 | 2); setReqError(null); }} className="rounded-full">
                  Back
                </Button>
              )}
              {reqStep < 3 ? (
                <Button
                  size="sm"
                  onClick={() => {
                    if (reqStep === 1 && reqMedia.length === 0) {
                      setReqError("Select at least one approved media asset for this request.");
                      return;
                    }
                    setReqError(null);
                    setReqStep((reqStep + 1) as 2 | 3);
                  }}
                  className="rounded-full bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
                >
                  Continue
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={() => void createRequest()}
                  disabled={reqBusy}
                  aria-busy={reqBusy}
                  className="rounded-full bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
                >
                  {reqBusy ? "Creating…" : "Create and send request"}
                </Button>
              )}
            </div>
          </div>
        </FadeIn>
      )}

      {notice && (
        <FadeIn>
          <p
            role={notice.ok ? "status" : "alert"}
            className={cn(
              "rounded-xl px-4 py-3 text-[13px] ring-1",
              notice.ok
                ? "bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900"
                : "bg-rose-50 text-rose-800 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-200 dark:ring-rose-900"
            )}
          >
            {notice.text}
          </p>
        </FadeIn>
      )}
      {(revokeAction.busy || renewAction.busy) && (revokeAction.status ?? renewAction.status) && (
        <p role="status" className="text-[13px] leading-relaxed text-muted-foreground">
          {revokeAction.busy ? revokeAction.status : renewAction.status}
        </p>
      )}
      {loadError && <ErrorState message={loadError} onRetry={() => { void snapshot.refetch(); }} />}
      {invites !== null && passports !== null && invites.length === 0 && passports.length === 0 && !loadError && (
        <EmptyState
          title="No creator permissions yet"
          body="Add approved material to unlock campaigns: request consent against it below, or start with brand rules and media. Then brief a campaign - the permission check runs automatically."
          actions={
            <>
              <Button onClick={() => setRequestOpen(true)} className="rounded-full bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400">
                New consent request
              </Button>
              <Button asChild variant="outline" className="rounded-full">
                <Link href="/products">Add brand rules <ArrowRight className="h-3.5 w-3.5" /></Link>
              </Button>
              <Button asChild variant="outline" className="rounded-full">
                <Link href="/media">Add media <ArrowRight className="h-3.5 w-3.5" /></Link>
              </Button>
            </>
          }
        />
      )}

      {/* Expiry warnings */}
      {warnings.length > 0 && (
        <FadeIn delay={0.04}>
          <div className="space-y-2">
            {warnings.map((w) => (
              <div
                key={w.passportId}
                className={cn(
                  "flex flex-wrap items-center gap-3 rounded-xl px-4 py-3 text-[13px] ring-1",
                  w.level === "expired"
                    ? "bg-rose-50 text-rose-800 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-200 dark:ring-rose-900"
                    : "bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900"
                )}
              >
                <AlertTriangle className="h-4 w-4" />
                <span className="font-medium">
                  {w.level === "expired" ? "Expired" : w.level === "critical" ? `Expires in ${w.daysLeft}d` : `Expires in ${w.daysLeft}d`}:
                </span>
                <span>{w.creatorName} · valid to {w.validUntil}</span>
                <span className="font-mono text-[10.5px] opacity-70">{w.passportId}</span>
                <Button variant="outline" size="sm" className="ml-auto h-7 rounded-full" onClick={() => { setRenewFor(w.passportId); setRenewDate(""); }}>
                  Renew
                </Button>
              </div>
            ))}
          </div>
        </FadeIn>
      )}

      {/* Creator permissions */}
      <section aria-label="Creator permissions">
        <h2 className="mb-1 text-[15px] font-semibold tracking-tight">Creator permissions</h2>
        <p id={`${uid}-revoke-hint`} className="mb-3 text-[12px] text-muted-foreground">
          Revoking takes effect immediately: the permission record is updated and
          dependent campaigns are blocked at the next permission check. You will confirm before anything happens.
        </p>
        {!passports && !loadError && <LoadingSkeleton rows={2} />}
        <Stagger className="space-y-3">
          {(passports ?? []).map((p) => (
              <StaggerItem key={p.id}>
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-4 rounded-2xl border border-border bg-card p-5">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <p className="text-[14.5px] font-semibold">{p.creatorName}</p>
                      <StatusBadge status={p.status} />
                    </div>
                    <p className="mt-1.5 flex flex-wrap items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted-foreground">
                      <CalendarClock className="h-3.5 w-3.5 shrink-0" aria-hidden /> valid to {p.validUntil}
                    </p>
                    <CopyableIdentifier value={p.id} className="mt-1 max-w-full" />
                  </div>
                  <div className="flex gap-2">
                    {p.status === "active" && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => { setRenewFor(p.id); setRenewDate(""); setRenewError(null); }}
                        disabled={busyId !== null}
                        className="rounded-full"
                      >
                        <CalendarClock className="h-3.5 w-3.5" aria-hidden /> {busyId === p.id ? "Working…" : "Renew"}
                      </Button>
                    )}
                    {p.status === "active" && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setRevokeTarget(p)}
                        disabled={busyId !== null}
                        aria-describedby={`${uid}-revoke-hint`}
                        className="rounded-full border-rose-300 text-rose-700 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-300 dark:hover:bg-rose-950"
                      >
                        <ShieldOff className="h-3.5 w-3.5" aria-hidden /> {busyId === p.id ? "Revoking…" : "Revoke"}
                      </Button>
                    )}
                  </div>
                </div>
                {renewFor === p.id && (
                  <div className="mt-2 space-y-2 rounded-xl border border-dashed border-border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Label htmlFor={`${uid}-renew-${p.id}`} className="text-[12px] text-muted-foreground">New expiry date</Label>
                      <DatePicker
                        id={`${uid}-renew-${p.id}`}
                        value={renewDate}
                        min={new Date().toISOString().slice(0, 10)}
                        aria-invalid={Boolean(renewError)}
                        onValueChange={(nextValue) => { setRenewDate(nextValue); setRenewError(null); }}
                        className="w-44"
                      />
                      <Button
                        size="sm"
                        onClick={() => renew(p.id)}
                        disabled={busyId !== null || !renewDate}
                        aria-busy={busyId === p.id}
                        title={!renewDate ? "Pick a future date to enable renewal" : undefined}
                        className="h-9 rounded-lg bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
                      >
                        {busyId === p.id ? "Renewing…" : "Confirm renewal"}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => { setRenewFor(null); setRenewError(null); }} disabled={busyId !== null} className="h-9 rounded-lg">
                        Cancel
                      </Button>
                    </div>
                    {renewError && <p role="alert" className="text-[12px] text-rose-600 dark:text-rose-300">{renewError}</p>}
                  </div>
                )}
              </StaggerItem>
          ))}
        </Stagger>
      </section>

      {/* Consent requests */}
      <section>
        <h2 className="mb-3 text-[15px] font-semibold tracking-tight">Consent requests</h2>
        <Stagger className="space-y-3">
          {(invites ?? []).map((invite) => {
            const lifecycle = consentLifecycle(invite);
            const mediaIds = invite.draft.sourceMediaIds ?? [];
            const legacyMedia = mediaIds.length === 0;
            const thumbs = mediaIds
              .map((id) => allMedia.find((m) => m.id === id))
              .filter((m): m is (typeof allMedia)[number] => Boolean(m))
              .slice(0, 4);
            const live = lifecycle === "pending" || lifecycle === "viewed";
            const replaceable = live || lifecycle === "expired" || lifecycle === "cancelled";
            return (
              <StaggerItem key={invite.token}>
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-4 rounded-2xl border border-border bg-card p-5">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <p className="text-[14.5px] font-semibold">{creatorNameOf(invite.creatorId)}</p>
                      <StatusBadge status={lifecycle} />
                      {legacyMedia && (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-[10.5px] font-medium text-muted-foreground ring-1 ring-border">
                          Legacy request — no media was attached.
                        </span>
                      )}
                      {invite.replacedBy && (
                        <span className="text-[11px] text-muted-foreground">Replaced by a newer link.</span>
                      )}
                    </div>
                    {thumbs.length > 0 && (
                      <div className="mt-2 flex gap-1.5">
                        {thumbs.map((m) => (
                          m.type === "image" ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img key={m.id} src={m.url} alt={m.title} loading="lazy" title={m.title} className="h-11 w-11 rounded-lg object-cover ring-1 ring-border" />
                          ) : (
                            <span key={m.id} title={m.title} className="grid h-11 w-11 place-items-center rounded-lg bg-black font-mono text-[9px] text-white ring-1 ring-border">
                              video
                            </span>
                          )
                        ))}
                        {mediaIds.length > thumbs.length && (
                          <span className="grid h-11 w-11 place-items-center rounded-lg bg-muted font-mono text-[10px] text-muted-foreground ring-1 ring-border">
                            +{mediaIds.length - thumbs.length}
                          </span>
                        )}
                      </div>
                    )}
                    <p className="mt-1.5 break-words text-[12px] text-muted-foreground">
                      {invite.purpose || "No purpose recorded (legacy request)."}
                    </p>
                    <p className="mt-0.5 font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted-foreground">
                      {invite.draft.platforms.join(", ")} · {invite.draft.countries.join(", ")} · to {invite.draft.validUntil}
                    </p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      Request link {invite.linkExpiresAt ? `expires ${invite.linkExpiresAt}` : "has no link expiry (legacy)"}
                      {invite.decision?.outcome === "declined" && invite.decision.note ? ` · declined: ${invite.decision.note}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    {live && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void copyText(`/consent/${invite.token}`, () => setCopiedToken(invite.token))}
                        className="rounded-full"
                      >
                        {copiedToken === invite.token ? "Copied" : "Copy link"}
                      </Button>
                    )}
                    {live && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void cancelRequest(invite.token)}
                        disabled={rowBusy !== null}
                        className="rounded-full border-rose-300 text-rose-700 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-300 dark:hover:bg-rose-950"
                      >
                        {cancelConfirm === invite.token ? "Confirm cancel" : rowBusy === invite.token ? "Working…" : "Cancel request"}
                      </Button>
                    )}
                    {replaceable && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void replaceRequest(invite.token)}
                        disabled={rowBusy !== null}
                        className="rounded-full"
                      >
                        {rowBusy === invite.token ? "Working…" : "Create replacement link"}
                      </Button>
                    )}
                  </div>
                </div>
              </StaggerItem>
            );
          })}
        </Stagger>
      </section>
      <ConfirmDialog
        open={revokeTarget !== null}
        title={`Revoke ${revokeTarget?.creatorName ?? "this"}’s rights?`}
        consequence={
          revokeWarning !== null && revokeWarning > 0
            ? `This updates the permission record for ${revokeTarget?.id}. ${revokeWarning} dependent campaign(s) will immediately block at the permission check. The rights record itself is kept for audit - nothing is deleted.`
            : `This updates the permission record for ${revokeTarget?.id}. Dependent campaigns of this creator will be re-checked. The rights record itself is kept for audit - nothing is deleted.`
        }
        confirmLabel="Yes, revoke it"
        pending={busyId !== null}
        pendingLabel="Revoking…"
        onConfirm={confirmRevoke}
        onCancel={() => (busyId ? undefined : setRevokeTarget(null))}
      />
    </div>
  );
}
