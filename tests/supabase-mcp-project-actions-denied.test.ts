// THE SUPABASE CONNECTIONS MAY RUN SQL, NEVER REACH A PROJECT OR A BRANCH — credentials audit of
// 18 Nov 2026, finding 4, fixed on the owner's word ("Fix 1, 3, 4 in one PR").
//
// WHY. All three Supabase connections a session can call — `supabase-production`, `supabase-staging`
// and the claude.ai connector `b345e47e-…` — carry ONE personal access token that reaches every
// project on the account, Future Talents Hub in the other organization included. AGENTS.md §8
// pre-authorizes SQL and migrations end to end, but says creating or deleting a project is NOT
// covered. Until this deny list, the settings allowed each connection WHOLESALE, so a session could
// pause production, restore it from a backup, or reset or merge a branch onto it without a prompt.
//
// A deny rule in `.claude/settings.json` outranks any allow rule, in this file or the user's, so the
// eight project- and branch-level actions below are refused on every connection while `execute_sql`,
// `apply_migration` and the reads stay exactly as they were. The list is pinned here because a deny
// entry deleted in a tidy-up looks like nothing at all, and the tool stays in the tool list either
// way (a denied tool is still advertised, memory note `a-denied-mcp-connector-still-appears-in-the-tool-list`).

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const SUPABASE_CONNECTIONS = [
  "supabase-production",
  "supabase-staging",
  "b345e47e-3198-4b48-97cc-07b47bbb3087",
] as const;

export const DENIED_PROJECT_ACTIONS = [
  "create_project",
  "pause_project",
  "restore_project",
  "create_branch",
  "delete_branch",
  "merge_branch",
  "reset_branch",
  "rebase_branch",
] as const;

// SQL and migrations stay pre-authorized (AGENTS.md §8) — denying one of these would stop the work
// the connections exist for, so the test refuses that too.
const STILL_ALLOWED = ["execute_sql", "apply_migration", "list_projects", "list_tables", "list_migrations"];

type Settings = { permissions?: { allow?: string[]; deny?: string[] } };

export function runSupabaseMcpProjectActionsDeniedTests() {
  const settings = JSON.parse(readFileSync(resolve(".claude/settings.json"), "utf8")) as Settings;
  const deny = new Set(settings.permissions?.deny ?? []);

  for (const server of SUPABASE_CONNECTIONS) {
    for (const action of DENIED_PROJECT_ACTIONS) {
      const rule = `mcp__${server}__${action}`;
      assert.ok(
        deny.has(rule),
        `${rule} must stay in .claude/settings.json permissions.deny — the token behind ${server} reaches every ` +
          "project on the account, and AGENTS.md §8 never pre-authorized a project or branch action (credentials audit, finding 4)",
      );
    }
    for (const action of STILL_ALLOWED) {
      assert.equal(
        deny.has(`mcp__${server}__${action}`),
        false,
        `mcp__${server}__${action} must NOT be denied — SQL, migrations and reads stay pre-authorized (AGENTS.md §8)`,
      );
    }
    assert.equal(
      deny.has(`mcp__${server}`),
      false,
      `a bare deny of mcp__${server} would switch the whole connection off; only the eight actions are refused`,
    );
  }

  const agents = readFileSync(resolve("AGENTS.md"), "utf8");
  assert.match(
    agents,
    /Not covered: creating\/deleting a project/,
    "AGENTS.md §8 still says a project action is not pre-authorized — the reason this deny list exists",
  );
}
