import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { stripComments } from "./support/comment-strip.ts";

// REC-079 / F-ENG-011 (phase 2): EVERY FOLDER UNDER src/lib/ IS IMPORTED BY AT LEAST ONE TEST.
//
// On 13 Nov 2026 the review found eleven src/lib folders that no test named. Five have tests now; the
// other six — dashboard, employee-lifecycle, finance, operations, overview, support-requests — and a
// seventh this check found (visits-report, which a test named only by a type import, erased before
// anything runs) got a behaviour test each on 19 Nov 2026. This keeps the count at zero: a NEW folder,
// or a folder whose only test is deleted, fails here by name.
//
// "Named" means IMPORTED — a static `import … from`, a bare `import "…"`, an `export … from` or a
// dynamic `import("…")`, by path (`../src/lib/<folder>/…`) or alias (`@/lib/<folder>/…`), in any file
// under tests/. Deliberately NOT counted:
//   - `import type` — erased before the test runs, so it runs nothing of the folder;
//   - a path in a comment, a string or a readFileSync — a test that reads a folder's text proves its
//     wording, not its behaviour (the review's whole point), and a file name that merely contains the
//     folder's name proves nothing at all.
// A folder that cannot be exercised by a test would go in EXEMPT with its reason. It is empty: every
// folder so far could be.

const REPO = process.cwd();
const LIB = path.join(REPO, "src", "lib");
const EXEMPT: Record<string, string> = {};

const IMPORT_SPECIFIER =
  /(?:^|[;\s}])(?:import\s+(type\s+)?(?:[\w*$\s{},]+?\s+from\s+)?|export\s+(type\s+)?(?:[\w*$\s{},]+?\s+)?from\s+)["'`]([^"'`]+)["'`]|import\(\s*["'`]([^"'`]+)["'`]\s*\)/g;

function filesUnder(directory: string, found: string[] = []): string[] {
  for (const name of readdirSync(directory)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) filesUnder(full, found);
    else if (/\.(?:ts|tsx|mts|mjs|js|cjs)$/.test(name)) found.push(full);
  }
  return found;
}

/** The src/lib folder a specifier lands in, or null. */
function libFolderOf(specifier: string, fromFile: string): string | null {
  let target: string | null = null;
  if (specifier.startsWith("@/lib/")) {
    const rest = specifier.slice("@/lib/".length);
    // The alias loader tries the repository root first (root lib/ holds only utils.ts), then src/.
    if (existsSync(path.join(REPO, "lib", rest)) || existsSync(path.join(REPO, "lib", `${rest}.ts`))) return null;
    target = path.join(LIB, rest);
  } else if (specifier.startsWith(".")) {
    target = path.resolve(path.dirname(fromFile), specifier);
  }
  if (!target) return null;
  const relative = path.relative(LIB, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const [first] = relative.split(path.sep);
  return first ? first.replace(/\.(?:ts|tsx)$/, "") : null;
}

/** For each src/lib folder, the test files that import it (type-only imports excluded). */
export function testImportsBySrcLibFolder(): { importsRead: number; importers: Map<string, Set<string>> } {
  const importers = new Map<string, Set<string>>();
  let importsRead = 0;
  for (const file of filesUnder(path.join(REPO, "tests"))) {
    const code = stripComments(readFileSync(file, "utf8"));
    IMPORT_SPECIFIER.lastIndex = 0;
    for (const match of code.matchAll(IMPORT_SPECIFIER)) {
      const typeOnly = Boolean(match[1] || match[2]);
      const specifier = match[3] ?? match[4];
      if (!specifier) continue;
      importsRead += 1;
      if (typeOnly) continue;
      const folder = libFolderOf(specifier, file);
      if (!folder) continue;
      if (!importers.has(folder)) importers.set(folder, new Set());
      importers.get(folder)!.add(path.relative(REPO, file));
    }
  }
  return { importers, importsRead };
}

export function runSrcLibFolderTestCoverageTests(): void {
  const folders = readdirSync(LIB).filter((name) => statSync(path.join(LIB, name)).isDirectory()).sort();
  assert.ok(folders.length >= 100, `src/lib must be read whole (${folders.length} folders found)`);

  const { importers, importsRead } = testImportsBySrcLibFolder();
  // "Nothing objected" is not "the imports were read": thousands of test imports exist, and they were parsed.
  assert.ok(importsRead >= 5_000, `the tests' import lines must be parsed for this check to mean anything (${importsRead} read)`);

  // The parser itself, on the shapes it must and must not count.
  assert.equal(libFolderOf("../src/lib/finance/command-center.ts", path.join(REPO, "tests", "x.test.ts")), "finance");
  assert.equal(libFolderOf("@/lib/support-requests/service", path.join(REPO, "tests", "x.test.ts")), "support-requests");
  assert.equal(libFolderOf("@/lib/utils", path.join(REPO, "tests", "x.test.ts")), null, "@/lib/utils is the root lib/, not a src/lib folder");
  assert.equal(libFolderOf("./support/postgrest-stand-in.ts", path.join(REPO, "tests", "x.test.ts")), null);

  const unnamed = folders.filter((folder) => !importers.has(folder) && !(folder in EXEMPT));
  assert.deepEqual(
    unnamed,
    [],
    `HEADLINE (REC-079): every folder under src/lib/ must be imported by at least one test — add a behaviour test that calls its main rule for: ${unnamed.join(", ")}`,
  );
  for (const folder of Object.keys(EXEMPT)) {
    assert.ok(folders.includes(folder), `EXEMPT names ${folder}, which is no longer a src/lib folder — take it off the list`);
    assert.ok(!importers.has(folder), `${folder} is imported by a test now — take it off EXEMPT`);
  }

  // The seven folders left untested on 19 Nov 2026 are held by their own behaviour test, by name.
  const heldBy: Record<string, string> = {
    dashboard: "tests/dashboard-invalidation-behaviour.test.ts",
    "employee-lifecycle": "tests/employee-lifecycle-workflow-behaviour.test.ts",
    finance: "tests/finance-command-center-behaviour.test.ts",
    operations: "tests/operations-activity-feed-behaviour.test.ts",
    overview: "tests/overview-dashboard-behaviour.test.ts",
    "support-requests": "tests/support-requests-behaviour.test.ts",
    "visits-report": "tests/visits-report-row-behaviour.test.ts",
  };
  for (const [folder, test] of Object.entries(heldBy)) {
    assert.ok(importers.get(folder)?.has(test), `src/lib/${folder} is imported by ${test}`);
  }
}
