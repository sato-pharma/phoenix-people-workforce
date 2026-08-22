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

    // The two fields are written in either order across the codebase, so pair them both ways — but
    // bound each pairing by the ENCLOSING CALL and by the neighbouring field, never by a byte
    // count. A 400-byte window measures how long the options literal happens to be, and it
    // silently DROPPED `revive_held -> pending_approval` in direct-orders/service.ts: the literal
    // that names the action and the call that asserts the status sit 60 lines apart. A dropped
    // pair does not fail here — the action just vanishes from the map, and section 3 then skips
    // every migration that retargets it. The window was quietly the weaker check.
    const actionKeys = [...source.matchAll(/actionKey:\s*["']([\w-]+)["']/g)];
    const statuses = [...source.matchAll(/expectedNextStatus:\s*["']([\w-]+)["']/g)];

    actionKeys.forEach((match, index) => {
      const from = match.index + match[0].length;
      const sibling = index + 1 < actionKeys.length ? actionKeys[index + 1].index : source.length;
      const callEnd = source.indexOf("});", from);
      const stop = Math.min(sibling, callEnd < 0 ? source.length : callEnd);
      const status = statuses.find((entry) => entry.index >= from && entry.index < stop);
      if (status) record(match[1], status[1]);
    });
    statuses.forEach((match, index) => {
      const sibling = index > 0 ? statuses[index - 1].index + statuses[index - 1][0].length : 0;
      const callStart = source.lastIndexOf("({", match.index);
      const from = Math.max(sibling, callStart < 0 ? 0 : callStart);
      const owners = actionKeys.filter((entry) => entry.index >= from && entry.index < match.index);
      if (owners.length > 0) record(owners[owners.length - 1][1], match[1]);
    });
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

  /**
   * Pull every `{to}` retarget out of one SQL body: the `key =` predicate that guards it (behind)
   * and the status it writes (ahead).
   *
   * Both sides are bounded by REAL edges — the enclosing statement, and the neighbouring `{to}`
   * writes — never by a byte count. A 500/300-byte window measures how long the surrounding SQL
   * happens to be, and when it falls short the retarget is not flagged, it is simply NOT SEEN:
   * section 3 then iterates a list that is missing it and goes green on precisely the migration
   * this guard exists to stop. That is the failure mode with no symptom.
   *
   * Section 4 runs this SAME function against the synthetic incident body, so the self-test can no
   * longer drift from the scraper it claims to be proving — it used to be a copy of it.
   */
  function scrapeRetargets(sql: string): Array<{ action: string; target: string }> {
    const found: Array<{ action: string; target: string }> = [];
    const writes = [...sql.matchAll(/['"]\{to\}['"]/g)];
    writes.forEach((match, index) => {
      const previousWrite = index > 0 ? writes[index - 1].index + writes[index - 1][0].length : 0;
      const statementStart = sql.lastIndexOf(";", match.index) + 1;
      const nextWrite = index + 1 < writes.length ? writes[index + 1].index : sql.length;
      const statementEnd = sql.indexOf(";", match.index);
      const behind = sql.slice(Math.max(previousWrite, statementStart), match.index);
      const ahead = sql.slice(match.index, Math.min(nextWrite, statementEnd < 0 ? sql.length : statementEnd));
      const action = [...behind.matchAll(/->>\s*['"]key['"]\s*=\s*'([\w-]+)'/g)].pop();
      const target = /'"([\w-]+)"'/.exec(ahead);
      if (action && target) found.push({ action: action[1], target: target[1] });
    });
    return found;
  }

  for (const name of readdirSync(migrationsDir)) {
    if (!name.endsWith(".sql")) continue;
    const sql = readFileSync(path.join(migrationsDir, name), "utf8");
    if (!sql.includes("workflow_registry_modules")) continue;

    // A retarget writes the jsonb path {to}. Comments are stripped first so PROSE describing a
    // past retarget cannot trip the guard — a lesson from a sibling test that matched its own
    // explanatory comment.
    const code = sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");

    for (const hit of scrapeRetargets(code)) {
      retargets.push({ action: hit.action, file: name, target: hit.target });
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
  // Run the SAME scraper section 2 runs. This used to be a hand-copied duplicate of it, which
  // could pass while the real loop above had stopped matching anything.
  const seen = scrapeRetargets(synthetic);
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
