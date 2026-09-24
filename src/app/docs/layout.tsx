import type { Metadata } from "next";
import Link from "next/link";
import { PermitFrameMark } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { DocsMobileNavigation, DocsNavigation, DocsPager } from "@/components/docs/docs-navigation";

export const metadata: Metadata = {
  title: {
    default: "Documentation | PermitFrame",
    template: "%s | PermitFrame Docs"
  },
  description: "First-run and workflow documentation for permission-aware campaign production with PermitFrame."
};

export const dynamic = "force-static";

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="pf-page min-h-screen bg-background text-foreground dark:bg-[#0b0f0e] dark:text-white">
      <a href="#docs-content" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[70] focus:rounded-lg focus:bg-emerald-600 focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-white">
        Skip to documentation
      </a>
      <header className="sticky top-0 z-50 border-b border-border bg-background/90 backdrop-blur-xl dark:border-white/[0.07] dark:bg-[#0b0f0e]/90">
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
          <Link href="/docs" className="flex min-w-0 items-center gap-2.5" aria-label="PermitFrame documentation home">
            <PermitFrameMark className="h-7 w-7 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <span className="truncate text-[15px] font-semibold tracking-tight">
              Permit<span className="text-emerald-600 dark:text-emerald-400">Frame</span>
            </span>
            <span className="hidden h-5 w-px bg-border sm:block" />
            <span className="hidden font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground sm:inline">Documentation</span>
          </Link>
          <div className="flex shrink-0 items-center gap-1.5">
            <Link href="/campaigns" prefetch={false} className="hidden rounded-full border border-border bg-card px-4 py-2 text-[12px] font-medium text-foreground transition hover:border-emerald-500/35 hover:bg-emerald-500/[0.05] sm:inline-flex">
              Open app
            </Link>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <div className="relative">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-72 overflow-hidden" aria-hidden>
          <div className="absolute left-1/2 top-[-10rem] h-80 w-[48rem] -translate-x-1/2 rounded-full bg-emerald-400/[0.07] blur-3xl" />
        </div>
        <div className="relative mx-auto grid w-full max-w-7xl gap-8 px-4 py-8 sm:px-6 lg:grid-cols-[13.5rem_minmax(0,1fr)] lg:px-8 lg:py-12">
          <aside className="hidden lg:block">
            <div className="sticky top-24">
              <DocsNavigation />
            </div>
          </aside>
          <main id="docs-content" className="min-w-0">
            <div className="lg:hidden">
              <DocsMobileNavigation />
            </div>
            <article className="mx-auto mt-8 max-w-3xl lg:mt-0">
              {children}
            </article>
            <div className="mx-auto max-w-3xl">
              <DocsPager />
            </div>
          </main>
        </div>
      </div>

      <footer className="border-t border-border dark:border-white/[0.07]">
        <div className="mx-auto w-full max-w-3xl px-4 py-8 text-center text-[12px] leading-5 text-muted-foreground sm:px-6">
          <p className="font-medium text-foreground/80">PermitFrame documentation</p>
          <p className="mx-auto mt-1.5 max-w-2xl">
            Attestations and approvals record declarations and decisions. They do not verify identity, legal ownership, automatic compliance, or guaranteed provider output.
          </p>
        </div>
      </footer>
    </div>
  );
}
