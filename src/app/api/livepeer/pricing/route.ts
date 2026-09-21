import { NextResponse } from "next/server";
import { fetchLivePriceMap } from "@/server/livepeer/pricing";

export const dynamic = "force-dynamic";

/**
 * Live Creative MCP price map for pre-render estimates. Best-effort and
 * cache-backed: `{ok:false}` when the agent is unreachable — the studio
 * falls back to clearly labeled historical estimates instead of blocking.
 */
export async function GET() {
  const prices = await fetchLivePriceMap();
  if (!prices) {
    return NextResponse.json({ ok: false, error: "Live pricing is currently unreachable." });
  }
  return NextResponse.json({
    ok: true,
    checkedAt: new Date().toISOString(),
    prices: [...prices.entries()].map(([name, p]) => ({ name, usd: p.usd, unit: p.unit, unitKind: p.unitKind }))
  });
}
