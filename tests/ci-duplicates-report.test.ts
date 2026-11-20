import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  ANNOTATION_LIMIT,
  SOURCES_FLOOR,
  annotationsFor,
  escapeData,
  escapeProperty,
  newClonesFrom,
  summaryFor,
} from "../scripts/ci-duplicates-report.mjs";

/**
 * The pull request copy-paste report (scripts/ci-duplicates-report.mjs, ci.yml `static`).
 *
 * THE FAILURE THAT MATTERS IS A REPORT THAT SAYS "NO NEW COPIES" WITHOUT HAVING LOOKED. A jscpd run
 * that scanned the wrong folder, or a report shape this script misreads, would otherwise print exactly
 * what a clean PR prints. So `newClonesFrom` must THROW under the coverage floor and on a report it does
 * not understand — the caller turns that into "could not run", never "clean".
 *
 * The rest: only clones jscpd marked `isNew` are reported (the ~1,000 already on main are not this PR's),
 * absolute paths come back repo-relative and forward-slashed so GitHub can pin the annotation to the
 * file, the annotations are capped at GitHub's ten per step, and workflow-command escaping holds.
 */
export async function runCiDuplicatesReportTests() {
  const root = process.cwd();
  const abs = (rel: string) => path.join(root, ...rel.split("/"));
  const clone = (isNew: boolean, lines: number, a: string, b: string, start = 10) => ({
    firstFile: { name: abs(a), start, end: start + lines - 1 },
    secondFile: { name: abs(b), start: 40, end: 40 + lines - 1 },
    format: "typescript",
    fragment: "…",
    isNew,
    kind: "exact",
    lines,
    tokens: lines * 8,
  });
  const report = (duplicates: unknown[], sources = 6500) => ({
    duplicates,
    statistics: { total: { sources, clones: duplicates.length, lines: 1_500_000, newClones: 0 } },
  });

  // ── Only the new clones, repo-relative, largest first ──────────────────────────────────────────
  const result = newClonesFrom(
    report([
      clone(false, 73, "app/api/devices/import/confirm/route.ts", "app/api/devices/import/dry-run/route.ts"),
      clone(true, 12, "app/api/a/route.ts", "app/api/b/route.ts"),
      clone(true, 28, "src/lib/outstation/x.ts", "src/lib/outstation/y.ts"),
    ]),
    { root },
  );
  assert.equal(result.clones.length, 2, "the clone already on main (isNew false) is not this PR's and must not be reported");
  assert.deepEqual(result.clones.map((c: { lines: number }) => c.lines), [28, 12], "largest first");
  assert.equal(result.clones[0].first.file, "src/lib/outstation/x.ts", "an absolute path comes back repo-relative with forward slashes");
  assert.equal(result.clones[0].second.file, "src/lib/outstation/y.ts");
  assert.equal(result.totalClones, 3);

  // A relative name (jscpd without --absolute) passes through, only re-slashed.
  const relative = newClonesFrom(
    report([{ ...clone(true, 9, "x", "y"), firstFile: { name: "src\\lib\\a.ts", start: 1, end: 9 }, secondFile: { name: "src\\lib\\b.ts", start: 2, end: 10 } }]),
    { root },
  );
  assert.equal(relative.clones[0].first.file, "src/lib/a.ts");

  // jscpd --absolute on Windows writes `\\?\F:\…`; the prefix must not reach the annotation's file.
  const extended = newClonesFrom(
    report([{ ...clone(true, 9, "x", "y"), firstFile: { name: `\\\\?\\${abs("app/api/a/route.ts")}`, start: 1, end: 9 } }]),
    { root },
  );
  assert.equal(extended.clones[0].first.file, "app/api/a/route.ts", "the extended-length prefix is stripped before the path is made relative");

  // ── It cannot call a PR clean without proof that it looked ─────────────────────────────────────
  assert.throws(
    () => newClonesFrom(report([], SOURCES_FLOOR - 1), { root }),
    /under the floor/,
    "a scan below the coverage floor must throw, never report zero new copies",
  );
  assert.throws(() => newClonesFrom(report([], 0), { root }), /under the floor/);
  assert.throws(() => newClonesFrom({ duplicates: [] }, { root }), /not a report/, "no statistics: not understood");
  assert.throws(() => newClonesFrom({ statistics: { total: { sources: 9000 } } }, { root }), /not a report/, "no duplicates array: not understood");
  assert.throws(() => newClonesFrom(null, { root }), /not a report/);
  assert.equal(newClonesFrom(report([], SOURCES_FLOOR), { root }).clones.length, 0, "at the floor exactly, an empty result IS clean");

  // ── Annotations: escaped, pinned to the first side, capped ─────────────────────────────────────
  assert.equal(escapeData("50% a\r\nb"), "50%25 a%0D%0Ab");
  assert.equal(escapeProperty("a:b,c%"), "a%3Ab%2Cc%25");
  const many = newClonesFrom(
    report(Array.from({ length: ANNOTATION_LIMIT + 5 }, (_, i) => clone(true, 9 + i, `app/api/r${i}/route.ts`, `app/api/s${i}/route.ts`))),
    { root },
  );
  const lines = annotationsFor(many.clones);
  assert.equal(lines.length, ANNOTATION_LIMIT, "GitHub shows ten warnings per step; the summary carries the rest");
  assert.match(lines[0], /^::warning file=app\/api\/r14\/route\.ts,line=10,endLine=32,title=Copied code::23 lines here are also at app\/api\/s14\/route\.ts lines 40-62\./);

  // ── The summary says which case it is ──────────────────────────────────────────────────────────
  const clean = summaryFor({ clones: [], sources: 6500, totalClones: 1012 }, "HEAD^1");
  assert.match(clean, /does not block the merge/);
  assert.match(clean, /No new copied blocks\. \(1012 copied blocks were already there before this PR\.\)/);
  const found = summaryFor(result, "HEAD^1");
  assert.match(found, /\*\*2 new copied blocks\*\*/);
  assert.match(found, /\| 28 \| `src\/lib\/outstation\/x\.ts` 10-37 \| `src\/lib\/outstation\/y\.ts` 40-67 \|/);
  assert.match(summaryFor({ ...result, clones: result.clones.slice(0, 1) }, "HEAD^1"), /\*\*1 new copied block\*\* in this PR/);

  // ── ci.yml runs it on pull requests only, without ever blocking ────────────────────────────────
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8").replaceAll("\r\n", "\n");
  const staticJob = workflow.slice(workflow.indexOf("\n  static:\n"), workflow.indexOf("\n  unit:\n"));
  const at = staticJob.indexOf("- name: Copy-paste report");
  assert.ok(at > 0, "the copy-paste report step lives in the static job");
  // The step ends at its first blank line: the next step's comment block must not lend it a matching line.
  const step = `${staticJob.slice(at, staticJob.indexOf("\n\n", at))}\n`;
  assert.match(step, /\n\s+if: github\.event_name == 'pull_request'\n/, "a push to main has no PR diff to report on");
  assert.match(step, /\n\s+continue-on-error: true\n/, "a report must never turn a required check red");
  assert.match(step, /\n\s+timeout-minutes: [1-5]\n/, "continue-on-error cannot absorb a step that never ends: it needs its own timeout");
  assert.match(step, /\n\s+run: node scripts\/ci-duplicates-report\.mjs --base HEAD\^1\n$/,"the base is the merge commit's first parent, the branch the PR merges into");
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.match(pkg.devDependencies?.jscpd ?? "", /^5\.\d+\.\d+$/, "jscpd 5 (the Rust engine), pinned exactly — jscpd 4 ran out of memory on this repo");
}
