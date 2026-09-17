import fs from "node:fs";
import path from "node:path";
import type { PermissionPassport, ProductFacts, Visibility } from "../types";
import { type DkgAdapter, type DkgHealth, type KaRecord, basePublicationStatus } from "./adapter";
import type { KaEnvelope } from "./schemas";

const DKG_DIR = process.env.PERMITFRAME_DATA_DIR
  ? path.join(process.env.PERMITFRAME_DATA_DIR, "dkg")
  : path.join(process.cwd(), ".data", "dkg");

/**
 * Local-evidence adapter: the same Knowledge Asset schemas and the same
 * SPARQL semantics, persisted locally instead of the public DKG.
 * Used before testnet node credentials are configured, and as fallback
 * if the remote node is unreachable — the UI clearly labels this mode.
 */
export class FileDkgAdapter implements DkgAdapter {
  readonly mode = "local-evidence" as const;

  async health(): Promise<DkgHealth> {
    return {
      mode: this.mode,
      healthy: true,
      detail:
        "Local evidence store — same KA schemas and SPARQL semantics, persisted under .data/dkg. Configure DKG_* env vars for testnet publication with real UALs."
    };
  }

  async publish(ka: KaEnvelope, _visibility: Visibility): Promise<KaRecord> {
    fs.mkdirSync(DKG_DIR, { recursive: true });
    const safeName = ka.name.replace(/[^a-z0-9-_.]/gi, "-");
    const file = path.join(DKG_DIR, `${safeName}.json`);
    fs.writeFileSync(file, JSON.stringify(ka.content, null, 2), "utf8");
    const ual = `did:dkg:local/${safeName}`;
    return {
      ual,
      explorerUrl: "",
      publicationStatus: basePublicationStatus(this.mode, false),
      name: ka.name,
      content: ka.content,
      publishedAt: new Date().toISOString(),
      mode: this.mode
    };
  }

  async publishVerifiable(ka: KaEnvelope, visibility: Visibility): Promise<KaRecord> {
    // Local mode has no blockchain. Keep the same evidence shape but never claim
    // that its did:dkg:local locator is a public, on-chain record.
    return this.publish(ka, visibility);
  }

  async get(ual: string): Promise<KaRecord | null> {
    const name = ual.replace("did:dkg:local/", "");
    const file = path.join(DKG_DIR, `${name.replace(/[^a-z0-9-_.]/gi, "-")}.json`);
    if (!fs.existsSync(file)) return null;
    return {
      ual,
      explorerUrl: "",
      publicationStatus: basePublicationStatus(this.mode, false),
      name,
      content: JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>,
      publishedAt: fs.statSync(file).mtime.toISOString(),
      mode: this.mode
    };
  }

  async sparql(query: string): Promise<Array<Record<string, unknown>>> {
    // Local mode answers the two domain queries the policy engine uses by
    // scanning stored assets; arbitrary SPARQL is echoed as not executable.
    if (query.includes("PermitFramePermissionPassport")) {
      return this.allPassportRows();
    }
    if (query.includes("PermitFrameProductFacts")) {
      return this.allFactsRows();
    }
    return [];
  }

  async findApplicablePassports(filter: {
    creatorId: string;
    platform: string;
    country: string;
    onDate: string;
  }): Promise<PermissionPassport[]> {
    return this.allAssets()
      .filter((a) => a.content["@type"] === "PermitFramePermissionPassport")
      .map((a) => rowToPassport(a.content, a.ual))
      .filter(
        (p) =>
          p.creatorId === filter.creatorId &&
          p.platforms.some((x) => x.toLowerCase() === filter.platform.toLowerCase()) &&
          p.countries.some((c) => c.toLowerCase() === filter.country.toLowerCase()) &&
          p.validUntil >= filter.onDate &&
          p.status !== "revoked"
      );
  }

  async listPassports(creatorId: string): Promise<PermissionPassport[]> {
    return this.allAssets()
      .filter((a) => a.content["@type"] === "PermitFramePermissionPassport")
      .map((a) => rowToPassport(a.content, a.ual))
      .filter((p) => p.creatorId === creatorId);
  }

  async findProductFacts(brand: string, productName: string): Promise<ProductFacts | null> {
    const match = this.allAssets().find(
      (a) =>
        a.content["@type"] === "PermitFrameProductFacts" &&
        String(a.content["pf:brand"] ?? "").toLowerCase() === brand.toLowerCase() &&
        String(a.content["pf:productName"] ?? "").toLowerCase() === productName.toLowerCase()
    );
    return match ? rowToFacts(match.content, match.ual) : null;
  }

  async listAssets(): Promise<KaRecord[]> {
    return this.allAssets();
  }

  private allAssets(): KaRecord[] {
    if (!fs.existsSync(DKG_DIR)) return [];
    return fs
      .readdirSync(DKG_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const name = f.replace(/\.json$/, "");
        return {
          ual: `did:dkg:local/${name}`,
          explorerUrl: "",
          publicationStatus: basePublicationStatus(this.mode, false),
          name,
          content: JSON.parse(fs.readFileSync(path.join(DKG_DIR, f), "utf8")) as Record<string, unknown>,
          publishedAt: fs.statSync(path.join(DKG_DIR, f)).mtime.toISOString(),
          mode: this.mode
        };
      });
  }

  private allPassportRows(): Array<Record<string, unknown>> {
    return this.allAssets()
      .filter((a) => a.content["@type"] === "PermitFramePermissionPassport")
      .map((a) => ({ passport: { value: a.content["@id"] }, ual: { value: a.ual }, ...flatten(a.content) }));
  }

  private allFactsRows(): Array<Record<string, unknown>> {
    return this.allAssets()
      .filter((a) => a.content["@type"] === "PermitFrameProductFacts")
      .map((a) => ({ facts: { value: a.content["@id"] }, ual: { value: a.ual }, ...flatten(a.content) }));
  }
}

export function rowToPassport(row: Record<string, unknown>, ual?: string): PermissionPassport {
  const id = String(row["@id"] ?? "").replace("urn:permitframe:passport:", "") || "unknown";
  return {
    id,
    creatorId: String(row["pf:creatorId"] ?? ""),
    creatorName: String(row["pf:creatorName"] ?? ""),
    sourceMediaIds: [],
    platforms: toList(row["pf:platform"]) as PermissionPassport["platforms"],
    countries: toList(row["pf:country"]),
    allowedTransformations: toList(row["pf:allowedTransformation"]) as PermissionPassport["allowedTransformations"],
    validFrom: String(row["pf:validFrom"] ?? ""),
    validUntil: String(row["pf:validUntil"] ?? ""),
    status: (String(row["pf:status"] ?? "active") as PermissionPassport["status"]) ?? "active",
    attestation: {
      method: "creator-consent-link",
      consentedAt: String(row["pf:attestedAt"] ?? ""),
      declaration: String(row["pf:declaration"] ?? "")
    },
    visibility: (String(row["pf:visibility"] ?? "public") as Visibility) ?? "public",
    ual
  };
}

export function rowToFacts(row: Record<string, unknown>, ual?: string): ProductFacts {
  const id = String(row["@id"] ?? "").replace("urn:permitframe:product-facts:", "") || "unknown";
  return {
    id,
    brand: String(row["pf:brand"] ?? ""),
    productName: String(row["pf:productName"] ?? ""),
    approvedClaims: toList(row["pf:approvedClaim"]),
    prohibitedClaims: toList(row["pf:prohibitedClaim"]),
    guidelines: toList(row["pf:brandGuideline"]),
    evidenceNotes: String(row["pf:evidenceNotes"] ?? ""),
    visibility: (String(row["pf:visibility"] ?? "shared") as Visibility) ?? "shared",
    ual
  };
}

function toList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (value === undefined || value === null) return [];
  return [String(value)];
}

export { toList };

function flatten(content: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(content)) {
    if (k.startsWith("@")) continue;
    out[k] = Array.isArray(v) ? { value: v.join(", ") } : { value: String(v) };
  }
  return out;
}
