"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Check, Copy, EllipsisVertical, LogOut, Moon, Settings, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useWorkspace } from "@/components/workspace/workspace-context";
import { usePermitFrameSession } from "@/components/privy-provider";
import { AuthControl } from "@/components/auth-control";
import { SidebarPopover } from "./sidebar-popover";
import { cn } from "@/lib/utils";

/**
 * Compact 52px account row pinned to the sidebar bottom: avatar initial,
 * truncated name, three-dot menu. The menu holds details, wallet copy,
 * Settings, theme selection and a separated destructive Sign out.
 */
export function AccountMenu({ collapsed = false }: { collapsed?: boolean }) {
  const { account } = useWorkspace();
  const { status, signOut } = usePermitFrameSession();
  const { resolvedTheme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Mount-gated theme icon: the server and first client render assume
  // light theme so hydration matches, then sync to the real theme.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // Mount-only flip so the first client render matches the server.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  if (status !== "ready" || !account) {
    return (
      <div className={cn("flex min-h-[52px] items-center", collapsed && "justify-center")}>
        <AuthControl compact />
      </div>
    );
  }

  const name = account.fullLabel ?? account.label;
  const initial = (name.trim().charAt(0) || "?").toUpperCase();
  const dark = mounted && resolvedTheme === "dark";

  async function copyWallet() {
    if (!account?.walletAddress) return;
    try {
      await navigator.clipboard.writeText(account.walletAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  const menu = (
    <SidebarPopover
      open={open}
      onClose={() => setOpen(false)}
      label="Account menu"
      triggerRef={triggerRef}
      className={collapsed ? "bottom-6 left-[88px]" : "bottom-6 left-[264px]"}
    >
      <div className="px-3.5 pb-2 pt-3">
        <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-muted-foreground dark:text-white/40">Signed in as</p>
        <p className="mt-1 break-words text-[13px] font-medium text-foreground dark:text-white" title={name}>
          {name}
        </p>
        {account.walletAddress && (
          <p className="mt-0.5 break-all font-mono text-[10.5px] text-muted-foreground dark:text-white/55" title={account.walletAddress}>
            {account.walletAddress}
          </p>
        )}
      </div>
      <div className="mx-2 border-t border-border dark:border-white/10" aria-hidden />
      <div className="p-1.5" role="menu" aria-label="Account actions">
        {account.walletAddress && (
          <button
            type="button"
            role="menuitem"
            onClick={() => void copyWallet()}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[12.5px] text-foreground transition hover:bg-accent dark:text-white/80 dark:hover:text-white"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden /> : <Copy className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />}
            {copied ? "Account ID copied" : "Copy account ID"}
          </button>
        )}
        <Link
          href="/settings"
          role="menuitem"
          onClick={() => setOpen(false)}
          className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[12.5px] text-foreground transition hover:bg-accent dark:text-white/80 dark:hover:text-white"
        >
          <Settings className="h-3.5 w-3.5 text-muted-foreground" aria-hidden /> Settings
        </Link>
        <button
          type="button"
          role="menuitem"
          onClick={() => setTheme(dark ? "light" : "dark")}
          aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
          className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[12.5px] text-foreground transition hover:bg-accent dark:text-white/80 dark:hover:text-white"
        >
          {dark ? <Sun className="h-3.5 w-3.5 text-muted-foreground" aria-hidden /> : <Moon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />}
          {dark ? "Light theme" : "Dark theme"}
        </button>
      </div>
      <div className="mx-2 border-t border-border dark:border-white/10" aria-hidden />
      <div className="p-1.5">
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setOpen(false);
            void signOut();
          }}
          className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[12.5px] font-medium text-rose-600 transition hover:bg-rose-50 dark:text-rose-300 dark:hover:bg-rose-950/50"
        >
          <LogOut className="h-3.5 w-3.5" aria-hidden /> Sign out
        </button>
      </div>
    </SidebarPopover>
  );

  if (collapsed) {
    return (
      <>
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={`Account: ${name}. Open account menu.`}
          title={name}
          className="mx-auto grid h-10 w-10 place-items-center rounded-full bg-emerald-600/10 text-[13px] font-semibold text-emerald-700 ring-1 ring-emerald-600/20 transition hover:bg-emerald-600/15 dark:bg-emerald-400/10 dark:text-emerald-300 dark:ring-emerald-400/20"
        >
          <span aria-hidden>{initial}</span>
        </button>
        {menu}
      </>
    );
  }

  return (
    <>
      <div className="flex min-h-[52px] min-w-0 items-center gap-2.5 rounded-xl px-2">
        <span
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-emerald-600/10 text-[12px] font-semibold text-emerald-700 ring-1 ring-emerald-600/20 dark:bg-emerald-400/10 dark:text-emerald-300 dark:ring-emerald-400/20"
          aria-hidden
        >
          {initial}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-foreground dark:text-white" title={name}>
          {account.label}
        </span>
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={`Account options for ${name}`}
          title="Account options"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition hover:bg-accent hover:text-foreground dark:text-white/55 dark:hover:bg-white/10 dark:hover:text-white"
        >
          <EllipsisVertical className="h-4 w-4" aria-hidden />
        </button>
      </div>
      {menu}
    </>
  );
}
