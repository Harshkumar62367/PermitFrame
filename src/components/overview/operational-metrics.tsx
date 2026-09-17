"use client";

import Link from "next/link";
import { AlertOctagon, CircleCheck, PackageCheck, ShieldCheck } from "lucide-react";
import { FadeIn } from "@/components/motion-primitives";
import type { OperationalMetrics } from "@/lib/use-workspace-snapshot";
import { cn } from "@/lib/utils";

function formatUsd(value: number): string {
  return value.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Dense operational summary strip. Every value is computed server-side from
 * real campaign/preflight/job data; every metric navigates to the campaigns
 * it counts. No fabricated analytics — zeros render as zeros.
 */
export function OperationalMetricsStrip({ metrics }: { metrics: OperationalMetrics }) {
  const items = [
    {
      label: "Needs attention",
      value: String(metrics.needsAttention),
      hint: metrics.needsAttention === 0 ? "no blocked requests" : "blocked before generation",
      href: "/campaigns?filter=attention",
      icon: AlertOctagon,
      tone: metrics.needsAttention > 0 ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground/60"
    },
    {
      label: "Ready to produce",
      value: String(metrics.readyToProduce),
      hint: metrics.readyToProduce === 0 ? "nothing cleared yet" : "cleared for production",
      href: "/campaigns?filter=ready",
      icon: CircleCheck,
      tone: metrics.readyToProduce > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground/60"
    },
    {
      label: "Outputs delivered",
      value: String(metrics.outputsDelivered),
      hint: metrics.outputsDelivered === 0 ? "no receipts yet" : "receipted outputs",
      href: "/campaigns?filter=delivered",
      icon: PackageCheck,
      tone: "text-muted-foreground/60"
    },
    {
      label: "Spend protected",
      value: formatUsd(metrics.spendProtected),
      hint: metrics.spendProtected === 0 ? "no prevented spend" : "production spend prevented",
      href: "/campaigns?filter=attention",
      icon: ShieldCheck,
      tone: metrics.spendProtected > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground/60"
    }
  ];
  return (
    <FadeIn subtle>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" role="list" aria-label="Operational summary">
        {items.map((item) => (
          <Link
            key={item.label}
            href={item.href}
            role="listitem"
            className="group rounded-2xl border border-border bg-card px-4 py-3.5 transition hover:-translate-y-0.5 hover:border-emerald-600/30 hover:shadow-[0_12px_40px_-16px_rgba(16,185,129,0.2)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600"
          >
            <span className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{item.label}</span>
              <item.icon className={cn("h-4 w-4 shrink-0", item.tone)} aria-hidden />
            </span>
            <span className="font-display mt-1 block text-[26px] font-semibold leading-none tracking-tight">{item.value}</span>
            <span className="mt-1 block truncate text-[12px] text-muted-foreground">{item.hint}</span>
          </Link>
        ))}
      </div>
    </FadeIn>
  );
}
