import { index, integer, jsonb, pgTable, real, text, timestamp } from "drizzle-orm/pg-core";
import type { AuditEvent, Campaign, Database, PublicVerificationSnapshot } from "../types";

/**
 * Transitional application-state table.
 *
 * PermitFrame's current domain layer operates on a single aggregate. Storing it
 * as JSONB lets us move off Vercel-incompatible filesystem persistence now,
 * while preserving the existing API surface. We will normalize this into
 * workspace-scoped tables when Privy tenancy is added.
 */
export const applicationState = pgTable("application_state", {
  id: text("id").primaryKey(),
  data: jsonb("data").$type<Database>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

/** A Privy identity is the source of truth for authentication. */
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email"),
  displayName: text("display_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

/** Each signed-in agency has its own isolated PermitFrame state. */
export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const workspaceState = pgTable("workspace_state", {
  workspaceId: text("workspace_id").primaryKey().references(() => workspaces.id, { onDelete: "cascade" }),
  data: jsonb("data").$type<Database>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

/**
 * Normalized hot paths (Phase 1 of the blob split).
 *
 * `workspace_state.data` remains the fallback source of truth until backfill
 * is verified, but all campaign/event writes mirror here and all hot reads
 * prefer here:
 * - campaigns: one row per campaign. `data` holds the full campaign document
 *   (jobs/receipts/comments/captions travel with it — they are only ever
 *   read/written with their campaign). List/detail reads are single-row or
 *   single-workspace indexed scans instead of whole-blob transfers.
 * - workspace_events: one row per audit event. Activity/timeline reads are
 *   indexed, newest-first, LIMIT-bound instead of load-all-then-slice.
 */
export const campaigns = pgTable(
  "campaigns",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    title: text("title").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    data: jsonb("data").$type<Campaign>().notNull()
  },
  (t) => [index("campaigns_workspace_idx").on(t.workspaceId, t.updatedAt)]
);

export const workspaceEvents = pgTable(
  "workspace_events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    campaignId: text("campaign_id"),
    kind: text("kind").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    summary: text("summary").notNull(),
    refs: jsonb("refs").$type<string[]>().notNull().default([]),
    data: jsonb("data").$type<AuditEvent>().notNull()
  },
  (t) => [
    index("workspace_events_workspace_at_idx").on(t.workspaceId, t.at),
    index("workspace_events_campaign_at_idx").on(t.campaignId, t.at)
  ]
);

/**
 * Small lookup collections (Phase 1b). Same mirror strategy: blob stays the
 * fallback until backfill is verified, normalized rows serve hot reads.
 * Each is one row per domain object, workspace-scoped, so campaign detail
 * resolves passport/media/facts with indexed single-row SELECTs.
 */
export const passports = pgTable(
  "passports",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    data: jsonb("data").$type<Database["passports"][number]>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [index("passports_workspace_idx").on(t.workspaceId)]
);

export const sourceMediaRows = pgTable(
  "source_media",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    data: jsonb("data").$type<Database["sourceMedia"][number]>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [index("source_media_workspace_idx").on(t.workspaceId)]
);

export const productFactsRows = pgTable(
  "product_facts",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    data: jsonb("data").$type<Database["productFacts"][number]>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [index("product_facts_workspace_idx").on(t.workspaceId)]
);

/**
 * Durable asset store (Cloudinary). One row per generation job output:
 * Livepeer provider provenance plus Cloudinary delivery identity. All
 * storage columns are nullable/backward-compatible — legacy outputs simply
 * have no row here and render provider-hosted. Never stores bytes or
 * credentials, only identifiers, URLs, and safe diagnostics.
 */
export const campaignAssets = pgTable(
  "campaign_assets",
  {
    jobId: text("job_id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    campaignId: text("campaign_id").notNull(),
    receiptId: text("receipt_id"),
    storageProvider: text("storage_provider").notNull().default("cloudinary"),
    storagePublicId: text("storage_public_id"),
    storageVersion: integer("storage_version"),
    storageUrl: text("storage_url"),
    storageResourceType: text("storage_resource_type"),
    storageFormat: text("storage_format"),
    storageBytes: integer("storage_bytes"),
    storageWidth: integer("storage_width"),
    storageHeight: integer("storage_height"),
    storageDuration: real("storage_duration"),
    storageStatus: text("storage_status").notNull().default("pending"),
    storageError: text("storage_error"),
    attempts: integer("attempts").notNull().default(0),
    persistedAt: timestamp("persisted_at", { withTimezone: true }),
    providerUrl: text("provider_url"),
    providerJobId: text("provider_job_id"),
    providerModel: text("provider_model"),
    providerCost: text("provider_cost"),
    promptHash: text("prompt_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    index("campaign_assets_workspace_campaign_idx").on(t.workspaceId, t.campaignId),
    index("campaign_assets_status_idx").on(t.storageStatus)
  ]
);

/** Only a SHA-256 hash of the opaque browser session token is persisted. */
export const sessions = pgTable("sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

/**
 * Immutable-by-contract public verification snapshots. Written once per
 * campaign approval from sanitized fields only — anonymous reads query this
 * table directly, never session workspace state.
 */
export const verificationSnapshots = pgTable("verification_snapshots", {
  ref: text("ref").primaryKey(),
  campaignId: text("campaign_id").notNull(),
  payload: jsonb("payload").$type<PublicVerificationSnapshot>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});
