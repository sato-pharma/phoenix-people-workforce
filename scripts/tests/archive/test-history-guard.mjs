// recoverDeleted's two guards: existence-checked, but never deciding a WRITE on existence alone.
//
// Two failures sit one step apart, and a fix for either one alone causes the other:
//
//   A. `if (blobs[blob])` without an existence check — a document git history shows was deleted,
//      whose archive copy has gone, is reported ALREADY HELD for ever and never recovered. The
//      archive silently holds nothing, which is the one thing it exists not to do.
//   B. existence-checking it and writing on the result — the 2026-09-20 de-duplication removed ~945
//      of those copies and kept the content in the day folders, so a dead pointer usually means
//      "the content moved", and writing would put back the duplicates the owner had removed.
//
// The shipped answer: a dead pointer asks the archive BY CONTENT, and only when the content is
// nowhere does it write. Both failures are watched here, each against a copy of the production
// script with one string reverted. NOTHING IS EVER DELETED — copies are RENAMED aside.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const SP = path.join(os.tmpdir(), "phx-archive-tests").split(path.sep).join("/");
const SRC = "C:/Users/satoh/.claude/scripts";
const RUN = `${SP}/harness-history/${new Date().toISOString().replace(/[:.]/g, "-")}`;
const ARCHIVE_CONST = "export const ARCHIVE = 'F:/Claude Scratchpad Archive';";

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
  if (!ok) failed++;
};

const REVERT = {
  // A: the guard goes back to trusting the recorded path.
  trustsPath: [
    ["if (blobs[blob] && fs.existsSync(blobs[blob])) { counts.alreadyHeld++; return; }", "if (blobs[blob]) { counts.alreadyHeld++; return; }"],
    ["      const recorded = shas[sha];\n      if (recorded && fs.existsSync(recorded)) { blobs[blob] = recorded; counts.alreadyHeld++; return; }",
      "      if (shas[sha]) { blobs[blob] = shas[sha]; counts.alreadyHeld++; return; }"],
  ],
  // B: existence-checked, but a dead pointer goes straight to the write.
  writesWithoutLooking: [
    ["      const elsewhere = findInArchive(out.stdout.length, sha);\n      if (elsewhere) { blobs[blob] = elsewhere; shas[sha] = elsewhere; counts.repointed++; return; }",
      "      void findInArchive;"],
  ],
};

const makeHarness = async (name, revert = null) => {
  const H = `${RUN}/${name}/code`;
  const ARCH = `${RUN}/${name}/archive`;
  const REPO = `${RUN}/${name}/repo`;
  fs.mkdirSync(H, { recursive: true });
  fs.mkdirSync(`${ARCH}/svg/2026-09-19`, { recursive: true }); // a day folder, like the real archive
  fs.mkdirSync(`${REPO}/docs`, { recursive: true });

  const sa = fs.readFileSync(`${SRC}/scratchpad-archive.mjs`, "utf8");
  fs.writeFileSync(`${H}/scratchpad-archive.mjs`, sa.replace(ARCHIVE_CONST, `export const ARCHIVE = '${ARCH}';`));
  let ra = fs.readFileSync(`${SRC}/repo-archive.mjs`, "utf8");
  if (revert) {
    for (const [from, to] of REVERT[revert]) {
      const n = ra.split(from).length - 1;
      if (n !== 1) throw new Error(`${revert}: expected 1 match of "${from.slice(0, 44)}", found ${n}`);
      ra = ra.replace(from, to);
    }
  }
  fs.writeFileSync(`${H}/repo-archive.mjs`, ra);

  const git = (...args) =>
    execFileSync("git", ["-C", REPO, "-c", "user.name=Harness", "-c", "user.email=harness@local", ...args], { stdio: "pipe" });
  execFileSync("git", ["init", "-q", REPO], { stdio: "pipe" });

  const body = (tag) => `<svg xmlns="http://www.w3.org/2000/svg"><!-- ${tag} ${crypto.randomUUID()} --></svg>`;
  const docs = { lost: body("lost"), moved: body("moved") };
  for (const [f, text] of Object.entries(docs)) fs.writeFileSync(`${REPO}/docs/${f}.svg`, text);
  git("add", "-A");
  git("commit", "-qm", "two documents");
  // Out of the tree without destroying anything: the path leaves the index, the file is renamed aside.
  for (const f of Object.keys(docs)) {
    git("rm", "-q", "--cached", `docs/${f}.svg`);
    fs.renameSync(`${REPO}/docs/${f}.svg`, `${RUN}/${name}/aside-tree-${f}.svg`);
  }
  git("commit", "-qm", "both retired");

  fs.writeFileSync(
    `${ARCH}/_repos.json`,
    JSON.stringify([{ dir: REPO.split("/").join("\\"), main: REPO.split("/").join("\\"), worktree: false, label: "HARNESS - repo" }]),
  );
  const mod = await import(`file:///${H}/repo-archive.mjs`);
  const countFiles = () => {
    let n = 0;
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(`${d}/${e.name}`) : n++; };
    walk(ARCH);
    return n;
  };
  const readIx = () => JSON.parse(fs.readFileSync(`${ARCH}/_repo-index.json`, "utf8"));
  const recoveredPath = (f) => `${ARCH}/_by-source/svg/_repos-deleted-in-git/HARNESS - repo/docs/${f}.svg`;
  return { ...mod, ARCH, RUN: `${RUN}/${name}`, docs, countFiles, readIx, recoveredPath, label: "HARNESS - repo" };
};

/**
 * Both documents are recovered from history, then both copies leave their recorded path — one with
 * its content kept in a day folder (the de-duplication), one with its content nowhere at all.
 */
const setUp = (h) => {
  const first = h.sweepRepos({ history: true });
  const ok = first?.recovered === 2 && fs.existsSync(h.recoveredPath("lost")) && fs.existsSync(h.recoveredPath("moved"));
  // "moved": the de-duplication — the content survives in a day folder under another name.
  fs.copyFileSync(h.recoveredPath("moved"), `${h.ARCH}/svg/2026-09-19/moved.svg`);
  fs.renameSync(h.recoveredPath("moved"), `${h.RUN}/aside-archived-moved.svg`);
  // "lost": the copy leaves the archive entirely, and its content is held nowhere.
  fs.renameSync(h.recoveredPath("lost"), `${h.RUN}/aside-archived-lost.svg`);
  return { ok, recovered: first?.recovered ?? 0 };
};

// ── shipped behaviour ────────────────────────────────────────────────────────────────────────────
{
  const h = await makeHarness("shipped");
  const s = setUp(h);
  check("setup: the history pass recovered both documents", s.ok, `recovered=${s.recovered}`);
  const before = h.countFiles();

  const c = h.sweepRepos({ history: true });
  check("the document held NOWHERE is written back", c.recovered === 1 && fs.existsSync(h.recoveredPath("lost")), JSON.stringify(c));
  check("the de-duplicated one is NOT written again — its pointer is corrected instead", c.repointed === 1, `repointed=${c.repointed}`);
  check("so exactly one file appeared, not two", h.countFiles() === before + 1, `${before} -> ${h.countFiles()}`);
  const blobDests = Object.values(h.readIx().gitBlobs[h.label] ?? {}).map((d) => d.split(path.sep).join("/"));
  check("the corrected pointer names the day folder, where the content actually is",
    blobDests.some((d) => d === `${h.ARCH}/svg/2026-09-19/moved.svg`), blobDests.join(" | ").slice(0, 150));

  const again = h.sweepRepos({ history: true });
  check("a second pass writes nothing and repoints nothing", again.recovered === 0 && again.repointed === 0, JSON.stringify(again));
}

// ── BREAK A: the guard trusts the recorded path, so a lost document stays lost ───────────────────
{
  const h = await makeHarness("trusts-path", "trustsPath");
  setUp(h);
  const before = h.countFiles();
  const c = h.sweepRepos({ history: true });
  check("BREAK A fires: the old guard calls BOTH already held and recovers nothing",
    c.recovered === 0 && c.alreadyHeld === 2 && h.countFiles() === before, JSON.stringify(c));
  check("BREAK A fires: the document held nowhere is STILL held nowhere", !fs.existsSync(h.recoveredPath("lost")));
}

// ── BREAK B: existence-checked but writing blind, so the de-duplication is undone ────────────────
{
  const h = await makeHarness("writes-blind", "writesWithoutLooking");
  setUp(h);
  const before = h.countFiles();
  const c = h.sweepRepos({ history: true });
  check("BREAK B fires: it writes BOTH back, re-creating the de-duplicated copy",
    c.recovered === 2 && h.countFiles() === before + 2, JSON.stringify(c));
  check("BREAK B fires: the copy the owner had removed is back at its old path", fs.existsSync(h.recoveredPath("moved")));
}

console.log(`      harness left in place at ${RUN}`);
console.log(failed === 0 ? "\nALL HISTORY GUARD TESTS PASS" : `\n${failed} HISTORY GUARD TEST(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
