// Is a dead index pointer safe to drop? Only when something else still blocks the history pass.
//
// The ask was "prune the 2,758 dead pointers". The hazard found while doing it: `recoverDeleted`
// asks `if (shas[sha])` before writing a document git history shows was deleted, and that question
// is NOT existence-checked — so a dead pointer is a TOMBSTONE, and dropping it lets the next
// history pass write that copy again. The owner had the duplicate copies removed on 2026-09-20, so
// a tidier index that resurrects documents is the worst possible trade.
//
// This pins the rule: an entry goes only when `gitBlobs[label]` holds the same destination (that
// guard is asked first and is content-addressed).
//
// 🔴 SUPERSEDED THE SAME DAY, and the suite says so rather than pretending otherwise: once
// recoverDeleted was made to existence-check both guards and then ask the archive BY CONTENT
// (test-history-guard.mjs), a dead pointer stopped being what protects the archive — the content
// does. An unguarded prune is therefore no longer a resurrection risk, only an extra hash walk, and
// the assertion below that used to watch a document come back now watches it NOT come back. The
// prune stays conservative anyway: a smaller index buys nothing worth re-deciding this over.
//
// Production code, archive root redirected, one throwaway git repo per harness. NOTHING IS EVER
// DELETED: a document that must leave the tree is `git rm --cached`-ed and RENAMED aside, because
// every fixture here is a protected type.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";

const SP = path.join(os.tmpdir(), "phx-archive-tests").split(path.sep).join("/");
const SRC = "C:/Users/satoh/.claude/scripts";
const RUN = `${SP}/harness-prune/${new Date().toISOString().replace(/[:.]/g, "-")}`;
const ARCHIVE_CONST = "export const ARCHIVE = 'F:/Claude Scratchpad Archive';";

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
  if (!ok) failed++;
};

// The two guards the break removes — the plan-time one and the re-check under the lock.
const UNGUARD = [
  ["      if (blobDests.has(dest)) plan.push({ label, sha });\n      else out.keptAsTombstone++;", "      plan.push({ label, sha });"],
  ["      if (!blobDests.has(dest)) continue;", "      void blobDests;"],
];

const makeHarness = async (name, unguarded = false) => {
  const H = `${RUN}/${name}/code`;
  const ARCH = `${RUN}/${name}/archive`;
  const REPO = `${RUN}/${name}/repo`;
  fs.mkdirSync(H, { recursive: true });
  fs.mkdirSync(ARCH, { recursive: true });
  fs.mkdirSync(`${REPO}/docs`, { recursive: true });

  const sa = fs.readFileSync(`${SRC}/scratchpad-archive.mjs`, "utf8");
  fs.writeFileSync(`${H}/scratchpad-archive.mjs`, sa.replace(ARCHIVE_CONST, `export const ARCHIVE = '${ARCH}';`));
  let ra = fs.readFileSync(`${SRC}/repo-archive.mjs`, "utf8");
  if (unguarded) {
    for (const [from, to] of UNGUARD) {
      const n = ra.split(from).length - 1;
      if (n !== 1) throw new Error(`unguard: expected 1 match of "${from.slice(0, 44)}", found ${n}`);
      ra = ra.replace(from, to);
    }
  }
  fs.writeFileSync(`${H}/repo-archive.mjs`, ra);

  const git = (...args) =>
    execFileSync("git", ["-C", REPO, "-c", "user.name=Harness", "-c", "user.email=harness@local", ...args], { stdio: "pipe" });
  execFileSync("git", ["init", "-q", REPO], { stdio: "pipe" });

  // Three documents, each unique: one that stays live, one recovered from history, one that was
  // swept from the working tree and later left it.
  const uniq = (tag) => `<svg xmlns="http://www.w3.org/2000/svg"><!-- ${tag} ${crypto.randomUUID()} --></svg>`;
  for (const [f, tag] of [["live.svg", "live"], ["gone.svg", "history"], ["doomed.svg", "doomed"]])
    fs.writeFileSync(`${REPO}/docs/${f}`, uniq(tag));
  git("add", "-A");
  git("commit", "-qm", "all three");

  fs.writeFileSync(
    `${ARCH}/_repos.json`,
    JSON.stringify([{ dir: REPO.split("/").join("\\"), main: REPO.split("/").join("\\"), worktree: false, label: "HARNESS - repo" }]),
  );
  const mod = await import(`file:///${H}/repo-archive.mjs`);
  const IX = `${ARCH}/_repo-index.json`;
  const readIx = () => JSON.parse(fs.readFileSync(IX, "utf8"));
  const countFiles = () => {
    let n = 0;
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(`${d}/${e.name}`) : n++; };
    walk(ARCH);
    return n;
  };
  // Out of the tree WITHOUT deleting it: the index loses the path (so history shows a deletion) and
  // the file is renamed aside, so walkRepo stops seeing it and no protected document is destroyed.
  const retire = (f) => {
    git("rm", "-q", "--cached", `docs/${f}`);
    git("commit", "-qm", `retire ${f}`);
    fs.renameSync(`${REPO}/docs/${f}`, `${RUN}/${name}/aside-${f}`);
  };
  const shaFor = (dest) => {
    const shas = readIx().shas["HARNESS - repo"] ?? {};
    return Object.entries(shas).find(([, d]) => d.split(path.sep).join("/") === dest)?.[0] ?? null;
  };
  return { ...mod, ARCH, REPO, RUN: `${RUN}/${name}`, readIx, countFiles, retire, shaFor, git, label: "HARNESS - repo" };
};

/** Build the state the prune has to reason about, in either harness. */
const setUp = async (h) => {
  // ORDER IS THE WHOLE HARNESS. gone.svg leaves the tree BEFORE any sweep, so the HISTORY pass is
  // the only thing that archives it and a gitBlobs entry lands behind its pointer. doomed.svg leaves
  // AFTER that pass, so nothing ever mirrored its pointer into gitBlobs — which is the only way to
  // get a dead pointer with no twin. Two earlier versions of this file got this wrong: sweeping
  // gone.svg from the tree first made the history pass a no-op (`recovered: 0`, no twin to test),
  // and retiring doomed.svg before the history pass gave it a twin too, because recoverDeleted
  // writes `blobs[blob] = shas[sha]` when the sha is already recorded — which is exactly how the 945
  // inert pointers on the real archive came to be inert.
  h.retire("gone.svg");
  const c = h.sweepRepos({ history: true });
  const blobs = h.readIx().gitBlobs["HARNESS - repo"] ?? {};
  const destHist = Object.values(blobs).find((d) => /_repos-deleted-in-git/.test(d));
  // Its content stays in a day folder too, so NOTHING in this suite is ever held nowhere: it is
  // about pointers, and a write here would mean the content check failed, not that a document was
  // rescued. (The rescue itself is asserted in test-history-guard.mjs, where content IS absent.)
  fs.mkdirSync(`${h.ARCH}/svg/2026-09-19`, { recursive: true });
  fs.copyFileSync(destHist, `${h.ARCH}/svg/2026-09-19/gone.svg`);
  fs.renameSync(destHist, `${h.RUN}/aside-archived-gone.svg`); // dead, but a blob twin still holds it

  const ownDoomed = `${h.ARCH}/_by-source/svg/_repos/HARNESS - repo/docs/doomed.svg`;
  const shaDoomed = h.shaFor(ownDoomed);
  h.retire("doomed.svg");
  // The 2026-09-20 de-duplication: the duplicate leaves its own path, the CONTENT stays in a day
  // folder. Anything that reads paths calls this document lost; only a content check finds it.
  fs.mkdirSync(`${h.ARCH}/svg/2026-09-19`, { recursive: true });
  fs.copyFileSync(ownDoomed, `${h.ARCH}/svg/2026-09-19/doomed.svg`);
  fs.renameSync(ownDoomed, `${h.RUN}/aside-archived-doomed.svg`); // its pointer is now dead
  return { shaDoomed, destHist, recovered: c?.recovered ?? 0, ownLive: `${h.ARCH}/_by-source/svg/_repos/HARNESS - repo/docs/live.svg` };
};

// ── the guarded prune ────────────────────────────────────────────────────────────────────────────
{
  const h = await makeHarness("guarded");
  const s = await setUp(h);
  check("setup: the history pass recovered the retired document", s.recovered === 1, `recovered=${s.recovered}`);
  check("setup: both pointers are now dead, and the live one is not", fs.existsSync(s.ownLive) && !fs.existsSync(s.destHist));

  const dry = h.prunePointers({});
  check("the dry run finds 2 dead pointers: 1 inert, 1 tombstone",
    dry.dead === 2 && dry.pruned === 1 && dry.keptAsTombstone === 1, JSON.stringify(dry));
  check("the dry run writes nothing", dry.applied === false && dry.backup === null);

  const before = h.countFiles();
  const got = h.prunePointers({ apply: true });
  check("the apply pruned exactly the inert one", got.applied && got.pruned === 1, JSON.stringify({ applied: got.applied, pruned: got.pruned }));
  check("it backed the index up first", Boolean(got.backup) && fs.existsSync(got.backup));
  const shas = h.readIx().shas["HARNESS - repo"];
  check("the tombstone SURVIVED", Boolean(shas[s.shaDoomed]), `kept=${Boolean(shas[s.shaDoomed])}`);
  check("the live pointer is untouched", Object.values(shas).some((d) => d.split(path.sep).join("/") === s.ownLive));
  check("no document was copied or removed by the prune", h.countFiles() === before + 1, `${before} -> ${h.countFiles()} (+1 is the index backup)`);

  // THE POINT, in its current form: the history pass writes nothing, because the CONTENT is held —
  // it repoints instead. (Before the content check landed, what stopped the write was the kept
  // tombstone; this assertion passed for that reason and now passes for a better one.)
  const after = h.countFiles();
  const c = h.sweepRepos({ history: true });
  check("after the prune the history pass re-creates NOTHING, because the content is held",
    c.recovered === 0 && h.countFiles() === after, `recovered=${c.recovered} repointed=${c.repointed} files ${after} -> ${h.countFiles()}`);
}

// ── THE BREAK: an unguarded prune resurrects a document the owner had removed ────────────────────
{
  const h = await makeHarness("unguarded", true);
  const s = await setUp(h);
  const got = h.prunePointers({ apply: true });
  check("BREAK: the unguarded prune drops BOTH dead pointers", got.pruned === 2 && got.keptAsTombstone === 0, JSON.stringify(got));
  const gone = !h.readIx().shas["HARNESS - repo"][s.shaDoomed];
  check("BREAK: the tombstone is gone", gone);

  const before = h.countFiles();
  const c = h.sweepRepos({ history: true });
  // This is the assertion that changed: with recoverDeleted asking by content, dropping every dead
  // pointer no longer resurrects anything. The resurrection itself is still watched firing — in
  // test-history-guard.mjs, against the variant that writes without looking.
  check("an unguarded prune no longer resurrects a document, because the content check catches it",
    c.recovered === 0 && h.countFiles() === before, `recovered=${c.recovered} repointed=${c.repointed} files ${before} -> ${h.countFiles()}`);
}

console.log(`      harness left in place at ${RUN}`);
console.log(failed === 0 ? "\nALL PRUNE TESTS PASS" : `\n${failed} PRUNE TEST(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
