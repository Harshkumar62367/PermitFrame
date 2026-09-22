import { NextResponse } from "next/server";
import { listTemplates } from "@/server/livepeer/templates";

export const dynamic = "force-dynamic";

/** Template catalogue for the studio selector (metadata only, no prompts). */
export async function GET() {
  return NextResponse.json({
    templates: listTemplates().map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      useCase: t.useCase,
      requiredInputs: t.requiredInputs,
      platforms: t.platforms,
      recipes: t.recipes.map((r) => ({
        id: r.id,
        label: r.label,
        kind: r.kind,
        role: r.role,
        format: r.format,
        assetType: r.assetType,
        optional: r.optional,
        quickPick: r.quickPick,
        execution: r.execution
      })),
      qualityChecks: t.qualityChecks,
      disclosureRules: t.disclosureRules,
      compatibleProfiles: t.compatibleProfiles,
      toolStrategy: t.toolStrategy,
      anchorPolicy: t.anchorPolicy
    }))
  });
}
