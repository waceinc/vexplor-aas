/**
 * Tree construction and location calculation — pure logic that holds without any UI.
 *
 * The most important point here: **the location the linter points to and the node the UI opens must be the same**.
 * If clicking a finding does not open that element, the linter loses half its value (docs/PROGRESS.md §5).
 * So each node gets two addresses.
 *   pointer     — Environment JSON Pointer. Matched against the linter finding.pointer
 *   idShortPath — IDTA Part 2 path. Used when editing values through the API
 *
 * 2026-10-13 componentization — split by topic into model/ (types · tree · findings · semanticId · linked branches). Callers still import from this file as before.
 */
export * from './model/types.js';
export * from './model/tree.js';
export * from './model/findings.js';
export * from './model/semantic.js';
export * from './model/linked.js';
