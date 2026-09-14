"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Menu, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { APP_NAV, isNavActive } from "@/components/app-nav";
import { PermitFrameMark } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { WorkspaceSwitcher } from "@/components/workspace/workspace-switcher";
import { AccountMenuSlot } from "@/components/workspace/account-menu-slot";
import { WalletStatus } from "@/components/workspace/wallet-status";
import { IntegrationStatus } from "@/components/ui/integration-status";

interface Health {
  dkg: { mode: string; healthy: boolean; blockchain?: string };
  livepeer: { keyless: boolean };
}

/**
 * Mobile navigation drawer: every destination, workspace identity,
 * account slot, theme toggle. Drawer (not a 3-link topbar).
 */
export function MobileNav({ health }: { health: Health | null }) {
  const pathname = usePathname();
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
          Demo workspace
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
            className="pf-dark-scope absolute inset-y-0 left-0 flex w-[86vw] max-w-80 flex-col bg-[#0c110f] text-white shadow-2xl"
          >
            <div className="flex h-14 shrink-0 items-center justify-between border-b border-white/[0.06] px-4">
              <div className="flex min-w-0 items-center gap-2">
                <PermitFrameMark className="h-6 w-6 shrink-0 text-emerald-400" />
                <span className="truncate text-[14px] font-semibold tracking-tight">
                  Permit<span className="text-emerald-400">Frame</span>
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <ThemeToggle subtle />
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close navigation menu"
                  className="rounded-lg p-2 text-white/60 transition hover:bg-white/10 hover:text-white"
                >
                  <X className="h-5 w-5" aria-hidden />
                </button>
              </div>
            </div>

            <div className="shrink-0 border-b border-white/[0.06] px-4 py-3">
              <WorkspaceSwitcher />
              <div className="mt-1 px-1">
                <WalletStatus />
              </div>
            </div>

            <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4" aria-label="Primary">
              {APP_NAV.map((group) => (
                <div key={group.section}>
                  <p className="px-3 pb-2 font-mono text-[9.5px] uppercase tracking-[0.18em] text-white/30">
                    {group.section}
                  </p>
                  <div className="space-y-0.5">
                    {group.items.map((item) => {
                      const active = isNavActive(pathname, item.href);
                      return (
                        <Link
                          key={item.href}
                          href={item.href}
                          onClick={() => setOpen(false)}
                          aria-current={active ? "page" : undefined}
                          className={cn(
                            "flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-[14px] transition-all",
                            active
                              ? "bg-emerald-400/[0.09] font-medium text-emerald-300"
                              : "text-white/60 hover:bg-white/[0.05] hover:text-white"
                          )}
                        >
                          <item.icon
                            className={cn("h-4 w-4 shrink-0", active ? "text-emerald-400" : "text-white/40")}
                            aria-hidden
                          />
                          {item.label}
                          {active && <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" aria-hidden />}
                        </Link>
                      );
                    })}
                  </div>
                </div>
              ))}
            </nav>

            <div className="shrink-0 space-y-2 border-t border-white/[0.06] p-4 text-[11.5px]">
              <IntegrationStatus
                label="DKG"
                state={!health ? "loading" : health.dkg.healthy ? "healthy" : "down"}
                detail={health ? (health.dkg.mode === "edge-node" ? `V10 ${health.dkg.blockchain ?? ""}` : "local evidence") : undefined}
              />
              <IntegrationStatus
                label="Livepeer"
                state={!health ? "loading" : "healthy"}
                detail={health ? (health.livepeer.keyless ? "demo credit" : "api key") : undefined}
              />
              <div className="flex items-center justify-between pt-1">
                <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-white/35">Account</span>
                <AccountMenuSlot compact />
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
