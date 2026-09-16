"use client";

import { motion, useInView, useReducedMotion, useSpring, useTransform } from "framer-motion";
import { useEffect, useRef, type ReactNode } from "react";

export function FadeIn({
  children,
  delay = 0,
  y = 18,
  className,
  subtle = false
}: {
  children: ReactNode;
  delay?: number;
  y?: number;
  className?: string;
  /** Subtle 150–250ms entrance for above-the-fold dashboard content. */
  subtle?: boolean;
}) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;
  const distance = subtle ? 8 : y;
  const duration = subtle ? 0.2 : 0.6;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: distance }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "0px 0px -40px 0px" }}
      transition={{ duration, delay: subtle ? 0 : delay, ease: [0.21, 0.47, 0.32, 0.98] }}
    >
      {children}
    </motion.div>
  );
}

export function Stagger({
  children,
  className,
  gap = 0.08
}: {
  children: ReactNode;
  className?: string;
  gap?: number;
}) {
  return (
    <motion.div
      className={className}
      initial="hidden"
      animate="show"
      variants={{ hidden: {}, show: { transition: { staggerChildren: gap } } }}
    >
      {children}
    </motion.div>
  );
}

export function StaggerItem({ children, className }: { children: ReactNode; className?: string }) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      variants={{
        hidden: { opacity: 0, y: 20 },
        show: { opacity: 1, y: 0, transition: { duration: 0.55, ease: [0.21, 0.47, 0.32, 0.98] } }
      }}
    >
      {children}
    </motion.div>
  );
}

export function Marquee({ items }: { items: string[] }) {
  const doubled = [...items, ...items];
  return (
    <div className="relative overflow-hidden py-1" aria-hidden>
      <div className="flex w-max animate-marquee gap-3">
        {doubled.map((item, i) => (
          <span
            key={i}
            className="rounded-full border border-border bg-muted px-4 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground dark:border-white/10 dark:bg-white/[0.04] dark:text-white/60"
          >
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * Animated counter with explicit formatting semantics. Integer counters must
 * pass `integer` (or `decimals={0}`) so transient spring values never render
 * fractional digits; currency uses `decimals={2}`. A custom `format` wins.
 */
export function AnimatedNumber({
  value,
  prefix = "",
  suffix = "",
  decimals,
  integer = false,
  format
}: {
  value: number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  integer?: boolean;
  format?: (v: number) => string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: "-40px" });
  const spring = useSpring(0, { stiffness: 70, damping: 18 });
  const effectiveDecimals = decimals ?? (integer ? 0 : undefined);
  const display = useTransform(spring, (v) => {
    const body = format ? format(v) : effectiveDecimals !== undefined ? v.toFixed(effectiveDecimals) : Math.round(v).toString();
    return `${prefix}${body}${suffix}`;
  });
  useEffect(() => {
    if (inView) spring.set(value);
  }, [inView, value, spring]);
  return (
    <span ref={ref}>
      <motion.span>{display}</motion.span>
    </span>
  );
}

export function VerdictCheck({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <motion.path
        d="M4 12.5l5.2 5.2L20 6.5"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.5, delay: 0.15, ease: "easeOut" }}
      />
    </svg>
  );
}

export function VerdictCross({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <motion.path
        d="M6 6l12 12M18 6L6 18"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.4, ease: "easeOut" }}
      />
    </svg>
  );
}
