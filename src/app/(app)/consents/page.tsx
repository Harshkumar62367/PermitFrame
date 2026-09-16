"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { AlertTriangle, ArrowRight, CalendarClock, ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FadeIn, Stagger, StaggerItem } from "@/components/motion-primitives";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/ui/status-badge";
import { CopyableIdentifier } from "@/components/ui/identifier";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { apiPost } from "@/lib/api";
import { useInvalidateDkgGraph } from "@/lib/use-dkg-graph";
import { useInvalidateWorkspaceSnapshot, useWorkspaceSnapshot } from "@/lib/use-workspace-snapshot";
import { cn } from "@/lib/utils";

interface Invite {
  token: string;
  creatorId: string;
  status: "pending" | "completed";
  draft: { platforms: string[]; countries: string[]; validUntil: string };
}
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
  // shared ["workspace-snapshot"] cache — no separate /api/consents or
  // /api/expiry reads on mount. Cached rows render instantly and stay visible
  // during background refetches; an inline skeleton shows only when no cached
  // snapshot exists at all.
  const snapshot = useWorkspaceSnapshot();
  const invites: Invite[] | null = snapshot.data?.consentInvites ?? null;
  const passports: Passport[] | null = snapshot.data?.passports.map((p) => ({ ...p, ual: p.ual ?? undefined })) ?? null;
  const warnings: Warning[] = snapshot.data?.warnings ?? [];
  const loadError = !snapshot.data && snapshot.isError
    ? (snapshot.error instanceof Error ? snapshot.error.message : "Consents failed to load.")
    : null;
  const [renewFor, setRenewFor] = useState<string | null>(null);
  const [renewDate, setRenewDate] = useState("");
  const [renewError, setRenewError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<Passport | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const invalidateSnapshot = useInvalidateWorkspaceSnapshot();
  const invalidateDkgGraph = useInvalidateDkgGraph();

  async function confirmRevoke() {
    if (!revokeTarget || busyId) return;
    const id = revokeTarget.id;
    setBusyId(id);
    setNotice(null);
    try {
      const j = await apiPost<{ revoked: boolean; blockedCampaigns: string[] }>(`/api/passports/${id}/revoke`, {
        note: "Revoked from the PermitFrame consents page."
      });
      setNotice({
        ok: true,
        text: j.revoked
          ? j.blockedCampaigns.length > 0
            ? `Passport ${id} revoked — an Amendment Knowledge Asset was published and ${j.blockedCampaigns.length} dependent campaign(s) are now blocked by preflight.`
            : `Passport ${id} revoked — an Amendment Knowledge Asset was published (no active campaigns affected).`
          : `Passport ${id} was already revoked — nothing changed.`
      });
      setRevokeTarget(null);
      // Revocation publishes an Amendment Knowledge Asset: refresh the shared
      // snapshot (awaited) and mark the cached graph stale.
      await invalidateSnapshot();
      invalidateDkgGraph();
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : "Revocation failed." });
      setRevokeTarget(null);
    } finally {
      setBusyId(null);
    }
  }

  async function renew(id: string) {
    if (busyId) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(renewDate)) {
      setRenewError("Pick a renewal date from the calendar.");
      return;
    }
    if (renewDate <= new Date().toISOString().slice(0, 10)) {
      setRenewError("Renewal must extend into the future — pick a date after today.");
      return;
    }
    setRenewError(null);
    setNotice(null);
    setBusyId(id);
    try {
      await apiPost(`/api/passports/${id}/renew`, { validUntil: renewDate });
      setNotice({ ok: true, text: `Passport ${id} renewed until ${renewDate} — status is active again.` });
      setRenewFor(null);
      setRenewDate("");
      // Renewal republishes the passport Knowledge Asset: same treatment.
      await invalidateSnapshot();
      invalidateDkgGraph();
    } catch (e) {
      setRenewError(e instanceof Error ? e.message : "Renewal failed. The date you picked is preserved.");
    } finally {
      setBusyId(null);
    }
  }

  const revokeWarning = revokeTarget
    ? (warnings.find((w) => w.passportId === revokeTarget.id)?.affectedCampaigns.length ?? null)
    : null;

  return (
    <div className="pf-page space-y-6">
      <FadeIn>
        <PageHeader
          eyebrow="Trust & proof"
          title="Creator consents"
          description="Revoking a passport publishes an Amendment Knowledge Asset and immediately re-blocks dependent campaigns at preflight."
        />
      </FadeIn>

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
      {loadError && <ErrorState message={loadError} onRetry={() => { void snapshot.refetch(); }} />}
      {invites !== null && passports !== null && invites.length === 0 && passports.length === 0 && !loadError && (
        <EmptyState
          title="No creator consents yet"
          body="Permission passports and consent links will appear here once creators attest through a consent link."
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

      {/* Passports */}
      <section aria-label="Permission passports">
        <h2 className="mb-1 text-[15px] font-semibold tracking-tight">Permission passports</h2>
        <p id={`${uid}-revoke-hint`} className="mb-3 text-[12px] text-muted-foreground">
          Revoking is immediate and permanent in effect: an Amendment Knowledge Asset is published and
          dependent campaigns re-block at preflight. You will confirm before anything happens.
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
                    <CopyableIdentifier value={p.ual ? `${p.id} · ${p.ual}` : p.id} className="mt-1 max-w-full" />
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
                      <Input
                        id={`${uid}-renew-${p.id}`}
                        type="date"
                        value={renewDate}
                        min={new Date().toISOString().slice(0, 10)}
                        aria-invalid={Boolean(renewError)}
                        onChange={(e) => { setRenewDate(e.target.value); setRenewError(null); }}
                        className="h-9 w-44 rounded-lg"
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

      {/* Consent links */}
      <section>
        <h2 className="mb-3 text-[15px] font-semibold tracking-tight">Consent links</h2>
        <Stagger className="space-y-3">
          {(invites ?? []).map((invite) => (
              <StaggerItem key={invite.token}>
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-4 rounded-2xl border border-border bg-card p-5">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <p className="text-[14.5px] font-semibold">{invite.creatorId}</p>
                      <StatusBadge status={invite.status === "completed" ? "attested" : "pending"} />
                    </div>
                    <p className="mt-1.5 break-all font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted-foreground" title={`/consent/${invite.token}`}>/consent/{invite.token}</p>
                  </div>
                  <Button asChild size="sm" variant={invite.status === "pending" ? "default" : "outline"} className={invite.status === "pending" ? "rounded-full bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600" : "rounded-full"}>
                    <Link href={`/consent/${invite.token}`}>
                      {invite.status === "pending" ? "Open consent link" : "View"} <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                  </Button>
                </div>
              </StaggerItem>
          ))}
        </Stagger>
      </section>
      <ConfirmDialog
        open={revokeTarget !== null}
        title={`Revoke ${revokeTarget?.creatorName ?? "this"}’s passport?`}
        consequence={
          revokeWarning !== null && revokeWarning > 0
            ? `This publishes a revocation Amendment Knowledge Asset for passport ${revokeTarget?.id}. ${revokeWarning} dependent campaign(s) will immediately re-block at preflight. The passport record itself is kept for audit — nothing is deleted.`
            : `This publishes a revocation Amendment Knowledge Asset for passport ${revokeTarget?.id}. Dependent campaigns of this creator will be re-checked at preflight. The passport record itself is kept for audit — nothing is deleted.`
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
