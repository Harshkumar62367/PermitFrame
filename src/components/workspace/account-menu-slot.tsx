"use client";

import { LogOut, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AuthControl } from "@/components/auth-control";
import { useWorkspace, type AccountIdentity } from "./workspace-context";
import { TruncatedIdentifier } from "@/components/ui/identifier";

/**
 * Account seam for the sidebar/mobile drawer. Renders the real Privy-backed
 * AuthControl by default; tests or future id-providers can inject `account`.
 */
export function AccountMenuSlot({
  account,
  compact = false
}: {
  account?: AccountIdentity | null;
  compact?: boolean;
}) {
  const ctx = useWorkspace();
  const resolved = account ?? ctx.account;
  if (!resolved) return <AuthControl compact={compact} />;
  return (
    <div className="flex min-w-0 items-center gap-2">
      {!compact && (
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-white/55" title={resolved.fullLabel ?? resolved.label}>
          {resolved.label}
        </span>
      )}
      {resolved.walletAddress && (
        <Wallet className="h-3.5 w-3.5 shrink-0 text-emerald-400" aria-label={`Wallet ${resolved.walletAddress}`} />
      )}
      <span className="sr-only">{resolved.fullLabel ?? resolved.label}</span>
    </div>
  );
}

/** Sign-out stays beside the injected account label (real behavior only). */
export function AccountSignOut() {
  return <AuthControl compact />;
}

export function SignOutIconButton({ onSignOut, label = "Sign out" }: { onSignOut: () => void; label?: string }) {
  return (
    <Button
      onClick={onSignOut}
      variant="ghost"
      size="icon"
      className="h-8 w-8 shrink-0 rounded-full text-white/55 hover:bg-white/10 hover:text-white"
      aria-label={label}
    >
      <LogOut className="h-3.5 w-3.5" aria-hidden />
    </Button>
  );
}

export function InjectedAccountLabel({ account }: { account: AccountIdentity }) {
  return <TruncatedIdentifier value={account.fullLabel ?? account.label} prefixLength={14} suffixLength={6} className="text-white/55" />;
}
