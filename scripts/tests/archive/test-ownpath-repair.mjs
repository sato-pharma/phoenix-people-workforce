// Does the archiver WRITE DOWN the own-path copy it just used?
//
// The hole this pins, measured 2026-10-09 on the real archive: 2,758 of 4,525 recorded destinations
// pointed at nothing, and 1,946 of those were documents whose own-path copy was sitting right there.
// No number of `--verify` runs could heal them, because the only repair lived in pass TWO and pass
// ONE — the arm that answers for a fully archived tree — short-circuited before reaching it. The
// sweep had the same blindness one level down: its unchanged fast path never looked at the
// destination at all, so a pointer the 2026-09-20 de-duplication killed was skipped for ever.
//
// Three holes, three break-watches, each against a copy of the PRODUCTION script with ONE string
// reverted, in its own throwaway archive and git repo. Nothing in F:\Claude Scratchpad Archive is
// read, written or touched, and NOTHING IS EVER DELETED — a copy that has to disappear is RENAMED
// aside, because every fixture here is a protected document type.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const SP = path.join(os.tmpdir(), "phx-archive-tests").split(path.sep).join("/");
const SRC = "C:/Users/satoh/.claude/scripts";
const RUN = `${SP}/harness-ownpath/${new Date().toISOString().replace(/[:.]/g, "-")}`;

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
  if (!ok) failed++;
};

const ARCHIVE_CONST = "export const ARCHIVE = 'F:/Claude Scratchpad Archive';";

// The three lines the fix added, and what the code said before it. A break-watch reverts exactly one.
const REVERT = {
  sweepFastPath: [
    [
      `      if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) {
        counts.unchanged++;`,
      `      if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) { counts.unchanged++; continue; }
      if (false) {`,
    ],
  ],
  sweepTrustsDeadPointer: [["if (shas[sha] && fs.existsSync(shas[sha]))", "if (shas[sha])"]],
  verifyPassOne: [
    [
      `      if (dest && fs.existsSync(dest)) { out.held++; continue; }
      if (fs.existsSync(expected)) {
        out.held++;`,
      `      if ((dest && fs.existsSync(dest)) || fs.existsSync(expected)) { out.held++; continue; }
      if (false) {`,
    ],
  ],
};

/** A harness: production code, the archive root redirected, one repo holding one unique document. */
const makeHarness = async (name, revert = null) => {
  const H = `${RUN}/${name}/code`;
  const ARCH = `${RUN}/${name}/archive`;
  const REPO = `${RUN}/${name}/repo`;
  fs.mkdirSync(H, { recursive: true });
  fs.mkdirSync(ARCH, { recursive: true });
  fs.mkdirSync(`${REPO}/docs`, { recursive: true });

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

  const unique = `<svg xmlns="http://www.w3.org/2000/svg"><!-- ${crypto.randomUUID()} --></svg>`;
  fs.writeFileSync(`${REPO}/docs/plan.svg`, unique);
  execFileSync("git", ["init", "-q", REPO], { stdio: "pipe" });
  fs.writeFileSync(
    `${ARCH}/_repos.json`,
    JSON.stringify([{ dir: REPO.split("/").join("\\"), main: REPO.split("/").join("\\"), worktree: false, label: "HARNESS - repo" }]),
  );

  const mod = await import(`file:///${H}/repo-archive.mjs`);
  const IX = `${ARCH}/_repo-index.json`;
  const OWN = `${ARCH}/_by-source/svg/_repos/HARNESS - repo/docs/plan.svg`;
  const readIx = () => JSON.parse(fs.readFileSync(IX, "utf8"));
  const countFiles = () => {
    let n = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(`${d}/${e.name}`) : n++;
    };
    walk(ARCH);
    return n;
  };
  // The pointer the de-duplication killed: the index names a path that no longer exists, while the
  // own-path copy stays where it is and the source file is untouched (so the sweep sees it unchanged).
  const killPointer = () => {
    const ix = readIx();
    const shas = ix.shas["HARNESS - repo"];
    const sha = Object.keys(shas)[0];
    shas[sha] = `${ARCH}/_by-source/svg/2026-09-19/plan.svg`; // a path the de-dup removed
    fs.writeFileSync(IX, JSON.stringify(ix));
    return sha;
  };
  const pointerOf = () => {
    const shas = readIx().shas["HARNESS - repo"] ?? {};
    return Object.values(shas)[0] ?? null;
  };
  return { ...mod, ARCH, REPO, OWN, readIx, countFiles, killPointer, pointerOf, src: `${REPO}/docs/plan.svg` };
};

// ── 1. THE SWEEP, unchanged fast path ────────────────────────────────────────────────────────────
{
  const h = await makeHarness("sweep-fixed");
  check("setup: the first sweep archives the document at its own path", h.sweepRepos({})?.copied === 1 && fs.existsSync(h.OWN));
  const before = h.countFiles();
  h.killPointer();
  check("setup: the pointer now names a path that does not exist", !fs.existsSync(h.pointerOf()));

  const c = h.sweepRepos({});
  check("the sweep saw the file as UNCHANGED (the fast path really is the one under test)", c.unchanged === 1, JSON.stringify(c));
  check("and it REPOINTED the index at the own-path copy", c.repointed === 1, `repointed=${c.repointed}`);
  check("the pointer is the own path, exactly", h.pointerOf()?.split(path.sep).join("/") === h.OWN, String(h.pointerOf()));
  check("nothing was copied and nothing deleted (same file count)", h.countFiles() === before, `${before} -> ${h.countFiles()}`);
}

// ── 1b. THE BREAK: without the repair, the dead pointer survives every sweep ─────────────────────
{
  const h = await makeHarness("sweep-broken", "sweepFastPath");
  h.sweepRepos({});
  const dead = h.killPointer() && h.pointerOf();
  const c = h.sweepRepos({});
  check("BREAK fires: the old fast path repoints NOTHING", !c.repointed, `repointed=${c.repointed}`);
  check("BREAK fires: and the pointer is still dead after the sweep", h.pointerOf() === dead && !fs.existsSync(h.pointerOf()));
}

// ── 2. THE SWEEP must not trust a recorded destination that is gone ──────────────────────────────
{
  const h = await makeHarness("trust-fixed");
  h.sweepRepos({});
  const aside = `${h.ARCH}/moved-aside-plan.svg`;
  fs.renameSync(h.OWN, aside); // renamed, never deleted: it is a protected type
  fs.utimesSync(h.src, new Date(), new Date(Date.now() + 2000)); // same content, new mtime
  const c = h.sweepRepos({});
  check("the archived copy is gone, so the sweep COPIES it again rather than claiming it is held",
    c.copied === 1 && c.alreadyHeld === 0 && fs.existsSync(h.OWN), JSON.stringify(c));
}
{
  const h = await makeHarness("trust-broken", "sweepTrustsDeadPointer");
  h.sweepRepos({});
  fs.renameSync(h.OWN, `${h.ARCH}/moved-aside-plan.svg`);
  fs.utimesSync(h.src, new Date(), new Date(Date.now() + 2000));
  const c = h.sweepRepos({});
  check("BREAK fires: the old code calls it ALREADY HELD while the archive holds nothing",
    c.alreadyHeld === 1 && c.copied === 0 && !fs.existsSync(h.OWN), JSON.stringify(c));
}

// ── 3. VERIFY, pass one ──────────────────────────────────────────────────────────────────────────
{
  const h = await makeHarness("verify-fixed");
  h.sweepRepos({});
  const before = h.countFiles();
  h.killPointer();
  const v = h.verify({ quiet: true });
  check("verify still reports the document held", v.held === 1 && v.lost.length === 0, JSON.stringify({ held: v.held, lost: v.lost.length }));
  check("verify repaired the pointer, and says it was an own-path one", v.repaired === 1 && v.repairedAtOwnPath === 1,
    `repaired=${v.repaired} atOwnPath=${v.repairedAtOwnPath}`);
  check("the pointer is the own path, exactly", h.pointerOf()?.split(path.sep).join("/") === h.OWN, String(h.pointerOf()));
  check("the archive was never walked (pass one answered) and nothing was copied",
    v.archiveFiles === null && h.countFiles() === before);
  const again = h.verify({ quiet: true });
  check("a second verify finds nothing left to repair", !again.repaired, `repaired=${again.repaired}`);
}
{
  const h = await makeHarness("verify-broken", "verifyPassOne");
  h.sweepRepos({});
  h.killPointer();
  const dead = h.pointerOf();
  const v = h.verify({ quiet: true });
  check("BREAK fires: the old pass one healed nothing", !v.repaired, `repaired=${v.repaired}`);
  check("BREAK fires: it reported the document held with the pointer still dead",
    v.held === 1 && h.pointerOf() === dead && !fs.existsSync(h.pointerOf()));
}

console.log(`      harness left in place at ${RUN}`);
console.log(failed === 0 ? "\nALL OWN-PATH REPAIR TESTS PASS" : `\n${failed} OWN-PATH REPAIR TEST(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
