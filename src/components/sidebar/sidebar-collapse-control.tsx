"use client";

import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * User-controlled expand/collapse, HackerEarth-style panel icon.
 * Parent persists the preference.
 */
export function SidebarCollapseControl({
  collapsed,
  onToggle
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      aria-expanded={!collapsed}
      className={cn(
        "grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition",
        "hover:bg-black/[0.05] hover:text-foreground",
        "dark:text-white/50 dark:hover:bg-white/10 dark:hover:text-white"
      )}
    >
      {collapsed ? <PanelLeftOpen className="h-[18px] w-[18px]" aria-hidden /> : <PanelLeftClose className="h-[18px] w-[18px]" aria-hidden />}
    </button>
  );
}
