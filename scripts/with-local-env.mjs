/**
 * Cross-platform env bootstrap for database diagnostic scripts.
 *
 * Loads `<repo>/.env.local` ONLY when the file exists, and only fills in
 * variables the ambient environment does not already define - dashboard or
 * shell values (e.g. a Render shell) always win. When the file is absent the
 * child runs on the ambient environment alone, so `db:check` and
 * `db:verify-auth` work in a Render shell with no .env file at all.
 * No secrets are printed, copied, or written anywhere by this wrapper.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ENV_FILE = ".env.local";
const KEY_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/** Parse one `KEY=value` line; null for blanks, comments, and malformed lines. */
export function parseEnvLine(line) {
  const text = line.trim();
  if (!text || text.startsWith("#")) return null;
  const body = text.startsWith("export ") ? text.slice("export ".length).trimStart() : text;
  const match = body.match(KEY_PATTERN);
  if (!match) return null;
  let value = match[2].trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
  return { key: match[1], value };
}

/**
 * Fill undefined vars from `<dir>/.env.local` when present. Returns the
 * names added (never values). Existing environment values are never
 * overwritten; an absent or unreadable file is a no-op.
 */
export function loadLocalEnvFile(dir = process.cwd()) {
  const added = [];
  let text;
  try {
    text = readFileSync(join(dir, ENV_FILE), "utf8");
  } catch {
    return added;
  }
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed || parsed.key in process.env) continue;
    process.env[parsed.key] = parsed.value;
    added.push(parsed.key);
  }
  return added;
}

const invokedAsCli = (process.argv[1] ?? "").endsWith("with-local-env.mjs");
if (invokedAsCli) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const [, , script, ...args] = process.argv;
  if (!script) {
    console.error("Usage: node scripts/with-local-env.mjs <script> [args...]");
    process.exit(2);
  }
  loadLocalEnvFile(repoRoot);
  const result = spawnSync(process.execPath, [resolve(repoRoot, script), ...args], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
