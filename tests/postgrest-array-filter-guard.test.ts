import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Class-level regression guard for the production "malformed array literal" bug.
//
// PostgREST array-membership operators used inside hand-built `.or()` / `.filter()`
// strings — cs (contains), cd (contained-by), ov (overlaps) — expect a Postgres
// brace array literal (`{a,b}`), NOT a JS/JSON bracket literal (`["a","b"]`). The
// bracket form is sent verbatim to Postgres and raises `malformed array literal`,
// which is exactly what hit production via `recipients.cs.["A-12"]`
// (fixed in src/lib/employee-portal/service.ts).
//
// The safe forms are the typed query builders — `.contains("col", [..])`,
// `.containedBy("col", [..])`, `.overlaps("col", [..])` — which serialize the
// array correctly. This guard fails if the bracket-after-operator anti-pattern
// reappears anywhere under src/, not just in the one file we already fixed.

const SRC_DIR = fileURLToPath(new URL("../src/", import.meta.url));

// Matches `.cs.[`, `.cd.[`, `.ov.[` (optionally with whitespace), i.e. a JSON
// bracket array handed to a raw PostgREST array operator.
const FORBIDDEN = /\.(cs|cd|ov)\.\s*\[/;

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

export function runPostgrestArrayFilterGuardTests() {
  const offenders: string[] = [];
  for (const file of collectSourceFiles(SRC_DIR)) {
    if (FORBIDDEN.test(readFileSync(file, "utf8"))) {
      offenders.push(file);
    }
  }
  assert.equal(
    offenders.length,
    0,
    "PostgREST array filters must use the typed builder " +
      "(.contains / .containedBy / .overlaps with a JS array), never a hand-built " +
      '".cs.[...]" / ".cd.[...]" / ".ov.[...]" string — the bracket form causes ' +
      '"malformed array literal" errors in production. Offending files:\n' +
      offenders.join("\n"),
  );
}
