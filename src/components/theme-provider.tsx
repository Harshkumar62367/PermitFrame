"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // next-themes persists to localStorage and injects a blocking pre-paint
  // script (same technique as the Next.js "preventing flash" guide), so the
  // stored theme applies before first paint without hydration mismatches.
  // `suppressHydrationWarning` on <html> in app/layout.tsx covers the rest.
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="light"
      enableSystem={false}
      storageKey="permitframe-theme"
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}
