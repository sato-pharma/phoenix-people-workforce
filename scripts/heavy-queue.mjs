// heavy-queue.mjs - RETIRED 2026-09-17 (owner instruction). This file is now a PASSTHROUGH.
//
//   node "C:/Users/satoh/.claude/scripts/heavy-queue.mjs" [--max-wait-min N] [--heavy] <command ...>
//
// It runs <command> IMMEDIATELY - through the shell, in the current directory, with stdio passed
// straight through - and exits with the command's own exit code. It never waits, never polls, never
// gives up, and writes nothing to heavy-job-gate.log. --max-wait-min and --heavy are accepted and
// ignored so nothing that still calls this path breaks.
//
// WHY IT WAS RETIRED. The heavy-job gate (~/.claude/hooks/heavy-job-gate.mjs) and this queue were
// installed after the two bluescreens of 2026-09-11. Measured from their own log over the 2 days 13
// hours from 2026-09-15 07:28 to 2026-09-17 20:44 Cairo:
//   - 1,997 minutes (33.3 h) of wall clock spent waiting in this queue,
//   - of which 1,205 minutes (20.1 h) ran NOTHING: 27 give-ups, the longest after 4 h 27 m,
//   - 23 commands refused outright by the gate, 15 of them a plain `tsc`.
// The gate's floor for a typecheck or build is 5,000 MB free physical RAM. This 16 GB machine
// habitually sits at 1-2 GB free with a dozen Claude sessions open, so that floor was effectively
// never met and typecheck simply stopped being runnable. The owner removed both on 2026-09-17.
//
// WHAT STILL GUARDS THE MACHINE: ~/.claude/scripts/mem-watchdog.ps1 (the cure - it reclaims RAM once
// the box is under its floor) and ~/.claude/scripts/ram-guard.ps1. Prevention is now a human call:
// do not start a dev server, typecheck, build or test run when free RAM is already low, and prefer
// pushing the branch and letting CI answer (AGENTS.md section 7).
//
// The originals are kept, unmodified, in
// ~/.claude/backups/_attic-2026-09/retired-heavy-job-2026-09-17/.

import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
for (;;) {
  if (args[0] === '--max-wait-min') {
    args.splice(0, 2);
  } else if (args[0] === '--heavy') {
    args.shift();
  } else {
    break;
  }
}
if (args[0] === '--') args.shift();
if (!args.length) {
  console.error('usage: node heavy-queue.mjs [--max-wait-min N] [--heavy] <command ...>');
  process.exit(64);
}

const command = args.length === 1 ? args[0] : args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');

const child = spawn(command, { shell: true, stdio: 'inherit', windowsHide: true });
child.on('error', (e) => {
  console.error(`[heavy-queue] could not start the command: ${e.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
