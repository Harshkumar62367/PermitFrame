"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  FolderKanban,
  Waypoints,
  LayoutDashboard,
  SearchCheck,
  Settings,
  ShieldCheck,
  Package,
  Images
} from "lucide-react";
import { cn } from "@/lib/utils";
import { PermitFrameMark } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";

interface Health {
  dkg: { mode: string; healthy: boolean; blockchain?: string };
  livepeer: { keyless: boolean };
}

const NAV = [
  { section: "Workspace", items: [{ href: "/workspace", label: "Overview", icon: LayoutDashboard }, { href: "/campaigns", label: "Campaigns", icon: FolderKanban }, { href: "/products", label: "Products & facts", icon: Package }, { href: "/media", label: "Media library", icon: Images }] },
  { section: "Trust & proof", items: [{ href: "/consents", label: "Creator consents", icon: ShieldCheck }, { href: "/graph", label: "Knowledge graph", icon: Waypoints }, { href: "/verifier", label: "Verifier", icon: SearchCheck }] },
  { section: "System", items: [{ href: "/settings", label: "Settings", icon: Settings }] }
];

export function AppSidebar() {
  const pathname = usePathname();
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    fetch("/api/bootstrap")
      .then((r) => (r.ok ? r.json() : null))
      .then(setHealth)
      .catch(() => undefined);
  }, []);

  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col border-r border-white/[0.06] bg-[#0c110f] lg:flex">
      <div className="flex h-16 items-center justify-between px-5">
        <div className="flex items-center gap-2.5">
          <PermitFrameMark className="h-7 w-7 text-emerald-400" />
          <div>
            <p className="text-[14px] font-semibold leading-none tracking-tight text-white">
              Permit<span className="text-emerald-400">Frame</span>
            </p>
            <p className="mt-1 font-mono text-[9px] uppercase tracking-[0.18em] text-white/35">verified production</p>
          </div>
        </div>
        <ThemeToggle subtle />
      </div>

      <nav className="mt-4 flex-1 space-y-6 overflow-y-auto px-3 pb-4">
        {NAV.map((group) => (
          <div key={group.section}>
            <p className="px-3 pb-2 font-mono text-[9.5px] uppercase tracking-[0.18em] text-white/30">{group.section}</p>
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const active = pathname === item.href || pathname.startsWith(item.href + "/");
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      "group flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] transition-all",
                      active
                        ? "bg-emerald-400/[0.09] font-medium text-emerald-300"
                        : "text-white/55 hover:bg-white/[0.05] hover:text-white"
                    )}
                  >
                    <item.icon className={cn("h-4 w-4", active ? "text-emerald-400" : "text-white/40 group-hover:text-white/70")} />
                    {item.label}
                    {active && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-emerald-400" />}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="border-t border-white/[0.06] p-4">
        <div className="rounded-xl border border-white/[0.07] bg-white/[0.03] p-3.5">
          <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-white/35">System</p>
          <div className="mt-2.5 space-y-2 text-[11.5px]">
            <div className="flex items-center justify-between">
              <span className="text-white/45">DKG</span>
              <span className={cn("font-mono text-[10px]", health?.dkg.healthy ? "text-emerald-400" : "text-rose-400")}>
                {health ? (health.dkg.mode === "dkg-testnet" ? `testnet ${health.dkg.blockchain ?? ""}` : "local evidence") : "…"}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-white/45">Livepeer</span>
              <span className="font-mono text-[10px] text-emerald-400">{health ? (health.livepeer.keyless ? "demo credit" : "api key") : "…"}</span>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}

export function MobileTopbar() {
  return (
    <div className="sticky top-0 z-40 flex h-14 items-center gap-2.5 border-b border-border bg-background/90 px-4 backdrop-blur lg:hidden">
      <PermitFrameMark className="h-6 w-6 text-emerald-600" />
      <span className="text-[14px] font-semibold tracking-tight">Permit<span className="text-emerald-600">Frame</span></span>
      <nav className="ml-auto flex gap-3 text-[12px] text-muted-foreground">
        <Link href="/workspace" className="hover:text-foreground">Overview</Link>
        <Link href="/campaigns" className="hover:text-foreground">Campaigns</Link>
        <Link href="/graph" className="hover:text-foreground">Graph</Link>
      </nav>
    </div>
  );
}
