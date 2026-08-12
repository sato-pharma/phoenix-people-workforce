import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

/**
 * THE MIGRATION CHAIN MUST REPLAY FROM SCRATCH.
 *
 * WHAT THIS PINS. `workflow_registry_modules` stores the direct_orders vocabulary as two jsonb
 * arrays: `statuses` and `actions`. Every action names a `to` status and a list of `from` statuses.
 * If an action ever references a status the module does not declare, `normalizeActions()` throws,
 * `listWorkflowRegistryModules()` catches it, logs, and SKIPS THE WHOLE MODULE — at which point
 * every direct_orders transition refuses and nobody can raise an order. That is the 2026-08-05
 * outage, and it is why every direct-orders migration since carries a loader simulation.
 *
 * WHY THOSE SIMULATIONS WERE NOT ENOUGH. Each one runs against the database it is applied to, so it
 * can only fail at apply time, on whichever environment happens to be next. It cannot answer the
 * question this test asks: does the chain hold at EVERY POINT ALONG THE WAY, for a database being
 * built from nothing?
 *
 * It did not. 20260804210000_direct_orders_held_lane.sql extended the table's CHECK constraint to
 * permit 'held' and 'expired' and appended three actions naming them, but never declared those
 * statuses in the registry. A fresh database therefore reached
 * 20260805150000_direct_orders_cancel_held.sql — the first file carrying a simulation — and that
 * simulation correctly refused to commit. The chain had been unreplayable for eight days, on every
 * environment, and nothing said so until someone tried.
 *
 * HOW THIS TEST FAILS. Loudly, and on a file it does not understand. A parser that silently skips
 * an unfamiliar statement shape is worse than no parser: it reports "all clear" about files it
 * never read, which is the exact failure mode being fixed here. Every write to the module must
 * classify into one of the four known shapes or this test fails and asks for the shape to be added.
 */

type ParsedAction = { key: string; to: string; from: string[] };

/** Extract the balanced parenthesised argument list of `fn(` starting at `open`. */
function balanced(source: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = source[i + 1] === quote ? (i += 1, quote) : null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error("unbalanced parentheses while parsing a jsonb_build_* call");
}

/** `jsonb_build_object('key', 'x', 'to', 'y', 'from', jsonb_build_array('a','b'), …)` → the fields we care about. */
function parseBuildObjects(source: string): Array<Record<string, string | string[]>> {
  const out: Array<Record<string, string | string[]>> = [];
  const re = /jsonb_build_object\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    const body = balanced(source, match.index + "jsonb_build_object".length);
    // Only top-level objects: a nested one is re-found by the regex anyway, and would double-count.
    if (/^\s*'/.test(body) === false) continue;
    const fields: Record<string, string | string[]> = {};
    // Scalar pairs: 'name', 'value'
    for (const pair of body.matchAll(/'((?:[^']|'')*)'\s*,\s*'((?:[^']|'')*)'/g)) {
      const name = pair[1].replace(/''/g, "'");
      if (name in fields) continue;
      fields[name] = pair[2].replace(/''/g, "'");
    }
    // Array pairs: 'name', jsonb_build_array('a', 'b')
    for (const pair of body.matchAll(/'((?:[^']|'')*)'\s*,\s*jsonb_build_array\(/g)) {
      const name = pair[1].replace(/''/g, "'");
      const arrayBody = balanced(body, pair.index! + pair[0].length - 1);
      fields[name] = Array.from(arrayBody.matchAll(/'((?:[^']|'')*)'/g)).map((m) => m[1].replace(/''/g, "'"));
    }
    out.push(fields);
  }
  return out;
}

/** `'[ {...} ]'::jsonb` → parsed JSON. */
function parseJsonLiteralAfter(source: string, from: number): unknown[] {
  const start = source.indexOf("'[", from);
  if (start < 0) throw new Error("expected a '[ … ]'::jsonb literal");
  const end = source.indexOf("]'", start);
  if (end < 0) throw new Error("unterminated '[ … ]'::jsonb literal");
  return JSON.parse(source.slice(start + 1, end + 1).replace(/''/g, "'")) as unknown[];
}

export async function runDirectOrderRegistryReplayTests() {
  const dir = new URL("../supabase/migrations/", import.meta.url);
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort(); // filename order IS apply order — the timestamps are the version.

  const declared = new Set<string>();
  const seenActions = new Map<string, ParsedAction>();
  let filesTouchingModule = 0;
  let foundationSeen = false;

  for (const file of files) {
    const sql = readFileSync(new URL(file, dir), "utf8");
    // Strip line comments so prose mentioning a status name cannot be mistaken for a declaration —
    // several of these files discuss 'held' and 'expired' at length in their headers.
    const code = sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    if (!code.includes("workflow_registry_modules")) continue;
    if (!code.includes("'direct_orders'")) continue; // another module's migration
    filesTouchingModule += 1;

    const addedStatuses: string[] = [];
    const addedActions: ParsedAction[] = [];
    let recognised = false;

    // ── Shape 1: the foundation INSERT, statuses and actions as JSON literals ──
    if (/insert\s+into\s+public\.workflow_registry_modules/i.test(code)) {
      recognised = true;
      foundationSeen = true;
      const statusesAt = code.indexOf("'direct_orders',");
      const statuses = parseJsonLiteralAfter(code, statusesAt) as Array<{ key: string }>;
      for (const status of statuses) addedStatuses.push(status.key);
      const actionsAt = code.indexOf("]'", code.indexOf("'[", statusesAt)) + 2;
      const actions = parseJsonLiteralAfter(code, actionsAt) as Array<{ key: string; to: string; from?: string[] }>;
      for (const action of actions) addedActions.push({ key: action.key, to: action.to, from: action.from ?? [] });
    }

    // ── Shape 2: append statuses via jsonb_build_array/object ─────────────────
    //
    // ANCHORED ON THE COLUMN, NOT ON `set`. One UPDATE may set both columns —
    // `set statuses = statuses || …, actions = actions || …` — and a pattern requiring the column
    // to follow `set` directly then matches only whichever comes first. That is not hypothetical:
    // it happened while writing this file. Merging held_lane's two statements into one (the trigger
    // bumps `version` per UPDATE, so one statement is correct) silently dropped its three actions
    // from the walk, and the per-file `recognised` flag still said the file had been understood.
    const appendsStatuses = /statuses\s*=\s*statuses\s*\|\|/i.test(code);
    const appendsActions = /actions\s*=\s*actions\s*\|\|/i.test(code);

    if (appendsStatuses) {
      recognised = true;
      for (const obj of parseBuildObjects(code)) {
        // A status object has a key and no `to` — that is what distinguishes it from an action.
        if (typeof obj.key === "string" && obj.to === undefined) addedStatuses.push(obj.key);
      }
    }

    // ── Shape 3: append actions, either literal or built ──────────────────────
    if (appendsActions) {
      recognised = true;
      const appendAt = code.search(/actions\s*=\s*actions\s*\|\|/i);
      if (/actions\s*=\s*actions\s*\|\|\s*'\[/i.test(code)) {
        const actions = parseJsonLiteralAfter(code, appendAt) as Array<{ key: string; to: string; from?: string[] }>;
        for (const action of actions) addedActions.push({ key: action.key, to: action.to, from: action.from ?? [] });
      } else {
        for (const obj of parseBuildObjects(code.slice(appendAt))) {
          if (typeof obj.key === "string" && typeof obj.to === "string") {
            addedActions.push({ key: obj.key, to: obj.to, from: Array.isArray(obj.from) ? obj.from : [] });
          }
        }
      }
    }

    // PER COLUMN, not per file. "The file was recognised" is not the same claim as "everything the
    // file appends was read", and only the second one makes the walk below trustworthy.
    if (appendsStatuses) {
      assert.ok(
        addedStatuses.length > 0,
        `${file} appends to statuses but this test extracted none — the parser missed the shape`,
      );
    }
    if (appendsActions) {
      assert.ok(
        addedActions.length > 0,
        `${file} appends to actions but this test extracted none — the parser missed the shape`,
      );
    }

    // ── Shape 4: transform existing actions in place (the SFE-rung allowedRoles fix) ──
    if (!recognised && /set\s*\n?\s*actions\s*=\s*\(/i.test(code)) {
      recognised = true;
      // Permitted ONLY because it cannot change the vocabulary. If a future in-place rewrite starts
      // setting `to`/`from`, this stops being safe to wave through and the test says so.
      assert.doesNotMatch(
        code,
        /'to'\s*,|"to"\s*:|'from'\s*,|"from"\s*:/,
        `${file}: an in-place actions rewrite that touches 'to'/'from' changes the vocabulary — ` +
          "teach this test to parse it rather than letting it through",
      );
    }

    assert.ok(
      recognised,
      `${file} writes the direct_orders registry in a shape this test does not recognise. ` +
        "Add the shape — a parser that silently skips a statement reports 'all clear' about a file " +
        "it never read, which is exactly how the held-lane gap survived eight days.",
    );

    for (const status of addedStatuses) declared.add(status);
    for (const action of addedActions) seenActions.set(action.key, action);

    // ── THE INVARIANT, checked after EVERY file rather than only at the end ───
    for (const action of seenActions.values()) {
      for (const status of [action.to, ...action.from]) {
        assert.ok(
          declared.has(status),
          `REPLAY BREAKS AT ${file}: action "${action.key}" references status "${status}", which no ` +
            "migration has declared yet. A database built from scratch reaches this point with an " +
            "invalid module, normalizeActions() throws, and the loader skips direct_orders entirely — " +
            "every transition refuses and nobody can raise an order. Declare the status in the same " +
            "migration that first references it, BEFORE the action is appended.",
        );
      }
    }
  }

  assert.ok(foundationSeen, "the foundation migration must have been parsed — the walk found no insert");
  assert.ok(
    filesTouchingModule >= 8,
    `only ${filesTouchingModule} migrations were parsed as touching the direct_orders registry; the ` +
      "chain is longer than that, so the filter is dropping files it should be checking",
  );

  // The vocabulary the chain ends on. Named explicitly so a status silently disappearing from the
  // registry — which would break every action referencing it — fails here rather than in production.
  for (const status of [
    "draft",
    "pending_approval",
    "approved",
    "rejected",
    "returned",
    "reversed",
    "held",
    "expired",
    "cancelled",
  ]) {
    assert.ok(declared.has(status), `the replayed chain must end with "${status}" declared`);
  }
  assert.ok(seenActions.has("repair_approval_rung"), "the newest action must be present in the replay");

  console.log(
    `  direct-orders registry replay: ${filesTouchingModule} migrations walked in order, ` +
      `${declared.size} statuses / ${seenActions.size} actions, invariant held at every step`,
  );
}
