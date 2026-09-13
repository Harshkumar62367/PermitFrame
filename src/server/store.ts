import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Database } from "./types";

const DATA_DIR = process.env.PERMITFRAME_DATA_DIR ?? path.join(process.cwd(), ".data");
const DATA_FILE = path.join(DATA_DIR, "permitframe.json");

let cache: Database | null = null;
let cacheMtime = 0;

function emptyDb(): Database {
  return {
    creators: [],
    passports: [],
    sourceMedia: [],
    productFacts: [],
    campaigns: [],
    consentInvites: [],
    events: []
  };
}

export function loadDb(): Database {
  // Reload when another module instance / process has written the file since our
  // last read — route handlers and RSC pages hold separate module caches in dev.
  try {
    if (fs.existsSync(DATA_FILE)) {
      const mtime = fs.statSync(DATA_FILE).mtimeMs;
      if (cache && mtime <= cacheMtime) return cache;
      cache = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) as Database;
      cacheMtime = mtime;
      return cache;
    }
  } catch {
    // corrupted file -> start fresh rather than crash the demo
  }
  cache = emptyDb();
  cacheMtime = 0;
  persist();
  return cache;
}

export function persist(): void {
  if (!cache) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(cache, null, 2), "utf8");
    cacheMtime = fs.statSync(DATA_FILE).mtimeMs;
  } catch {
    // read-only FS (e.g. serverless): keep state in memory for this instance
  }
}

export function updateDb(mutator: (db: Database) => void): Database {
  const db = loadDb();
  mutator(db);
  persist();
  return db;
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function nowIso(): string {
  return new Date().toISOString();
}
