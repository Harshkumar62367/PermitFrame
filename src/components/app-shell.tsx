"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AppSidebar } from "@/components/app-sidebar";
import { MobileNav } from "@/components/mobile-nav";
import { apiGet } from "@/lib/api";
import { WORKSPACE_SNAPSHOT_KEY, fetchWorkspaceSnapshot } from "@/lib/use-workspace-snapshot";
import type { ShellHealth } from "@/components/app-sidebar";
import { cn } from "@/lib/utils";

const COLLAPSE_KEY = "permitframe-sidebar-collapsed";

/**
 * App shell: integration health loads independently at low priority from
 * /api/health and never blocks the main content. Owns the user-controlled
 * sidebar collapse (persisted locally, never automatic).
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const [health, setHealth] = useState<ShellHealth | null>(null);
  // Expanded by default so the first render matches the server and never
  // flashes; the stored preference applies before paint via layout effect.
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    // Mount-only restore of the persisted rail preference. The first render
    // must match the server (expanded) to avoid a hydration mismatch, and the
    // stored value can only be read on the client after mount.
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (window.localStorage.getItem(COLLAPSE_KEY) === "1") setCollapsed(true);
    } catch {
      // private mode etc. — expanded sidebar is the safe default
    }
  }, []);

  const queryClient = useQueryClient();

  useEffect(() => {
    // Prefetch the workspace snapshot once while the persistent app shell
    // hydrates. Campaigns and other pages read this same cached query on
    // navigation, so the second route renders instantly from cache.
    void queryClient.prefetchQuery({ queryKey: WORKSPACE_SNAPSHOT_KEY, queryFn: ({ signal }) => fetchWorkspaceSnapshot(signal), staleTime: 60_000 }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    apiGet<{ dkg: ShellHealth["dkg"]; livepeer: ShellHealth["livepeer"] }>("/api/health", controller.signal).then(
      (d) => setHealth({ dkg: d.dkg, livepeer: d.livepeer }),
      () => undefined // sidebar keeps its neutral "checking" state
    );
    return () => controller.abort();
  }, []);

  function toggleCollapse() {
    setCollapsed((v) => {
      try {
        window.localStorage.setItem(COLLAPSE_KEY, v ? "0" : "1");
      } catch {
        // ignore persistence failures
      }
      return !v;
    });
  }

  return (
    <div className="pf-page min-h-screen">
      <a
        href="#pf-main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:bg-emerald-600 focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-white"
      >
        Skip to content
      </a>
      <AppSidebar health={health} collapsed={collapsed} onToggleCollapse={toggleCollapse} />
      <MobileNav health={health} />
      <main id="pf-main" className={cn("pf-main min-w-0 transition-[padding] duration-200", collapsed && "pf-main-collapsed")}>
        <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:py-8 min-[1500px]:max-w-[80rem]">{children}</div>
      </main>
    </div>
  );
}
