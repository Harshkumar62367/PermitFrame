import { NextResponse } from "next/server";
import { catalogueSnapshot, modelChoicesForOverride } from "@/server/livepeer/catalogue";
import { logDkgError, sanitizeDkgError } from "@/server/dkg/public-errors";

export const dynamic = "force-dynamic";

/**
 * Safe expert-model choices for Short Clip packs. Returns display data
 * only (capability name + short provider blurb) per override role, drawn
 * from the current live catalogue - never endpoints, auth mode details,
 * raw payloads, internal model ids, or provider diagnostics. Unreachable
 * discovery yields empty lists (the UI shows a neutral retry state);
 * validation at preview/apply remains authoritative.
 */
export async function GET() {
  try {
    const snapshot = await catalogueSnapshot();
    return NextResponse.json({
      ok: true,
      reachable: snapshot.reachable,
      checkedAt: snapshot.checkedAt,
      choices: {
        conceptImage: modelChoicesForOverride(snapshot, "conceptImage"),
        imageToVideo: modelChoicesForOverride(snapshot, "imageToVideo")
      }
    });
  } catch (error) {
    logDkgError("livepeer-model-choices", error);
    const safe = sanitizeDkgError(error, "provider");
    return NextResponse.json({ ok: false, error: safe.message, code: safe.code }, { status: safe.status });
  }
}
