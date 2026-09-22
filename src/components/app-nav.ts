import {
  BadgeCheck,
  FolderKanban,
  Images,
  LayoutDashboard,
  Package,
  Settings,
  ShieldCheck,
  type LucideIcon
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

export interface NavGroup {
  section: string;
  items: NavItem[];
}

/**
 * Single source of truth for desktop sidebar + mobile drawer.
 * Task-based IA: Overview first, Campaigns as the working home, then the
 * three libraries (creator permissions, brand rules, media), Verification,
 * and Settings. Brand rules reuses the existing /products route, API, data,
 * and policy-engine integration - renamed, not rebuilt.
 */
export const APP_NAV: NavGroup[] = [
  {
    section: "Workspace",
    items: [
      { href: "/workspace", label: "Overview", icon: LayoutDashboard },
      { href: "/campaigns", label: "Campaigns", icon: FolderKanban },
      { href: "/consents", label: "Creator permissions", icon: ShieldCheck },
      { href: "/products", label: "Brand rules", icon: Package },
      { href: "/media", label: "Media library", icon: Images },
      { href: "/verifier", label: "Verification", icon: BadgeCheck },
      { href: "/settings", label: "Settings", icon: Settings }
    ]
  }
];

export function isNavActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
