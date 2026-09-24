import { NextResponse } from "next/server";
import { AuthenticationRequiredError, requireCurrentSession, type WorkspaceSession } from "@/server/auth";
import { getDkg } from "@/server/dkg";
import { dkgStatusResponse } from "@/server/dkg/status";
import { loadWorkspaceDb } from "@/server/store";
import { logDkgError, sanitizeDkgError } from "@/server/dkg/public-errors";

export const dynamic = "force-dynamic";

/**
 * Workspace-member proof status: static health plus ONLY this workspace's
 * permitted shared/anchored proof records (see server/dkg/status.ts and
 * workspace-records.ts). Every request requires an authenticated
 * PermitFrame session - the session workspace binds all reads, and no
 * identifier-parameterized reads exist, so no cross-workspace identifier
 * can be requested. Arbitrary SPARQL execution is deliberately NOT
 * exposed: the former browser console was diagnostic-only and has been
 * removed from both this route and the Graph page. Failures return static
 * sanitized errors only - never SSH hostnames, commands, paths,
 * credentials, or raw adapter text.
 */
export async function GET() {
  let session: WorkspaceSession | null;
  try {
    session = await requireCurrentSession();
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) session = null;
    else throw error;
  }
  try {
    const dkg = getDkg();
    const workspaceId = session?.workspaceId;
    return await dkgStatusResponse(session, dkg, () =>
      workspaceId ? loadWorkspaceDb(workspaceId) : Promise.resolve(null)
    );
  } catch (error) {
    logDkgError("dkg-status", error);
    const safe = sanitizeDkgError(error, "query");
    return NextResponse.json({ error: safe.message, code: safe.code }, { status: safe.status });
  }
}
