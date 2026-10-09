import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { stripComments } from "./support/comment-strip.ts";
import { dispatchedHookGroups, settingsHookGroups, wiredHookEvents } from "./support/hook-wiring.ts";

/**
 * Every hook command in `.claude/settings.json` must point at a file that EXISTS, must parse in
 * whatever shell runs it, and must fail open.
 *
 * WHY THIS EXISTS. Until 2026-09-27 each command located its own script:
 * `DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; node
 * "$DIR/.claude/hooks/bash-guard.mjs" 2>/dev/null || true`. That string is Git-Bash syntax, and
 * #4520 replaced the nine pure-node ones with `node .claude/hooks/<x>.mjs` because a runtime that
 * reads this file but ignores `"shell": "bash"` ran the raw string through cmd.exe (`'true' is not
 * recognized`) or PowerShell (`token '||' is not a valid statement separator`), reported "hook
 * errored", and denied every tool call.
 *
 * The rewrite was right and it moved two guarantees out of the command string, where nothing was
 * watching them any more:
 *
 *   1. THE PATH. Nine hardcoded relative paths, and no test anywhere read one. A typo
 *      (`.claude/hook/bash-guard.mjs`), a renamed hook or a moved directory would leave node
 *      exiting "Cannot find module" on every tool call — so bash-guard's C6 (pnpm in a worktree),
 *      C7 (raw `next dev`) and C8 (local typecheck) would stop denying, and session-lock would stop
 *      writing the one guard against two sessions in one folder, with nothing anywhere going red.
 *      AGENTS.md §2.1 says a hook "FAILS OPEN and SILENT, so its silence proves nothing" — which is
 *      exactly why the wiring needs a mechanical check and not a reader.
 *   2. THE FAIL-OPEN. `2>/dev/null || true` forced exit 0 however the hook died. Dropping it left
 *      session-lock.mjs, memory-index-guard.mjs and worktree-exit-guard.mjs with no top-level
 *      handler at all: session-lock writes `.claude/session.lock` unguarded on a PreToolUse hook
 *      matching Bash|PowerShell|Edit|Write, so one EPERM/EBUSY (antivirus, a held husk, a read-only
 *      checkout) would exit non-zero on EVERY tool call — reproducing the very symptom #4520 set
 *      out to remove, from a new cause.
 *
 * So this reads the real settings file and asserts all three properties of every entry. It is
 * deliberately not scoped to one hook: the point is that a hook added later cannot skip them.
 */

const SETTINGS = ".claude/settings.json";

/** Any script path a command names, `$DIR/`-prefixed or not. Quotes and shell operators end it. */
const SCRIPT_PATH = /[^\s"';|&()]*\.(?:mjs|sh)\b/g;

/**
 * `${CLAUDE_PROJECT_DIR}` is the ONE expansion a hook command may use without declaring a shell,
 * and it is the only thing that makes a command independent of the directory it is launched from.
 * Claude Code handles it in both shells it runs hooks under: bash expands it natively, and for
 * PowerShell the CLI rewrites `${CLAUDE_PROJECT_DIR}` to `${env:CLAUDE_PROJECT_DIR}` itself before
 * running the command. Read out of the shipped binary, 2026-09-27.
 */
const PROJECT_DIR_TOKEN = /\$\{CLAUDE_PROJECT_DIR\}/g;

/**
 * The BARE form is a trap, and the CLI says so in its own words: "PowerShell hook command
 * references $CLAUDE_PROJECT_DIR, which PowerShell reads as an undefined variable ($null). Use
 * $env:CLAUDE_PROJECT_DIR or ${CLAUDE_PROJECT_DIR} instead." An unexpanded `$null` leaves the path
 * rooted at `/`, so the hook is not found and guards nothing — silently.
 */
const BARE_PROJECT_DIR = /\$CLAUDE_PROJECT_DIR\b/;

/**
 * Shell syntax, in the spellings that actually appear in a hook command. `$(...)` is an expansion
 * no other shell performs; `||`, `&&`, `;` and `>` are operators cmd.exe and PowerShell either
 * reject or read differently. A command carrying any of them only works under bash. `${…}` beyond
 * the sanctioned token above counts too, which is why it is stripped before this runs.
 */
const SHELL_SYNTAX = [/\$\{/, /\$\(/, /\|\|/, /&&/, /;/, /\d?>/, /\[\s/];

type HookEntry = { type?: string; command?: string; shell?: string };

/** Every hook command a session runs: settings.json's own (the dispatcher included) and the dispatch table's. */
function hookEntries(): Array<{ event: string; entry: HookEntry }> {
  return wiredHookEvents().flatMap((event) =>
    [...settingsHookGroups(event), ...dispatchedHookGroups(event)].flatMap((group) =>
      (group.hooks ?? []).map((entry) => ({ event, entry })),
    ),
  );
}

export function runHookCommandsResolveTests() {
  const entries = hookEntries();
  assert.ok(entries.length >= 9, `expected the hook wiring to still be in ${SETTINGS}, found ${entries.length} entries`);

  // 0. EVERY NODE HOOK LOCATES ITSELF FROM ${CLAUDE_PROJECT_DIR}, NOT FROM cwd. This is the whole
  //    point: a bare `node .claude/hooks/x.mjs` resolves against whatever directory the hook
  //    process happens to start in. Start `claude` in a subdirectory — `…/phoenix-workforce/src` —
  //    and node exits 1 "Cannot find module", so C6 (pnpm in a worktree), C7 (raw `next dev`) and
  //    C8 (local typecheck) stop denying and session-lock stops writing the one guard against two
  //    sessions in one folder. None of it says anything. `${CLAUDE_PROJECT_DIR}` is the session's
  //    OWN worktree, so it is also what keeps a worktree session off the primary's lock.
  for (const { event, entry } of entries) {
    const command = entry.command ?? "";
    assert.ok(
      !BARE_PROJECT_DIR.test(command.replace(PROJECT_DIR_TOKEN, "")),
      `the ${event} hook command uses the BARE $CLAUDE_PROJECT_DIR. PowerShell reads that as an `
        + `undefined variable ($null), which roots the path at "/" and the hook is never found. `
        + `Write \${CLAUDE_PROJECT_DIR} — the CLI rewrites that form for PowerShell itself: ${command}`,
    );
    for (const raw of command.match(SCRIPT_PATH) ?? []) {
      if (!raw.includes(".claude/hooks/")) continue; // a helper script, not a hook entry point
      assert.ok(
        /^\$\{CLAUDE_PROJECT_DIR\}\//.test(raw) || /^\$DIR\//.test(raw),
        `the ${event} hook runs "${raw}" as a path relative to cwd. Prefix it with `
          + `\${CLAUDE_PROJECT_DIR}/ so it resolves from the session's own project directory `
          + `whatever folder the hook process is launched in.`,
      );
    }
  }

  // 1. EVERY SCRIPT A COMMAND NAMES IS ON DISK.
  let checked = 0;
  for (const { event, entry } of entries) {
    const command = entry.command ?? "";
    const named = new Set(command.match(SCRIPT_PATH) ?? []);
    assert.ok(
      named.size > 0,
      `the ${event} hook command names no .mjs or .sh script, so nothing can be verified: ${command}`,
    );
    for (const raw of named) {
      // `$DIR/` is the shell-expanded prefix the two genuinely-bash entries still use.
      const rel = raw.replace(/^\$DIR\//, "").replace(/^\$\{[^}]*\}\//, "");
      assert.ok(
        existsSync(resolve(rel)),
        `the ${event} hook runs "${rel}", which does not exist. A hook whose script cannot be found `
          + `exits non-zero on every matching tool call and guards nothing, silently.`,
      );
      checked += 1;
    }
  }
  assert.ok(checked >= 9, `expected at least 9 hook script paths to verify, checked ${checked}`);

  // 2. A COMMAND WITHOUT "shell": "bash" CARRIES NO SHELL SYNTAX BEYOND ${CLAUDE_PROJECT_DIR}, and
  //    vice versa. This is #4520: the shell-expanded form errored under any runtime that reads this
  //    file and ignores `"shell": "bash"` — cmd.exe answered `'true' is not recognized`, PowerShell
  //    `token '||' is not a valid statement separator` — and the runtime then denied every tool
  //    call. Those two errors came from the OPERATORS (`|| true`, `2>/dev/null`), not from the
  //    variable, which is why a command can be both cwd-independent and operator-free. No operators
  //    also means no reason to declare a shell and pay a Git Bash spawn on every tool call.
  const bashEntries = entries.filter(({ entry }) => entry.shell === "bash");
  for (const { event, entry } of entries) {
    const command = entry.command ?? "";
    const offending = SHELL_SYNTAX.filter((pattern) => pattern.test(command.replace(PROJECT_DIR_TOKEN, "")));
    if (entry.shell === "bash") {
      assert.ok(
        offending.length > 0,
        `the ${event} hook declares "shell": "bash" but its command needs no shell — drop the key so `
          + `it runs without a Git Bash spawn on every matching tool call: ${command}`,
      );
    } else {
      assert.equal(
        offending.length,
        0,
        `the ${event} hook command has no "shell": "bash", so it runs under the platform default `
          + `(cmd.exe on Windows) and must contain no shell syntax — found ${offending.join(", ")} `
          + `in: ${command}`,
      );
    }
  }
  // ONE since 2026-10-09 (hook speed fixes): the all-worktrees provisioning one-liner became two
  // exec-form entries (`sync-worktree-env.mjs --hook`, which fails open itself, and an async
  // `--sweep-only`), so the cloud-only remote setup script is the last command that needs bash.
  // The folded `command` above is how an exec-form entry (`"command": "node", "args": [...]`) reads
  // here — see tests/support/hook-wiring.ts; tests/hook-hot-path.test.ts checks the spelling itself.
  assert.equal(
    bashEntries.length,
    1,
    "exactly one hook command is genuinely bash (the remote Linux setup script, which only runs in "
      + "a cloud session). A second means a shell-expanded command came back — that is what "
      + "errored under cmd.exe and PowerShell and denied every tool call, and it pays a Git Bash "
      + "spawn every time it runs.",
  );

  // 3. EVERY HOOK SCRIPT FAILS OPEN. The command no longer does it for them, and AGENTS.md §2.1
  //    tells every session a hook's failure is silent — which is only true if it exits 0.
  //
  //    The shape has to be TOP-LEVEL, and that is why this looks at the tail rather than searching
  //    the whole file for `catch`. Four hooks wrap their whole body in `try { … } catch {
  //    process.exit(0) }`, which necessarily ends the file; the other three register
  //    `uncaughtException` instead, which catches a throw in this module's own top-level evaluation
  //    and so does not need the envelope. A plain "is there a catch anywhere" test passed a hook
  //    whose only catch guarded a three-line dynamic import with the entire body unprotected after
  //    it — measured while building this, by deleting the net and watching it stay green.
  const TAIL_CHARS = 320;
  const failsOpen = (source: string) =>
    /process\.on\(\s*["']uncaughtException["']/.test(source)
    || /catch[\s\S]*process\.exit\(0\)/.test(source.trimEnd().slice(-TAIL_CHARS));
  const scripts = new Set(
    entries.flatMap(({ entry }) =>
      [...(entry.command ?? "").matchAll(SCRIPT_PATH)]
        .map(([raw]) => raw.replace(/^\$DIR\//, "").replace(/^\$\{[^}]*\}\//, ""))
        .filter((rel) => rel.startsWith(".claude/hooks/") && rel.endsWith(".mjs")),
    ),
  );
  assert.ok(scripts.size >= 7, `expected at least 7 node hooks to check, found ${scripts.size}`);
  for (const rel of scripts) {
    assert.ok(
      failsOpen(stripComments(readFileSync(rel, "utf8"))),
      `${rel} has no top-level fail-open. Add \`process.on("uncaughtException", () => process.exit(0))\` `
        + `or a trailing \`} catch { process.exit(0) }\`: the settings.json command no longer ends in `
        + `\`|| true\`, so a throw here exits non-zero and a runtime that reads that as a denial `
        + `refuses the tool call.`,
    );
  }
}
