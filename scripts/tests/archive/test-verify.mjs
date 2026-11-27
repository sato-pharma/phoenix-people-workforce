// Break-and-watch for --verify, run against the PRODUCTION code with one constant replaced.
//
// The harness copies both scripts verbatim and changes exactly one line — the archive root — so the
// logic under test is the shipped logic, and the whole test lives in a throwaway archive and a
// throwaway git repo. Nothing in F:\Claude Scratchpad Archive is read, written, moved or deleted.
//
// Every run gets its own directory and NOTHING is ever removed: the copies this test makes are
// protected document types, and the first version of it reused one archive, so the second run's
// sweep met last run's plan.svg, copyNoClobber correctly refused to overwrite it, and the test read
// back the previous content and failed four of its own assertions.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import os from "node:os";
// The racers sit beside this file; the harnesses go in a stable temp folder of their own.
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const SP = path.join(os.tmpdir(), "phx-archive-tests").split(path.sep).join("/");
fs.mkdirSync(SP, { recursive: true });
const SRC = "C:/Users/satoh/.claude/scripts";
const RUN = `${SP}/harness-v/${new Date().toISOString().replace(/[:.]/g, "-")}`;
const H = `${RUN}/code`;
const ARCH = `${RUN}/archive`;
const REPO = `${RUN}/repo`;

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
  if (!ok) failed++;
};

// --- harness: the production scripts, one constant changed -------------------------------
fs.mkdirSync(H, { recursive: true });
fs.mkdirSync(ARCH, { recursive: true });

const origConst = "export const ARCHIVE = 'F:/Claude Scratchpad Archive';";
const sa = fs.readFileSync(`${SRC}/scratchpad-archive.mjs`, "utf8");
check("harness: the archive root appears exactly once in scratchpad-archive.mjs", sa.split(origConst).length - 1 === 1);
const saPatched = sa.replace(origConst, `export const ARCHIVE = '${ARCH}';`);
fs.writeFileSync(`${H}/scratchpad-archive.mjs`, saPatched);
const ra = fs.readFileSync(`${SRC}/repo-archive.mjs`, "utf8");
fs.writeFileSync(`${H}/repo-archive.mjs`, ra);
check("harness: repo-archive.mjs is byte-identical to production",
  fs.readFileSync(`${H}/repo-archive.mjs`, "utf8") === ra);
const saLines = sa.split("\n");
const diffLines = saPatched.split("\n").filter((l, i) => l !== saLines[i]).length;
check("harness: exactly one line differs in scratchpad-archive.mjs", diffLines === 1, `${diffLines} line(s)`);

// --- a throwaway repository holding one unique document ---------------------------------
fs.mkdirSync(`${REPO}/docs`, { recursive: true });
const unique = `<svg xmlns="http://www.w3.org/2000/svg"><!-- ${crypto.randomUUID()} --></svg>`;
fs.writeFileSync(`${REPO}/docs/plan.svg`, unique);
execFileSync("git", ["init", "-q", REPO], { stdio: "pipe" });
// Hand the sweep its repo list so findRepos never walks the machine.
fs.writeFileSync(`${ARCH}/_repos.json`, JSON.stringify(
  [{ dir: REPO.split("/").join("\\"), main: REPO.split("/").join("\\"), worktree: false, label: "HARNESS - repo" }]));

const { sweepRepos, verify } = await import(`file:///${H}/repo-archive.mjs`);
const DEST = `${ARCH}/_by-source/svg/_repos/HARNESS - repo/docs/plan.svg`;

// 1. The sweep must write the _repos tree — the thing the whole fix is about.
const counts = sweepRepos({});
check("sweep copied the document", counts?.copied === 1, JSON.stringify(counts));
check("sweep wrote it to _by-source/<ext>/_repos/<label>/<path>", fs.existsSync(DEST), DEST.replace(ARCH, "<archive>"));
check("the copy is byte-identical to the source", fs.existsSync(DEST) && fs.readFileSync(DEST, "utf8") === unique);

// 2. verify must call it held.
let v = verify({ json: true });
check("verify: held at its own path, nothing lost", v.held === 1 && v.lost.length === 0, JSON.stringify(v).slice(0, 110));

// 3. THE BREAK: the archived copy is moved aside — exactly the state that fooled a session this
//    morning, except here the content exists NOWHERE else, so the document is genuinely unheld.
const ASIDE = `${RUN}/moved-aside-plan.svg`;
fs.renameSync(DEST, ASIDE);
v = verify({ json: true });
check("BREAK fires: verify reports the document LOST", v.lost.length === 1, JSON.stringify(v.lost).slice(0, 90));
check("BREAK fires: it names the file, not just a count",
  v.lost[0]?.file?.split(path.sep).join("/") === "docs/plan.svg", v.lost[0]?.file);
check("BREAK fires: it is counted as lost, not as 'held elsewhere'", v.elsewhere === 0 && v.held === 0,
  `held=${v.held} elsewhere=${v.elsewhere}`);

// 4. A copy under ANOTHER name must read as held-elsewhere, never as lost (the 332 real ones).
fs.mkdirSync(`${ARCH}/svg/2026-10-09`, { recursive: true });
fs.copyFileSync(ASIDE, `${ARCH}/svg/2026-10-09/plan (HARNESS).svg`);
v = verify({ json: true });
check("a day-folder copy reads as held elsewhere, not lost", v.elsewhere === 1 && v.lost.length === 0,
  `held=${v.held} elsewhere=${v.elsewhere} lost=${v.lost.length}`);

// 5. Put the copy back at its own path and confirm the assertion stops firing.
fs.renameSync(ASIDE, DEST);
v = verify({ json: true });
check("restored: verify is quiet again", v.held === 1 && v.lost.length === 0, `held=${v.held} lost=${v.lost.length}`);

console.log(`      harness left in place at ${RUN.replace(SP, "<scratchpad>")}`);
console.log(failed === 0 ? "\nALL VERIFY TESTS PASS" : `\n${failed} VERIFY TEST(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
