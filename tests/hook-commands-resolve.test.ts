import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { stripComments } from "./support/comment-strip.ts";

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
 * Shell syntax, in the spellings that actually appear in a hook command. `${VAR}`/`$(...)` are
 * expansions no other shell performs; `||`, `&&`, `;` and `>` are operators cmd.exe and PowerShell
 * either reject or read differently. A command carrying any of them only works under bash.
 */
const SHELL_SYNTAX = [/\$\{/, /\$\(/, /\|\|/, /&&/, /;/, /\d?>/, /\[\s/];

type HookEntry = { type?: string; command?: string; shell?: string };

function hookEntries(): Array<{ event: string; entry: HookEntry }> {
  const settings = JSON.parse(readFileSync(SETTINGS, "utf8")) as {
    hooks?: Record<string, Array<{ hooks?: HookEntry[] }>>;
  };
  return Object.entries(settings.hooks ?? {}).flatMap(([event, groups]) =>
    (groups ?? []).flatMap((group) => (group.hooks ?? []).map((entry) => ({ event, entry }))),
  );
}

export function runHookCommandsResolveTests() {
  const entries = hookEntries();
  assert.ok(entries.length >= 9, `expected the hook wiring to still be in ${SETTINGS}, found ${entries.length} entries`);

  // 1. EVERY SCRIPT A COMMAND NAMES IS ON DISK. Resolved from the repo root, which is the cwd a
  //    hook runs with and therefore what a relative command resolves against.
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

  // 2. A COMMAND WITHOUT "shell": "bash" CARRIES NO SHELL SYNTAX, and vice versa. This is the whole
  //    of #4520: a node-only command must parse identically under bash, cmd.exe and PowerShell, so
  //    it may not contain an operator or an expansion — and it therefore has no reason to declare a
  //    shell and pay a Git Bash spawn on every tool call.
  const bashEntries = entries.filter(({ entry }) => entry.shell === "bash");
  for (const { event, entry } of entries) {
    const command = entry.command ?? "";
    const offending = SHELL_SYNTAX.filter((pattern) => pattern.test(command));
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
  assert.equal(
    bashEntries.length,
    2,
    "exactly two hook commands are genuinely bash (the worktree `[ -f .git ]` test and the remote "
      + "Linux setup script). A third means a shell-expanded command came back — that is what "
      + "errored under cmd.exe and PowerShell and denied every tool call.",
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
