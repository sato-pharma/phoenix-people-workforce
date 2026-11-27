// Does the sweep-then-verify speed-up (2026-11-06) keep every answer the guard gives?
//
// The guard sweeps a repository and then verifies it before every worktree removal. Two repeats were
// cut: an unchanged sweep no longer writes the 13.5 MB index back, and verify({ afterSweep }) reuses
// the index and file lists that sweep just read instead of reading both again. Pinned here:
//   1. an unchanged sweep leaves the index on disk exactly as it was (the speed-up itself)
//   2. a sweep that copies a document DOES write it into the index on disk
//   3. verify({ afterSweep }) still reports a document whose only copy is gone as LOST
//   4. a SKIPPED sweep (another holds the lock) leaves nothing to reuse: verify reads the disk again
// Each break-watch reverts ONE string in a copy of the PRODUCTION script, in its own throwaway
// archive and git repo. Nothing in F:\Claude Scratchpad Archive is touched and NOTHING IS DELETED —
// a copy that has to disappear is RENAMED out of the throwaway archive.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const SP = path.join(os.tmpdir(), "phx-archive-tests").split(path.sep).join("/");
const SRC = "C:/Users/satoh/.claude/scripts";
const RUN = `${SP}/harness-sweep-reuse/${new Date().toISOString().replace(/[:.]/g, "-")}`;
const LABEL = "HARNESS - repo";

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
  if (!ok) failed++;
};

const ARCHIVE_CONST = "export const ARCHIVE = 'F:/Claude Scratchpad Archive';";

const REVERT = {
  alwaysSave: [["if (history || ix[DIRTY]) saveIndex(ix);", "saveIndex(ix);"]],
  noDirtyOnCopy: [["      ix.files[key] = { size: st.size, mtimeMs: st.mtimeMs, sha };\n      ix[DIRTY] = true;", "      ix.files[key] = { size: st.size, mtimeMs: st.mtimeMs, sha };"]],
  staleReuse: [["  lastSweep = null; // a skipped or failed sweep leaves nothing for verify to reuse\n", ""]],
};

const makeHarness = async (name, revert = null) => {
  const H = `${RUN}/${name}/code`;
  const ARCH = `${RUN}/${name}/archive`;
  const REPO = `${RUN}/${name}/repo`;
  const ASIDE = `${RUN}/${name}/aside`;
  for (const d of [H, ARCH, `${REPO}/docs`, ASIDE]) fs.mkdirSync(d, { recursive: true });

  const sa = fs.readFileSync(`${SRC}/scratchpad-archive.mjs`, "utf8");
  if (sa.split(ARCHIVE_CONST).length - 1 !== 1) throw new Error("the archive root is not where the harness expects it");
  fs.writeFileSync(`${H}/scratchpad-archive.mjs`, sa.replace(ARCHIVE_CONST, `export const ARCHIVE = '${ARCH}';`));

  let ra = fs.readFileSync(`${SRC}/repo-archive.mjs`, "utf8");
  if (revert) {
    for (const [from, to] of REVERT[revert]) {
      const n = ra.split(from).length - 1;
      if (n !== 1) throw new Error(`${revert}: expected 1 match of "${from.slice(0, 50)}", found ${n}`);
      ra = ra.replace(from, to);
    }
  }
  fs.writeFileSync(`${H}/repo-archive.mjs`, ra);

  const doc = (file) => {
    fs.writeFileSync(`${REPO}/docs/${file}`, `<svg xmlns="http://www.w3.org/2000/svg"><!-- ${crypto.randomUUID()} --></svg>`);
    return path.join(REPO, "docs", file);
  };
  doc("plan.svg");
  execFileSync("git", ["init", "-q", REPO], { stdio: "pipe" });
  const dir = REPO.split("/").join("\\");
  fs.writeFileSync(`${ARCH}/_repos.json`, JSON.stringify([{ dir, main: dir, worktree: false, label: LABEL }]));

  const mod = await import(`file:///${H}/repo-archive.mjs`);
  const IX = `${ARCH}/_repo-index.json`;
  const readIx = () => JSON.parse(fs.readFileSync(IX, "utf8"));
  return { ...mod, ARCH, REPO, ASIDE, IX, readIx, doc, own: (f) => `${ARCH}/_by-source/svg/_repos/${LABEL}/docs/${f}` };
};

/** Runs all four checks on one harness; returns which of them failed. */
const scenario = async (name, revert) => {
  const h = await makeHarness(name, revert);
  const out = {};

  // 1. An unchanged sweep leaves the index file alone.
  h.sweepRepos({});
  const past = new Date(Date.now() - 3600_000);
  fs.utimesSync(h.IX, past, past);
  const bytes = fs.readFileSync(h.IX, "utf8");
  const c = h.sweepRepos({});
  out.unchangedNoWrite = c?.unchanged === 1 && Math.abs(fs.statSync(h.IX).mtimeMs - past.getTime()) < 1000 && fs.readFileSync(h.IX, "utf8") === bytes;

  // 2. A sweep that copies a new document writes it down on disk.
  const second = h.doc("second.svg");
  const c2 = h.sweepRepos({});
  out.copyIsWritten = c2?.copied === 1 && Boolean(h.readIx().files[second.toLowerCase()]?.sha);

  // 3. The only copy of plan.svg leaves the archive; sweep, then verify on the reused state: LOST.
  fs.renameSync(h.own("plan.svg"), `${h.ASIDE}/plan.svg`);
  h.sweepRepos({});
  const v = h.verify({ quiet: true, afterSweep: true });
  const fresh = h.verify({ quiet: true });
  out.lostStillLost = v.lost.length === 1 && v.lost[0].file.endsWith("plan.svg") && fresh.lost.length === 1;

  // 4. A document recorded as swept but held nowhere appears; a sweep is SKIPPED (lock held).
  //    verify({ afterSweep }) must read the disk, not the previous sweep's state, and find it LOST.
  const third = h.doc("third.svg");
  const ix = h.readIx();
  const st = fs.statSync(third);
  ix.files[third.toLowerCase()] = { size: st.size, mtimeMs: st.mtimeMs, sha: "0".repeat(40) };
  fs.writeFileSync(h.IX, JSON.stringify(ix));
  fs.writeFileSync(`${h.ARCH}/_repo-sweep.lock`, "harness", { flag: "wx" });
  const skipped = h.sweepRepos({});
  const v2 = h.verify({ quiet: true, afterSweep: true });
  fs.renameSync(`${h.ARCH}/_repo-sweep.lock`, `${h.ASIDE}/_repo-sweep.lock`);
  out.skippedSweepNotReused = skipped === null && v2.lost.some((l) => l.file.endsWith("third.svg"));
  return out;
};

const fixed = await scenario("fixed");
check("an unchanged sweep leaves the index on disk untouched", fixed.unchangedNoWrite);
check("a sweep that copies a document writes it into the index", fixed.copyIsWritten);
check("verify after a sweep still reports a document with no copy as LOST", fixed.lostStillLost);
check("after a SKIPPED sweep, verify reads the disk and finds the new LOST document", fixed.skippedSweepNotReused);

// Break-watches: each reverted string must make its own check fire.
const a = await scenario("break-alwaysSave", "alwaysSave");
check("break: saving every time — the unchanged-sweep check fires", a.unchangedNoWrite === false);
const b = await scenario("break-noDirtyOnCopy", "noDirtyOnCopy");
check("break: a copy not marked as a change — the written-down check fires", b.copyIsWritten === false);
const s = await scenario("break-staleReuse", "staleReuse");
check("break: reusing a skipped sweep's state — the LOST document is missed and the check fires", s.skippedSweepNotReused === false);

console.log(failed ? `\n${failed} failed` : "\nall pass");
process.exit(failed ? 1 : 0);
