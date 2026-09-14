"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { APP_NAV, isNavActive } from "@/components/app-nav";
import { PermitFrameMark } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { WorkspaceSwitcher } from "@/components/workspace/workspace-switcher";
import { AccountMenuSlot } from "@/components/workspace/account-menu-slot";
import { WalletStatus } from "@/components/workspace/wallet-status";
import { IntegrationStatus } from "@/components/ui/integration-status";

export interface ShellHealth {
  dkg: { mode: string; healthy: boolean; blockchain?: string };
  livepeer: { keyless: boolean };
}

/**
 * Desktop sidebar. Dark editorial surface is explicit and scoped
 * (pf-dark-scope) so it stays readable under either root theme.
 */
export function AppSidebar({ health }: { health: ShellHealth | null }) {
  const pathname = usePathname();

  return (
    <aside
      aria-label="Primary"
      className="pf-dark-scope fixed inset-y-0 left-0 z-40 hidden w-60 flex-col border-r border-white/[0.06] bg-[#0c110f] text-white lg:flex"
    >
      <div className="flex h-16 shrink-0 items-center justify-between gap-2 px-5">
        <Link href="/workspace" className="flex min-w-0 items-center gap-2.5" aria-label="PermitFrame home">
          <PermitFrameMark className="h-7 w-7 shrink-0 text-emerald-400" />
          <span className="min-w-0">
            <span className="block text-[14px] font-semibold leading-none tracking-tight">
              Permit<span className="text-emerald-400">Frame</span>
            </span>
            <span className="mt-1 block font-mono text-[9px] uppercase tracking-[0.18em] text-white/35">
              verified production
            </span>
          </span>
        </Link>
        <ThemeToggle subtle />
      </div>

      <div className="shrink-0 border-y border-white/[0.06] px-4 py-3">
        <WorkspaceSwitcher />
        <div className="mt-1 px-1">
          <WalletStatus />
        </div>
      </div>

      <nav className="mt-2 flex-1 space-y-6 overflow-y-auto px-3 py-3" aria-label="Primary">
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
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "group flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] transition-all",
                      active
                        ? "bg-emerald-400/[0.09] font-medium text-emerald-300"
                        : "text-white/55 hover:bg-white/[0.05] hover:text-white"
                    )}
                  >
                    <item.icon
                      className={cn("h-4 w-4 shrink-0", active ? "text-emerald-400" : "text-white/40 group-hover:text-white/70")}
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

      <div className="shrink-0 border-t border-white/[0.06] p-4">
        <div className="rounded-xl border border-white/[0.07] bg-white/[0.03] p-3.5">
          <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-white/35">System</p>
          <div className="mt-2.5 space-y-2 text-[11.5px]">
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
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between gap-2 px-1">
          <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-white/35">Account</span>
          <AccountMenuSlot compact />
        </div>
      </div>
    </aside>
  );
}
