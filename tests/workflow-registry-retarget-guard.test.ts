import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * A migration must never retarget a workflow action to a status the CODE does not expect.
 *
 * Phoenix keeps approval rules in TWO places that nothing automatically compares: the TypeScript
 * under `src/lib/<domain>/`, and the `workflow_registry_modules` row in Postgres.
 * `assertWorkflowRegistryTransition` reads the DB row and THROWS when its `to` disagrees with the
 * `expectedNextStatus` literal the caller passed:
 *
 *     if (input.expectedNextStatus && transition.nextStatus !== input.expectedNextStatus) throw
 *
 * The registry is the LAST gate before the write, so a mismatch wedges the whole action.
 *
 * This is not hypothetical. On 2026-08-04 a migration flipped outstation `submit` from
 * "pending" to "pending_departure_photo" for a two-photo feature. Three call sites in
 * submitOutstationRequest still passed "pending", so EVERY outstation submission failed the
 * moment it reached production. It was reverted in ~2 minutes and nobody happened to be
 * submitting, which is luck, not a control.
 *
 * Staging cannot catch this — there is no staging APPLICATION, so applying a registry migration
 * there proves the SQL ran and nothing about whether the app still works. A static check is the
 * only pre-merge gate available, so this is it.
 *
 * What this does NOT claim: it cannot read production's live registry, so it cannot detect drift
 * that already exists there (see the workflow-registry memory — 7 modules have never been swept).
 * It only stops the repo ADDING a new mismatch.
 */
export function runWorkflowRegistryRetargetGuardTests() {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(testDir, "..");

  // ── 1. Every (actionKey -> expectedNextStatus) the code asserts ─────────────────
  const expectedByAction = new Map<string, Set<string>>();
  const record = (action: string, status: string) => {
    if (!expectedByAction.has(action)) expectedByAction.set(action, new Set());
    expectedByAction.get(action)!.add(status);
  };

  function walk(dir: string, onFile: (file: string) => void) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, onFile);
      else onFile(full);
    }
  }

  walk(path.join(repoRoot, "src", "lib"), (file) => {
    if (!file.endsWith(".ts")) return;
    const source = readFileSync(file, "utf8");
    if (!source.includes("expectedNextStatus")) return;

    // The two fields are written in either order across the codebase, so pair them both ways
    // within a small window rather than assuming one layout.
    for (const match of source.matchAll(/actionKey:\s*["']([\w-]+)["']/g)) {
      const ahead = source.slice(match.index + match[0].length, match.index + match[0].length + 400);
      const status = /expectedNextStatus:\s*["']([\w-]+)["']/.exec(ahead);
      if (status) record(match[1], status[1]);
    }
    for (const match of source.matchAll(/expectedNextStatus:\s*["']([\w-]+)["']/g)) {
      const behind = source.slice(Math.max(0, match.index - 400), match.index);
      const actions = [...behind.matchAll(/actionKey:\s*["']([\w-]+)["']/g)];
      if (actions.length > 0) record(actions[actions.length - 1][1], match[1]);
    }
  });

  assert.ok(
    expectedByAction.size >= 8,
    `expected to find many actionKey/expectedNextStatus pairs, found ${expectedByAction.size} — ` +
      "the scraper has probably stopped matching the code's shape and is now asserting nothing",
  );
  // The incident action must be among them, or this guard is not watching the thing it exists for.
  assert.ok(expectedByAction.has("submit"), "the 'submit' action must be discovered by the scraper");

  // ── 2. Every retarget a migration performs ──────────────────────────────────────
  const retargets: Array<{ action: string; file: string; target: string }> = [];
  const migrationsDir = path.join(repoRoot, "supabase", "migrations");

  for (const name of readdirSync(migrationsDir)) {
    if (!name.endsWith(".sql")) continue;
    const sql = readFileSync(path.join(migrationsDir, name), "utf8");
    if (!sql.includes("workflow_registry_modules")) continue;

    // A retarget writes the jsonb path {to}. Find each one and read the action it is guarded by
    // (behind) and the value it writes (ahead). Comments are stripped first so PROSE describing a
    // past retarget cannot trip the guard — a lesson from a sibling test that matched its own
    // explanatory comment.
    const code = sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");

    for (const match of code.matchAll(/['"]\{to\}['"]/g)) {
      const behind = code.slice(Math.max(0, match.index - 500), match.index);
      const ahead = code.slice(match.index, match.index + 300);
      const action = [...behind.matchAll(/->>\s*['"]key['"]\s*=\s*'([\w-]+)'/g)].pop();
      const target = /'"([\w-]+)"'/.exec(ahead);
      if (action && target) retargets.push({ action: action[1], file: name, target: target[1] });
    }
  }

  // ── 3. A retarget must land on a status the code actually expects ───────────────
  for (const retarget of retargets) {
    const expected = expectedByAction.get(retarget.action);
    if (!expected) continue; // no code asserts a target for this action — nothing to contradict.

    assert.ok(
      expected.has(retarget.target),
      `${retarget.file} retargets the "${retarget.action}" action to "${retarget.target}", but no ` +
        `code path expects that — the call sites assert ${JSON.stringify([...expected].sort())}. ` +
        "assertWorkflowRegistryTransition THROWS on a mismatch, so applying this migration would " +
        `wedge every "${retarget.action}" in that module the moment it reaches production. ` +
        "Retargeting an action is a BREAKING change to deployed code, not an additive one: update " +
        "the expectedNextStatus literals in the SAME release, or add a new action instead of " +
        "moving an existing one.",
    );
  }

  // ── 4. The guard must actually be able to see a retarget ────────────────────────
  // Without this, a scraper that silently stops matching the SQL shape would leave section 3
  // iterating an empty list and passing forever. Prove it against a synthetic migration body in
  // the exact form the incident used.
  const synthetic = `
    update public.workflow_registry_modules
       set actions = (
             select jsonb_agg(
                      case when action->>'key' = 'submit'
                           then jsonb_set(action, '{to}', '"pending_departure_photo"'::jsonb)
                           else action end order by ordinality)
               from jsonb_array_elements(actions) with ordinality as t(action, ordinality))
     where module_key = 'outstation_expenses';`;
  const seen: Array<{ action: string; target: string }> = [];
  for (const match of synthetic.matchAll(/['"]\{to\}['"]/g)) {
    const behind = synthetic.slice(Math.max(0, match.index - 500), match.index);
    const ahead = synthetic.slice(match.index, match.index + 300);
    const action = [...behind.matchAll(/->>\s*['"]key['"]\s*=\s*'([\w-]+)'/g)].pop();
    const target = /'"([\w-]+)"'/.exec(ahead);
    if (action && target) seen.push({ action: action[1], target: target[1] });
  }
  assert.deepEqual(
    seen,
    [{ action: "submit", target: "pending_departure_photo" }],
    "the retarget scraper must still recognise the exact SQL shape that caused the 2026-08-04 outage",
  );
  assert.ok(
    !expectedByAction.get("submit")?.has("pending_departure_photo"),
    "no code path expects submit -> pending_departure_photo, so the synthetic case above would " +
      "correctly fail section 3 — which is what makes this guard meaningful",
  );
}
