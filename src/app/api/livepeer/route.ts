import { NextResponse } from "next/server";
import { LivepeerMcpClient, livepeerConfig } from "@/server/livepeer/mcp-client";

export const dynamic = "force-dynamic";

export async function GET() {
  const client = new LivepeerMcpClient(livepeerConfig());
  try {
    const [capabilities, pricing] = await Promise.all([
      client.listCapabilities(),
      client.getPricing().catch(() => ({}))
    ]);
    return NextResponse.json({ ok: true, capabilities, pricing });
  } catch (error) {
    return NextResponse.json({ ok: false, error: (error as Error).message.slice(0, 400) }, { status: 502 });
  }
}
