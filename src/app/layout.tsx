import type { Metadata } from "next";
import { Inter, IBM_Plex_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { PermitFramePrivyProvider } from "@/components/privy-provider";
import { QueryProvider } from "@/components/query-provider";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap"
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  weight: ["400", "500", "600"],
  subsets: ["latin"],
  display: "swap"
});

export const metadata: Metadata = {
  title: "PermitFrame - verified AI campaign production",
  description:
    "PermitFrame helps creative teams turn approved creator rights and brand rules into platform-ready AI campaign assets - with a reviewable proof trail."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${plexMono.variable}`} suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <QueryProvider>
          <PermitFramePrivyProvider>
            <ThemeProvider>{children}</ThemeProvider>
          </PermitFramePrivyProvider>
        </QueryProvider>
      </body>
    </html>
  );
}
