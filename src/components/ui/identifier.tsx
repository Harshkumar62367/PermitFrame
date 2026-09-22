"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Long DKG identifiers: truncated visually, full value in tooltip,
 * one-click copy. splits copy behavior from pure truncation so server
 * components can use TruncatedIdentifier without client JS.
 */
export function TruncatedIdentifier({
  value,
  className,
  prefixLength = 18,
  suffixLength = 10
}: {
  value: string;
  className?: string;
  prefixLength?: number;
  suffixLength?: number;
}) {
  const short =
    value.length > prefixLength + suffixLength + 3
      ? `${value.slice(0, prefixLength)}…${value.slice(-suffixLength)}`
      : value;
  return (
    <span title={value} className={cn("pf-id font-mono", className)}>
      {short}
    </span>
  );
}

export function CopyableIdentifier({
  value,
  className,
  label = "Copy identifier"
}: {
  value: string;
  className?: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard unavailable (permissions) - tooltip still exposes the value
    }
  }
  return (
    <span className={cn("inline-flex min-w-0 max-w-full items-center gap-1.5", className)}>
      <TruncatedIdentifier value={value} className="flex-1 text-muted-foreground" />
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={`${label}: ${value}`}
        title={value}
        className="shrink-0 rounded-md p-1 text-muted-foreground transition hover:bg-accent hover:text-accent-foreground"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
      </button>
    </span>
  );
}
