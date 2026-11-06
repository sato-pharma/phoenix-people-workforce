// While ANOTHER sweep holds the lock, does the delete guard still archive before a wipe?
//
// The gap (closed 2026-11-06): the guard's own sweep was skipped whenever another sweep held the
// lock, so a document added or edited since the last sweep was archived by nothing before a
// worktree removal — and verify could not see it (new reads "unswept", edited finds its old copy).
// Now archiveUnlocked copies those documents without touching the index, and a copy that fails
// makes the wipe DENIED.
//
// Run against the PRODUCTION guard and archiver, redirected into a throwaway folder exactly as
// test-guard-verify does. Nothing in F:\Claude Scratchpad Archive is touched and NOTHING IS DELETED.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";

const SRC = "C:/Users/satoh/.claude/scripts";
const HOOKS = "C:/Users/satoh/.claude/hooks";
// Not under a session scratchpad: the guard sweeps those too ("claude"/"scratchpad" must not appear).
const RUN = path.join(os.tmpdir(), "phx-busy-lock-harness", new Date().toISOString().replace(/[:.]/g, "-")).split(path.sep).join("/");

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
  if (!ok) failed++;
};

// The strings the fix added to the guard; each break-watch removes one.
const BREAKS = {
  loudSweep: ["sweepRepos({ only: [...repos.values()], quiet: true })", "sweepRepos({ only: [...repos.values()] })"],
  noFallback: ["=== null) unlocked = archiveUnlocked({ only: [...repos.values()] });", "=== null) unlocked = null;"],
  noDeny: ["if (wipes && unlocked?.failed.length) {", "if (false) {"],
};

const makeHarness = (name, brk = null) => {
  const base = `${RUN}/${name}`;
  const H = `${base}/code`, ARCH = `${base}/archive`, REPO = `${base}/repo`, ASIDE = `${base}/aside`;
  for (const d of [H, ARCH, `${REPO}/docs`, `${REPO}/blocked`, ASIDE]) fs.mkdirSync(d, { recursive: true });
  const sa = fs.readFileSync(`${SRC}/scratchpad-archive.mjs`, "utf8");
  const saOut = sa.replace("export const ARCHIVE = 'F:/Claude Scratchpad Archive';", `export const ARCHIVE = '${ARCH}';`);
  if (saOut === sa) throw new Error("archive root not redirected");
  fs.writeFileSync(`${H}/scratchpad-archive.mjs`, saOut);
  fs.writeFileSync(`${H}/repo-archive.mjs`, fs.readFileSync(`${SRC}/repo-archive.mjs`, "utf8"));
  let g = fs.readFileSync(`${HOOKS}/scratchpad-guard.mjs`, "utf8")
    .replace("const ARCHIVER = 'C:/Users/satoh/.claude/scripts/scratchpad-archive.mjs';", `const ARCHIVER = '${H}/scratchpad-archive.mjs';`)
    .replace("const REPO_ARCHIVER = 'C:/Users/satoh/.claude/scripts/repo-archive.mjs';", `const REPO_ARCHIVER = '${H}/repo-archive.mjs';`)
    .replace("const LOG = 'F:/Claude Scratchpad Archive/_archive.log';", `const LOG = '${base}/guard.log';`);
  if (brk) {
    const [from, to] = BREAKS[brk];
    if (g.split(from).length !== 2) throw new Error(`${brk}: the string to break is not in the guard exactly once`);
    g = g.replace(from, to);
  }
  fs.writeFileSync(`${H}/scratchpad-guard.mjs`, g);

  const svg = () => `<svg xmlns="http://www.w3.org/2000/svg"><!-- ${crypto.randomUUID()} --></svg>`;
  fs.writeFileSync(`${REPO}/docs/plan.svg`, svg());
  execFileSync("git", ["init", "-q", REPO], { stdio: "pipe" });

  const ask = (command) => {
    const r = spawnSync(process.execPath, [`${H}/scratchpad-guard.mjs`, "pre"], { input: JSON.stringify({ cwd: REPO, tool_input: { command } }), encoding: "utf8" });
    const out = String(r.stdout ?? "").trim();
    if (!out) return { decision: "allow", reason: "" };
    // Anything but the decision JSON on stdout makes Claude Code drop the decision — a deny included.
    try {
      const j = JSON.parse(out).hookSpecificOutput ?? {};
      return { decision: j.permissionDecision ?? "allow", reason: j.permissionDecisionReason ?? "" };
    } catch {
      return { decision: "unparseable", reason: out.slice(0, 120) };
    }
  };
  return { H, ARCH, REPO, ASIDE, ask, svg, LOCK: `${ARCH}/_repo-sweep.lock`, IX: `${ARCH}/_repo-index.json`, WIPE: `git worktree remove "${REPO}"` };
};

const scenario = async (name, brk) => {
  const h = makeHarness(name, brk);
  const { sweepRepos, repoFor } = await import(`file:///${h.H}/repo-archive.mjs`);
  // The guard files a tree under the label repoFor gives it; the setup sweep must use the same one.
  const tree = repoFor(h.REPO);
  fs.writeFileSync(`${h.ARCH}/_repos.json`, JSON.stringify([tree]));
  h.ownDir = `${h.ARCH}/_by-source/svg/_repos/${tree.label}`;
  const out = { setup: sweepRepos({})?.copied === 1 && fs.existsSync(`${h.ownDir}/docs/plan.svg`) };
  const ixBefore = fs.readFileSync(h.IX, "utf8");

  // Another sweep is running.
  fs.writeFileSync(h.LOCK, "another sweep", { flag: "wx" });
  // Since the last sweep: one new document, and one edited.
  fs.writeFileSync(`${h.REPO}/docs/fresh.svg`, h.svg());
  const edited = h.svg();
  fs.writeFileSync(`${h.REPO}/docs/plan.svg`, edited);

  const r1 = h.ask(h.WIPE);
  out.allowed = r1.decision === "allow";
  out.freshCopied = fs.existsSync(`${h.ownDir}/docs/fresh.svg`);
  out.editCopied = fs.readdirSync(`${h.ownDir}/docs`).some((f) => /^plan\.v\d{8}-\d{6}(-\d+)?\.svg$/.test(f) &&
    fs.readFileSync(`${h.ownDir}/docs/${f}`, "utf8") === edited);
  out.indexUntouched = fs.readFileSync(h.IX, "utf8") === ixBefore;
  out.lockKept = fs.readFileSync(h.LOCK, "utf8") === "another sweep";

  // A copy that cannot be made: a FILE sits where the document's archive folder must go.
  fs.writeFileSync(`${h.ownDir}/blocked`, "a file where a folder must be");
  fs.writeFileSync(`${h.REPO}/blocked/stuck.svg`, h.svg());
  const r2 = h.ask(h.WIPE);
  out.failDenied = r2.decision === "deny" && /stuck\.svg/.test(r2.reason);
  const r3 = h.ask(`rm "${h.REPO}/docs/notes.txt"`);
  out.plainDeleteAllowed = r3.decision === "allow";

  fs.renameSync(h.LOCK, `${h.ASIDE}/_repo-sweep.lock`);
  return out;
};

const fixed = await scenario("fixed");
check("setup: the first sweep archived the document", fixed.setup);
check("lock held: the wipe of a fully copyable tree is allowed", fixed.allowed);
check("lock held: a document added since the last sweep is copied before the wipe", fixed.freshCopied);
check("lock held: a document edited since the last sweep has its new content copied", fixed.editCopied);
check("lock held: the index is not written (the running sweep owns it)", fixed.indexUntouched);
check("lock held: the other sweep's lock is left alone", fixed.lockKept);
check("lock held: a document that cannot be copied makes the wipe DENIED, naming it", fixed.failDenied);
check("lock held: an unprotected per-file delete is still allowed", fixed.plainDeleteAllowed);

const a = await scenario("break-noFallback", "noFallback");
check("break: no fallback — the new document is NOT copied, and the check fires", a.freshCopied === false && a.editCopied === false);
const b = await scenario("break-noDeny", "noDeny");
check("break: no deny — the uncopyable document's wipe goes through, and the check fires", b.failDenied === false);
const l = await scenario("break-loudSweep", "loudSweep");
check("break: the skipped sweep prints into the hook's answer — the deny is lost, and the check fires", l.failDenied === false);

console.log(`      harness left in place at ${RUN}`);
console.log(failed ? `\n${failed} failed` : "\nall pass");
process.exit(failed ? 1 : 0);
