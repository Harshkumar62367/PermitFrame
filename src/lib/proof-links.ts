/**
 * Proof-link helpers (pure, no network). The OriginTrail explorer only
 * indexes the networks it serves - a correctly-formed link can still land
 * on a blank page for testnet assets. For EVM chains we additionally offer
 * the token page on the chain's block explorer, derived from the UAL itself
 * (contract + token id), so the on-chain NFT is always one click away.
 */

export interface ParsedUal {
  namespace: string;
  chainId: string;
  contract: string;
  tokenId: string;
}

export function parseUal(ual: string): ParsedUal | null {
  const match = /^did:dkg:([^:]+):([^/]+)\/([^/]+)\/([^?#]+)/.exec((ual ?? "").trim());
  if (!match) return null;
  const [, namespace, chainId, contract, tokenId] = match;
  if (!namespace || !chainId || !contract || !tokenId) return null;
  return { namespace, chainId, contract, tokenId };
}

const EVM_EXPLORERS: Record<string, { label: string; base: string }> = {
  "84532": { label: "View token on Basescan Sepolia", base: "https://sepolia.basescan.org" },
  "8453": { label: "View token on Basescan", base: "https://basescan.org" },
  "1": { label: "View token on Etherscan", base: "https://etherscan.io" },
  "137": { label: "View token on Polygonscan", base: "https://polygonscan.com" }
};

/** Block-explorer NFT page for EVM UALs, or null when no explorer is known. */
export function blockExplorerNftUrl(ual: string): { label: string; href: string } | null {
  const parsed = parseUal(ual);
  if (!parsed) return null;
  const explorer = EVM_EXPLORERS[parsed.chainId];
  if (!explorer) return null;
  return {
    label: explorer.label,
    href: `${explorer.base}/token/${parsed.contract}?a=${parsed.tokenId}`
  };
}

/**
 * Base Sepolia transaction link for a finalized DKG publication. A transaction
 * hash on its own is not enough: the corresponding UAL must explicitly be a
 * Base Sepolia Knowledge Asset, and the hash must be a canonical EVM hash.
 * This keeps malformed, local, and non-Base records out of public UI.
 */
export function baseSepoliaTransactionUrl(ual: string | null | undefined, txHash: string | null | undefined): { label: string; href: string } | null {
  const parsed = typeof ual === "string" ? parseUal(ual) : null;
  const hash = typeof txHash === "string" ? txHash.trim() : "";
  if (parsed?.chainId !== "84532" || !/^0x[a-fA-F0-9]{64}$/.test(hash)) return null;
  return {
    label: "View Base Sepolia transaction",
    href: `https://sepolia.basescan.org/tx/${hash}`
  };
}

/**
 * Download href for a delivered asset. Cloudinary delivery URLs accept the
 * `fl_attachment` flag, which makes the CDN respond with
 * Content-Disposition: attachment - a real file download even cross-origin
 * (the plain `download` attribute is ignored off-origin). Provider-hosted
 * legacy URLs have no such flag, so they open in a new tab for manual save.
 */
export function downloadHrefFor(outputUrl: string, storageUrl?: string | null): { href: string; attachment: boolean } {
  const canonical = storageUrl ?? outputUrl;
  const marker = "/upload/";
  const at = canonical.indexOf(marker);
  if (storageUrl && at >= 0) {
    return { href: `${canonical.slice(0, at + marker.length)}fl_attachment/${canonical.slice(at + marker.length)}`, attachment: true };
  }
  return { href: canonical, attachment: false };
}
