import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

describe("bundled application fonts", () => {
  it("uses packaged fonts instead of build-time Google Fonts requests", () => {
    const layout = fs.readFileSync(path.join(process.cwd(), "src", "app", "layout.tsx"), "utf8");
    assert.ok(layout.includes("@fontsource-variable/inter/wght.css"));
    assert.ok(layout.includes("@fontsource/ibm-plex-mono/400.css"));
    assert.ok(!layout.includes("next/font/google"));
    assert.ok(!layout.includes("fonts.googleapis.com"));
  });
});
