import Link from "next/link";
import { PermitFrameMark } from "@/components/logo";
import { SidebarCollapseControl } from "./sidebar-collapse-control";

/**
 * HackerEarth-style sidebar header: brand left, collapse icon right,
 * thin divider below. Collapsed rail shows just the expand control,
 * centered like the icon-only rail in the reference.
 */
export function SidebarBrand({
  collapsed,
  onToggleCollapse
}: {
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  if (collapsed) {
    return (
      <div className="flex shrink-0 items-center justify-center border-b border-border px-2 py-2.5 dark:border-white/[0.07]">
        <SidebarCollapseControl collapsed={collapsed} onToggle={onToggleCollapse} />
      </div>
    );
  }
  return (
    <div className="flex h-14 shrink-0 items-center justify-between gap-1 border-b border-border pl-4 pr-2.5 dark:border-white/[0.07]">
      <Link
        href="/workspace"
        className="flex min-w-0 items-center gap-2.5"
        aria-label="PermitFrame home"
      >
        <PermitFrameMark className="h-7 w-7 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <span className="min-w-0">
          <span className="block truncate text-[15px] font-semibold leading-none tracking-tight text-foreground dark:text-white">
            Permit<span className="text-emerald-600 dark:text-emerald-400">Frame</span>
          </span>
          <span
            className="pf-side-micro mt-1 block font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground dark:text-white/35"
            title="Attested creator rights, enforced before generation"
          >
            verified production
          </span>
        </span>
      </Link>
      <SidebarCollapseControl collapsed={collapsed} onToggle={onToggleCollapse} />
    </div>
  );
}
