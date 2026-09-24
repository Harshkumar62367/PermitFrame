import { NextRequest, NextResponse } from "next/server";
import { AuthenticationRequiredError } from "@/server/auth";
import { applyTemplateSpec, loadCampaign } from "@/server/campaigns";
import { resolveEntitlements } from "@/server/entitlements";
import { fetchLivePriceMap, quoteStage } from "@/server/livepeer/pricing";
import { catalogueSnapshot, resolvePlanRolesLive } from "@/server/livepeer/catalogue";
import { checkModelOverrides } from "@/server/livepeer/template-validation";
import {
  buildTemplateStages,
  estimateTemplateMinutes,
  getTemplate,
  validateTemplateSelection
} from "@/server/livepeer/templates";
import { normalizeQualityProfile } from "@/server/livepeer/plan-dag";
import { logDkgError, sanitizeDkgError } from "@/server/dkg/public-errors";

export const dynamic = "force-dynamic";

/**
 * Template planning endpoint. dryRun previews the assembled plan (stages,
 * live cost estimate, rough minutes, deferred list) without persisting;
 * without dryRun the spec is validated, stored, and the plan rebuilt
 * through preflight. Blocked campaigns are refused - they never reach
 * generation, so they never reach template planning either.
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
    if (campaign.preflight?.decision !== "allow") {
      return NextResponse.json(
        { error: "Resolve the rights block before choosing a production template - blocked campaigns never reach generation." },
        { status: 400 }
      );
    }
    const tier = resolveEntitlements();
    const validated = validateTemplateSelection(body.selection ?? body, tier.maxCustomStages);
    if (!validated.ok || !validated.spec) {
      return NextResponse.json({ error: validated.error ?? "Invalid template selection." }, { status: 400 });
    }
    const spec = validated.spec;
    const template = getTemplate(spec.templateId);
    if (!template) return NextResponse.json({ error: `Unknown template "${spec.templateId}".` }, { status: 400 });

    // Expert model choices are enforced live on preview AND apply: the
    // override must be currently available and compatible with its role.
    const snapshot = await catalogueSnapshot();
    const overrides = checkModelOverrides(spec, template, snapshot);
    if (!overrides.ok) return NextResponse.json({ error: overrides.error }, { status: 400 });

    const profile = normalizeQualityProfile(spec.qualityProfile);
    const roles = await resolvePlanRolesLive(profile);
    const built = buildTemplateStages(template, spec, (role) => {
      const resolved = (roles as Record<string, { capability: string | null; fallbackFrom?: string }>)[role];
      const capability =
        role === "sourceGuidedImage"
          ? (roles.conceptImage.capability ?? "flux-dev")
          : (resolved?.capability ?? "flux-dev");
      const fallbackFrom = role === "sourceGuidedImage" ? roles.conceptImage.fallbackFrom : resolved?.fallbackFrom;
      return { capability, ...(fallbackFrom ? { fallbackFrom } : {}) };
    });
    if (!built.ok) return NextResponse.json({ error: built.error }, { status: 400 });
    const plan = built.plan;

    // Live cost estimate over the executable stages (inexact units marked).
    const live = await fetchLivePriceMap();
    let total = 0;
    let exact = true;
    let quotable = false;
    for (const s of plan.stages) {
      const quote = quoteStage(
        { capability: s.capability, kind: s.recipe.kind },
        live,
        s.durationSeconds ?? s.recipe.defaultDurationSeconds ?? 5
      );
      if (!quote) {
        exact = false;
        continue;
      }
      quotable = true;
      total += quote.usd;
      if (!quote.exact) exact = false;
    }
    const preview = {
      templateId: template.id,
      packSize: spec.packSize,
      stages: plan.stages.map((s) => ({
        id: s.recipe.id,
        label: s.recipe.label,
        kind: s.recipe.kind,
        role: s.recipe.role,
        format: s.recipe.format,
        capability: s.capability,
        // Exact user pin for this stage, or null for Automatic resolution.
        requestedCapability: s.requestedCapability ?? null,
        durationSeconds: s.durationSeconds ?? s.recipe.defaultDurationSeconds ?? null,
        requestedDurationSeconds: s.requestedDurationSeconds ?? null,
        durationAdjusted: s.requestedDurationSeconds !== undefined && s.durationSeconds !== undefined && s.requestedDurationSeconds !== s.durationSeconds,
        durationNote: s.durationNote ?? null,
        durationSource: s.durationSource ?? null,
        dependsOn: s.recipe.dependsOn,
        inputSource: s.recipe.inputSource,
        requiredFor: plan.autoIncluded.find((a) => a.id === s.recipe.id)?.requiredFor ?? []
      })),
      // True when any motion length rests on the unverified product range
      // (no provider metadata, no cited policy) - shown once, quietly.
      durationUnverified: plan.stages.some((s) => s.durationSource === "product-range-unverified"),
      deferred: plan.deferred.map((d) => ({ id: d.recipe.id, label: d.recipe.label, reason: d.reason })),
      outputCount: plan.outputCount,
      executableCount: plan.executableCount,
      estimateUsd: quotable ? Math.round(total * 10000) / 10000 : null,
      estimateExact: exact && quotable,
      estimateMinutes: estimateTemplateMinutes(plan),
      qualityChecks: template.qualityChecks,
      disclosureRules: template.disclosureRules
    };
    if (body.dryRun === true) return NextResponse.json({ ok: true, preview });

    // Persist the server-resolved length (never a client-supplied one).
    const firstMotion = plan.stages.find((s) => s.durationSeconds !== undefined);
    const resolvedSpec = firstMotion
      ? { ...spec, resolvedMotionSeconds: firstMotion.durationSeconds as number }
      : spec;
    const applied = await applyTemplateSpec(id, resolvedSpec);
    if (!applied.campaign) return NextResponse.json({ error: applied.error ?? "Template apply failed." }, { status: 400 });
    return NextResponse.json({ ok: true, preview, campaign: applied.campaign });
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    // Template planning evaluates live rights: raw transport failures must
    // never reach the configurator UI. Validation 400s above are untouched.
    logDkgError("template", error);
    const safe = sanitizeDkgError(error, "preflight");
    return NextResponse.json({ error: safe.message, code: safe.code }, { status: safe.status });
  }
}
