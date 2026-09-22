"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * HackerEarth-style pinned bottom utilities: icon + label rows matching
 * the primary nav geometry. Theme is an instant toggle action -
 * never a dead link. Mount-gated: the server and first client render
 * assume light theme so hydration matches, then sync to the real theme.
 */
export function SidebarFooterNav({ collapsed = false }: { collapsed?: boolean }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // Mount-only flip so the first client render matches the server.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);
  const dark = mounted && resolvedTheme === "dark";
  const label = dark ? "Light theme" : "Dark theme";
  const title = dark ? "Switch to light theme" : "Switch to dark theme";

  return (
    <div role="group" aria-label="Display preferences" className={cn(collapsed && "flex flex-col items-center")}>
      <button
        type="button"
        onClick={() => setTheme(dark ? "light" : "dark")}
        aria-label={title}
        title={collapsed ? title : undefined}
        className={cn(
          "pf-side-row group flex items-center gap-3 rounded-lg text-[14px] transition-colors",
          collapsed
            ? "h-10 w-10 justify-center rounded-xl p-0"
            : "h-10 w-full px-3",
          "font-normal text-muted-foreground hover:bg-black/[0.04] hover:text-foreground dark:text-white/55 dark:hover:bg-white/[0.05] dark:hover:text-white"
        )}
      >
        {dark ? (
          <Sun className="h-[18px] w-[18px] shrink-0" aria-hidden />
        ) : (
          <Moon className="h-[18px] w-[18px] shrink-0" aria-hidden />
        )}
        {!collapsed && <span className="min-w-0 flex-1 truncate text-left">Theme</span>}
        {!collapsed && (
          <span className="shrink-0 text-[11px] text-muted-foreground/70 dark:text-white/35">{label}</span>
        )}
      </button>
    </div>
  );
}
