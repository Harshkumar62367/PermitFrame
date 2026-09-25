/**
 * Media Library source tabs: "Upload from computer" and "Use public URL".
 * WAI-ARIA tab keyboard behavior as a pure helper so it is unit-testable
 * without a DOM: arrows move and activate with wrap-around, Home/End jump
 * to the ends, and every other key (including Tab itself) is untouched so
 * normal focus navigation continues into the active panel. Pure.
 */

export type MediaTab = "upload" | "url";

export const MEDIA_TABS: readonly MediaTab[] = ["upload", "url"];

/**
 * Resolve a tablist keydown to the tab to activate, or null when the key
 * is not a tab-navigation key. Activation is automatic: the caller selects
 * the returned tab (which also owns side effects like aborting an active
 * upload when leaving the upload tab).
 */
export function nextMediaTab(current: MediaTab, key: string): MediaTab | null {
  const index = MEDIA_TABS.indexOf(current);
  switch (key) {
    case "ArrowRight":
      return MEDIA_TABS[(index + 1) % MEDIA_TABS.length];
    case "ArrowLeft":
      return MEDIA_TABS[(index - 1 + MEDIA_TABS.length) % MEDIA_TABS.length];
    case "Home":
      return MEDIA_TABS[0];
    case "End":
      return MEDIA_TABS[MEDIA_TABS.length - 1];
    default:
      return null;
  }
}
