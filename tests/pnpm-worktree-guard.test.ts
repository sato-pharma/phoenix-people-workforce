// pnpm must be REFUSED inside a linked worktree, and must still work in the primary checkout.
//
// WHY THIS EXISTS. A worktree's node_modules is a junction to the primary checkout's — never an
// install of its own (scripts/new-session.mjs says so at length). When pnpm runs there it sees a
// lockfile that has "moved", and its deps check offers to delete node_modules: the PRIMARY's
// install, shared by every session on this machine. CLAUDE.md records that prompt being answered
// `N` with one second to spare on 2026-09-05.
//
// AGENTS.md §5 has said "never pnpm in a worktree" since the junction layout existed, and until
// 2026-09-16 that rule was words only. Measured on origin/main that day: no .npmrc; no hook in
// .claude/hooks reading pnpm at all; and the user-level heavy-job gate classifying `pnpm install`
// as not heavy. In the other direction the command was AUTO-APPROVED from three places —
// `Bash(pnpm run *)` and `Bash(pnpm exec *)` in the gitignored .claude/settings.local.json that
// scripts/sync-worktree-env.mjs copies into every new worktree, plus `Bash(pnpm run build)` and
// friends in ~/.claude/settings.json. Deleting allow-rules cannot close that: a wildcard grant
// somewhere else still auto-approves, and §1.5 is explicit that a missing prompt is not approval.
// Only a hook deny is a gate, so bash-guard.mjs C6 is the enforcement and this file is its proof.
//
// These tests drive the real hook as a SUBPROCESS against a real throwaway repo that really has a
// linked worktree. The properties that matter are runtime ones — does a deny come back, does the
// PRIMARY stay usable, does the replacement command it prints actually exist — and a test that
// imported the regex and asserted on strings would pass against a hook wired to nothing.
//
// The allow half is asserted as hard as the deny half. A guard that also refuses `git grep pnpm`,
// or refuses to let a session write the documentation for this very rule, would be uninstalled
// within a day; an over-broad guard is how a real one gets switched off.

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const guardPath = resolve(".claude/hooks/bash-guard.mjs");
const settingsPath = resolve(".claude/settings.json");

type Decision = { decision: "allow" | "deny"; reason: string };

/**
 * Runs the hook exactly as settings.json does: the tool payload on stdin, cwd inside the folder
 * the command would run in.
 *
 * CLAUDE_PROJECT_DIR is DELETED unless a case sets it. The suite itself usually runs inside a
 * worktree, so an inherited value would silently make the "primary checkout" cases deny — passing
 * for the wrong reason while proving nothing about the primary.
 */
function runGuard(
  cwd: string,
  command: string,
  options: { tool?: string; projectDir?: string } = {},
): Decision {
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  if (options.projectDir) env.CLAUDE_PROJECT_DIR = options.projectDir;

  const payload = JSON.stringify({
    tool_name: options.tool ?? "Bash",
    cwd,
    tool_input: { command },
  });
  const raw = execFileSync(process.execPath, [guardPath], {
    cwd,
    input: payload,
    encoding: "utf8",
    env,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30000,
  });

  if (!raw.trim()) return { decision: "allow", reason: "" };
  const start = raw.indexOf('{"hookSpecificOutput"');
  assert.ok(start >= 0, `hook emitted something that is not a decision:\n${raw}`);
  const output = JSON.parse(raw.slice(start)).hookSpecificOutput;
  return { decision: output.permissionDecision, reason: String(output.permissionDecisionReason ?? "") };
}

const norm = (value: string) => value.replace(/\\/g, "/").toLowerCase();

function git(at: string, args: string[]): string {
  return execFileSync("git", args, { cwd: at, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * A throwaway repo plus one real linked worktree of it.
 *
 * package.json is COMMITTED, so the worktree gets its own copy — that is what the deny message
 * reads to name a replacement command. node_modules is then written into the worktree by hand,
 * standing in for the junction the real layout has: it is untracked, so `git worktree add` would
 * never have produced it, and without it the binary lookup has nothing to resolve.
 */
function makeRepo(): { primary: string; worktree: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "phx-pnpm-guard-"));
  const primary = join(root, "primary");
  execFileSync("git", ["init", "-b", "main", primary], { stdio: ["ignore", "ignore", "pipe"] });
  git(primary, ["config", "user.email", "test@example.com"]);
  git(primary, ["config", "user.name", "Guard Test"]);
  git(primary, ["config", "commit.gpgsign", "false"]);

  writeFileSync(
    join(primary, "package.json"),
    JSON.stringify(
      {
        name: "phx-guard-fixture",
        scripts: {
          dev: "node scripts/dev-server.mjs",
          test: "node --experimental-strip-types tests/run-tests.ts",
          typecheck: "tsc --noEmit --pretty false",
          // A fixture stand-in for the repo's real one-hop scripts (`master-map:sync`, the
          // `:preview` pairs). `check:edit` used to be the plainest example and was deleted from
          // package.json on 2026-09-25 — the guard resolves whatever scripts exist, so the shape
          // is what this pins, not that one name.
          "typecheck:alias": "pnpm run typecheck",
          ci: "pnpm run typecheck && pnpm run test && pnpm run build",
        },
      },
      null,
      2,
    ),
  );
  mkdirSync(join(primary, "src"), { recursive: true });
  writeFileSync(join(primary, "src", "keep.txt"), "seed\n");
  git(primary, ["add", "."]);
  git(primary, ["commit", "-m", "seed"]);

  const worktree = join(root, "_wt-fixture");
  git(primary, ["worktree", "add", "-b", "codex/fixture", worktree]);

  for (const at of [primary, worktree]) {
    const bin = join(at, "node_modules", "typescript", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "tsc"), "// stand-in for the real compiler entry\n");
    writeFileSync(
      join(at, "node_modules", "typescript", "package.json"),
      JSON.stringify({ name: "typescript", bin: { tsc: "./bin/tsc" } }),
    );
  }

  return { primary, worktree, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export function runPnpmWorktreeGuardTests() {
  assert.ok(existsSync(guardPath), `bash-guard not found at ${guardPath}`);

  // ── The wiring: the hook must be reached for BOTH tools ──────────────────────────────────────
  // A deny that only fires for the Bash tool leaves `PowerShell(pnpm run typecheck)` — a real
  // grant in ~/.claude/settings.json — completely ungated. bash-guard's own matcher was `Bash`
  // alone until 2026-09-12, which is exactly how its worktree-removal branch sat dead for weeks.
  {
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    const entries = (settings?.hooks?.PreToolUse ?? []).filter((entry: { hooks?: { command?: string }[] }) =>
      (entry.hooks ?? []).some((hook) => String(hook.command ?? "").includes("bash-guard.mjs")),
    );
    assert.equal(entries.length, 1, "bash-guard.mjs must be registered exactly once as a PreToolUse hook");
    const matcher = String(entries[0].matcher ?? "");
    for (const tool of ["Bash", "PowerShell"]) {
      assert.ok(
        matcher.split("|").includes(tool),
        `the bash-guard matcher must cover the ${tool} tool, but it is "${matcher}"`,
      );
    }
  }

  const { primary, worktree, cleanup } = makeRepo();
  try {
    // ── In a linked worktree, every entry form of pnpm is refused ───────────────────────────────
    // `pnpm i`, the bare script shorthand and `pnpm <binary>` reach the same deps check as
    // `pnpm install` does; a guard that only knew `install`/`run`/`exec` would wave through the
    // spellings a tired session actually types.
    for (const command of [
      "pnpm install",
      "pnpm i",
      "pnpm install --frozen-lockfile",
      "pnpm add zod",
      "pnpm run test",
      "pnpm run worktree:sync-env",
      "pnpm exec tsc --noEmit",
      "pnpm dlx supabase status",
      "pnpm test",
      "pnpm supabase status",
      "pnpm -r run build",
    ]) {
      const { decision, reason } = runGuard(worktree, command);
      assert.equal(decision, "deny", `\`${command}\` must be denied inside a worktree`);
      assert.ok(
        norm(reason).includes(norm(worktree)),
        `the deny must name the worktree it is protecting.\n${command}\n${reason}`,
      );
    }

    // ── Compound commands: pnpm is rarely the first token of the line ───────────────────────────
    for (const command of [
      `cd src && pnpm run test`,
      `cd src; pnpm install`,
      `git fetch origin && cd "${worktree}" && pnpm run test`,
      `node scripts/x.mjs\npnpm run test`,
      `echo building && pnpm run build || pnpm run test`,
      `VERSION=$(pnpm -v) && echo "$VERSION"`,
    ]) {
      assert.equal(
        runGuard(worktree, command).decision,
        "deny",
        `pnpm after a separator must be caught: ${command}`,
      );
    }

    // ── The PowerShell tool is the same denial ──────────────────────────────────────────────────
    {
      const { decision, reason } = runGuard(worktree, "pnpm run typecheck", { tool: "PowerShell" });
      assert.equal(decision, "deny", "the PowerShell tool must be gated too");
      assert.ok(reason.includes("node node_modules/typescript/bin/tsc"), `PowerShell gets the advice too.\n${reason}`);
    }

    // ── A subdirectory of the worktree is still the worktree ────────────────────────────────────
    // `.git` is only a FILE at the worktree root, so the folder-shape test alone answers "no" one
    // level down. The --git-dir vs --git-common-dir comparison is what holds there.
    {
      const { decision } = runGuard(join(worktree, "src"), "pnpm run test");
      assert.equal(decision, "deny", "a session sitting in a subfolder of a worktree is still in a worktree");
    }

    // ── CLAUDE_PROJECT_DIR answers when the shell's cwd is somewhere unrelated ──────────────────
    {
      const elsewhere = mkdtempSync(join(tmpdir(), "phx-not-a-repo-"));
      try {
        assert.equal(
          runGuard(elsewhere, "pnpm run test", { projectDir: worktree }).decision,
          "deny",
          "the session's project dir is a worktree even when the shell has wandered out of it",
        );
        assert.equal(
          runGuard(elsewhere, "pnpm run test").decision,
          "allow",
          "with nothing pointing at a worktree there is nothing to protect — the guard must not fire blind",
        );
      } finally {
        rmSync(elsewhere, { recursive: true, force: true });
      }
    }

    // ── The message names the NODE equivalent, and it is a command that exists ──────────────────
    {
      const script = runGuard(worktree, "pnpm run test").reason;
      assert.ok(script.includes("Run instead:"), `a script must get a replacement.\n${script}`);
      assert.ok(
        script.includes("node --experimental-strip-types tests/run-tests.ts"),
        `the replacement is the script's own body, invoked through node.\n${script}`,
      );

      // The dev server is pinned by AGENTS.md §5, not read from package.json: it is the launcher,
      // which picks --webpack on Windows (turbopack rejects the node_modules junction) and caps the
      // heap. Naming a raw `next dev` here would send the session straight into bash-guard C7.
      const dev = runGuard(worktree, "pnpm run dev").reason;
      assert.ok(
        dev.includes("node scripts/dev-server.mjs --port 3000"),
        `the dev server must be named as the launcher, with its port.\n${dev}`,
      );
      assert.ok(!/next dev/.test(dev), `the advice must not be a raw \`next dev\`, which C7 refuses.\n${dev}`);

      // A bare binary resolves through that package's own manifest and is checked on disk, so the
      // line printed is one that runs. Guessing `node_modules/tsc/…` would have been plausible,
      // wrong, and impossible to tell apart from working advice.
      const typecheck = runGuard(worktree, "pnpm run typecheck").reason;
      assert.ok(
        typecheck.includes("node node_modules/typescript/bin/tsc --noEmit --pretty false"),
        `a binary must resolve to its real installed entry.\n${typecheck}`,
      );

      const install = runGuard(worktree, "pnpm install").reason;
      assert.ok(
        install.includes("node scripts/new-session.mjs --repair"),
        `an install has no node equivalent — it must point at the junction repair instead.\n${install}`,
      );
    }

    // ── A replacement must never itself contain pnpm ────────────────────────────────────────────
    // `ci` is `pnpm run typecheck && pnpm run test && …`. Resolving it naively produced a "Run
    // instead" line still carrying pnpm calls — an instruction that lands the session straight
    // back in this deny, which is worse than saying nothing. Same trap for a one-hop alias, which
    // MUST resolve through to the real command rather than to another pnpm.
    {
      const chain = runGuard(worktree, "pnpm run ci").reason;
      assert.ok(chain.includes("No node-direct equivalent"), `an unresolvable chain must say so.\n${chain}`);
      assert.ok(
        !/(?:^|[\n|&;(])\s*pnpm\s/.test(chain.split("Invoke node directly")[0].replace(/^pnpm is refused.*$/m, "")),
        `the deny must not hand back a command that is itself pnpm.\n${chain}`,
      );

      const oneHop = runGuard(worktree, "pnpm run typecheck:alias").reason;
      assert.ok(
        oneHop.includes("node node_modules/typescript/bin/tsc --noEmit --pretty false"),
        `a script that is one \`pnpm run <other>\` must resolve through to the real command.\n${oneHop}`,
      );
    }

    // ── The PRIMARY checkout is untouched ───────────────────────────────────────────────────────
    // This is the half that keeps the guard installed. pnpm is how the repo is actually built and
    // released; the rule is about WHERE, not about pnpm.
    for (const command of [
      "pnpm install --frozen-lockfile",
      "pnpm run test",
      "pnpm exec next typegen",
      "pnpm run dev",
    ]) {
      assert.equal(
        runGuard(primary, command).decision,
        "allow",
        `\`${command}\` is legitimate in the primary checkout and must not be denied`,
      );
    }

    // ── Talking ABOUT pnpm is not running pnpm ──────────────────────────────────────────────────
    // Every one of these is denied by a match that is not anchored to a command position, and this
    // repo's own documentation is full of them. A guard that blocks writing down the rule it
    // enforces gets turned off.
    for (const command of [
      "git grep -n pnpm -- AGENTS.md",
      "node scripts/repo-doctor.mjs",
      'echo "never run pnpm install in a worktree"',
      "git log --oneline --grep=pnpm",
      `cd "${worktree}" && node scripts/new-session.mjs --status`,
      "git commit -m 'docs(agents): the pnpm rule is mechanical now'",
      // A folder whose NAME carries the word — this very branch's worktree is called that.
      "cd /f/Phoenix/_wt-pnpm-worktree-guard && node --version",
      // A heredoc BODY is data. Writing the documentation for this rule must not trip it.
      "cat > note.md <<'EOF'\nNever do this here:\npnpm install\nEOF",
    ]) {
      const { decision, reason } = runGuard(worktree, command);
      assert.equal(decision, "allow", `this is not a pnpm invocation and must be allowed: ${command}\n${reason}`);
    }

    // ── Other tools are none of this hook's business ────────────────────────────────────────────
    assert.equal(
      runGuard(worktree, "pnpm install", { tool: "Read" }).decision,
      "allow",
      "the hook must return silently for any tool but Bash and PowerShell",
    );
  } finally {
    cleanup();
  }
}
