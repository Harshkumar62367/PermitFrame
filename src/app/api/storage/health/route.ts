import { NextResponse } from "next/server";
import { getStorageHealth } from "@/server/asset-store";

export const dynamic = "force-dynamic";

/**
 * Durable-storage health: configured/unconfigured + reachable/unreachable.
 * Never exposes credentials, cloud names, or account details.
 */
export async function GET() {
  const health = await getStorageHealth();
  return NextResponse.json({
    storage: health.configured ? "cloudinary" : "unconfigured",
    configured: health.configured,
    reachable: health.reachable,
    detail: !health.configured
      ? "Durable storage is not configured - outputs stay provider-hosted."
      : health.reachable
        ? "Durable storage reachable - completed outputs persist to PermitFrame storage."
        : "Durable storage unreachable - completed outputs wait as storage-pending with provider results intact."
  });
}
