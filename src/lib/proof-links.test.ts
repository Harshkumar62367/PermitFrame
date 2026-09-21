import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { blockExplorerNftUrl, downloadHrefFor, parseUal } from "./proof-links";

describe("proof links", () => {
  it("parses UAL contract and token id", () => {
    assert.deepEqual(parseUal("did:dkg:base:84532/0x31c83ac625c29ef7f4fabdb49ee68fb56b06977c/10"), {
      namespace: "base",
      chainId: "84532",
      contract: "0x31c83ac625c29ef7f4fabdb49ee68fb56b06977c",
      tokenId: "10"
    });
    assert.equal(parseUal("not-a-ual"), null);
    assert.equal(parseUal(""), null);
  });

  it("links Base Sepolia tokens to Basescan, unknown chains to null", () => {
    assert.deepEqual(blockExplorerNftUrl("did:dkg:base:84532/0xabc/10"), {
      label: "View token on Basescan Sepolia",
      href: "https://sepolia.basescan.org/token/0xabc?a=10"
    });
    assert.equal(blockExplorerNftUrl("did:dkg:foo:999/0xabc/10"), null);
  });

  it("forces attachment downloads for stored assets, plain links otherwise", () => {
    const stored = downloadHrefFor(
      "https://provider.example/o.png",
      "https://res.cloudinary.com/demo/image/upload/v7/folder/asset.png"
    );
    assert.equal(stored.attachment, true);
    assert.ok(stored.href.includes("/upload/fl_attachment/v7/"));
    const legacy = downloadHrefFor("https://provider.example/o.png", null);
    assert.equal(legacy.attachment, false);
    assert.equal(legacy.href, "https://provider.example/o.png");
  });
});
