import { NextRequest, NextResponse } from "next/server";
import { AuthenticationRequiredError } from "@/server/auth";
import { archiveCampaign } from "@/server/campaigns";
import {
  CampaignNotFoundError,
  CampaignProtectedError,
  WorkspaceOwnerRequiredError
} from "@/server/deletion";

export const dynamic = "force-dynamic";

/**
 * Archive a campaign in place (owner only): it leaves Campaigns/Overview and
 * metrics but stays readable (detail page, share link, timeline) so audit
 * history remains intact. Idempotent - re-archiving succeeds with
 * alreadyArchived. Blocked only while production jobs are running.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    return NextResponse.json(await archiveCampaign(id));
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
