"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ArrowRight, BadgeCheck, CalendarClock, Clock3, ShieldOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FadeIn, Stagger, StaggerItem } from "@/components/motion-primitives";
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
interface Creator {
  id: string;
  name: string;
  handle: string;
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
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [passports, setPassports] = useState<Passport[] | null>(null);
  const [creators, setCreators] = useState<Creator[]>([]);
  const [warnings, setWarnings] = useState<Warning[]>([]);
  const [renewFor, setRenewFor] = useState<string | null>(null);
  const [renewDate, setRenewDate] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/consents")
      .then((r) => r.json())
      .then((d) => {
        setInvites(d.invites);
        setPassports(d.passports);
      })
      .catch(() => {
        setInvites([]);
        setPassports([]);
      });
    fetch("/api/bootstrap")
      .then((r) => r.json())
      .then((d) => setCreators(d.creators ?? []))
      .catch(() => undefined);
    fetch("/api/expiry")
      .then((r) => r.json())
      .then((d) => setWarnings(d.warnings ?? []))
      .catch(() => undefined);
  }, []);

  useEffect(load, [load]);

  async function revoke(id: string) {
    setMsg(null);
    const res = await fetch(`/api/passports/${id}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "Revoked from the PermitFrame consents page." })
    });
    const j = await res.json();
    if (!res.ok) return setMsg(j.error);
    setMsg(
      j.blockedCampaigns.length > 0
        ? `Passport revoked — ${j.blockedCampaigns.length} dependent campaign(s) now blocked by preflight.`
        : "Passport revoked (no active campaigns affected)."
    );
    load();
  }

  async function renew(id: string) {
    setMsg(null);
    const res = await fetch(`/api/passports/${id}/renew`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ validUntil: renewDate })
    });
    const j = await res.json();
    if (!res.ok) return setMsg(j.error);
    setMsg(`Passport renewed until ${renewDate}.`);
    setRenewFor(null);
    load();
  }

  return (
    <div className="space-y-6">
      <FadeIn>
        <p className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-emerald-700">Trust & proof</p>
        <h1 className="font-display mt-1.5 text-3xl font-semibold tracking-tight">Creator consents</h1>
        <p className="mt-1.5 max-w-2xl text-[13.5px] text-muted-foreground">
          Revoking a passport publishes an Amendment Knowledge Asset and immediately re-blocks
          dependent campaigns at preflight.
        </p>
      </FadeIn>

      {msg && <FadeIn><p className="rounded-xl bg-emerald-50 px-4 py-3 text-[13px] text-emerald-800 ring-1 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900">{msg}</p></FadeIn>}

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
      <section>
        <h2 className="mb-3 text-[15px] font-semibold tracking-tight">Permission passports</h2>
        <Stagger className="space-y-3">
          {(passports ?? []).map((p) => {
            const creator = creators.find((c) => c.id === p.creatorId);
            return (
              <StaggerItem key={p.id}>
                <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border bg-card p-5">
                  <div>
                    <div className="flex items-center gap-2.5">
                      <p className="text-[14.5px] font-semibold">{creator?.name ?? p.creatorName}</p>
                      <span className="font-mono text-[11px] text-muted-foreground">{creator?.handle}</span>
                      <Badge variant="outline" className={cn(
                        "rounded-full font-medium capitalize",
                        p.status === "active" ? "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-800" : "bg-rose-50 text-rose-700 ring-rose-600/20 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-800"
                      )}>
                        {p.status}
                      </Badge>
                    </div>
                    <p className="mt-1.5 flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted-foreground">
                      <CalendarClock className="h-3.5 w-3.5" /> valid to {p.validUntil} · {p.id}
                      {p.ual ? ` · ${p.ual}` : ""}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    {p.status === "active" && (
                      <Button variant="outline" size="sm" onClick={() => { setRenewFor(p.id); setRenewDate(""); }} className="rounded-full">
                        <CalendarClock className="h-3.5 w-3.5" /> Renew
                      </Button>
                    )}
                    {p.status === "active" && (
                      <Button variant="outline" size="sm" onClick={() => revoke(p.id)} className="rounded-full border-rose-300 text-rose-700 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-300 dark:hover:bg-rose-950">
                        <ShieldOff className="h-3.5 w-3.5" /> Revoke
                      </Button>
                    )}
                  </div>
                </div>
                {renewFor === p.id && (
                  <div className="mt-2 flex items-center gap-2 rounded-xl border border-dashed border-border p-3">
                    <Input type="date" value={renewDate} onChange={(e) => setRenewDate(e.target.value)} className="h-9 w-44 rounded-lg" />
                    <Button size="sm" onClick={() => renew(p.id)} disabled={!renewDate} className="h-9 rounded-lg bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600">
                      Confirm renewal
                    </Button>
                  </div>
                )}
              </StaggerItem>
            );
          })}
        </Stagger>
      </section>

      {/* Consent links */}
      <section>
        <h2 className="mb-3 text-[15px] font-semibold tracking-tight">Consent links</h2>
        <Stagger className="space-y-3">
          {(invites ?? []).map((invite) => {
            const creator = creators.find((c) => c.id === invite.creatorId);
            return (
              <StaggerItem key={invite.token}>
                <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border bg-card p-5">
                  <div>
                    <div className="flex items-center gap-2.5">
                      <p className="text-[14.5px] font-semibold">{creator?.name ?? invite.creatorId}</p>
                      <span className="font-mono text-[11px] text-muted-foreground">{creator?.handle}</span>
                      {invite.status === "completed" ? (
                        <Badge variant="outline" className="rounded-full bg-emerald-50 font-medium text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-800">
                          <BadgeCheck className="h-3 w-3" /> attested
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="rounded-full bg-amber-50 font-medium text-amber-700 ring-amber-600/20 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-800">
                          <Clock3 className="h-3 w-3" /> pending
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1.5 font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted-foreground">/consent/{invite.token}</p>
                  </div>
                  <Button asChild size="sm" variant={invite.status === "pending" ? "default" : "outline"} className={invite.status === "pending" ? "rounded-full bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600" : "rounded-full"}>
                    <Link href={`/consent/${invite.token}`}>
                      {invite.status === "pending" ? "Open consent link" : "View"} <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                  </Button>
                </div>
              </StaggerItem>
            );
          })}
        </Stagger>
      </section>
    </div>
  );
}
