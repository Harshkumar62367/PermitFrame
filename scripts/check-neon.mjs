import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is missing from .env.local");
}

const sql = neon(url);
const rows = await sql`select current_database() as database, current_user as role`;
const row = rows[0];
if (!row) throw new Error("Neon returned no connection information.");

console.log(`Connected to Neon database \"${row.database}\" as \"${row.role}\".`);
