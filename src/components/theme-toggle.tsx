"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

export function ThemeToggle({ subtle = false }: { subtle?: boolean }) {
  const { resolvedTheme, setTheme } = useTheme();
  // Mount-gated so the server HTML and the first client render are
  // identical (placeholder). Reading `resolvedTheme` immediately would
  // hydrate "Switch to dark theme" on the server but "Switch to light
  // theme" on a dark-mode client — a hydration mismatch that forces a
  // full client re-render.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // Mount-only flip so the first client render matches the server.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  if (!mounted) {
    return <Button variant="ghost" size="icon" className={subtle ? "h-8 w-8 text-white/40" : "h-8 w-8"} aria-label="Switch to dark theme" />;
  }
  const dark = resolvedTheme === "dark";
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setTheme(dark ? "light" : "dark")}
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      title={dark ? "Switch to light theme" : "Switch to dark theme"}
      className={subtle ? "h-8 w-8 text-white/50 hover:bg-white/10 hover:text-white" : "h-8 w-8"}
    >
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  );
}
