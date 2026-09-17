import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { basePublicationStatus } from "./adapter";

describe("basePublicationStatus", () => {
  it("local store is always local, even for verifiable publishes", () => {
    assert.equal(basePublicationStatus("local-evidence", false), "local");
    assert.equal(basePublicationStatus("local-evidence", true), "local");
  });

  it("edge shares are shared until a verifiable publish finalizes", () => {
    assert.equal(basePublicationStatus("edge-node", false), "shared");
    assert.equal(basePublicationStatus("edge-node", true), "anchored");
  });
});
