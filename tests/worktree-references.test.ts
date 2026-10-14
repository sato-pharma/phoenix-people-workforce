import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  parseProcessProbe,
  referenceHolders,
  referenceHoldReason,
  scriptPathsIn,
  textNamesWorktree,
  worktreeNameOf,
} from "../scripts/worktree-references.mjs";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// repo-doctor --strip-idle must not empty a worktree that a PARKED job is aimed at.
//
// 2026-09-17, about 11:30 Cairo: the strip took node_modules and .next out of five worktrees it
// judged "idle 120+ minutes, clean, fully pushed". Three were still wanted:
//   - a bash chain `cd "<wt>" && node wait-for-dev-window.mjs 230 && ... next dev` had sat queued
//     since 09:44. The waiter ran in node with its cwd in the PRIMARY; only the bash process's
//     command line named the folder, so the PEB sweep never attributed it;
//   - `wait-dev-slot.mjs 8` was parked "to resume the browser checks" in another, and a scratchpad
//     `wait-live.mjs` hard-coded that folder in its SOURCE;
//   - a third was held by a live process the same run's own report listed — closed on 2026-09-28
//     by the holder gate, which this file does not re-prove.
// A sleeping process writes nothing, so 120 minutes of silence is what a finished session and a
// parked one look like alike. The only trace is TEXT, and this reads it.
// ─────────────────────────────────────────────────────────────────────────────

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

const WT = "F:/Phoenix Workforce/_wt-closing-details-publication-gate";
const NESTED = "F:/Phoenix Workforce/phoenix-workforce/.claude/worktrees/nostalgic-borg-edf506";

function probe(rows: { pid: number; name: string; commandLine: string }[]) {
  // five unrelated rows: parseProcessProbe's positive control refuses a shorter list
  const filler = [1, 2, 3, 4, 5].map((n) => ({ pid: 100 + n, name: "svchost", commandLine: "svchost.exe -k netsvcs" }));
  return { rows: [...filler, ...rows] };
}

export function runWorktreeReferencesTests() {
  // ── 1. A name matches on its boundary, not as a substring ───────────────────
  {
    assert.deepEqual(worktreeNameOf(WT), { name: "_wt-closing-details-publication-gate", nested: false });
    assert.deepEqual(worktreeNameOf(NESTED), { name: "nostalgic-borg-edf506", nested: true });
    assert.equal(worktreeNameOf("F:/Phoenix Workforce/phoenix-workforce"), null, "the primary is not a worktree");

    assert.ok(textNamesWorktree(WT, `cd "F:/Phoenix Workforce/_wt-closing-details-publication-gate" && node x.mjs`));
    assert.ok(textNamesWorktree(WT, "F:\\\\Phoenix Workforce\\\\_wt-closing-details-publication-gate\\\\src"), "JSON-escaped path");
    assert.ok(textNamesWorktree(WT, "...\\_WT-CLOSING-DETAILS-PUBLICATION-GATE"), "Windows paths are case-insensitive");
    // The repo extends a shared stem constantly: one folder's waiter must not pin its sibling.
    assert.equal(textNamesWorktree("F:/x/_wt-pharmacy", "cd /f/x/_wt-pharmacy-guard && node a.mjs"), false);
    assert.equal(textNamesWorktree("F:/x/_wt-pharmacy", "cd /f/x/_wt-pharmacy2"), false);
    assert.ok(textNamesWorktree("F:/x/_wt-pharmacy", 'cd "/f/x/_wt-pharmacy"'));
    // A nested worktree is named only under .claude/worktrees: a bare word equal to its name is not it.
    assert.ok(textNamesWorktree(NESTED, "C:\\repo\\.claude\\worktrees\\nostalgic-borg-edf506\\src"));
    assert.equal(textNamesWorktree(NESTED, "nostalgic-borg-edf506 is a fine name"), false);
  }

  // ── 2. The incident's own shapes ────────────────────────────────────────────
  {
    const chain =
      `bash -c "cd \\"${WT}\\" && node C:/Users/satoh/AppData/Local/Temp/scratchpad/wait-for-dev-window.mjs 230 ` +
      `&& PHOENIX_ENABLE_DEV_AUTH_HEADERS=true node node_modules/next/dist/bin/next dev --webpack --port 3000"`;
    const waiter = "node C:/Users/satoh/AppData/Local/Temp/scratchpad/wait-for-dev-window.mjs 230";
    const rows = probe([
      { pid: 4001, name: "bash", commandLine: chain },
      // the waiter's own line does NOT name the folder, and its source does not either
      { pid: 4002, name: "node", commandLine: waiter },
    ]);
    const held = referenceHolders(WT, rows, { readFile: () => "setTimeout(() => {}, 1000)" });
    assert.deepEqual(held.map((h) => h.pid), [4001], "the bash chain names the folder in its command line");
    assert.match(referenceHoldReason(WT, rows, { readFile: () => null }) ?? "", /bash pid 4001/);

    // wait-dev-slot.mjs: the folder is only in the SCRIPT'S SOURCE, never in a command line.
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "wt-ref-"));
    try {
      const script = path.join(scratch, "wait-live.mjs");
      fs.writeFileSync(script, `const dir = "F:/Phoenix Workforce/_wt-weekly-dashboard-owner-rules";\n`);
      const other = path.join(scratch, "unrelated.mjs");
      fs.writeFileSync(other, `console.log("nothing to see");\n`);
      const parked = probe([
        { pid: 5001, name: "node", commandLine: `node "${script}" 8` },
        { pid: 5002, name: "node", commandLine: `node ${other.replace(/\\/g, "/")}` },
      ]);
      const wd = "F:/Phoenix Workforce/_wt-weekly-dashboard-owner-rules";
      const hit = referenceHolders(wd, parked);
      assert.deepEqual(hit.map((h) => h.pid), [5001]);
      assert.match(hit[0].how, /wait-live\.mjs, whose source names it/);
      assert.equal(referenceHoldReason("F:/Phoenix Workforce/_wt-some-other-task", parked), null);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }

  // ── 3. Not knowing is HELD, and the doctor never refuses over itself ────────
  {
    assert.match(referenceHoldReason(WT, null) ?? "", /cannot read the running processes/);
    const self = probe([{ pid: 777, name: "node", commandLine: `node scripts/repo-doctor.mjs --strip-idle # ${WT}` }]);
    assert.deepEqual(referenceHolders(WT, self, { ownPid: 777 }), []);
    assert.equal(parseProcessProbe("[]"), null, "an empty list is a broken sweep, not an empty machine");
    assert.equal(parseProcessProbe("not json"), null);
    const six = JSON.stringify([1, 2, 3, 4, 5, 6].map((n) => ({ ProcessId: n, Name: "p", CommandLine: null })));
    assert.equal(parseProcessProbe(six)?.rows.length, 6);
  }

  // ── 4. A script path is found however bash spelled it ───────────────────────
  {
    assert.deepEqual(
      scriptPathsIn(`node /c/Users/satoh/AppData/Local/Temp/w.mjs 5 && "C:\\a b\\x.ps1" 'D:/y/z.sh' ./notes.txt`, {
        msys: true,
      }),
      ["C:/Users/satoh/AppData/Local/Temp/w.mjs", "C:\\a b\\x.ps1", "D:/y/z.sh"],
    );
  }

  // ── 5. The doctor consults it in BOTH destructive paths, and strips no link ──
  {
    const doctor = stripComments(read("scripts/repo-doctor.mjs"));
    const calls = doctor.match(/referenceHoldReason\(/g) ?? [];
    assert.equal(calls.length, 2, "the strip gate and the retirable gate must both ask the queued-job question");
    assert.match(
      doctor,
      /function stripIdleVerdict[\s\S]*?referenceHoldReason\(dir, referenceProbe/,
      "stripIdleVerdict is the ONE place the strip gates live — the queued-job gate belongs inside it",
    );
    assert.match(doctor, /heldByLiveSession\.push/, "anti-vacuity: the retirable block still exists");

    // The junction is never the payload: counted for the offer by reclaimableEntries, never removed.
    const strip = doctor.slice(doctor.indexOf("if (stripIdle) {"));
    assert.match(strip, /entry\.isSymbolicLink\(\)\) continue;/, "the strip must step over a node_modules LINK");
    assert.doesNotMatch(
      strip,
      /if \(fs\.lstatSync\(p, \{ throwIfNoEntry: false \}\)\) fs\.rmSync/,
      "the old unconditional remove (which took the link too) is back",
    );
    assert.match(doctor, /function reclaimableEntries[\s\S]*?isSymbolicLink\(\)\) continue;/);

    // The restore hint has a working spelling for a nested worktree, and new-session honours it.
    assert.match(doctor, /--repair --nested/);
    const session = stripComments(read("scripts/new-session.mjs"));
    assert.match(session, /args\.includes\("--nested"\)/);
    for (const line of doctor.match(/[^\n]*pnpm install[^\n]*/g) ?? []) {
      assert.match(line, /NEVER/, "every mention of pnpm install in printed output is a prohibition");
    }
  }
}
