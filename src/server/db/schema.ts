import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { Database } from "../types";

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

/** Only a SHA-256 hash of the opaque browser session token is persisted. */
export const sessions = pgTable("sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});
