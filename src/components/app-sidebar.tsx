"use client";

import { cn } from "@/lib/utils";
import { SidebarBrand } from "./sidebar/sidebar-brand";
import { WorkspaceSwitcher } from "./sidebar/workspace-switcher";
import { SidebarNavigation } from "./sidebar/sidebar-navigation";
import { SidebarFooterNav } from "./sidebar/sidebar-footer-nav";
import { IntegrationStatusStrip } from "./sidebar/integration-status-strip";
import { AccountMenu } from "./sidebar/account-menu";
import type { IntegrationHealth } from "@/lib/use-integration-health";

export type ShellHealth = IntegrationHealth;

/**
 * Desktop sidebar, HackerEarth-style floating panel: inset from the viewport
 * edges with rounded corners, header (brand + collapse) / switcher+nav /
 * utilities+strip+account zones. Collapsed rail is 68px.
 */
export function AppSidebar({
  health,
  collapsed = false,
  onToggleCollapse = () => undefined,
  isSlow = false,
  onRetry
}: {
  health: ShellHealth | null;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  isSlow?: boolean;
  onRetry?: () => void;
}) {
  return (
    <aside
      aria-label="Primary"
      className={cn(
        "fixed bottom-3 left-3 top-3 z-40 hidden flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm lg:flex dark:border-white/[0.08] dark:bg-[#1d1f21] dark:shadow-none",
        collapsed ? "w-[68px]" : "w-[248px]"
      )}
    >
      <SidebarBrand collapsed={collapsed} onToggleCollapse={onToggleCollapse} />

      <div className={cn("shrink-0 border-b border-border dark:border-white/[0.07]", collapsed ? "px-2 py-2" : "px-3 py-2")}>
        <WorkspaceSwitcher collapsed={collapsed} />
      </div>

      <SidebarNavigation collapsed={collapsed} />

      <div className={cn("shrink-0 space-y-1 border-t border-border dark:border-white/[0.07]", collapsed ? "px-2 py-2" : "px-3 py-2")}>
        <SidebarFooterNav collapsed={collapsed} />
        <IntegrationStatusStrip health={health} collapsed={collapsed} isSlow={isSlow} onRetry={onRetry} />
        <AccountMenu collapsed={collapsed} />
      </div>
    </aside>
  );
}
