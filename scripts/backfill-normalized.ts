/** Backfill normalized tables from workspace_state blobs (no server-only imports). */
import { config } from "dotenv";
config({ path: ".env.local" });
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "../src/server/db/schema";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for backfill.");
const sql = neon(connectionString);
const db = drizzle({ client: sql, schema });

function campaignIdFromRefs(refs: unknown): string | null {
  if (!Array.isArray(refs)) return null;
  return refs.find((r): r is string => typeof r === "string" && r.startsWith("cmp_")) ?? null;
}

async function main() {
  const rows = await db
    .select({ workspaceId: schema.workspaceState.workspaceId, data: schema.workspaceState.data })
    .from(schema.workspaceState);
  console.log(`Backfilling ${rows.length} workspace(s)...`);
  for (const row of rows) {
    const data = row.data;
    for (const c of data.campaigns ?? []) {
      await db
        .insert(schema.campaigns)
        .values({
          id: c.id,
          workspaceId: row.workspaceId,
          status: c.status,
          title: c.title,
          updatedAt: c.updatedAt ? new Date(c.updatedAt) : new Date(),
          data: { ...c, comments: c.comments ?? [], captions: c.captions ?? [] }
        })
        .onConflictDoUpdate({
          target: schema.campaigns.id,
          set: {
            workspaceId: row.workspaceId,
            status: c.status,
            title: c.title,
            updatedAt: c.updatedAt ? new Date(c.updatedAt) : new Date(),
            data: { ...c, comments: c.comments ?? [], captions: c.captions ?? [] }
          }
        });
    }
    for (const e of data.events ?? []) {
      await db
        .insert(schema.workspaceEvents)
        .values({
          id: e.id,
          workspaceId: row.workspaceId,
          campaignId: campaignIdFromRefs(e.refs ?? []),
          kind: e.kind,
          at: e.at ? new Date(e.at) : new Date(),
          summary: e.summary,
          refs: e.refs ?? [],
          data: e
        })
        .onConflictDoNothing({ target: schema.workspaceEvents.id });
    }
    for (const p of data.passports ?? []) {
      await db
        .insert(schema.passports)
        .values({ id: p.id, workspaceId: row.workspaceId, data: p, updatedAt: new Date() })
        .onConflictDoUpdate({ target: schema.passports.id, set: { workspaceId: row.workspaceId, data: p, updatedAt: new Date() } });
    }
    for (const m of data.sourceMedia ?? []) {
      await db
        .insert(schema.sourceMediaRows)
        .values({ id: m.id, workspaceId: row.workspaceId, data: m, updatedAt: new Date() })
        .onConflictDoUpdate({ target: schema.sourceMediaRows.id, set: { workspaceId: row.workspaceId, data: m, updatedAt: new Date() } });
    }
    for (const f of data.productFacts ?? []) {
      await db
        .insert(schema.productFactsRows)
        .values({ id: f.id, workspaceId: row.workspaceId, data: f, updatedAt: new Date() })
        .onConflictDoUpdate({ target: schema.productFactsRows.id, set: { workspaceId: row.workspaceId, data: f, updatedAt: new Date() } });
    }
    console.log(`  ${row.workspaceId}: ${(data.campaigns ?? []).length} campaign(s), ${(data.events ?? []).length} event(s) mirrored`);
  }
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
