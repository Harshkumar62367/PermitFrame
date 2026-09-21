import { CAPABILITY_PRICE_MAP } from "../types";
import { LivepeerMcpClient, livepeerConfig } from "./mcp-client";

export interface LivePrice {
  usd: number;
  unit: string;
  unitKind: string;
}

/**
 * Live Creative MCP pricing, TTL-cached and never throwing: a slow or
 * unreachable agent yields `null` (callers fall back to clearly labeled
 * historical estimates) instead of blocking workspace screens.
 */
const PRICING_TTL_MS = 10 * 60 * 1000;
let cached: { prices: Map<string, LivePrice>; expiresAt: number } | null = null;
let pending: Promise<Map<string, LivePrice> | null> | null = null;

/** Parse a get_pricing payload in either envelope shape (pure, unit-testable). */
export function parseLivePrices(raw: unknown): Map<string, LivePrice> {
  const out = new Map<string, LivePrice>();
  // getPricing() unwraps result.structuredContent, so accept both the
  // unwrapped `{capabilities}` shape and the raw envelope shape.
  const root = raw as { structuredContent?: { capabilities?: unknown }; capabilities?: unknown };
  const list = Array.isArray(root?.structuredContent?.capabilities)
    ? root.structuredContent.capabilities
    : Array.isArray(root?.capabilities)
      ? root.capabilities
      : [];
  for (const c of list) {
    if (typeof c !== "object" || c === null) continue;
    const row = c as Record<string, unknown>;
    if (typeof row.name !== "string" || typeof row.display_price_usd !== "number") continue;
    out.set(row.name, {
      usd: row.display_price_usd,
      unit: typeof row.display_unit === "string" ? row.display_unit : "",
      unitKind: typeof row.unit_kind === "string" ? row.unit_kind : ""
    });
  }
  return out;
}

async function fetchFresh(): Promise<Map<string, LivePrice> | null> {
  try {
    const prices = parseLivePrices(await new LivepeerMcpClient(livepeerConfig()).getPricing());
    return prices.size > 0 ? prices : null;
  } catch {
    return null;
  }
}

export async function fetchLivePriceMap(): Promise<Map<string, LivePrice> | null> {
  if (cached && cached.expiresAt > Date.now()) return cached.prices;
  if (!pending) {
    pending = fetchFresh()
      .then((prices) => {
        if (prices) cached = { prices, expiresAt: Date.now() + PRICING_TTL_MS };
        return prices;
      })
      .finally(() => {
        pending = null;
      });
  }
  return pending;
}

export interface StageQuote {
  usd: number;
  /** True only when derived from a live per-image/per-second price. */
  exact: boolean;
}

/**
 * Expected cost for one plan stage. Live per-image and per-second prices map
 * accurately (video uses the stage duration, defaulting to 5s); per-megapixel
 * and exotic units (tokens, tracks, calls) cannot be quoted exactly, so the
 * historical static map fills in and the quote is marked inexact — callers
 * must label it an estimate, never a live price.
 */
export function quoteStage(
  stage: { capability: string; kind: string },
  live: Map<string, LivePrice> | null,
  durationSeconds = 5
): StageQuote | null {
  const entry = live?.get(stage.capability);
  if (entry) {
    if (entry.unit === "image") return { usd: entry.usd, exact: true };
    if (entry.unit === "second") return { usd: entry.usd * durationSeconds, exact: true };
  }
  const fallback = CAPABILITY_PRICE_MAP[stage.capability];
  if (!fallback) return null;
  return { usd: fallback.unit === "second" ? fallback.usd * durationSeconds : fallback.usd, exact: false };
}

/**
 * Server-side spend ceiling for one `create_media` call: 3x the expected
 * cost (live when exactly mappable, else historical), floored at $0.25 and
 * defaulting to $5 when nothing is mappable. Bounds runaway renders; it is
 * not a price quote — the user confirms the estimate separately.
 */
export function stageSpendingCeiling(
  stage: { capability: string; kind: string },
  live: Map<string, LivePrice> | null,
  durationSeconds = 5
): number {
  const quote = quoteStage(stage, live, durationSeconds);
  if (!quote) return 5;
  return Math.round(Math.max(quote.usd * 3, 0.25) * 100) / 100;
}
