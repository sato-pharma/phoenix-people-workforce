// .claude/hooks/batch-nudge.mjs: a session reading the codebase ONE CALL PER STEP is reminded to batch
// (2026-10-08, after the owner's "building is slow": 14 single look-around steps per build task, only
// 10% of steps batched, 19% of all build time).
//
// It drives the real hook as a subprocess over hand-built transcripts, as the dispatcher runs it. The
// silent half matters as much as the reminder: a batched step, an edit in between, an owner prompt in
// between, a write disguised as a read, a second call in the same step, and the stand-down must all
// stay quiet — the hook only ever ADDS context, so a false reminder is the only way it can cost.

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const hookPath = resolve(".claude/hooks/batch-nudge.mjs");

type Call = { name: string; input: Record<string, unknown> };
type Step = Call[] | "PROMPT";

function transcriptOf(steps: Step[]): { lines: string[]; ids: string[][] } {
  const lines: string[] = [];
  const ids: string[][] = [];
  for (const [i, step] of steps.entries()) {
    if (step === "PROMPT") {
      lines.push(JSON.stringify({ type: "user", message: { role: "user", content: "fix the payroll export" } }));
      ids.push([]);
      continue;
    }
    const req = `req_${i}`; // index-based, so a longer transcript of the same session keeps its ids
    const stepIds: string[] = [];
    for (const [j, call] of step.entries()) {
      const id = `toolu_${i}_${j}`;
      stepIds.push(id);
      // one entry per content block, as Claude Code writes them
      lines.push(JSON.stringify({ type: "assistant", requestId: req, message: { id: `msg_${req}`, content: [{ type: "tool_use", id, name: call.name, input: call.input }] } }));
    }
    for (const id of stepIds) {
      lines.push(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "x".repeat(2000) }] } }));
    }
    ids.push(stepIds);
  }
  return { lines, ids };
}

function run(home: string, transcript: string, session: string, call: Call, toolUseId = "toolu_next", env: Record<string, string> = {}): string {
  const out = execFileSync(process.execPath, [hookPath], {
    input: JSON.stringify({ session_id: session, transcript_path: transcript, tool_name: call.name, tool_input: call.input, tool_use_id: toolUseId, hook_event_name: "PreToolUse" }),
    encoding: "utf8",
    env: { ...process.env, USERPROFILE: home, HOME: home, PHX_BATCH_NUDGE_OFF: "", ...env },
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30000,
  });
  if (!out.trim()) return "";
  return String(JSON.parse(out).hookSpecificOutput?.additionalContext ?? "");
}

const READ: Call = { name: "Read", input: { file_path: "F:/x/src/lib/payroll/run.ts" } };
const GREP: Call = { name: "Grep", input: { pattern: "netSalary" } };
const SHELL_LOOK: Call = { name: "Bash", input: { command: 'cd "/f/Phoenix Workforce/_wt-x" && grep -n "netSalary" src/lib/payroll/run.ts | head -20' } };
const GIT_LOOK: Call = { name: "Bash", input: { command: "git status --short && git log -1 --oneline 2>&1" } };
const PS_LOOK: Call = { name: "PowerShell", input: { command: "Get-Content src/lib/payroll/run.ts | Select-Object -First 40" } };
const EDIT: Call = { name: "Edit", input: { file_path: "F:/x/src/lib/payroll/run.ts", old_string: "a", new_string: "b" } };
const NODE: Call = { name: "Bash", input: { command: "node scripts/module-memory/build.mjs" } };

export function runBatchNudgeTests(): void {
  const dir = mkdtempSync(join(tmpdir(), "phx-batch-nudge-"));
  let n = 0;
  const fresh = (steps: Step[]) => {
    const { lines, ids } = transcriptOf(steps);
    const file = join(dir, `t${++n}.jsonl`);
    writeFileSync(file, lines.join("\n") + "\n", "utf8");
    return { file, ids, session: `s${n}`, home: mkdtempSync(join(dir, "home-")) };
  };
  try {
    // ── the reminder: three single look-around steps, then a fourth look-around ──────────────────
    for (const [what, steps, next] of [
      ["three single Reads", [[READ], [READ], [READ]], READ],
      ["Grep, a shell grep|head, git status&&log", [[GREP], [SHELL_LOOK], [GIT_LOOK]], GREP],
      ["PowerShell Get-Content|Select-Object twice and a Read", [[PS_LOOK], [PS_LOOK], [READ]], SHELL_LOOK],
      ["an older batched step does not hide the trailing three", [[READ, GREP], [READ], [GREP], [SHELL_LOOK]], READ],
    ] as Array<[string, Step[], Call]>) {
      const t = fresh(steps);
      const said = run(t.home, t.file, t.session, next);
      assert.match(said, /^BATCH YOUR LOOK-AROUNDS — your last \d+ steps each ran ONE read-only call/, `the hook must remind after ${what}`);
      assert.match(said, /parallel tool calls in ONE message/, "the reminder must say what to do instead");
      assert.match(said, /nothing is blocked/, "the reminder must say it blocks nothing");
    }

    // the current step already in the transcript as a single look-around still counts its history
    {
      const t = fresh([[READ], [READ], [READ], [READ]]);
      const current = t.ids[3]![0]!;
      assert.match(run(t.home, t.file, t.session, READ, current), /^BATCH YOUR LOOK-AROUNDS — your last 3 steps/, "a current single step must be measured against the three before it");
    }

    // ── silence ───────────────────────────────────────────────────────────────────────────────────
    for (const [what, steps, next] of [
      ["only two single steps", [[READ], [GREP]], READ],
      ["a batched step in the trailing three", [[READ], [READ, GREP], [READ]], READ],
      ["an Edit in between", [[READ], [READ], [EDIT], [READ]], READ],
      ["an owner prompt in between", [[READ], [READ], "PROMPT", [READ]], READ],
      ["a non-look-around shell step in between", [[READ], [NODE], [READ], [READ]], READ],
      ["a write disguised as a read (redirect)", [[READ], [READ], [{ name: "Bash", input: { command: "cat a.ts > b.ts" } }]], READ],
      ["a sed -i edit", [[READ], [READ], [{ name: "Bash", input: { command: "sed -i 's/a/b/' x.ts" } }]], READ],
      ["a background shell call", [[READ], [READ], [{ name: "Bash", input: { command: "grep -n x y", run_in_background: true } }]], READ],
      ["a heredoc", [[READ], [READ], [{ name: "Bash", input: { command: "cat > n.md <<'EOF'\nhi\nEOF" } }]], READ],
    ] as Array<[string, Step[], Call]>) {
      const t = fresh(steps);
      assert.equal(run(t.home, t.file, t.session, next), "", `the hook must stay silent for ${what}`);
    }

    // the call about to run is not a look-around
    {
      const t = fresh([[READ], [READ], [READ]]);
      assert.equal(run(t.home, t.file, t.session, EDIT), "", "an Edit about to run is not reminded");
      assert.equal(run(t.home, t.file, t.session, NODE), "", "a non-look-around command about to run is not reminded");
    }

    // the current step is batched
    {
      const t = fresh([[READ], [READ], [READ], [READ, GREP]]);
      assert.equal(run(t.home, t.file, t.session, READ, t.ids[3]![0]!), "", "a step that is batching right now is not reminded");
    }

    // once per step, and the streak restarts after a reminder
    {
      const t = fresh([[READ], [READ], [READ]]);
      assert.notEqual(run(t.home, t.file, t.session, READ, "toolu_a"), "", "first parallel call reminds");
      assert.equal(run(t.home, t.file, t.session, GREP, "toolu_b"), "", "a second call of the same step must not remind again");
      // the same session one and two steps later: the streak restarts from the step it reminded after
      const later = (steps: Step[]) => {
        const f = join(dir, `later-${steps.length}.jsonl`);
        writeFileSync(f, transcriptOf(steps).lines.join("\n") + "\n", "utf8");
        return f;
      };
      assert.equal(run(t.home, later([[READ], [READ], [READ], [READ], [READ]]), t.session, READ), "", "two single steps after a reminder must not remind again");
      assert.notEqual(run(t.home, later([[READ], [READ], [READ], [READ], [READ], [READ]]), t.session, READ), "", "three single steps after a reminder remind again");
    }

    // the stand-down, a missing transcript, a broken transcript
    {
      const t = fresh([[READ], [READ], [READ]]);
      assert.equal(run(t.home, t.file, t.session, READ, "toolu_x", { PHX_BATCH_NUDGE_OFF: "1" }), "", "PHX_BATCH_NUDGE_OFF=1 stands it down");
      assert.equal(run(t.home, join(dir, "missing.jsonl"), t.session, READ), "", "a missing transcript is silence");
      const broken = join(dir, "broken.jsonl");
      writeFileSync(broken, "{not json\n\u0000\u0001\n", "utf8");
      assert.equal(run(t.home, broken, t.session, READ), "", "a broken transcript is silence");
    }

    // a bounded cost: at most six reminders per session
    {
      const steps: Step[] = [];
      const home = mkdtempSync(join(dir, "home-cap-"));
      let reminders = 0;
      for (let i = 0; i < 40; i++) {
        steps.push([READ]);
        const { lines } = transcriptOf(steps);
        const file = join(dir, `cap-${i}.jsonl`);
        writeFileSync(file, lines.join("\n") + "\n", "utf8");
        if (run(home, file, "capped", READ)) reminders++;
      }
      assert.equal(reminders, 6, `a session that never batches is reminded at most 6 times, got ${reminders}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
