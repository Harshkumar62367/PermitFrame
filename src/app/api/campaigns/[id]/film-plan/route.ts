import { NextRequest, NextResponse } from "next/server";
import { AuthenticationRequiredError } from "@/server/auth";
import { loadCampaign } from "@/server/campaigns";
import { throwIfArchived } from "@/server/campaign-lifecycle";
import { newId, nowIso, updateDb } from "@/server/store";
import {
  describeFilmPlanSummary,
  mergeFilmPlanIntoRequest,
  validateFilmPlan
} from "@/server/livepeer/film-plan";
import { logDkgError, sanitizeDkgError } from "@/server/dkg/public-errors";

export const dynamic = "force-dynamic";

/**
 * Campaign Film planning endpoint (first half: plan + confirm only).
 * dryRun validates and summarizes without persisting (backs "Review film
 * plan"); without dryRun the validated plan is merged onto the campaign
 * request JSON next to the untouched template production spec. Never
 * rebuilds preflight, never submits a provider job - the active template
 * plan, runner, review, and proof paths are unaware of this field.
 * Blocked campaigns are refused, like template planning.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  try {
    const campaign = await loadCampaign(id);
    if (!campaign) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
    try {
      throwIfArchived(campaign, "film-planned");
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Archived campaigns are read-only." }, { status: 400 });
    }
    if (campaign.preflight?.decision !== "allow") {
      return NextResponse.json(
        { error: "Resolve the rights block before planning a campaign film - blocked campaigns never reach generation." },
        { status: 400 }
      );
    }
    // Invalid plans are rejected before persistence - nothing is stored.
    const validated = validateFilmPlan(body.filmPlan ?? body);
    if (!validated.ok) {
      return NextResponse.json({ error: validated.error }, { status: 400 });
    }
    const filmPlan = validated.filmPlan;
    const summary = describeFilmPlanSummary(filmPlan);
    const review = {
      sceneCount: filmPlan.scenes.length,
      totalSeconds: filmPlan.targetDurationSeconds,
      format: filmPlan.aspectRatio,
      budgetCapUsd: filmPlan.budgetCapUsd,
      summary
    };
    if (body.dryRun === true) return NextResponse.json({ ok: true, review });

    await updateDb((d) => {
      const c = d.campaigns.find((x) => x.id === id);
      if (!c) return;
      c.request = mergeFilmPlanIntoRequest(c.request, filmPlan);
      c.updatedAt = nowIso();
      d.events.push({
        id: newId("evt"),
        at: nowIso(),
        kind: "film-plan.save",
        summary: `Film plan saved (${summary}). Generation and final assembly have not started.`,
        refs: [id]
      });
    });
    const final = await loadCampaign(id);
    if (!final) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
    return NextResponse.json({ ok: true, review, campaign: final });
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    logDkgError("film-plan", error);
    const safe = sanitizeDkgError(error, "mutation");
    return NextResponse.json({ error: safe.message, code: safe.code }, { status: safe.status });
  }
}
