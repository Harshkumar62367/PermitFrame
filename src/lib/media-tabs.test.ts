import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MEDIA_TABS, nextMediaTab } from "./media-tabs";

/**
 * Media Library tab keyboard behavior: arrows move and activate with
 * wrap-around, Home/End jump to the ends, and unrelated keys (notably Tab
 * itself) resolve to null so normal focus navigation is untouched. Pure.
 */
describe("nextMediaTab", () => {
  it("moves right and wraps from the last tab to the first", () => {
    assert.equal(nextMediaTab("upload", "ArrowRight"), "url");
    assert.equal(nextMediaTab("url", "ArrowRight"), "upload");
  });

  it("moves left and wraps from the first tab to the last", () => {
    assert.equal(nextMediaTab("url", "ArrowLeft"), "upload");
    assert.equal(nextMediaTab("upload", "ArrowLeft"), "url");
  });

  it("jumps with Home and End regardless of the current tab", () => {
    assert.equal(nextMediaTab("url", "Home"), "upload");
    assert.equal(nextMediaTab("upload", "Home"), "upload");
    assert.equal(nextMediaTab("upload", "End"), "url");
    assert.equal(nextMediaTab("url", "End"), "url");
  });

  it("ignores unrelated keys so Tab navigation is unaffected", () => {
    for (const tab of MEDIA_TABS) {
      for (const key of ["Tab", "Enter", " ", "Escape", "a", "ArrowUp", "ArrowDown", "PageDown", "F6"]) {
        assert.equal(nextMediaTab(tab, key), null, `${tab} + ${key} must not move tabs`);
      }
    }
  });
});
