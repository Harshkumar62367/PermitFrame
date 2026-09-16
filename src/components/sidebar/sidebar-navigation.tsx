"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { APP_NAV, isNavActive } from "@/components/app-nav";

/**
 * Primary navigation, HackerEarth-style: flat icon + label rows (~40px),
 * rounded-lg, neutral grey active pill. Section grouping from APP_NAV is
 * preserved for screen readers via aria-labels but renders as one
 * continuous list like the reference. Collapsed rail shows icon-only
 * rows with tooltips.
 */
export function SidebarNavigation({
  collapsed = false,
  onNavigate
}: {
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();

  return (
    <nav className="pf-no-scrollbar min-h-0 flex-1 overflow-y-auto" aria-label="Primary">
      <div className={cn("flex flex-col py-2", collapsed ? "items-center px-2" : "px-3")}>
        {APP_NAV.map((group, gi) => (
          <div
            key={group.section}
            role="group"
            aria-label={group.section}
            className={cn(collapsed ? "flex flex-col items-center" : "flex flex-col gap-0.5", gi > 0 && !collapsed && "mt-0.5")}
          >
            <div className={cn(collapsed ? "flex flex-col items-center gap-1" : "flex flex-col gap-0.5")}>
              {group.items.map((item) => {
                const active = isNavActive(pathname, item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    title={collapsed ? item.label : undefined}
                    aria-label={collapsed ? item.label : undefined}
                    className={cn(
                      "pf-side-row group flex items-center gap-3 rounded-lg text-[14px] transition-colors",
                      collapsed
                        ? "h-10 w-10 justify-center rounded-xl p-0"
                        : "h-10 px-3",
                      active
                        ? "bg-black/[0.06] font-medium text-foreground dark:bg-white/[0.09] dark:text-white"
                        : "font-normal text-muted-foreground hover:bg-black/[0.04] hover:text-foreground dark:text-white/55 dark:hover:bg-white/[0.05] dark:hover:text-white"
                    )}
                  >
                    <item.icon
                      className="h-[18px] w-[18px] shrink-0"
                      aria-hidden
                    />
                    {!collapsed && <span className="min-w-0 truncate">{item.label}</span>}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </nav>
  );
}
