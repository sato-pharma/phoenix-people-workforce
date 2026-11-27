// Does the delete guard refuse a wipe that would take the last copy of a document?
//
// Run against the PRODUCTION guard and the PRODUCTION archiver, with only their archive root and
// each other's paths redirected into a throwaway folder, so the real archive is never touched and
// the logic under test is the shipped logic. Every run gets its own directory and nothing is deleted:
// the files this makes are protected document types.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";

const SP = path.join(os.tmpdir(), "phx-archive-tests").split(path.sep).join("/");
const SRC = "C:/Users/satoh/.claude/scripts";
const HOOKS = "C:/Users/satoh/.claude/hooks";
// 🔴 NOT under the session scratchpad. The guard sweeps a scratchpad too, so a fixture living
// there gets archived by THAT sweep and the document is held after all — the first version of
// this test put it there and watched its own break fail to fire. "claude" and "scratchpad" must
// not appear in this path, or touchesScratch picks it up.
const RUN = path.join(os.tmpdir(), "phx-guard-harness", new Date().toISOString().replace(/[:.]/g, "-"))
  .split(path.sep).join("/");
const H = `${RUN}/code`;
const ARCH = `${RUN}/archive`;
const REPO = `${RUN}/repo`;

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
  if (!ok) failed++;
};

fs.mkdirSync(H, { recursive: true });
fs.mkdirSync(ARCH, { recursive: true });
fs.mkdirSync(`${REPO}/docs`, { recursive: true });

// ── the harness: production files, redirected ────────────────────────────────────────────────
const sa = fs.readFileSync(`${SRC}/scratchpad-archive.mjs`, "utf8");
const saOut = sa.replace("export const ARCHIVE = 'F:/Claude Scratchpad Archive';", `export const ARCHIVE = '${ARCH}';`);
check("harness: the archive root is redirected", saOut !== sa);
fs.writeFileSync(`${H}/scratchpad-archive.mjs`, saOut);

const ra = fs.readFileSync(`${SRC}/repo-archive.mjs`, "utf8");
fs.writeFileSync(`${H}/repo-archive.mjs`, ra);
check("harness: the archiver is byte-identical to production", fs.readFileSync(`${H}/repo-archive.mjs`, "utf8") === ra);

const g = fs.readFileSync(`${HOOKS}/scratchpad-guard.mjs`, "utf8");
const gOut = g
  .replace("const ARCHIVER = 'C:/Users/satoh/.claude/scripts/scratchpad-archive.mjs';", `const ARCHIVER = '${H}/scratchpad-archive.mjs';`)
  .replace("const REPO_ARCHIVER = 'C:/Users/satoh/.claude/scripts/repo-archive.mjs';", `const REPO_ARCHIVER = '${H}/repo-archive.mjs';`)
  .replace("const LOG = 'F:/Claude Scratchpad Archive/_archive.log';", `const LOG = '${RUN}/guard.log';`);
const changed = g.split("\n").filter((l, i) => l !== gOut.split("\n")[i]).length;
check("harness: exactly three lines of the guard differ (both archivers and the log)", changed === 3, `${changed} line(s)`);
fs.writeFileSync(`${H}/scratchpad-guard.mjs`, gOut);

// ── a repository holding one document that exists nowhere else in the world ─────────────────
const unique = `<svg xmlns="http://www.w3.org/2000/svg"><!-- ${crypto.randomUUID()} --></svg>`;
fs.writeFileSync(`${REPO}/docs/handover.svg`, unique);
execFileSync("git", ["init", "-q", REPO], { stdio: "pipe" });
fs.writeFileSync(`${ARCH}/_repos.json`, JSON.stringify(
  [{ dir: REPO.split("/").join("\\"), main: REPO.split("/").join("\\"), worktree: false, label: "HARNESS - repo" }]));

const { sweepRepos } = await import(`file:///${H}/repo-archive.mjs`);
const DEST = `${ARCH}/_by-source/svg/_repos/HARNESS - repo/docs/handover.svg`;
check("setup: the sweep archived the document", sweepRepos({})?.copied === 1 && fs.existsSync(DEST));

// ── the guard, asked about a wipe ────────────────────────────────────────────────────────────
const askGuard = (command) => {
  const r = spawnSync(process.execPath, [`${H}/scratchpad-guard.mjs`, "pre"], {
    input: JSON.stringify({ cwd: REPO, tool_input: { command } }),
    encoding: "utf8",
  });
  const out = String(r.stdout ?? "").trim();
  if (!out) return { decision: "allow", reason: "", stderr: String(r.stderr ?? "") };
  try {
    const j = JSON.parse(out);
    return {
      decision: j.hookSpecificOutput?.permissionDecision ?? "allow",
      reason: j.hookSpecificOutput?.permissionDecisionReason ?? "",
      stderr: String(r.stderr ?? ""),
    };
  } catch {
    return { decision: "unparseable", reason: out.slice(0, 200), stderr: String(r.stderr ?? "") };
  }
};

const WIPE = `git worktree remove "${REPO}"`;

// 1. Everything is held: the wipe must go through, and the hook must print nothing at all.
let r = askGuard(WIPE);
check("held: the wipe is allowed", r.decision === "allow", `${r.decision} ${r.reason.slice(0, 60)}`);
check("held: the hook printed nothing on stdout (quiet mode holds)", r.reason === "", r.reason.slice(0, 80));

// 2. THE BREAK: the archived copy is moved aside, which is exactly what the de-duplication did to
//    332 real documents — except this content exists nowhere else, so the document is truly unheld.
//    The sweep inside the guard will NOT re-copy it: the stat cache sees an unchanged file.
const ASIDE = `${RUN}/moved-aside-handover.svg`;
fs.renameSync(DEST, ASIDE);
r = askGuard(WIPE);
check("BREAK fires: the wipe is DENIED", r.decision === "deny", r.decision);
check("BREAK fires: the reason names the document", /handover\.svg/.test(r.reason), r.reason.slice(0, 100));
check("BREAK fires: the reason says it is held nowhere else", /held NOWHERE ELSE/.test(r.reason));
check("BREAK fires: and tells the reader how to clear it", /--verify --repo/.test(r.reason));

// 3. A per-file delete of something unprotected must NOT pay for this check or be denied by it.
r = askGuard(`rm "${REPO}/docs/notes.txt"`);
check("an unprotected per-file delete is untouched", r.decision === "allow", r.decision);

// 4. Restored: the wipe goes through again.
fs.renameSync(ASIDE, DEST);
r = askGuard(WIPE);
check("restored: the wipe is allowed again", r.decision === "allow", r.decision);

// 5. The deny must be a positive finding only — never the fallout of an error. A broken archiver
//    path makes the import throw, and the guard's catch has to FAIL OPEN.
const broken = gOut.replace(`const REPO_ARCHIVER = '${H}/repo-archive.mjs';`, `const REPO_ARCHIVER = '${H}/no-such-archiver.mjs';`);
fs.writeFileSync(`${H}/scratchpad-guard-broken.mjs`, broken);
const rb = spawnSync(process.execPath, [`${H}/scratchpad-guard-broken.mjs`, "pre"], {
  input: JSON.stringify({ cwd: REPO, tool_input: { command: WIPE } }), encoding: "utf8",
});
check("an error in the check FAILS OPEN, it does not deny", String(rb.stdout ?? "").trim() === "", String(rb.stdout ?? "").slice(0, 80));
check("and the failure is logged, not swallowed",
  fs.existsSync(`${RUN}/guard.log`) && /pre-hook error \(failed open\)/.test(fs.readFileSync(`${RUN}/guard.log`, "utf8")));

console.log(`      harness left in place at ${RUN}`);
console.log(failed === 0 ? "\nALL GUARD TESTS PASS" : `\n${failed} GUARD TEST(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
