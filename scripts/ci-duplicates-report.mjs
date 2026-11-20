#!/usr/bin/env node
/**
 * The copy-paste report for a change: which blocks of product code it COPIES, compared with the commit
 * before it (a pull request's base, or main before a push). Report-only — it prints, annotates and writes the job summary, and it
 * always exits 0. The CI step that runs it (`static`, "Copy-paste report") is non-blocking as well.
 *
 * WHY ONLY THE NEW ONES. The whole product tree already carries about a thousand copied blocks (measured
 * 2026-11-20: 1,012 in `app/api` alone, mostly route plumbing such as request parsing and the spreadsheet
 * response headers). A report of all of them on every PR is noise nobody reads. jscpd 5 builds a
 * baseline from the base ref's own tree with the same settings (`--baseline-from-ref`) and marks each
 * clone that is absent from it `isNew`; this script reports those and nothing else.
 *
 * WHAT IT CANNOT SEE. jscpd matches TOKENS. A payroll, leave or sales rule written again in different
 * words is not a copy to it — that is still the reviewer's job and the domain-first rule's.
 *
 * WHY THE COVERAGE FLOOR. A scan that read almost nothing would report "no new copies" exactly like a
 * clean PR (the lesson of scripts/vuln-scan.mjs). So a run that analysed fewer than SOURCES_FLOOR files
 * never says clean: it says it could not prove anything.
 *
 * WHY jscpd 5 AND NOT 4. jscpd 4 is JavaScript and holds every token in the V8 heap: it ran out of
 * memory at a 448 MB cap on ~230k lines here. jscpd 5 is a Rust binary: the same slice in 1.2 s at a
 * 214 MB peak (2026-11-20, measured on this laptop).
 *
 * Usage: node scripts/ci-duplicates-report.mjs [--base <ref>]   (default origin/main; CI passes HEAD^1,
 * the base side of the pull request's merge commit)
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// Before anything below can write or spawn. A no-op when the module is imported (the test does).
refuseUnknownFlags({
  name: "ci-duplicates-report",
  entry: import.meta.url,
  known: ["--base"],
  hints: ["node scripts/ci-duplicates-report.mjs [--base <ref>]   (default origin/main)"],
});

/** The product code. Tests are left out: a test repeating its arrange step is not a defect. */
export const SCAN_PATHS = ["src", "app"];
export const JSCPD_ARGS = [
  "--format", "typescript,tsx",
  "--min-tokens", "70",
  "--min-lines", "8",
  "--ignore", "**/*.test.ts,**/*.test.tsx,**/__tests__/**,**/*.generated.ts",
];
/** src + app hold ~6,500 tracked TypeScript files; a scan that read under 1,000 read the wrong thing. */
export const SOURCES_FLOOR = 1000;
/** GitHub shows at most 10 warning annotations per step; the job summary lists every clone. */
export const ANNOTATION_LIMIT = 10;

const toPosix = (p) => String(p).replaceAll("\\", "/");

/**
 * The new clones of a jscpd JSON report, with repo-relative paths, largest first.
 * Throws when the report is not one this script understands, or covers fewer files than `floor`.
 */
export function newClonesFrom(report, { root, floor = SOURCES_FLOOR }) {
  const total = report?.statistics?.total;
  if (!total || !Array.isArray(report?.duplicates)) {
    throw new Error("the jscpd report has no statistics.total or duplicates — not a report this script understands");
  }
  if (!(Number(total.sources) >= floor)) {
    throw new Error(`the scan analysed ${total.sources ?? 0} files, under the floor of ${floor} — it cannot vouch for this change`);
  }
  // jscpd's --absolute on Windows writes the extended-length form `\\?\F:\…` (measured 2026-11-20), which
  // path.relative cannot place, so the prefix goes first. On the Linux runner a path is plain `/home/…`.
  const rel = (name) => {
    const plain = String(name).replace(/^[\\/]{2}\?[\\/]/, "");
    const posix = toPosix(plain);
    return path.isAbsolute(plain) || /^[A-Za-z]:\//.test(posix) ? toPosix(path.relative(root, plain)) : posix;
  };
  const clones = report.duplicates
    .filter((clone) => clone?.isNew === true)
    .map((clone) => ({
      lines: Number(clone.lines) || 0,
      tokens: Number(clone.tokens) || 0,
      kind: clone.kind ?? "exact",
      first: { file: rel(clone.firstFile.name), start: clone.firstFile.start, end: clone.firstFile.end },
      second: { file: rel(clone.secondFile.name), start: clone.secondFile.start, end: clone.secondFile.end },
    }))
    .sort((a, b) => b.lines - a.lines || a.first.file.localeCompare(b.first.file) || a.first.start - b.first.start);
  return { clones, sources: Number(total.sources), totalClones: Number(total.clones) || 0 };
}

/** GitHub workflow-command escaping: data escapes % CR LF; a property also escapes : and ,. */
export function escapeData(text) {
  return String(text).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}
export function escapeProperty(text) {
  return escapeData(text).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

/** One `::warning` per clone, on the file the PR most likely added it in (the first side), capped. */
export function annotationsFor(clones, limit = ANNOTATION_LIMIT) {
  return clones.slice(0, limit).map((clone) => {
    const props = `file=${escapeProperty(clone.first.file)},line=${clone.first.start},endLine=${clone.first.end},title=${escapeProperty("Copied code")}`;
    const message = `${clone.lines} lines here are also at ${clone.second.file} lines ${clone.second.start}-${clone.second.end}. `
      + "Consider one shared helper (business rules belong in src/lib/<domain>).";
    return `::warning ${props}::${escapeData(message)}`;
  });
}

/** The job summary, in Markdown. */
export function summaryFor({ clones, sources, totalClones }, base) {
  const head = `### Copy-paste report (does not block the merge)\n\nScanned ${sources} files in ${SCAN_PATHS.join(" and ")} against \`${base}\`.\n\n`;
  if (clones.length === 0) {
    return `${head}No new copied blocks. (${totalClones} copied blocks were already there before this change.)\n`;
  }
  const rows = clones.map((c) =>
    `| ${c.lines} | \`${c.first.file}\` ${c.first.start}-${c.first.end} | \`${c.second.file}\` ${c.second.start}-${c.second.end} |`);
  return `${head}**${clones.length} new copied block${clones.length === 1 ? "" : "s"}** in this change:\n\n`
    + "| Lines | Here | Also here |\n| --- | --- | --- |\n"
    + `${rows.join("\n")}\n`;
}

function writeSummary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, `${markdown}\n`);
}

/** Never a red step: anything that stops the report is a warning that says so, never "clean". */
function cannotReport(reason) {
  console.log(`::warning title=${escapeProperty("Copy-paste report did not run")}::${escapeData(reason)}`);
  writeSummary(`### Copy-paste report (does not block the merge)\n\nIt could not run, so it says nothing about this change: ${reason}\n`);
  return 0;
}

export function main(argv = process.argv.slice(2)) {
  const baseAt = argv.indexOf("--base");
  const base = baseAt === -1 ? "origin/main" : argv[baseAt + 1];
  if (!base || base.startsWith("-")) return cannotReport("--base needs a git ref");

  const root = process.cwd();
  const verify = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${base}^{commit}`], { encoding: "utf8" });
  if (verify.status !== 0) return cannotReport(`the base ref ${base} is not a commit in this checkout`);

  let launcher;
  try {
    launcher = createRequire(import.meta.url).resolve("jscpd/run-jscpd.js");
  } catch {
    return cannotReport("jscpd is not installed (devDependency jscpd 5)");
  }

  const out = mkdtempSync(path.join(tmpdir(), "phoenix-jscpd-"));
  const run = spawnSync(
    process.execPath,
    [launcher, ...SCAN_PATHS, ...JSCPD_ARGS, "--baseline-from-ref", base, "--absolute",
      "--reporters", "json", "--output", out, "--silent", "--no-colors", "--no-tips"],
    // Under the step's 4-minute timeout, so a slow scan ends as "could not run" rather than a killed step.
    { encoding: "utf8", timeout: 210_000, maxBuffer: 64 * 1024 * 1024 },
  );
  if (run.error || run.status !== 0) {
    const why = run.error ? run.error.message : `exit ${run.status}: ${(run.stderr || run.stdout || "").trim().slice(-400)}`;
    return cannotReport(`jscpd failed (${why})`);
  }

  let result;
  try {
    result = newClonesFrom(JSON.parse(readFileSync(path.join(out, "jscpd-report.json"), "utf8")), { root });
  } catch (error) {
    return cannotReport(error instanceof Error ? error.message : String(error));
  }

  for (const line of annotationsFor(result.clones)) console.log(line);
  const markdown = summaryFor(result, base);
  console.log(markdown);
  writeSummary(markdown);
  // Deliberately 0: this reports, it never gates. See the header.
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main());
}
