import {
  FolderKanban,
  Images,
  LayoutDashboard,
  Package,
  SearchCheck,
  Settings,
  ShieldCheck,
  Waypoints,
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

/** Single source of truth for desktop sidebar + mobile drawer. */
export const APP_NAV: NavGroup[] = [
  {
    section: "Workspace",
    items: [
      { href: "/workspace", label: "Overview", icon: LayoutDashboard },
      { href: "/campaigns", label: "Campaigns", icon: FolderKanban },
      { href: "/products", label: "Products & facts", icon: Package },
      { href: "/media", label: "Media library", icon: Images }
    ]
  },
  {
    section: "Trust & proof",
    items: [
      { href: "/consents", label: "Creator consents", icon: ShieldCheck },
      { href: "/graph", label: "Knowledge graph", icon: Waypoints },
      { href: "/verifier", label: "Verifier", icon: SearchCheck }
    ]
  },
  {
    section: "System",
    items: [{ href: "/settings", label: "Settings", icon: Settings }]
  }
];

export function isNavActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
