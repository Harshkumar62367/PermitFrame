"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Menu, X } from "lucide-react";
import { PermitFrameMark } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { useWorkspace } from "@/components/workspace/workspace-context";
import { WorkspaceSwitcher } from "@/components/sidebar/workspace-switcher";
import { SidebarNavigation } from "@/components/sidebar/sidebar-navigation";
import { IntegrationStatusStrip } from "@/components/sidebar/integration-status-strip";
import { AccountMenu } from "@/components/sidebar/account-menu";

interface Health {
  dkg: { mode: string; healthy: boolean; blockchain?: string; detail?: string; endpoint?: string };
  livepeer: { keyless: boolean; endpoint?: string; reachable?: boolean; detail?: string };
}

/**
 * Mobile navigation drawer: every destination, workspace identity,
 * account slot, theme toggle. Drawer (not a 3-link topbar).
 * Fully theme-aware, mirroring the desktop sidebar.
 */
export function MobileNav({ health }: { health: Health | null }) {
  const { workspace } = useWorkspace();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open ]);

  return (
    <>
      <div className="sticky top-0 z-40 flex h-14 items-center gap-2 border-b border-border bg-background/90 px-4 backdrop-blur lg:hidden">
        <Link href="/workspace" className="flex min-w-0 items-center gap-2" aria-label="PermitFrame home">
          <PermitFrameMark className="h-6 w-6 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <span className="truncate text-[14px] font-semibold tracking-tight">
            Permit<span className="text-emerald-600 dark:text-emerald-400">Frame</span>
          </span>
        </Link>
        <span className="ml-1 hidden truncate font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground min-[400px]:inline">
          {workspace.name}
        </span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-expanded={open}
          aria-controls="pf-mobile-drawer"
          aria-label="Open navigation menu"
          className="ml-auto rounded-lg p-2 text-foreground transition hover:bg-accent"
        >
          <Menu className="h-5 w-5" aria-hidden />
        </button>
      </div>

      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} aria-hidden />
          <div
            id="pf-mobile-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Site navigation"
            className="absolute inset-y-0 left-0 flex w-[86vw] max-w-80 flex-col border-r border-border bg-card shadow-2xl dark:border-white/[0.06] dark:bg-[#0c110f]"
          >
            <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4 dark:border-white/[0.06]">
              <div className="flex min-w-0 items-center gap-2">
                <PermitFrameMark className="h-6 w-6 shrink-0 text-emerald-600 dark:text-emerald-400" />
                <span className="truncate text-[14px] font-semibold tracking-tight">
                  Permit<span className="text-emerald-600 dark:text-emerald-400">Frame</span>
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <ThemeToggle />
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close navigation menu"
                  className="rounded-lg p-2 text-muted-foreground transition hover:bg-accent hover:text-foreground dark:text-white/60 dark:hover:bg-white/10 dark:hover:text-white"
                >
                  <X className="h-5 w-5" aria-hidden />
                </button>
              </div>
            </div>

            <div className="shrink-0 border-b border-border px-3 py-2 dark:border-white/[0.06]">
              <WorkspaceSwitcher />
            </div>

            <SidebarNavigation onNavigate={() => setOpen(false)} />

            <div className="shrink-0 space-y-2 border-t border-border p-3 dark:border-white/[0.06]">
              <IntegrationStatusStrip health={health} onNavigate={() => setOpen(false)} />
              <AccountMenu />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
