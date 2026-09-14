"use client";

import { AppSidebar, type ShellHealth } from "@/components/app-sidebar";
import { MobileNav } from "@/components/mobile-nav";
import { useBootstrap } from "@/lib/bootstrap";

/**
 * App shell: health comes from the single shared bootstrap snapshot,
 * responsive content width (dense workflows wider than simple forms).
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const boot = useBootstrap();
  const health: ShellHealth | null =
    boot.status === "ready" ? { dkg: boot.snapshot.dkg, livepeer: boot.snapshot.livepeer } : null;

  return (
    <div className="pf-page min-h-screen">
      <a
        href="#pf-main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:bg-emerald-600 focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-white"
      >
        Skip to content
      </a>
      <AppSidebar health={health} />
      <MobileNav health={health} />
      <main id="pf-main" className="min-w-0 lg:pl-60">
        <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">{children}</div>
      </main>
    </div>
  );
}
