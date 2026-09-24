"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpen, ChevronLeft, ChevronRight, Compass, FileCheck2, Film, Network, Route } from "lucide-react";
import { cn } from "@/lib/utils";

const pages = [
  { href: "/docs", label: "Overview", eyebrow: "Guide", icon: BookOpen },
  { href: "/docs/getting-started", label: "Getting started", eyebrow: "First run", icon: Compass },
  { href: "/docs/dkg-and-proof", label: "DKG and proof", eyebrow: "Track 2", icon: Network },
  { href: "/docs/campaign-workflow", label: "Campaign workflow", eyebrow: "Production", icon: Route },
  { href: "/docs/film-and-finishing", label: "Film and finishing", eyebrow: "Motion", icon: Film },
  { href: "/docs/verification-and-delivery", label: "Verification and delivery", eyebrow: "Handoff", icon: FileCheck2 }
] as const;

function isActive(pathname: string, href: string): boolean {
  const normalized = pathname !== "/" && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return href === "/docs" ? normalized === href : normalized === href || normalized.startsWith(`${href}/`);
}

function NavigationLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <div className="space-y-1">
      {pages.map((page, index) => {
        const active = isActive(pathname, page.href);
        return (
          <Link
            key={page.href}
            href={page.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "group flex items-start gap-3 rounded-xl px-3 py-2.5 transition",
              active
                ? "bg-emerald-500/[0.11] text-foreground ring-1 ring-emerald-500/20"
                : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground"
            )}
          >
            <span className={cn("mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg", active ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300" : "bg-muted/70 text-muted-foreground group-hover:text-foreground")}>
              <page.icon className="h-3.5 w-3.5" aria-hidden />
            </span>
            <span className="min-w-0">
              <span className="block font-mono text-[9px] uppercase tracking-[0.14em] opacity-65">{String(index + 1).padStart(2, "0")} · {page.eyebrow}</span>
              <span className="mt-0.5 block text-[13px] font-medium leading-5">{page.label}</span>
            </span>
          </Link>
        );
      })}
    </div>
  );
}

export function DocsNavigation() {
  return (
    <nav aria-label="Documentation" className="space-y-5">
      <div>
        <p className="px-3 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Documentation</p>
        <div className="mt-3">
          <NavigationLinks />
        </div>
      </div>
      <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.06] p-4">
        <p className="text-[12.5px] font-semibold">New to PermitFrame?</p>
        <p className="mt-1.5 text-[12px] leading-5 text-muted-foreground">Follow the ten-step path from an empty workspace to owner approval.</p>
        <Link href="/docs/getting-started" className="mt-3 inline-flex text-[12px] font-medium text-emerald-700 hover:underline dark:text-emerald-300">
          Open Getting started
        </Link>
      </div>
    </nav>
  );
}

export function DocsMobileNavigation() {
  return (
    <details className="group rounded-2xl border border-border bg-card">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium">
        <span className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
          Documentation menu
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">6 pages</span>
      </summary>
      <div className="border-t border-border p-2">
        <NavigationLinks />
      </div>
    </details>
  );
}

export function DocsPager() {
  const pathname = usePathname();
  const normalized = pathname !== "/" && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  const index = Math.max(0, pages.findIndex((page) => isActive(normalized, page.href)));
  const previous = index > 0 ? pages[index - 1] : null;
  const next = index < pages.length - 1 ? pages[index + 1] : null;

  return (
    <nav aria-label="Documentation pages" className="mt-14 grid gap-3 border-t border-border pt-6 sm:grid-cols-2">
      {previous ? (
        <Link href={previous.href} className="group rounded-2xl border border-border bg-card p-4 transition hover:border-emerald-500/35 hover:bg-emerald-500/[0.04]">
          <span className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground"><ChevronLeft className="h-3 w-3" aria-hidden /> Previous</span>
          <span className="mt-2 block text-[13px] font-medium">{previous.label}</span>
        </Link>
      ) : <span />}
      {next && (
        <Link href={next.href} className="group rounded-2xl border border-border bg-card p-4 text-right transition hover:border-emerald-500/35 hover:bg-emerald-500/[0.04] sm:col-start-2">
          <span className="flex items-center justify-end gap-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground">Next <ChevronRight className="h-3 w-3" aria-hidden /></span>
          <span className="mt-2 block text-[13px] font-medium">{next.label}</span>
        </Link>
      )}
    </nav>
  );
}
