"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/consents", label: "Creator permissions" },
  { href: "/products", label: "Brand rules" }
];

/**
 * Sub-navigation for the permissions + rules area: creator permissions and
 * brand rules are two tabs of one workflow, even though the /consents and
 * /products routes are preserved underneath.
 */
export function RightsTabs() {
  const pathname = usePathname();
  return (
    <nav aria-label="Permissions and brand rules" className="flex w-fit gap-1 rounded-full border border-border bg-card p-1">
      {TABS.map((t) => {
        const active = pathname === t.href || pathname.startsWith(`${t.href}/`);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-full px-4 py-1.5 text-[12.5px] font-medium transition",
              active
                ? "bg-foreground text-background dark:bg-white dark:text-black"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
