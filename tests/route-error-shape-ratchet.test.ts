import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Mossy-ocean A5 · route error-shape ratchet.
//
// A route handler should not define its OWN ad-hoc `jsonError` error-shape
// function. The repo already ships shared per-domain helpers — five exported
// `jsonError`s (coaching, territory-drilldown and territory-management `_lib`
// route-utils, plus src/lib/automated-payroll/http.ts and src/lib/deductions/
// http.ts) — and importing one of those is the right move. Each new inline copy
// is another place the error contract can drift from the client that parses it.
//
// WHAT THIS RATCHET IS NOT
// It does NOT try to unify the shapes. Track A leaves the jsonErrors alone on
// purpose: they ship SIX visibly distinct response bodies, each parsed by a
// specific client, and collapsing them would change what those clients receive.
// So there is no preceding fix here and nothing to migrate in bulk — this test
// only stops the number GROWING, and lets it fall as routes voluntarily adopt a
// shared helper.
//
// WHAT COUNTS
// A LOCAL (non-exported) `jsonError` definition inside a route handler file
// (app/**/route.ts): `function jsonError(…)` or `const jsonError = …`, defined
// in the route file itself. An `export function jsonError` (a shared helper) does
// not count — those are the solution, not the problem. Nor does an `import { …,
// jsonError }` (a route already using the shared helper), nor a call site, nor
// the word in a comment. Comments are stripped before anything is measured.
//
// HOW IT RATCHETS
// The count may fall and may never rise. UP means someone hand-rolled a new
// error shape in a route instead of importing a shared one. DOWN is good news
// and the test says so, because a stale-high baseline quietly re-opens the door
// to the number it was lowered from.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Counted 2026-08-29 on origin/main (6779336c0). There is no preceding fix that
 * reduced this — Track A deliberately keeps the distinct jsonError bodies — so
 * the PRE-FIX number is the same 30. This baseline pins the count so no NEW inline
 * error shape is added; lower it when a route is migrated to a shared helper, and
 * never raise it to make a red run go green.
 */
// Lowered 30 -> 22 in the C6 deductions cutover (2026-08-30): removing the 8 legacy governance
// and Payroll-Copilot deduction API routes deleted their inline jsonError bodies. Retiring a route
// counts as ground won, same as migrating one to a shared helper.
const BASELINE = 22;

const APP_ROOT = "app";

/**
 * A local jsonError definition sits at the start of its line (after indentation).
 * A shared export starts the line with `export`, so `^\s*function` / `^\s*const`
 * never matches it — that is the whole export-vs-local distinction, done by anchor
 * rather than by a fragile negative lookbehind.
 */
const LOCAL_JSON_ERROR_DEF =
  /^\s*(?:async\s+)?function\s+jsonError\b|^\s*const\s+jsonError\s*=/;
/** Cheap pre-filter so we only line-scan files that mention it at all. */
const ANY_JSON_ERROR_TOKEN = /\bjsonError\b/;

/**
 * Remove comments before counting, so a definition only counts where it is real
 * code. Block comments keep their newlines (so reported file:line stays accurate)
 * and lose everything else; the `[^:]` guard keeps a `https://…` URL from reading
 * as the start of a line comment. Same helper shape as the sibling ratchets.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// Collect every route handler file (a file named route.ts under app/).
function collectRouteFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry.startsWith(".") || entry.startsWith("_wt-")) continue;
      collectRouteFiles(full, out);
    } else if (entry === "route.ts" || entry === "route.tsx") {
      out.push(full);
    }
  }
  return out;
}

export function runRouteErrorShapeRatchetTests() {
  const routeFiles = collectRouteFiles(APP_ROOT);
  assert.ok(
    routeFiles.length > 300,
    `only ${routeFiles.length} route handler files were scanned — the walk is not reaching app/**/route.ts, so any count it reports is meaningless`,
  );

  // ───────────────────────────────────────────────────────────────────────────
  // Check the detector against known inputs BEFORE trusting it across 600+ files.
  // A ratchet whose regex is wrong does not fail loudly — it reports a number, and
  // a wrong number looks exactly as authoritative as a right one.
  // ───────────────────────────────────────────────────────────────────────────
  const countIn = (snippet: string) =>
    stripComments(snippet)
      .split("\n")
      .filter((line) => LOCAL_JSON_ERROR_DEF.test(line)).length;

  assert.equal(countIn("function jsonError(error: unknown) {"), 1, "a plain local function definition is what this ratchet counts");
  assert.equal(countIn("  function jsonError(error: unknown, fallback: string) {"), 1, "an indented local definition still counts");
  assert.equal(countIn("async function jsonError(error: unknown) {"), 1, "an async local definition still counts");
  assert.equal(countIn("const jsonError = (error: unknown) => NextResponse.json({ error });"), 1, "a local arrow definition counts too");
  assert.equal(countIn("export function jsonError(error: unknown, fallback = 'x') {"), 0, "an exported shared helper is the solution, not a violation — it must NOT count");
  assert.equal(countIn("export const jsonError = (error: unknown) => NextResponse.json({ error });"), 0, "an exported arrow helper must NOT count either");
  assert.equal(countIn('import { resolveAccessContext, jsonError } from "@/lib/deductions/http.ts";'), 0, "a route that IMPORTS the shared helper is doing the right thing — an import is not a definition");
  assert.equal(countIn("  return jsonError(error, 'Unable to acknowledge plan.');"), 0, "a call site is not a definition");
  assert.equal(countIn("// function jsonError(error: unknown) { /* old */ }"), 0, "a commented-out definition is not live code");
  assert.equal(countIn("/**\n * function jsonError is described here\n */"), 0, "a JSDoc block naming it is prose, not a definition");

  // Line numbers survive comment stripping, or every file:line reported below is
  // shifted upward by the size of whatever comment block sat above the definition.
  const preserved = stripComments("/*\n * a note\n */\nfunction jsonError(e: unknown) {").split("\n");
  assert.equal(preserved.length, 4, "stripping must preserve the line count, or every file:line this test prints is wrong");
  assert.ok(
    LOCAL_JSON_ERROR_DEF.test(preserved[3]),
    "the surviving definition must still sit on its original line after the comment above it is stripped",
  );

  const sites: string[] = [];
  for (const file of routeFiles) {
    const source = stripComments(readFileSync(file, "utf8"));
    if (!ANY_JSON_ERROR_TOKEN.test(source)) continue;
    source.split("\n").forEach((line, i) => {
      if (LOCAL_JSON_ERROR_DEF.test(line)) sites.push(`${file.replace(/\\/g, "/")}:${i + 1}`);
    });
  }

  const count = sites.length;

  assert.ok(
    count <= BASELINE,
    `${count - BASELINE} new inline jsonError definition(s) were added — the count went ${BASELINE} -> ${count}.\n` +
      `A route handler should import a shared jsonError (e.g. "@/lib/deductions/http.ts", ` +
      `"@/lib/automated-payroll/http.ts", or a domain _lib/route-utils.ts) rather than define its ` +
      `own error shape, so the response contract stays in one place.\n` +
      `Definitions now present:\n  ${sites.slice(-12).join("\n  ")}`,
  );

  assert.ok(
    count >= BASELINE,
    `Good news: inline jsonError definitions dropped ${BASELINE} -> ${count}. Lower BASELINE in this ` +
      `file to ${count} so the ground that was won cannot be given back.`,
  );
}
