"use client";

import Link from "next/link";
import { ArrowRight, BadgeCheck, Ban, FileCheck2, Layers, ShieldCheck, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FadeIn, Marquee, Stagger, StaggerItem } from "@/components/motion-primitives";
import { PermitFrameMark } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";

const STEPS = [
  {
    icon: BadgeCheck,
    kicker: "01 — Consent",
    title: "The creator attests a Permission Passport",
    body: "Platforms, territories, transformations and expiry — chosen by the creator on a consent link, published as a minimized Knowledge Asset."
  },
  {
    icon: ShieldCheck,
    kicker: "02 — Preflight",
    title: "The DKG decides before a dollar is spent",
    body: "Real SPARQL queries over rights and verified product facts compile every request into allow or block — with the exact reasons and the evidence."
  },
  {
    icon: Sparkles,
    kicker: "03 — Produce",
    title: "Livepeer Agent builds the campaign pack",
    body: "Keyframe, feed variation, wide header, and a five-second vertical cut — generated inside the constraints, with live cost per output."
  },
  {
    icon: FileCheck2,
    kicker: "04 — Prove",
    title: "Every pixel carries its receipts",
    body: "A Derivative Receipt links each output to its source, permission and claim evidence — resolvable on a public verification page."
  }
];

const FEATURES = [
  { icon: BadgeCheck, title: "Creator Permission Passports", body: "Creator-attested usage rights as queryable knowledge — not a spreadsheet." },
  { icon: ShieldCheck, title: "Verified product facts", body: "Approved and prohibited advertising claims, with the evidence notes behind them." },
  { icon: Ban, title: "Policy preflight", body: "Invalid campaigns are refused before inference spend — with precise, evidence-linked reasons." },
  { icon: Layers, title: "Complete campaign packs", body: "9:16, 1:1, 16:9 and a short vertical video — every format the platform needs." },
  { icon: FileCheck2, title: "Derivative receipts", body: "Output hash, capability, prompt hash and claims used — published per output." },
  { icon: BadgeCheck, title: "Public verification", body: "A client-facing page that proves what was recorded — and honestly states its limits." }
];

export default function LandingPage() {
  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="fixed inset-x-0 top-0 z-50 border-b border-white/5 bg-[#0b0f0e]/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <Link href="/" className="flex items-center gap-2">
            <PermitFrameMark className="h-6 w-6 text-emerald-400" />
            <span className="text-[15px] font-semibold tracking-tight text-white">
              Permit<span className="text-emerald-400">Frame</span>
            </span>
          </Link>
          <nav className="hidden items-center gap-6 text-[13px] text-white/60 md:flex">
            <a href="#how" className="transition hover:text-white">How it works</a>
            <a href="#demo" className="transition hover:text-white">The demo</a>
            <a href="#features" className="transition hover:text-white">Platform</a>
          </nav>
          <div className="flex items-center gap-2">
            <ThemeToggle subtle />
            <Button asChild size="sm" className="rounded-full bg-emerald-400 font-medium text-emerald-950 hover:bg-emerald-300">
              <Link href="/workspace">
                Open the app <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </Button>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="grain relative overflow-hidden bg-[#0b0f0e] pb-16 pt-36 text-white">
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(60% 50% at 50% 0%, rgba(16,185,129,0.16), transparent 70%), radial-gradient(40% 35% at 85% 20%, rgba(16,185,129,0.07), transparent 70%)"
          }}
        />
        <div className="relative mx-auto max-w-4xl px-6 text-center">
          <FadeIn>
            <span className="inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-400/[0.06] px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-emerald-300">
              Livepeer Agent × OriginTrail DKG
            </span>
          </FadeIn>
          <FadeIn delay={0.08}>
            <h1 className="font-display mt-6 text-balance text-5xl font-semibold leading-[1.04] sm:text-6xl md:text-7xl">
              Campaigns that only generate{" "}
              <span className="italic text-emerald-300">inside your rights.</span>
            </h1>
          </FadeIn>
          <FadeIn delay={0.16}>
            <p className="mx-auto mt-6 max-w-2xl text-pretty text-lg leading-relaxed text-white/60">
              PermitFrame turns creator permissions and verified brand facts into enforceable
              production policy — then builds the entire campaign pack through the Livepeer
              Agent. Every output ships with verifiable provenance.
            </p>
          </FadeIn>
          <FadeIn delay={0.24}>
            <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
              <Button asChild size="lg" className="rounded-full bg-emerald-400 px-6 font-medium text-emerald-950 hover:bg-emerald-300">
                <Link href="/workspace">
                  Open the workspace <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline" className="rounded-full border-white/15 bg-white/[0.03] px-6 text-white hover:bg-white/10">
                <Link href="/campaigns/campaign_blocked_demo">See a campaign get blocked</Link>
              </Button>
            </div>
          </FadeIn>
        </div>
        <FadeIn delay={0.35} className="relative mx-auto mt-16 max-w-5xl px-6">
          <Marquee
            items={[
              "Permission Passports",
              "Verified Product Facts",
              "SPARQL preflight",
              "Livepeer Agent MCP",
              "OriginTrail DKG",
              "Derivative receipts",
              "9:16 · 1:1 · 16:9",
              "Public verification",
              "Cost per output",
              "Consented data only"
            ]}
          />
        </FadeIn>
      </section>

      {/* How it works */}
      <section id="how" className="mx-auto max-w-6xl px-6 py-24">
        <FadeIn>
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-emerald-700 dark:text-emerald-300">How it works</p>
          <h2 className="font-display mt-3 max-w-2xl text-balance text-4xl font-semibold tracking-tight">
            Four steps between a creator&rsquo;s yes and a verified campaign.
          </h2>
        </FadeIn>
        <Stagger className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step) => (
            <StaggerItem key={step.kicker}>
              <div className="group h-full rounded-2xl border border-border bg-card p-6 transition-all duration-300 hover:-translate-y-1 hover:border-emerald-600/30 hover:shadow-[0_12px_40px_-12px_rgba(16,185,129,0.15)]">
                <step.icon className="h-5 w-5 text-emerald-700 dark:text-emerald-300" />
                <p className="mt-5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{step.kicker}</p>
                <h3 className="mt-2 text-[15px] font-semibold leading-snug">{step.title}</h3>
                <p className="mt-2.5 text-[13px] leading-relaxed text-muted-foreground">{step.body}</p>
              </div>
            </StaggerItem>
          ))}
        </Stagger>
      </section>

      {/* Block / Allow showcase */}
      <section id="demo" className="border-y border-border bg-secondary/60 py-24">
        <div className="mx-auto max-w-6xl px-6">
          <FadeIn>
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-emerald-700 dark:text-emerald-300">The demo</p>
            <h2 className="font-display mt-3 max-w-3xl text-balance text-4xl font-semibold tracking-tight">
              Watch a request get refused — then watch the compliant one ship.
            </h2>
          </FadeIn>
          <div className="mt-12 grid gap-4 lg:grid-cols-2">
            <FadeIn>
              <div className="h-full rounded-2xl border border-rose-200 bg-rose-50/70 p-7 dark:border-rose-900 dark:bg-rose-950/30">
                <div className="flex items-center justify-between">
                  <Badge className="rounded-full bg-rose-600/10 text-rose-700 ring-1 ring-rose-600/20">Blocked</Badge>
                  <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-rose-700/70">TikTok · Germany · “waterproof”</span>
                </div>
                <p className="mt-5 text-[15px] font-medium leading-snug text-rose-950 dark:text-rose-100">
                  Three precise reasons. Zero inference spent.
                </p>
                <ul className="mt-4 space-y-2.5 text-[13px] leading-relaxed text-rose-900/80 dark:text-rose-200/80">
                  <li className="flex gap-2.5"><Ban className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />TikTok is not in the creator&rsquo;s permission passports</li>
                  <li className="flex gap-2.5"><Ban className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />Germany is not covered by any granted territory</li>
                  <li className="flex gap-2.5"><Ban className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />“Waterproof” is on the prohibited-claims list</li>
                </ul>
                <Button asChild variant="outline" size="sm" className="mt-6 rounded-full border-rose-300 bg-white text-rose-800 hover:bg-rose-100 dark:border-rose-800 dark:bg-transparent dark:text-rose-200 dark:hover:bg-rose-950">
                  <Link href="/campaigns/campaign_blocked_demo">Open this campaign <ArrowRight className="h-3.5 w-3.5" /></Link>
                </Button>
              </div>
            </FadeIn>
            <FadeIn delay={0.1}>
              <div className="h-full rounded-2xl border border-emerald-200 bg-emerald-50/70 p-7 dark:border-emerald-900 dark:bg-emerald-950/30">
                <div className="flex items-center justify-between">
                  <Badge className="rounded-full bg-emerald-600/10 text-emerald-700 ring-1 ring-emerald-600/20">Approved</Badge>
                  <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-emerald-800/70">Instagram · Greece · recycled materials</span>
                </div>
                <p className="mt-5 text-[15px] font-medium leading-snug text-emerald-950 dark:text-emerald-100">
                  Rights verify, claims are supported — the pack generates.
                </p>
                <ul className="mt-4 space-y-2.5 text-[13px] leading-relaxed text-emerald-900/80 dark:text-emerald-200/80">
                  <li className="flex gap-2.5"><BadgeCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />Passport covers Instagram + Greece, valid to 2027</li>
                  <li className="flex gap-2.5"><BadgeCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />“Made with recycled materials” is a verified fact</li>
                  <li className="flex gap-2.5"><BadgeCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />Keyframe → variations → video, with cost per output</li>
                </ul>
                <Button asChild size="sm" className="mt-6 rounded-full bg-emerald-700 font-medium text-emerald-50 hover:bg-emerald-600 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400">
                  <Link href="/campaigns/campaign_approved_demo">Open this campaign <ArrowRight className="h-3.5 w-3.5" /></Link>
                </Button>
              </div>
            </FadeIn>
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="mx-auto max-w-6xl px-6 py-24">
        <FadeIn>
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-emerald-700 dark:text-emerald-300">Platform</p>
          <h2 className="font-display mt-3 max-w-2xl text-balance text-4xl font-semibold tracking-tight">
            The system of record for rights-safe creative.
          </h2>
        </FadeIn>
        <Stagger className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <StaggerItem key={f.title}>
              <div className="h-full rounded-2xl border border-border bg-card p-6 transition-all duration-300 hover:-translate-y-1 hover:border-emerald-600/30 hover:shadow-[0_12px_40px_-12px_rgba(16,185,129,0.15)]">
                <f.icon className="h-5 w-5 text-emerald-700 dark:text-emerald-300" />
                <h3 className="mt-4 text-[15px] font-semibold">{f.title}</h3>
                <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">{f.body}</p>
              </div>
            </StaggerItem>
          ))}
        </Stagger>
      </section>

      {/* CTA */}
      <section className="grain relative overflow-hidden bg-[#0b0f0e] py-24 text-center text-white">
        <div
          className="pointer-events-none absolute inset-0"
          style={{ background: "radial-gradient(50% 60% at 50% 100%, rgba(16,185,129,0.14), transparent 70%)" }}
        />
        <div className="relative mx-auto max-w-2xl px-6">
          <FadeIn>
            <h2 className="font-display text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
              From creator consent to verified campaign pack.
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-white/55">
              Open the demo workspace — two campaigns are waiting: one the DKG will refuse,
              and one it will produce end-to-end.
            </p>
            <Button asChild size="lg" className="mt-8 rounded-full bg-emerald-400 px-7 font-medium text-emerald-950 hover:bg-emerald-300">
              <Link href="/workspace">Open the workspace <ArrowRight className="h-4 w-4" /></Link>
            </Button>
          </FadeIn>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border py-10">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 text-[12px] text-muted-foreground sm:flex-row">
          <div className="flex items-center gap-2">
            <PermitFrameMark className="h-4 w-4 text-emerald-700 dark:text-emerald-300" />
            <span>PermitFrame Core — Livepeer Agent × OriginTrail DKG</span>
          </div>
          <p className="max-w-md text-center sm:text-right">
            Attestations prove declarations and integrity — not legal ownership. Built for the
            Atumera Livepeer Agent Hackathon, Track 2.
          </p>
        </div>
      </footer>
    </div>
  );
}
