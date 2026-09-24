import "server-only";

import { readFileSync } from "node:fs";
import path from "node:path";

export const DOCS_SLUGS = [
  "index",
  "getting-started",
  "dkg-and-proof",
  "campaign-workflow",
  "film-and-finishing",
  "verification-and-delivery"
] as const;

export type DocsSlug = (typeof DOCS_SLUGS)[number];

export function getDocsSource(slug: DocsSlug): string {
  return readFileSync(path.join(process.cwd(), "docs", `${slug}.md`), "utf8");
}
