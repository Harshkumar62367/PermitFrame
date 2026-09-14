import "server-only";

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

function connectionString(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required for Neon persistence.");
  return value;
}

/** Server-only Neon HTTP client, suitable for short-lived Next.js requests. */
export function getDb() {
  return drizzle({ client: neon(connectionString()), schema });
}
