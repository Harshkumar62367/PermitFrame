import { NextRequest, NextResponse } from "next/server";
import { AuthenticationRequiredError } from "@/server/auth";
import { refreshVerificationSnapshot } from "@/server/campaigns";
import {
  CampaignNotFoundError,
  CampaignProtectedError,
  WorkspaceOwnerRequiredError
} from "@/server/deletion";

export const dynamic = "force-dynamic";

/**
 * Owner-only "Refresh verification link" for pre-snapshot approvals. Builds a
 * new opaque snapshot from the campaign's real current data — never marks old
 * campaigns as verified, never rewrites status or proof.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    return NextResponse.json(await refreshVerificationSnapshot(id));
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    if (error instanceof WorkspaceOwnerRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof CampaignNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof CampaignProtectedError) {
      return NextResponse.json(
        { error: error.message, reasons: error.reasons, archiveAvailable: error.archiveAvailable },
        { status: 409 }
      );
    }
    throw error;
  }
}
