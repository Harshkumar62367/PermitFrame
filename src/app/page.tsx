"use client";

import Link from "next/link";
import { FadeIn, Marquee } from "@/components/motion-primitives";
import { PermitFrameMark } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { WorkspaceCta } from "@/components/workspace-cta";
import { HowItWorks, PlatformFeatures, PolicyScenarios } from "@/components/landing/landing-sections";

export default function LandingPage() {
  return (
    <div className="pf-page min-h-screen bg-background text-foreground dark:bg-[#0b0f0e] dark:text-white">
      {/* Header — same dark backdrop, blur over content */}
      <header className="fixed inset-x-0 top-0 z-50 border-b border-border bg-background/80 backdrop-blur-md dark:border-white/5 dark:bg-[#0b0f0e]/80">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-2 px-4 sm:px-6">
          <Link href="/" className="flex min-w-0 items-center gap-2" aria-label="PermitFrame home">
            <PermitFrameMark className="h-6 w-6 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <span className="truncate text-[15px] font-semibold tracking-tight text-foreground dark:text-white">
              Permit<span className="text-emerald-600 dark:text-emerald-400">Frame</span>
            </span>
          </Link>
          <nav className="hidden items-center gap-6 text-[13px] text-muted-foreground md:flex dark:text-white/60" aria-label="Landing">
            <a href="#how" className="transition hover:text-foreground dark:hover:text-white">How it works</a>
            <a href="#policy" className="transition hover:text-foreground dark:hover:text-white">Policy</a>
            <a href="#features" className="transition hover:text-foreground dark:hover:text-white">Platform</a>
          </nav>
          <div className="flex shrink-0 items-center gap-2">
            <ThemeToggle />
            <WorkspaceCta label="Open campaigns" className="rounded-full bg-emerald-400 font-medium text-emerald-950 hover:bg-emerald-300" />
          </div>
        </div>
      </header>

      {/* Hero — same dark backdrop; emerald glow carries the character */}
      <section className="grain relative overflow-hidden bg-background pb-16 pt-36 dark:bg-[#0b0f0e]">
        <div
          className="pointer-events-none absolute inset-0"
          aria-hidden
          style={{
            background:
              "radial-gradient(60% 50% at 50% 0%, rgba(16,185,129,0.16), transparent 70%), radial-gradient(40% 35% at 85% 20%, rgba(16,185,129,0.07), transparent 70%)"
          }}
        />
        <div className="relative mx-auto w-full max-w-4xl px-4 text-center sm:px-6">
          <FadeIn>
            <span className="inline-flex max-w-full items-center gap-2 rounded-full border border-emerald-600/20 bg-emerald-600/[0.06] px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-emerald-700 dark:border-emerald-400/20 dark:bg-emerald-400/[0.06] dark:text-emerald-300">
              Approved rights → platform-ready assets
            </span>
          </FadeIn>
          <FadeIn delay={0.08}>
            <h1 className="font-display mt-6 text-balance text-4xl font-semibold leading-[1.04] text-foreground sm:text-6xl md:text-7xl dark:text-white">
              Campaigns that only generate{" "}
              <span className="italic text-emerald-600 dark:text-emerald-300">inside your rights.</span>
            </h1>
          </FadeIn>
          <FadeIn delay={0.16}>
            <p className="mx-auto mt-6 max-w-2xl text-pretty text-base leading-relaxed text-muted-foreground sm:text-lg dark:text-white/60">
              PermitFrame helps creative teams turn approved creator rights and brand rules into
              platform-ready AI campaign assets — with a reviewable proof trail.
            </p>
          </FadeIn>
        </div>
        <FadeIn delay={0.3} className="relative mx-auto mt-16 w-full max-w-5xl px-4 sm:px-6">
          <Marquee
            items={[
              "Permission Passports",
              "Verified Brand Rules",
              "Permission check",
              "AI production",
              "Proof trail",
              "Derivative receipts",
              "9:16 · 1:1 · 16:9",
              "Public verification",
              "Cost per output",
              "Consented data only"
            ]}
          />
        </FadeIn>
      </section>

      <HowItWorks />
      <PolicyScenarios />
      <PlatformFeatures />

      {/* CTA — same dark backdrop; hairline separates, not a second backdrop */}
      <section className="grain relative overflow-hidden border-t border-border bg-background py-20 text-center sm:py-24 dark:border-white/5 dark:bg-[#0b0f0e] dark:text-white">
        <div
          className="pointer-events-none absolute inset-0"
          aria-hidden
          style={{ background: "radial-gradient(50% 60% at 50% 100%, rgba(16,185,129,0.14), transparent 70%)" }}
        />
        <div className="relative mx-auto w-full max-w-2xl px-4 sm:px-6">
          <FadeIn>
            <h2 className="font-display text-balance text-3xl font-semibold tracking-tight sm:text-5xl">
              From creator consent to verified campaign pack.
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-pretty text-muted-foreground dark:text-white/55">
              Create a product record, collect creator consent, then produce campaigns inside
              the permissions and claims your team has actually recorded.
            </p>
            <WorkspaceCta size="lg" className="mt-8 rounded-full bg-emerald-400 px-7 font-medium text-emerald-950 hover:bg-emerald-300" />
          </FadeIn>
        </div>
      </section>

      {/* Footer — semantic tokens, readable in both themes */}
      <footer className="border-t border-border py-10 dark:border-white/5">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-4 px-4 text-[12px] text-muted-foreground sm:flex-row sm:px-6">
          <div className="flex items-center gap-2">
            <PermitFrameMark className="h-4 w-4 shrink-0 text-emerald-700 dark:text-emerald-300" />
            <span>PermitFrame — rights-aware creative production</span>
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
