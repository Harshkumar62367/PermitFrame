"use client";

import { usePrivy } from "@privy-io/react-auth";
import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { LogIn, LogOut, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePermitFrameSession } from "@/components/privy-provider";

export function AuthControl({ compact = false }: { compact?: boolean }) {
  const { ready, authenticated, user, login } = usePrivy();
  const { status, signOut } = usePermitFrameSession();
  const pathname = usePathname();
  const router = useRouter();

  // A completed Privy sign-in should feel like entering the product, not a
  // separate identity step followed by another button click.
  useEffect(() => {
    if (authenticated && status === "ready" && pathname === "/") router.replace("/workspace");
  }, [authenticated, pathname, router, status]);

  if (!ready) {
    return <span className="font-mono text-[10px] text-muted-foreground dark:text-white/35">Loading identity…</span>;
  }

  if (!authenticated) {
    return (
      <Button onClick={() => login()} size={compact ? "sm" : "default"} className="rounded-full bg-emerald-400 font-medium text-emerald-950 hover:bg-emerald-300">
        <LogIn className="h-3.5 w-3.5" /> Sign in
      </Button>
    );
  }

  const identity = user?.email?.address ?? user?.google?.name ?? user?.wallet?.address?.slice(0, 10) ?? "Signed in";
  return (
    <div className="flex items-center gap-2">
      {!compact && <span className="max-w-28 truncate font-mono text-[10px] text-muted-foreground dark:text-white/55" title={identity}>{identity}</span>}
      {user?.wallet && <Wallet className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" aria-label="Wallet linked" />}
      <Button onClick={() => void signOut()} disabled={status === "loading"} variant="ghost" size="icon" className="h-8 w-8 rounded-full text-muted-foreground hover:bg-accent hover:text-foreground dark:text-white/55 dark:hover:bg-white/10 dark:hover:text-white" aria-label="Sign out">
        <LogOut className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
