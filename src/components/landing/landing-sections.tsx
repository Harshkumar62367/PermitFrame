import { BadgeCheck, Ban, FileCheck2, Layers, ShieldCheck, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { FadeIn, Stagger, StaggerItem } from "@/components/motion-primitives";

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

export function HowItWorks() {
  return (
    <section id="how" className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 sm:py-24">
      <FadeIn>
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-emerald-700 dark:text-emerald-300">How it works</p>
        <h2 className="font-display mt-3 max-w-2xl text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
          Four steps between a creator&rsquo;s yes and a verified campaign.
        </h2>
      </FadeIn>
      <Stagger className="mt-10 grid gap-4 sm:mt-12 md:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((step) => (
          <StaggerItem key={step.kicker}>
            <div className="group h-full rounded-2xl border border-border bg-card p-6 transition-all duration-300 hover:-translate-y-1 hover:border-emerald-600/30 hover:shadow-[0_12px_40px_-12px_rgba(16,185,129,0.15)]">
              <step.icon className="h-5 w-5 text-emerald-700 dark:text-emerald-300" aria-hidden />
              <p className="mt-5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{step.kicker}</p>
              <h3 className="mt-2 text-[15px] font-semibold leading-snug">{step.title}</h3>
              <p className="mt-2.5 text-[13px] leading-relaxed text-muted-foreground">{step.body}</p>
            </div>
          </StaggerItem>
        ))}
      </Stagger>
    </section>
  );
}

export function PolicyScenarios() {
  return (
    <section id="policy" className="py-20 sm:py-24">
      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
        <FadeIn>
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-emerald-700 dark:text-emerald-300">Policy in action</p>
          <h2 className="font-display mt-3 max-w-3xl text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
            Watch a request get refused — then watch the compliant one ship.
          </h2>
        </FadeIn>
        <div className="mt-10 grid gap-4 sm:mt-12 lg:grid-cols-2">
          <FadeIn>
            <div className="h-full rounded-2xl border border-rose-200 bg-rose-50/70 p-6 sm:p-7 dark:border-rose-900 dark:bg-rose-950/30">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Badge className="rounded-full bg-rose-600/10 text-rose-700 ring-1 ring-rose-600/20 dark:text-rose-300">Blocked</Badge>
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-rose-700/70 dark:text-rose-300/70">TikTok · Germany · “waterproof”</span>
              </div>
              <p className="mt-5 text-[15px] font-medium leading-snug text-rose-950 dark:text-rose-100">
                Three precise reasons. Zero inference spent.
              </p>
              <ul className="mt-4 space-y-2.5 text-[13px] leading-relaxed text-rose-900/80 dark:text-rose-200/80">
                <li className="flex gap-2.5"><Ban className="mt-0.5 h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" aria-hidden />TikTok is not in the creator&rsquo;s permission passports</li>
                <li className="flex gap-2.5"><Ban className="mt-0.5 h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" aria-hidden />Germany is not covered by any granted territory</li>
                <li className="flex gap-2.5"><Ban className="mt-0.5 h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" aria-hidden />“Waterproof” is on the prohibited-claims list</li>
              </ul>
            </div>
          </FadeIn>
          <FadeIn delay={0.1}>
            <div className="h-full rounded-2xl border border-emerald-200 bg-emerald-50/70 p-6 sm:p-7 dark:border-emerald-900 dark:bg-emerald-950/30">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Badge className="rounded-full bg-emerald-600/10 text-emerald-700 ring-1 ring-emerald-600/20 dark:text-emerald-300">Approved</Badge>
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-emerald-800/70 dark:text-emerald-300/70">Instagram · Greece · recycled materials</span>
              </div>
              <p className="mt-5 text-[15px] font-medium leading-snug text-emerald-950 dark:text-emerald-100">
                Rights verify, claims are supported — the pack generates.
              </p>
              <ul className="mt-4 space-y-2.5 text-[13px] leading-relaxed text-emerald-900/80 dark:text-emerald-200/80">
                <li className="flex gap-2.5"><BadgeCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />Passport covers Instagram + Greece, valid to 2027</li>
                <li className="flex gap-2.5"><BadgeCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />“Made with recycled materials” is a verified fact</li>
                <li className="flex gap-2.5"><BadgeCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />Keyframe → variations → video, with cost per output</li>
              </ul>
            </div>
          </FadeIn>
        </div>
      </div>
    </section>
  );
}

export function PlatformFeatures() {
  return (
    <section id="features" className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 sm:py-24">
      <FadeIn>
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-emerald-700 dark:text-emerald-300">Platform</p>
        <h2 className="font-display mt-3 max-w-2xl text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
          The system of record for rights-safe creative.
        </h2>
      </FadeIn>
      <Stagger className="mt-10 grid gap-4 sm:mt-12 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((f) => (
          <StaggerItem key={f.title}>
            <div className="h-full rounded-2xl border border-border bg-card p-6 transition-all duration-300 hover:-translate-y-1 hover:border-emerald-600/30 hover:shadow-[0_12px_40px_-12px_rgba(16,185,129,0.15)]">
              <f.icon className="h-5 w-5 text-emerald-700 dark:text-emerald-300" aria-hidden />
              <h3 className="mt-4 text-[15px] font-semibold">{f.title}</h3>
              <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">{f.body}</p>
            </div>
          </StaggerItem>
        ))}
      </Stagger>
    </section>
  );
}
