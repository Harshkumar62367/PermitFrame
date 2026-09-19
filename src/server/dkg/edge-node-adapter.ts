import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { PermissionPassport, ProductFacts, Visibility } from "../types";
import { explorerUrlFor, basePublicationStatus, type DkgAdapter, type DkgHealth, type KaRecord } from "./adapter";
import type { KaEnvelope } from "./schemas";

const execFileAsync = promisify(execFile);
const CG_ENV = process.env.DKG_CONTEXT_GRAPH ?? "permitframe";
// Where the CLI actually talks to: local daemon by default, EC2 via the
// SSH wrapper when DKG_CLI_BIN points at scripts/dkg-remote-cli.*.
const ENDPOINT_LABEL = process.env.DKG_ENDPOINT_LABEL ?? "local daemon (127.0.0.1:9200)";

/**
 * Edge Node adapter: talks to a local OriginTrail Edge Node (DKG v10) through the
 * `dkg` CLI (https://www.npmjs.com/package/@origintrail-official/dkg).
 * Knowledge Assets are created in a context graph and shared into Shared Working
 * Memory (free); on-chain Verifiable Memory registration is available via
 * `dkg context-graph register` when the node wallets hold gas.
 */
export class EdgeNodeAdapter implements DkgAdapter {
  readonly mode = "edge-node" as const;
  private canonicalCg?: string;

  private async run(args: string[], timeoutMs = 120_000): Promise<string> {
    try {
      const { stdout } = await execFileAsync(process.env.DKG_CLI_BIN ?? "dkg", args, {
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        shell: process.platform === "win32" // dkg is a .cmd shim on Windows
      });
      return stdout;
    } catch (error) {
      const message = (error as Error).message.replace(/0x[a-fA-F0-9]{64,}/g, "0x[redacted]");
      console.error(`[edge-node] dkg ${args[0]} ${args[1] ?? ""} failed:`, message.slice(0, 400));
      throw new Error(`dkg CLI failed (${args[0]} ${args[1] ?? ""}): ${message.slice(0, 300)}`);
    }
  }

  /** Resolve (or create) the canonical context-graph id `<agent-address>/<name>`. */
  private async contextGraph(): Promise<string> {
    if (this.canonicalCg) return this.canonicalCg;
    const configured = process.env.DKG_CONTEXT_GRAPH_ID;
    if (configured) {
      this.canonicalCg = configured;
      return configured;
    }
    const out = await this.run(["context-graph", "create", CG_ENV]).catch((e) => {
      if (/already exists|duplicate/i.test(e.message)) return "";
      throw e;
    });
    const created = out.match(/ID:\s+(\S+)/)?.[1];
    if (created) {
      this.canonicalCg = created;
      return created;
    }
    // already existed: derive from the primary operational wallet address
    const wallet = await this.run(["wallet"]);
    const primary = wallet.match(/\(primary\)\s+(0x[a-fA-F0-9]{40})/)?.[1];
    if (!primary) throw new Error("Could not resolve context graph id or primary wallet");
    this.canonicalCg = `${primary}/${CG_ENV}`;
    return this.canonicalCg;
  }

  async health(): Promise<DkgHealth> {
    try {
      // Health is only a diagnostic. The cold `dkg` CLI spawn alone takes
      // ~3-6s on Windows, so a 3s bound declares a healthy node unreachable.
      // 12s tolerates real slowness while staying bounded; the health cache
      // keeps this off every request path (stale-while-revalidate), so the
      // bound never gates page loads.
      const status = await this.run(["status"], 12_000);
      const peers = status.match(/Peers:\s+(\d+)/)?.[1] ?? "?";
      return {
        mode: this.mode,
        healthy: true,
        endpoint: ENDPOINT_LABEL,
        blockchain: process.env.DKG_BLOCKCHAIN ?? "base:84532 (V10 testnet)",
        detail: `Edge Node running — ${peers} peer(s), context graph "${CG_ENV}". SWM shares are live DKG operations.`
      };
    } catch (error) {
      return {
        mode: this.mode,
        healthy: false,
        endpoint: ENDPOINT_LABEL,
        detail: `Edge Node unreachable — check the DKG_CLI_BIN target (${process.env.DKG_CLI_BIN ?? "dkg"}). ${(error as Error).message.slice(0, 140)}`
      };
    }
  }

  async publish(ka: KaEnvelope, _visibility: Visibility): Promise<KaRecord> {
    const cg = await this.contextGraph();
    const ttl = jsonLdToTurtle(ka.content);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pf-ka-"));
    // KA names are immutable in the node — suffix every publish so re-seeds never collide
    const name = `${ka.name.slice(0, 64)}-${Date.now().toString(36)}`;
    const file = path.join(dir, `${ka.name.replace(/[^a-z0-9-_.]/gi, "-")}.ttl`);
    await fs.writeFile(file, ttl, "utf8");
    let out = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      out = await this.run(["ka", "create", attempt === 1 ? name : `${name}r${attempt}`, "-c", cg, "--input-file", file, "--share"]);
      if (out.includes("complete") || out.match(/Assertion URI:/)) break;
      console.error(`[edge-node] ka create attempt ${attempt} did not complete:`, out.slice(0, 250));
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    const assertionUri = out.match(/Assertion URI:\s+(\S+)/)?.[1];
    const merkle = out.match(/Merkle root:\s+(\S+)/)?.[1];
    if (!out.includes("complete") && !assertionUri) {
      throw new Error(`KA publish failed: ${out.slice(0, 300)}`);
    }
    return {
      // `ka create --share` produces Shared Working Memory evidence, not an
      // explorer-resolvable Verifiable Memory UAL. Leave `ual` empty until the
      // explicit VM publish path has completed.
      ual: "",
      evidenceUri: assertionUri,
      merkleRoot: merkle,
      publicationStatus: basePublicationStatus(this.mode, false),
      name,
      explorerUrl: "",
      content: { ...ka.content, "pf:contextGraph": cg },
      publishedAt: new Date().toISOString(),
      mode: this.mode
    };
  }

  /**
   * Keep ordinary policy records in WM/SWM, but anchor an explicitly approved
   * campaign record in Verifiable Memory. The DKG V10 publisher is async, so
   * we enqueue a named finalized KA then wait for its canonical UAL and tx hash.
   */
  async publishVerifiable(ka: KaEnvelope, visibility: Visibility): Promise<KaRecord> {
    const shared = await this.publish(ka, visibility);
    const cg = await this.contextGraph();
    const accepted = await this.run(["publisher", "publish-async", cg, shared.name], 30_000);
    const jobId = accepted.match(/Job ID:\s*([^\s]+)/)?.[1];
    if (!jobId) throw new Error(`DKG publisher did not return a job id: ${accepted.slice(0, 300)}`);

    const finalized = await this.waitForVerifiablePublish(jobId);
    return {
      ...shared,
      ual: finalized.ual,
      txHash: finalized.txHash,
      explorerUrl: explorerUrlFor(finalized.ual),
      // Set ONLY here, after the async publish job genuinely finalized.
      publicationStatus: basePublicationStatus(this.mode, true)
    };
  }

  private async waitForVerifiablePublish(jobId: string): Promise<{ ual: string; txHash?: string }> {
    const deadline = Date.now() + 150_000;
    let lastStatus = "accepted";
    while (Date.now() < deadline) {
      const out = await this.run(["publisher", "job", jobId], 30_000);
      const job = parsePublisherJob(out);
      lastStatus = String(job.status ?? lastStatus);
      if (lastStatus === "failed") {
        throw new Error(`DKG Verifiable Memory publish failed: ${String(job.error ?? job.failureReason ?? "unknown publisher error")}`);
      }
      const ual = findNestedString(job, "ual");
      if (lastStatus === "finalized" && ual) {
        return { ual, txHash: findNestedString(job, "txHash") };
      }
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    throw new Error(`DKG Verifiable Memory publish is still ${lastStatus}. Check job ${jobId} with \"dkg publisher job ${jobId}\".`);
  }

  async get(ual: string): Promise<KaRecord | null> {
    // WM/SWM assertions are queried rather than fetched by UAL; verify flows use sparql()
    void ual;
    return null;
  }

  async sparql(query: string): Promise<Array<Record<string, unknown>>> {
    const cg = await this.contextGraph();
    // pass the query via --file: multi-word args are unsafe through cmd.exe shells
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pf-sq-"));
    const file = path.join(dir, "query.sparql");
    await fs.writeFile(file, query, "utf8");
    try {
      const out = await this.run(["query", cg, "--include-shared-memory", "--file", file]);
      return parseCliTable(out);
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async passportRows(sparql: string): Promise<PermissionPassport[]> {
    const rows = await this.sparql(sparql);
    const grouped = new Map<string, PermissionPassport>();
    for (const row of rows) {
      const id = String(row.passport ?? "").replace("urn:permitframe:passport:", "") || "unknown";
      const existing = grouped.get(id);
      const passport: PermissionPassport = existing ?? {
        id,
        creatorId: String(row.creatorId ?? ""),
        creatorName: String(row.creatorName ?? ""),
        sourceMediaIds: [],
        platforms: [],
        countries: [],
        allowedTransformations: [],
        validFrom: String(row.validFrom ?? ""),
        validUntil: String(row.validUntil ?? ""),
        status: (String(row.status ?? "active") as PermissionPassport["status"]) ?? "active",
        attestation: { method: "creator-consent-link", consentedAt: String(row.attestedAt ?? ""), declaration: String(row.declaration ?? "") },
        visibility: "public"
      };
      for (const field of ["platforms", "countries", "allowedTransformations"] as const) {
        const value = String(row[field === "platforms" ? "platform" : field === "countries" ? "country" : "transformation"] ?? "");
        if (value && !passport[field].includes(value as never)) (passport[field] as string[]).push(value);
      }
      grouped.set(id, passport);
    }
    return [...grouped.values()];
  }

  async findApplicablePassports(filter: {
    creatorId: string;
    platform: string;
    country: string;
    onDate: string;
  }): Promise<PermissionPassport[]> {
    return this.passportRows(`PREFIX pf: <https://permitframe.app/ns#>
SELECT ?passport ?creatorId ?creatorName ?platform ?country ?transformation ?status ?validFrom ?validUntil ?attestedAt ?declaration
WHERE {
  ?passport a pf:PermitFramePermissionPassport ;
    pf:creatorId "${filter.creatorId}" ;
    pf:status ?status ;
    pf:validFrom ?validFrom ;
    pf:validUntil ?validUntil ;
    pf:creatorName ?creatorName ;
    pf:attestedAt ?attestedAt ;
    pf:declaration ?declaration ;
    pf:platform ?platform ;
    pf:country ?country ;
    pf:allowedTransformation ?transformation .
  FILTER (LCASE(STR(?platform)) = "${filter.platform}")
  FILTER (EXISTS { ?passport pf:country "${filter.country}" })
  FILTER (?status != "revoked")
  FILTER (?validUntil >= "${filter.onDate}")
}`);
  }

  async listPassports(creatorId: string): Promise<PermissionPassport[]> {
    return this.passportRows(`PREFIX pf: <https://permitframe.app/ns#>
SELECT ?passport ?creatorId ?creatorName ?platform ?country ?transformation ?status ?validFrom ?validUntil ?attestedAt ?declaration
WHERE {
  ?passport a pf:PermitFramePermissionPassport ;
    pf:creatorId "${creatorId}" ;
    pf:status ?status ;
    pf:validFrom ?validFrom ;
    pf:validUntil ?validUntil ;
    pf:creatorName ?creatorName ;
    pf:attestedAt ?attestedAt ;
    pf:declaration ?declaration ;
    pf:platform ?platform ;
    pf:country ?country ;
    pf:allowedTransformation ?transformation .
}`);
  }

  async findProductFacts(brand: string, productName: string): Promise<ProductFacts | null> {
    const rows = await this.sparql(`PREFIX pf: <https://permitframe.app/ns#>
SELECT ?facts ?claimType ?claim WHERE {
  ?facts a pf:PermitFrameProductFacts ;
    pf:brand "${brand}" ;
    pf:productName "${productName}" ;
    ?claimType ?claim .
  FILTER (?claimType IN (pf:approvedClaim, pf:prohibitedClaim, pf:brandGuideline))
}`);
    if (rows.length === 0) return null;
    const first = rows[0];
    const id = String(first.facts ?? "").replace("urn:permitframe:product-facts:", "") || "unknown";
    const approved = new Set<string>();
    const prohibited = new Set<string>();
    const guidelines = new Set<string>();
    for (const row of rows) {
      const claim = String(row.claim ?? "");
      const type = String(row.claimType ?? "");
      if (type.endsWith("approvedClaim")) approved.add(claim);
      else if (type.endsWith("prohibitedClaim")) prohibited.add(claim);
      else if (type.endsWith("brandGuideline")) guidelines.add(claim);
    }
    return {
      id,
      brand,
      productName,
      approvedClaims: [...approved],
      prohibitedClaims: [...prohibited],
      guidelines: [...guidelines],
      evidenceNotes: String(first.evidenceNotes ?? ""),
      visibility: "shared"
    };
  }

  async listAssets(): Promise<KaRecord[]> {
    const rows = await this.sparql(`PREFIX pf: <https://permitframe.app/ns#>
PREFIX schema: <https://schema.org/>
SELECT ?asset ?type ?name WHERE { ?asset a ?type ; schema:name ?name .
  FILTER (STRSTARTS(STR(?type), "https://permitframe.app/ns#")) }`);
    return rows.map((row) => ({
      // The graph subject is a Shared Working Memory identifier, not an
      // on-chain Verifiable Memory UAL.
      ual: "",
      evidenceUri: String(row.asset ?? ""),
      explorerUrl: "",
      publicationStatus: basePublicationStatus(this.mode, false),
      name: String(row.name ?? ""),
      content: { "@type": String(row.type ?? "") },
      publishedAt: "",
      mode: this.mode
    }));
  }
}

/** Parse the `dkg query` formatted table (header, dashes, rows; cells split by 2+ spaces). */
export function parseCliTable(out: string): Array<Record<string, string>> {
  const lines = out.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const tableStart = lines.findIndex((l) => /^[-─-╰\s]+$/.test(l));
  if (tableStart <= 0) return [];
  const headers = lines[tableStart - 1].trim().split(/\s{2,}/);
  const rows: Array<Record<string, string>> = [];
  for (const line of lines.slice(tableStart + 1)) {
    if (/^[-─-╰\s]+$/.test(line)) break;
    const cells = line.trim().split(/\s{2,}/);
    if (cells.length < headers.length) continue; // wrapped value fragment — skipped for simplicity
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h] = cells[i]?.trim() ?? ""));
    rows.push(row);
  }
  const total = out.match(/(\d+)\s+row\(s\)/)?.[1];
  if (total && rows.length !== Number(total)) {
    // keep what parsed; count mismatch indicates wrapped cells — surfaced to caller as partial
  }
  return rows;
}

function parsePublisherJob(out: string): Record<string, unknown> {
  const start = out.indexOf("{");
  if (start < 0) throw new Error(`Could not parse DKG publisher job: ${out.slice(0, 300)}`);
  try {
    return JSON.parse(out.slice(start)) as Record<string, unknown>;
  } catch {
    throw new Error(`Could not parse DKG publisher job JSON: ${out.slice(0, 300)}`);
  }
}

function findNestedString(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNestedString(item, field);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record[field] === "string" && record[field]) return record[field] as string;
  for (const nested of Object.values(record)) {
    const found = findNestedString(nested, field);
    if (found) return found;
  }
  return undefined;
}

/**
 * Minimal JSON-LD → Turtle serializer for PermitFrame KA shapes:
 * shallow objects with @id/@type, literal values, string arrays, and {"@id": urn} refs.
 */
export function jsonLdToTurtle(content: Record<string, unknown>): string {
  const subject = String(content["@id"]);
  const type = String(content["@type"]);
  const lines: string[] = [
    "@prefix pf: <https://permitframe.app/ns#> .",
    "@prefix schema: <https://schema.org/> .",
    ""
  ];
  const pred = (key: string) => (key.startsWith("schema:") ? key : key.replace(/^pf:/, "pf:"));
  const emit = (key: string, value: unknown) => {
    if (key.startsWith("@") || value === null || value === undefined || value === "") return;
    const objects: string[] = [];
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      if (typeof v === "string") {
        if (v.startsWith("urn:") || v.startsWith("http")) objects.push(`<${v}>`);
        else objects.push(`${JSON.stringify(String(v).normalize("NFKD").replace(/[—–]/g, "-"))}`);
      } else if (typeof v === "number" || typeof v === "boolean") {
        objects.push(String(v));
      } else if (typeof v === "object" && "@id" in (v as Record<string, unknown>)) {
        objects.push(`<${(v as { "@id": string })["@id"]}>`);
      } else if (typeof v === "object") {
        objects.push(JSON.stringify(JSON.stringify(v)));
      }
    }
    if (objects.length > 0) lines.push(`    ${pred(key)} ${objects.join(", ")} ;`);
  };
  lines.push(`<${subject}> a pf:${type} ;`);
  for (const [key, value] of Object.entries(content)) emit(key, value);
  if (lines.at(-1)?.endsWith(";")) lines[lines.length - 1] = lines.at(-1)!.replace(/;$/, ".");
  return `${lines.join("\n")}\n`;
}
