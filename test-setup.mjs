/**
 * Test-only shim: neutralizes the `server-only` guard so server modules can
 * be unit-tested under tsx (which runs outside the RSC bundler). Production
 * bundling behavior is unchanged — bundlers still enforce the guard there.
 */
import { Module } from "node:module";

const originalLoad = Module._load;
Module._load = function _load(request, parent, isMain) {
  if (request === "server-only") return {};
  return originalLoad.call(this, request, parent, isMain);
};
