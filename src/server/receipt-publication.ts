import { getDkg } from "./dkg";
import type { KaRecord } from "./dkg/adapter";
import { receiptKa } from "./dkg/schemas";
import { logDkgError, sanitizeDkgError } from "./dkg/public-errors";
import { loadDb, newId, nowIso, updateDb } from "./store";
import {
  classifyReceiptForAnchor,
  type Database,
  type DerivativeReceipt,
  type ReceiptPublishResult
} from "./types";

/**
 * Proof-ledger anchoring for derivative receipts. Shareable receipts are
 * offered to on-chain Verifiable Memory via `publishVerifiable` - never the
 * Shared Working Memory `publish`, whose empty UAL must never read as
 * "published". Each receipt moves through persisted states
 * (publishing -> anchored | failed) so a refresh or timeout never loses
 * the outcome, and concurrent requests never anchor the same receipt
 * twice. Pure classifier lives in types.ts; the DKG call is injectable so
 * tests run with stubs and zero provider/ledger traffic.
 */

export type ReceiptAnchorFn = (receipt: DerivativeReceipt) => Promise<KaRecord>;

export interface AnchorReceiptsDeps {
  load(): Promise<Database>;
  save(mutator: (db: Database) => void): Promise<unknown>;
  anchor(receipt: DerivativeReceipt): Promise<KaRecord>;
}

/** Customer-facing failure copy: short and useful, never raw transport text. */
export const LEDGER_UNCONFIRMED = "The proof ledger did not confirm this record. Retry publishing.";
const LEDGER_LOCAL_MODE = "Local evidence mode cannot anchor on-chain records - connect the proof ledger, then retry.";
const RECEIPT_MISSING = "Receipt no longer exists - nothing was changed.";

function findReceipt(db: Database, campaignId: string, receiptId: string): DerivativeReceipt | undefined {
  return db.campaigns.find((c) => c.id === campaignId)?.receipts.find((r) => r.id === receiptId);
}

async function markPublishing(
  deps: AnchorReceiptsDeps,
  campaignId: string,
  receiptId: string
): Promise<boolean> {
  let claimed = false;
  await deps
    .save((d) => {
      const r = findReceipt(d, campaignId, receiptId);
      // Re-check inside the write: a concurrent request may have anchored
      // (or claimed) this receipt since the loop read it.
      if (!r || r.ual || classifyReceiptForAnchor(r) !== "eligible") return;
      r.publicationStatus = "publishing";
      r.publicationUpdatedAt = nowIso();
      r.publicationError = undefined;
      claimed = true;
    })
    .catch(() => undefined);
  return claimed;
}

async function markFinal(
  deps: AnchorReceiptsDeps,
  campaignId: string,
  receiptId: string,
  final: Pick<DerivativeReceipt, "publicationStatus"> & {
    ual?: string;
    ualExplorer?: string;
    publicationError?: string;
  }
): Promise<void> {
  await deps
    .save((d) => {
      const r = findReceipt(d, campaignId, receiptId);
      if (!r) return;
      if (final.publicationStatus === "anchored") {
        r.ual = final.ual;
        r.ualExplorer = final.ualExplorer;
      }
      r.publicationStatus = final.publicationStatus;
      r.publicationUpdatedAt = nowIso();
      r.publicationError = final.publicationError;
    })
    .catch(() => undefined);
}

async function anchorOneReceipt(
  campaignId: string,
  receiptId: string,
  deps: AnchorReceiptsDeps
): Promise<ReceiptPublishResult> {
  const snapshot = await deps.load();
  const receipt = findReceipt(snapshot, campaignId, receiptId);
  if (!receipt) return { receiptId, status: "failed", reason: RECEIPT_MISSING };
  const directive = classifyReceiptForAnchor(receipt);
  if (directive !== "eligible") return { receiptId, status: directive };
  // Belt-and-braces: the classifier already excludes private records, but
  // the anchor call below must never depend on a single layer.
  if (receipt.visibility === "private") return { receiptId, status: "skipped_private" };
  if (!(await markPublishing(deps, campaignId, receiptId))) {
    // Lost the claim race (concurrent request) - report the fresh state.
    const raced = await deps.load().catch(() => null);
    const current = raced ? findReceipt(raced, campaignId, receiptId) : undefined;
    const state = current ? classifyReceiptForAnchor(current) : "eligible";
    return { receiptId, status: state === "eligible" ? "publishing" : state };
  }
  try {
    const record = await deps.anchor(receipt);
    // Only a genuinely finalized Verifiable Memory record counts: a
    // non-empty UAL AND the anchored status. Shared Working Memory
    // evidence (empty UAL) and local-evidence locators are never "published".
    if (record.ual && record.publicationStatus === "anchored") {
      await markFinal(deps, campaignId, receiptId, {
        publicationStatus: "anchored",
        ual: record.ual,
        ualExplorer: record.explorerUrl
      });
      return { receiptId, status: "anchored", ual: record.ual, explorerUrl: record.explorerUrl };
    }
    const reason = record.mode === "local-evidence" ? LEDGER_LOCAL_MODE : LEDGER_UNCONFIRMED;
    await markFinal(deps, campaignId, receiptId, { publicationStatus: "failed", publicationError: reason });
    return { receiptId, status: "failed", reason };
  } catch (error) {
    // Raw DKG text stays in server logs; the persisted + returned reason is
    // the sanitized short failure.
    logDkgError("receipt-anchor", error);
    const safe = sanitizeDkgError(error, "mutation");
    const reason = safe.message.slice(0, 200);
    await markFinal(deps, campaignId, receiptId, { publicationStatus: "failed", publicationError: reason });
    return { receiptId, status: "failed", reason };
  }
}

export async function anchorReceipts(input: {
  campaignId: string;
  receiptIds?: string[];
  deps?: Partial<AnchorReceiptsDeps>;
}): Promise<{ results: ReceiptPublishResult[] }> {
  const deps: AnchorReceiptsDeps = {
    load: () => loadDb(),
    save: (mutator) => updateDb(mutator),
    anchor: (receipt) => getDkg().publishVerifiable(receiptKa(receipt), receipt.visibility),
    ...input.deps
  };
  const snapshot = await deps.load();
  const campaign = snapshot.campaigns.find((c) => c.id === input.campaignId);
  if (!campaign) throw new Error("Campaign not found");
  const requested = input.receiptIds && input.receiptIds.length > 0 ? new Set(input.receiptIds) : null;
  // One failure never blocks the rest: each receipt settles independently.
  const targets = campaign.receipts.filter((r) => !requested || requested.has(r.id));
  const results: ReceiptPublishResult[] = [];
  for (const target of targets) {
    results.push(await anchorOneReceipt(input.campaignId, target.id, deps));
  }
  const anchored = results.filter((r) => r.status === "anchored").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const skipped = results.length - anchored - failed;
  await deps
    .save((d) => {
      d.events.push({
        id: newId("evt"),
        at: nowIso(),
        kind: "dkg.republish",
        summary: `Proof-ledger publish: ${anchored} anchored, ${failed} failed, ${skipped} skipped.`,
        refs: [input.campaignId]
      });
    })
    .catch(() => undefined);
  return { results };
}
