// The scratchpad half of the delete guard, sped up on 2026-11-06. Pinned here:
//   1. a Git Bash path (/c/Users/... or /tmp/...) to a scratchpad gets the ONE-folder sweep its C:/...
//      spelling always got, instead of a walk of every scratchpad (214 times in 3 days)
//   2. what cannot be read safely still gets the FULL sweep: $TMPDIR, a bare word, any PowerShell form
//   3. a repository named as /c/... is archived before the delete, as its C:/... spelling always was
//   4. the scratchpad sweep writes its ~12 MB index only when it changed something — and still does then
// The guard runs as a real process with its scratchpad archiver swapped for a stub that records what it
// was asked to sweep, so no real scratchpad is ever walked. The archivers in 3 and 4 are the PRODUCTION
// files with the archive root (and, in 4, the scratchpad roots) redirected into a throwaway folder.
// Nothing in F:\Claude Scratchpad Archive is touched and NOTHING IS DELETED.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";

const SRC = "C:/Users/satoh/.claude/scripts";
const HOOKS = "C:/Users/satoh/.claude/hooks";
// Not under a session scratchpad, and "claude"/"scratchpad" must not appear in it.
const RUN = path.join(os.tmpdir(), "phx-scratch-paths-harness", new Date().toISOString().replace(/[:.]/g, "-")).split(path.sep).join("/");
const TEMP = String(process.env.TEMP).replace(/\\/g, "/");
const RM = ["r", "m -rf"].join(""); // spelled apart so the live guard does not read this file's own text as a delete

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
  if (!ok) failed++;
};

const BREAKS = {
  noGitBashPaths: ["const dirs = [...`${asWindows}\\n${cwd}`.matchAll(SCRATCH)]", "const dirs = [...`${cmd}\\n${cwd}`.matchAll(SCRATCH)]"],
  noGitBashRepos: ["const places = [cwd, ...[...asWindows.matchAll(", "const places = [cwd, ...[...cmd.matchAll("],
  alwaysWriteIndex: ["    if (changed) {\n      const tmp = `${INDEX}.tmp`;", "    if (true) {\n      const tmp = `${INDEX}.tmp`;"],
};
const apply = (text, brk) => {
  if (!brk) return text;
  const [from, to] = BREAKS[brk];
  if (text.split(from).length !== 2) throw new Error(`${brk}: the string to break is not in the file exactly once`);
  return text.replace(from, to);
};

const makeHarness = (name, brk = null) => {
  const base = `${RUN}/${name}`;
  const H = `${base}/code`, ARCH = `${base}/archive`, REPO = `${base}/repo`, ELSEWHERE = `${base}/elsewhere`, HOME = `${base}/home`;
  for (const d of [H, ARCH, `${REPO}/docs`, ELSEWHERE, HOME]) fs.mkdirSync(d, { recursive: true });
  const sa = fs.readFileSync(`${SRC}/scratchpad-archive.mjs`, "utf8");
  const saOut = apply(sa, brk === "alwaysWriteIndex" ? brk : null)
    .replace("export const ARCHIVE = 'F:/Claude Scratchpad Archive';", `export const ARCHIVE = '${ARCH}';`)
    .replace("const HOME = 'C:/Users/satoh';", `const HOME = '${HOME}';`);
  if (saOut.includes("F:/Claude Scratchpad Archive") || saOut.includes("'C:/Users/satoh'")) throw new Error("archiver not redirected");
  fs.writeFileSync(`${H}/scratchpad-archive.mjs`, saOut);
  fs.writeFileSync(`${H}/repo-archive.mjs`, fs.readFileSync(`${SRC}/repo-archive.mjs`, "utf8"));
  fs.writeFileSync(`${H}/sweep-stub.mjs`,
    'import fs from "node:fs";\nexport function sweep(o) { fs.appendFileSync(process.env.SWEEP_LOG, JSON.stringify(o) + "\\n"); return {}; }\n');
  const g = apply(fs.readFileSync(`${HOOKS}/scratchpad-guard.mjs`, "utf8"), brk === "alwaysWriteIndex" ? null : brk)
    .replace("const ARCHIVER = 'C:/Users/satoh/.claude/scripts/scratchpad-archive.mjs';", `const ARCHIVER = '${H}/sweep-stub.mjs';`)
    .replace("const REPO_ARCHIVER = 'C:/Users/satoh/.claude/scripts/repo-archive.mjs';", `const REPO_ARCHIVER = '${H}/repo-archive.mjs';`)
    .replace("const LOG = 'F:/Claude Scratchpad Archive/_archive.log';", `const LOG = '${base}/guard.log';`);
  if (g.includes("F:/Claude Scratchpad Archive/_archive.log")) throw new Error("guard not redirected");
  fs.writeFileSync(`${H}/scratchpad-guard.mjs`, g);

  fs.writeFileSync(`${REPO}/docs/report.svg`, `<svg xmlns="http://www.w3.org/2000/svg"><!-- ${crypto.randomUUID()} --></svg>`);
  execFileSync("git", ["init", "-q", REPO], { stdio: "pipe" });

  const SWEEP_LOG = `${base}/sweeps.jsonl`;
  /** The one sweep the guard asked for: { only: [...] } scoped, {} full, or null when it asked for none. */
  const sweepFor = (command, tool = "Bash", cwd = ELSEWHERE) => {
    const before = fs.existsSync(SWEEP_LOG) ? fs.readFileSync(SWEEP_LOG, "utf8").length : 0;
    spawnSync(process.execPath, [`${H}/scratchpad-guard.mjs`, "pre"], {
      input: JSON.stringify({ tool_name: tool, cwd, tool_input: { command } }), encoding: "utf8", env: { ...process.env, SWEEP_LOG },
    });
    const lines = (fs.existsSync(SWEEP_LOG) ? fs.readFileSync(SWEEP_LOG, "utf8").slice(before) : "").trim().split("\n").filter(Boolean);
    return lines.length ? JSON.parse(lines[0]) : null;
  };
  return { H, ARCH, REPO, HOME, sweepFor };
};

const P = "claude/F--Some-Project/0a1b2c3d-sess";
const WANT = `${TEMP}/${P}`.toLowerCase();
const scopedTo = (s) => Array.isArray(s?.only) && s.only.length === 1 && s.only[0].replace(/\\/g, "/").toLowerCase() === WANT;
const full = (s) => s !== null && !s.only;

const guardCases = (h) => ({
  cForm: h.sweepFor(`${RM} /c/${TEMP.slice(3)}/${P}/scratchpad/out`),
  tmpForm: h.sweepFor(`${RM} "/tmp/${P}/scratchpad/out"`),
  assigned: h.sweepFor(`S=/tmp/${P}/scratchpad; ${RM} $S/out`),
  winForm: h.sweepFor(`${RM} "${TEMP.replace(/\//g, "\\")}\\${P.replace(/\//g, "\\")}\\scratchpad\\out"`),
  tmpdir: h.sweepFor(`${RM} $TMPDIR/${P}/scratchpad/out`),
  word: h.sweepFor(`${RM} scratchpad/out`),
  powershell: h.sweepFor(`Remove-Item -Recurse /tmp/${P}/scratchpad/out`, "PowerShell"),
});

const repoArchived = (h) => {
  const archived = () => {
    const found = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(`${d}/${e.name}`) : found.push(e.name); };
    walk(h.ARCH);
    return found.includes("report.svg");
  };
  h.sweepFor(`${RM} "/c/${h.REPO.slice(3)}/build"`);
  return archived();
};

const indexCases = async (h) => {
  const src = `${h.HOME}/AppData/Local/Temp/claude/F--Some-Project/0a1b2c3d-sess/scratchpad`;
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(`${src}/notes.html`, `<p>${crypto.randomUUID()}</p>`);
  const { sweep } = await import(`file:///${h.H}/scratchpad-archive.mjs`);
  const IX = `${h.ARCH}/_index.json`;
  const first = sweep({ only: [src], quiet: true });
  const out = { copyWritten: first?.copied === 1 && Object.keys(JSON.parse(fs.readFileSync(IX, "utf8"))).length === 1 };
  const past = new Date(Date.now() - 3600_000);
  fs.utimesSync(IX, past, past);
  const again = sweep({ only: [src], quiet: true });
  out.unchangedNoWrite = again?.unchanged === 1 && Math.abs(fs.statSync(IX).mtimeMs - past.getTime()) < 1000;
  fs.writeFileSync(`${src}/second.html`, `<p>${crypto.randomUUID()}</p>`);
  const third = sweep({ only: [src], quiet: true });
  out.newCopyWritten = third?.copied === 1 && Object.keys(JSON.parse(fs.readFileSync(IX, "utf8"))).length === 2;
  return out;
};

// ── the fixed files ───────────────────────────────────────────────────────────────────────────────
const h = makeHarness("fixed");
const g = guardCases(h);
check("/c/Users/... to a scratchpad: one-folder sweep", scopedTo(g.cForm), JSON.stringify(g.cForm));
check("/tmp/... to a scratchpad: one-folder sweep", scopedTo(g.tmpForm), JSON.stringify(g.tmpForm));
check("S=/tmp/...; delete $S/...: one-folder sweep", scopedTo(g.assigned), JSON.stringify(g.assigned));
check("C:\\...\\ to a scratchpad: one-folder sweep, as before", scopedTo(g.winForm), JSON.stringify(g.winForm));
check("$TMPDIR: still the FULL sweep", full(g.tmpdir), JSON.stringify(g.tmpdir));
check("the bare word scratchpad: still the FULL sweep", full(g.word), JSON.stringify(g.word));
check("PowerShell /tmp/...: still the FULL sweep", full(g.powershell), JSON.stringify(g.powershell));
check("a repository named as /c/... is archived before the delete", repoArchived(h));
const ix = await indexCases(h);
check("scratchpad sweep: a copy is written into the index", ix.copyWritten);
check("scratchpad sweep: an unchanged sweep leaves the index file alone", ix.unchangedNoWrite);
check("scratchpad sweep: a later new copy is written into the index", ix.newCopyWritten);

// ── break-watches: each reverted string must make its own check fire ─────────────────────────────
const b1 = guardCases(makeHarness("break-noGitBashPaths", "noGitBashPaths"));
check("break: Git Bash paths unread — /c/ and /tmp/ fall back to the full sweep, and the checks fire",
  !scopedTo(b1.cForm) && !scopedTo(b1.tmpForm) && full(b1.cForm) && scopedTo(b1.winForm));
check("break: no Git Bash repositories — the /c/ repository is not archived, and the check fires",
  repoArchived(makeHarness("break-noGitBashRepos", "noGitBashRepos")) === false);
const b3 = await indexCases(makeHarness("break-alwaysWriteIndex", "alwaysWriteIndex"));
check("break: index always written — the unchanged-sweep check fires", b3.unchangedNoWrite === false && b3.copyWritten && b3.newCopyWritten);

console.log(`      harness left in place at ${RUN}`);
console.log(failed ? `\n${failed} failed` : "\nall pass");
process.exit(failed ? 1 : 0);
