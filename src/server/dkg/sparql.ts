import { PF_NS } from "./schemas";

/**
 * Real SPARQL executed against the DKG (or shown as the query preview in
 * local-evidence mode). The policy engine consumes these results - this is
 * how knowledge changes agent behavior.
 */

export function findApplicablePassportsSparql(creatorId: string, platform: string, country: string, onDate: string): string {
  return `PREFIX pf: <${PF_NS}>
PREFIX schema: <https://schema.org/>
SELECT ?passport ?creatorName ?status ?validFrom ?validUntil ?transformations
WHERE {
  ?passport a pf:PermitFramePermissionPassport ;
    pf:creatorId "${creatorId}" ;
    pf:platform ?platformRaw ;
    pf:country "${country}" ;
    pf:status ?status ;
    pf:validFrom ?validFrom ;
    pf:validUntil ?validUntil ;
    pf:allowedTransformation ?transformations ;
    pf:creatorName ?creatorName .
  FILTER (LCASE(STR(?platformRaw)) = "${platform}")
  FILTER (?status != "revoked")
  FILTER (?validUntil >= "${onDate}")
}`;
}

export function findProductFactsSparql(brand: string, productName: string): string {
  return `PREFIX pf: <${PF_NS}>
PREFIX schema: <https://schema.org/>
SELECT ?facts ?approvedClaim ?prohibitedClaim ?guideline
WHERE {
  ?facts a pf:PermitFrameProductFacts ;
    pf:brand "${brand}" ;
    pf:productName "${productName}" ;
    pf:approvedClaim ?approvedClaim .
  OPTIONAL { ?facts pf:prohibitedClaim ?prohibitedClaim . }
  OPTIONAL { ?facts pf:brandGuideline ?guideline . }
}`;
}

export function findReceiptsForCampaignSparql(campaignId: string): string {
  return `PREFIX pf: <${PF_NS}>
SELECT ?receipt ?outputUrl ?outputHash ?providerUrlFingerprint ?capability ?generatedAt
WHERE {
  ?receipt a pf:PermitFrameDerivativeReceipt ;
    pf:campaign ?campaign ;
    pf:outputUrl ?outputUrl ;
    pf:generationCapability ?capability ;
    pf:generatedAt ?generatedAt .
  OPTIONAL { ?receipt pf:outputHash ?outputHash . }
  OPTIONAL { ?receipt pf:providerUrlFingerprint ?providerUrlFingerprint . }
  ?campaign pf:campaignId "${campaignId}" .
}`;
}

/** Query used on the public verification page: reconstruct an output's lineage. */
export function receiptLineageSparql(receiptId: string): string {
  return `PREFIX pf: <${PF_NS}>
SELECT ?predicate ?object
WHERE {
  ?receipt a pf:PermitFrameDerivativeReceipt ;
    ?predicate ?object .
  FILTER (STRSTARTS(STR(?receipt), "urn:permitframe:receipt:${receiptId}"))
}`;
}

/** Policy simulator query: what would change if the country changed? */
export function countPassportsForPlatformSparql(platform: string): string {
  return `PREFIX pf: <${PF_NS}>
SELECT (COUNT(DISTINCT ?passport) AS ?count)
WHERE {
  ?passport a pf:PermitFramePermissionPassport ;
    pf:platform ?platformRaw ;
    pf:status "active" .
  FILTER (LCASE(STR(?platformRaw)) = "${platform}")
}`;
}
