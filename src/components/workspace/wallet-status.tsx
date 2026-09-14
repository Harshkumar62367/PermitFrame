"use client";

import { usePrivy } from "@privy-io/react-auth";
import { Wallet } from "lucide-react";
import { TruncatedIdentifier } from "@/components/ui/identifier";

/**
 * Wallet seam. Shows the linked Privy wallet when present, renders nothing
 * otherwise — never a fake connect button.
 */
export function WalletStatus({ address }: { address?: string }) {
  const { user } = usePrivy();
  const resolved = address ?? user?.wallet?.address;
  if (!resolved) return null;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 font-mono text-[10px] text-white/55" title={resolved}>
      <Wallet className="h-3.5 w-3.5 shrink-0 text-emerald-400" aria-hidden />
      <TruncatedIdentifier value={resolved} prefixLength={6} suffixLength={4} className="text-white/55" />
      <span className="sr-only">Wallet linked: {resolved}</span>
    </span>
  );
}
