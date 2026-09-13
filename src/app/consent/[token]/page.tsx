"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowLeft, BadgeCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FadeIn } from "@/components/motion-primitives";
import { PermitFrameMark } from "@/components/logo";
import { cn } from "@/lib/utils";

interface ConsentData {
  status: "pending" | "completed";
  draft: {
    platforms: string[];
    countries: string[];
    allowedTransformations: string[];
    validUntil: string;
    sourceMediaIds: string[];
  };
  creator: { name: string; handle: string } | null;
}

const ALL_PLATFORMS = ["instagram", "tiktok", "youtube", "linkedin"];
const ALL_COUNTRIES = ["US", "GR", "DE", "IN", "GB"];
const ALL_TRANSFORMS = ["edit", "animate", "crop", "upscale"];

export default function ConsentPage() {
  const params = useParams<{ token: string }>();
  const [data, setData] = useState<ConsentData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ passportId: string; ual?: string; explorerUrl?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ platforms: [] as string[], countries: [] as string[], transforms: [] as string[], validUntil: "" });

  useEffect(() => {
    fetch(`/api/consent/${params.token}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Consent link not found"))))
      .then((d: ConsentData) => {
        setData(d);
        setForm({
          platforms: d.draft.platforms,
          countries: d.draft.countries,
          transforms: d.draft.allowedTransformations,
          validUntil: d.draft.validUntil
        });
      })
      .catch((e) => setError(String(e.message ?? e)));
  }, [params.token]);

  function toggle(key: "platforms" | "countries" | "transforms", value: string) {
    setForm((f) => ({
      ...f,
      [key]: f[key].includes(value) ? f[key].filter((v) => v !== value) : [...f[key], value]
    }));
  }

  async function attest() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/consent/${params.token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          platforms: form.platforms,
          countries: form.countries,
          allowedTransformations: form.transforms,
          validUntil: form.validUntil
        })
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Attestation failed");
      setResult({ passportId: j.passportId, ual: j.ual, explorerUrl: j.explorerUrl });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) {
    return (
      <div className="mx-auto max-w-xl px-6 py-24">
        <p className="rounded-2xl bg-rose-50 p-4 text-sm text-rose-700 ring-1 ring-rose-200">{error}</p>
      </div>
    );
  }
  if (!data) return <div className="px-6 py-24 text-center text-sm text-muted-foreground">Loading consent link…</div>;

  if (result || data.status === "completed") {
    return (
      <div className="mx-auto max-w-xl px-6 py-24">
        <FadeIn>
          <div className="grain relative overflow-hidden rounded-3xl bg-[#0c110f] p-10 text-center text-white">
            <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-emerald-400/15 ring-1 ring-emerald-400/40">
              <BadgeCheck className="h-7 w-7 text-emerald-300" />
            </span>
            <h1 className="font-display mt-5 text-2xl font-semibold tracking-tight">Permission attested</h1>
            <p className="mx-auto mt-2 max-w-sm text-[13.5px] leading-relaxed text-white/55">
              Your Permission Passport is live. Agencies can now produce campaigns inside
              exactly the rights you granted — nothing more.
            </p>
            {(result?.ual || data.status === "completed") && (
              <p className="mt-4 font-mono text-[11px] text-emerald-300/90">
                {result?.ual ?? "Passport recorded in the evidence layer"}
                {result?.explorerUrl ? (
                  <> · <a href={result.explorerUrl} target="_blank" rel="noreferrer" className="underline">view in explorer</a></>
                ) : null}
              </p>
            )}
          </div>
        </FadeIn>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-xl px-6 py-14">
        <FadeIn>
          <div className="flex items-center gap-2.5">
            <PermitFrameMark className="h-7 w-7 text-emerald-700" />
            <span className="text-[15px] font-semibold tracking-tight">Permit<span className="text-emerald-600">Frame</span></span>
          </div>
          <p className="mt-6 font-mono text-[10.5px] uppercase tracking-[0.18em] text-emerald-700">Creator consent link</p>
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
          <div className="mt-7 space-y-6 rounded-3xl border border-border bg-card p-7">
            <ChoiceGroup label="Platforms" options={ALL_PLATFORMS} selected={form.platforms} onToggle={(v) => toggle("platforms", v)} />
            <ChoiceGroup label="Territories" options={ALL_COUNTRIES} selected={form.countries} onToggle={(v) => toggle("countries", v)} />
            <ChoiceGroup label="Allowed transformations" options={ALL_TRANSFORMS} selected={form.transforms} onToggle={(v) => toggle("transforms", v)} />
            <div>
              <Label className="text-[12px] text-muted-foreground">Valid until</Label>
              <Input
                type="date"
                value={form.validUntil}
                onChange={(e) => setForm((f) => ({ ...f, validUntil: e.target.value }))}
                className="mt-1.5 rounded-xl"
              />
            </div>
            <Button
              onClick={attest}
              disabled={busy || form.platforms.length === 0 || form.countries.length === 0}
              className="w-full rounded-full bg-emerald-700 py-2.5 font-medium text-emerald-50 hover:bg-emerald-600"
            >
              {busy ? "Attesting…" : "Attest & publish my Permission Passport"}
            </Button>
            {error && <p className="text-[13px] text-rose-600">{error}</p>}
          </div>
        </FadeIn>
        <Link href="/workspace" className="mt-5 inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to PermitFrame
        </Link>
      </div>
    </div>
  );
}

function ChoiceGroup({
  label,
  options,
  selected,
  onToggle
}: {
  label: string;
  options: string[];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  return (
    <div>
      <Label className="text-[12px] text-muted-foreground">{label}</Label>
      <div className="mt-2 flex flex-wrap gap-2">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => onToggle(option)}
            className={cn(
              "rounded-full px-4 py-1.5 text-[12.5px] ring-1 transition-all",
              selected.includes(option)
                ? "bg-emerald-700 font-medium text-emerald-50 ring-emerald-700"
                : "bg-muted/60 text-muted-foreground ring-border hover:text-foreground"
            )}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}
