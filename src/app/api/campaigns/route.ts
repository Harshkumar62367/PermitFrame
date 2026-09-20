import { NextRequest, NextResponse } from "next/server";
import { AuthenticationRequiredError, requireCurrentSession } from "@/server/auth";
import { loadDb } from "@/server/store";
import { createCampaign, createCampaignIdempotent } from "@/server/campaigns";
import { resolveCampaignSelection } from "@/server/campaign-selection";
import { IDEMPOTENCY_KEY_PATTERN, IdempotencyMismatchError } from "@/server/idempotency";
import { isDkgUnavailable } from "@/server/dkg/edge-node-adapter";
import { CampaignDeletedError } from "@/server/deletion";
import type { CampaignRequest } from "@/server/types";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ campaigns: (await loadDb()).campaigns });
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    throw error;
  }
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as {
    title: string;
    platform: string;
    country: string;
    requestedClaims: string[];
    transformation: "image" | "video";
    creativeBrief: string;
    creatorId?: string;
    passportId?: string;
    sourceMediaId?: string;
    productFactsId?: string;
    /** Client-generated per-submission key: retries of the same submission replay the original campaign. */
    idempotencyKey?: string;
  };
  const rawKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  if (body.idempotencyKey !== undefined && !IDEMPOTENCY_KEY_PATTERN.test(rawKey)) {
    return NextResponse.json({ error: "idempotencyKey must be 1–128 chars of letters, numbers, dash or underscore." }, { status: 400 });
  }
  let workspaceId: string;
  try {
    workspaceId = (await requireCurrentSession()).workspaceId;
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    throw error;
  }
  let db;
  try {
    db = await loadDb();
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    throw error;
  }
  // Explicit selection only: the server never falls back to the first
  // workspace record (unsafe with multiple creators/media/brand rules).
  // The UI disables submission until all four are chosen.
  const resolved = resolveCampaignSelection(db, {
    creatorId: body.creatorId,
    passportId: body.passportId,
    sourceMediaId: body.sourceMediaId,
    productFactsId: body.productFactsId
  });
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 });
  const { creator, passport, media, facts } = resolved.value;
  const req: CampaignRequest = {
    platform: body.platform as CampaignRequest["platform"],
    country: body.country.toUpperCase().slice(0, 2),
    requestedClaims: body.requestedClaims ?? [],
    transformation: body.transformation ?? "image",
    creativeBrief: body.creativeBrief ?? ""
  };
  const input = {
    title: body.title || `${req.platform} campaign — ${req.country}`,
    brand: facts.brand,
    productName: facts.productName,
    creatorId: creator.id,
    sourceMediaId: media.id,
    passportId: passport.id,
    productFactsId: facts.id,
    request: req
  };
  // Keyed submissions are idempotent: a retry after a network failure (the
  // client may have aborted after the server already persisted) replays the
  // original campaign instead of creating a duplicate. Keyless callers keep
  // the legacy one-shot behavior.
  if (!rawKey) {
    try {
      const campaign = await createCampaign(input);
      return NextResponse.json({ campaign, deduplicated: false }, { status: 201 });
    } catch (error) {
      if (error instanceof Error && isDkgUnavailable(error.message)) {
        return NextResponse.json(
          { error: "Proof ledger unreachable — campaign not created. Nothing was saved; retry in a moment.", retryable: true },
          { status: 503 }
        );
      }
      throw error;
    }
  }
  try {
    const { campaign, deduplicated } = await createCampaignIdempotent(input, rawKey, `${workspaceId}:${rawKey}`);
    return NextResponse.json({ campaign, deduplicated }, { status: deduplicated ? 200 : 201 });
  } catch (error) {
    if (error instanceof IdempotencyMismatchError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    if (error instanceof CampaignDeletedError) {
      // The replayed key points at a hard-deleted campaign: Gone, never resurrected.
      return NextResponse.json({ error: error.message }, { status: 410 });
    }
    if (error instanceof Error && isDkgUnavailable(error.message)) {
      // Creation consults the live ledger (preflight rights/facts reads). A
      // down ledger is a 503 with retry guidance — never a 500, and the
      // idempotency slot is already marked failed so the retry takes over.
      return NextResponse.json(
        { error: "Proof ledger unreachable — campaign not created. Nothing was saved; retry in a moment.", retryable: true },
        { status: 503 }
      );
    }
    throw error;
  }
}
