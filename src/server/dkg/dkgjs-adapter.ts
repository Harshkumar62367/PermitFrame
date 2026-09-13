import type { PermissionPassport, ProductFacts, Visibility } from "../types";
import { explorerUrlFor, type DkgAdapter, type DkgHealth, type KaRecord } from "./adapter";
import type { KaEnvelope } from "./schemas";
import { findApplicablePassportsSparql, findProductFactsSparql } from "./sparql";
import { toList } from "./file-adapter";

/* eslint-disable @typescript-eslint/no-explicit-any */

interface DkgClient {
  node: { info: () => Promise<any> };
  asset: {
    create: (content: any, options?: any) => Promise<any>;
    get: (ual: string, options?: any) => Promise<any>;
  };
  graph: { query: (query: string, type: string) => Promise<any> };
}

/**
 * Real DKG adapter: publishes Knowledge Assets to the OriginTrail DKG
 * (testnet by default) via dkg.js and executes real SPARQL against the graph.
 */
export class DkgJsAdapter implements DkgAdapter {
  readonly mode = "dkg-testnet" as const;
  private client: DkgClient | null = null;

  private async getClient(): Promise<DkgClient> {
    if (this.client) return this.client;
    const endpoint = process.env.DKG_ENDPOINT;
    const privateKey = process.env.DKG_PRIVATE_KEY;
    if (!endpoint || !privateKey) {
      throw new Error("DKG_ENDPOINT and DKG_PRIVATE_KEY are required for DKG_MODE=real.");
    }
    const mod = await import("dkg.js");
    const DKG = (mod as any).default ?? mod;
    this.client = new DKG({
      endpoint,
      port: process.env.DKG_PORT ?? "8900",
        blockchain: {
          name: process.env.DKG_BLOCKCHAIN ?? "otp:20430",
          privateKey
        },
      maxNumberOfRetries: 30,
      frequency: 2,
      contentType: "all",
      nodeApiVersion: "/v1"
    }) as DkgClient;
    return this.client;
  }

  async health(): Promise<DkgHealth> {
    try {
      const client = await this.getClient();
      const info = await client.node.info();
      const blockchain = process.env.DKG_BLOCKCHAIN ?? "otp:20430";
      return {
        mode: this.mode,
        healthy: true,
        endpoint: process.env.DKG_ENDPOINT,
        blockchain,
        detail: `Connected to DKG node v${info?.version ?? "?"} on "${blockchain}".`
      };
    } catch (error) {
      return {
        mode: this.mode,
        healthy: false,
        endpoint: process.env.DKG_ENDPOINT,
        blockchain: process.env.DKG_BLOCKCHAIN,
        detail: `DKG node unreachable: ${(error as Error).message.slice(0, 200)}`
      };
    }
  }

  async publish(ka: KaEnvelope, _visibility: Visibility): Promise<KaRecord> {
    const client = await this.getClient();
    const result = await client.asset.create({ public: ka.content }, { epochsNum: Number(process.env.DKG_EPOCHS ?? 2) });
    if (!result?.UAL) throw new Error(`DKG publish failed: ${JSON.stringify(result ?? {}).slice(0, 300)}`);
    return {
      ual: result.UAL,
      explorerUrl: explorerUrlFor(result.UAL),
      name: ka.name,
      content: ka.content,
      publishedAt: new Date().toISOString(),
      mode: this.mode
    };
  }

  async get(ual: string): Promise<KaRecord | null> {
    const client = await this.getClient();
    const result = await client.asset.get(ual, { contentType: "all" });
    if (!result) return null;
    const content = (result.public ?? result) as Record<string, unknown>;
    return {
      ual,
      explorerUrl: explorerUrlFor(ual),
      name: String(content["schema:name"] ?? ual),
      content,
      publishedAt: new Date().toISOString(),
      mode: this.mode
    };
  }

  async sparql(query: string): Promise<Array<Record<string, unknown>>> {
    const client = await this.getClient();
    const result = await client.graph.query(query, "SELECT");
    const bindings = (result?.data?.bindings ?? result?.bindings ?? []) as Array<Record<string, any>>;
    return bindings.map((b) => unwrapBindings(b));
  }

  async findApplicablePassports(filter: {
    creatorId: string;
    platform: string;
    country: string;
    onDate: string;
  }): Promise<PermissionPassport[]> {
    const rows = await this.sparql(
      findApplicablePassportsSparql(filter.creatorId, filter.platform, filter.country, filter.onDate)
    );
    return rows.map(sparqlRowToPassport);
  }

  async listPassports(creatorId: string): Promise<PermissionPassport[]> {
    const rows = await this.sparql(`PREFIX pf: <https://permitframe.app/ns#>
SELECT ?passport ?creatorName ?status ?validFrom ?validUntil ?transformations
WHERE {
  ?passport a pf:PermitFramePermissionPassport ;
    pf:creatorId "${creatorId}" ;
    pf:status ?status ;
    pf:validFrom ?validFrom ;
    pf:validUntil ?validUntil ;
    pf:allowedTransformation ?transformations ;
    pf:creatorName ?creatorName .
}`);
    return rows.map(sparqlRowToPassport);
  }

  async findProductFacts(brand: string, productName: string): Promise<ProductFacts | null> {
    const rows = await this.sparql(findProductFactsSparql(brand, productName));
    if (rows.length === 0) return null;
    const merged: Record<string, unknown> = {};
    for (const row of rows) Object.assign(merged, row.raw ?? row);
    return {
      id: String(merged["@id"] ?? "").replace("urn:permitframe:product-facts:", "") || "unknown",
      brand: String(merged["pf:brand"] ?? brand),
      productName: String(merged["pf:productName"] ?? productName),
      approvedClaims: [...new Set(toList(merged["pf:approvedClaim"]))] as string[],
      prohibitedClaims: [...new Set(toList(merged["pf:prohibitedClaim"]))] as string[],
      guidelines: [...new Set(toList(merged["pf:brandGuideline"]))] as string[],
      evidenceNotes: String(merged["pf:evidenceNotes"] ?? ""),
      visibility: "shared"
    };
  }

  async listAssets(): Promise<KaRecord[]> {
    const client = await this.getClient();
    const result = await client.graph.query(
      `PREFIX pf: <https://permitframe.app/ns#>
PREFIX schema: <https://schema.org/>
SELECT ?asset ?type ?name WHERE { ?asset a ?type . ?asset schema:name ?name .
  FILTER (STRSTARTS(STR(?type), "https://permitframe.app/ns#")) }`,
      "SELECT"
    );
    const bindings = (result?.data?.bindings ?? result?.bindings ?? []) as Array<Record<string, any>>;
    return bindings.map((b) => {
      const ual = String(b.asset?.value ?? "");
      return {
        ual,
        explorerUrl: explorerUrlFor(ual),
        name: String(b.name?.value ?? ""),
        content: { "@type": String(b.type?.value ?? "") },
        publishedAt: "",
        mode: this.mode
      };
    });
  }
}

function sparqlRowToPassport(row: Record<string, any>): PermissionPassport {
  const raw = (row.raw ?? row) as Record<string, unknown>;
  const passportUri = String(row.passport?.value ?? raw["@id"] ?? "");
  const id = passportUri.replace("urn:permitframe:passport:", "") || passportUri;
  return {
    id,
    creatorId: String(raw["pf:creatorId"] ?? ""),
    creatorName: String(row.creatorName?.value ?? raw["pf:creatorName"] ?? ""),
    sourceMediaIds: [],
    platforms: toList(raw["pf:platform"]) as PermissionPassport["platforms"],
    countries: toList(raw["pf:country"]),
    allowedTransformations: toList(raw["pf:allowedTransformation"]) as PermissionPassport["allowedTransformations"],
    validFrom: String(row.validFrom?.value ?? raw["pf:validFrom"] ?? ""),
    validUntil: String(row.validUntil?.value ?? raw["pf:validUntil"] ?? ""),
    status: (String(row.status?.value ?? raw["pf:status"] ?? "active") as PermissionPassport["status"]) ?? "active",
    attestation: {
      method: "creator-consent-link",
      consentedAt: String(raw["pf:attestedAt"] ?? ""),
      declaration: String(raw["pf:declaration"] ?? "")
    },
    visibility: "public",
    ual: undefined
  };
}

function unwrapBindings(binding: Record<string, any>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const raw: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(binding)) {
    if (key === "raw") {
      out.raw = value;
      continue;
    }
    out[key] = (value as any)?.value ?? value;
    raw[key] = (value as any)?.value ?? value;
  }
  return { ...out, raw };
}
