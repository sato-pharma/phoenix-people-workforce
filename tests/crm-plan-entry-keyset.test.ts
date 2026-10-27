import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { planEntryKeyOf, planEntryKeysetAfter, type PlanEntryKey } from "../src/lib/crm/plan-entry-keyset.ts";
import { stripComments } from "./support/comment-strip.ts";

// STAGE 2a, 28 Oct 2026. The two heaviest statements in Phoenix were `scanPlanEntries` reading a month
// for ten hr ids or fifty CRM ids, OFFSET-paged and ordered by `crm_plan_entry_id` alone — and that id
// is NOT unique in `crm_plan_entries_unified`: the Phoenix branch repeats a plan item's id for every
// rep who sat on its territory that day (103 extra rows on production, 779 rows under 767 ids on
// 27 Oct). Every paged plan read now walks the (plan_date, crm_plan_entry_id, agent_hr_id NULLS LAST)
// keyset instead. This suite runs the cursor's real PostgREST filter against an in-memory view full of
// tied ids and null hr ids, at page sizes small enough that a tie straddles every boundary, and pins
// that the readers use it.

type Row = { plan_date: string; crm_plan_entry_id: number; agent_hr_id: string | null };

/** Postgres's order for the keyset: day, entry id, hr id with nulls last. */
function compareKey(left: Row, right: Row, byDate: boolean): number {
  if (byDate && left.plan_date !== right.plan_date) return left.plan_date < right.plan_date ? -1 : 1;
  if (left.crm_plan_entry_id !== right.crm_plan_entry_id) return left.crm_plan_entry_id - right.crm_plan_entry_id;
  if (left.agent_hr_id === right.agent_hr_id) return 0;
  if (left.agent_hr_id === null) return 1;
  if (right.agent_hr_id === null) return -1;
  return left.agent_hr_id < right.agent_hr_id ? -1 : 1;
}

// ── A small evaluator for the PostgREST logic tree the cursor writes ───────────────────────────────
// `col.op.value`, `and(...)`, `or(...)`, double-quoted values with backslash escapes. Only what the
// cursor emits; anything else throws, so a new operator cannot pass by being ignored.

/** Split at the commas that are not inside parentheses or quotes. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      current += char;
      if (char === "\\") {
        current += text[index + 1];
        index += 1;
      } else if (char === '"') {
        quoted = false;
      }
      continue;
    }
    if (char === '"') quoted = true;
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

function unquote(value: string): string {
  if (!value.startsWith('"')) return value;
  assert.ok(value.endsWith('"'), `an unterminated quoted value: ${value}`);
  return value.slice(1, -1).replace(/\\(.)/g, "$1");
}

function evaluate(expression: string, row: Row): boolean {
  const logic = /^(and|or)\(([\s\S]*)\)$/.exec(expression);
  if (logic) {
    const terms = splitTopLevel(logic[2]).map((term) => evaluate(term, row));
    return logic[1] === "and" ? terms.every(Boolean) : terms.some(Boolean);
  }
  const condition = /^(plan_date|crm_plan_entry_id|agent_hr_id)\.(gt|eq|is)\.([\s\S]+)$/.exec(expression);
  assert.ok(condition, `the cursor wrote a condition this suite does not know: ${expression}`);
  const [, column, operator, raw] = condition;
  const cell = row[column as keyof Row];
  if (operator === "is") {
    assert.equal(raw, "null", `only "is.null" is expected, got ${expression}`);
    return cell === null;
  }
  // SQL: a comparison with NULL is never true.
  if (cell === null) return false;
  const value = column === "crm_plan_entry_id" ? Number(unquote(raw)) : unquote(raw);
  if (operator === "eq") return cell === value;
  return typeof cell === "number" ? cell > (value as number) : (cell as string) > (value as string);
}

/** Read a table the way the readers do: ordered pages, each after the last row's whole key. */
function walk(table: readonly Row[], pageSize: number, byDate: boolean): Row[] {
  const ordered = [...table].sort((left, right) => compareKey(left, right, byDate));
  const read: Row[] = [];
  let cursor: Row | null = null;
  for (let guard = 0; guard < table.length + 2; guard += 1) {
    const filter: string | null = cursor === null ? null : planEntryKeysetAfter(cursor, { byDate });
    const from: string | null = cursor === null || !byDate ? null : cursor.plan_date;
    const page: Row[] = ordered
      .filter((row) => from === null || row.plan_date >= from)
      .filter((row) => filter === null || evaluate(`or(${filter})`, row))
      .slice(0, pageSize);
    read.push(...page);
    if (page.length < pageSize) return read;
    cursor = page[page.length - 1];
  }
  throw new Error("the keyset never ended — a page did not move the cursor forward");
}

function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A view-shaped table: vendor rows with unique positive ids (some with no hr id), and Phoenix rows
 * whose negative item ids repeat for two or three reps on a seat — the ties the old cursor fell into. */
function viewLikeTable(seed: number): Row[] {
  const random = prng(seed);
  const days = ["2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28"];
  const reps = ["B-101", "B-102", "b-103", "B-104", 'B-"9', "B-\\7"];
  const rows: Row[] = [];
  let vendorId = 8_548_343;
  for (const day of days) {
    for (let index = 0; index < 9; index += 1) {
      vendorId += 1 + Math.floor(random() * 3);
      rows.push({ agent_hr_id: random() < 0.3 ? null : reps[Math.floor(random() * reps.length)], crm_plan_entry_id: vendorId, plan_date: day });
    }
    for (let item = 0; item < 7; item += 1) {
      const id = -1 - Math.floor(random() * 4_503_460_478_014_710);
      const sitting = [...reps].sort(() => random() - 0.5).slice(0, 1 + Math.floor(random() * 3));
      for (const rep of sitting) rows.push({ agent_hr_id: rep, crm_plan_entry_id: id, plan_date: day });
    }
    // One id shared by a rep with an hr id and one without — the null must still come after it.
    rows.push({ agent_hr_id: "B-101", crm_plan_entry_id: -42, plan_date: day });
    rows.push({ agent_hr_id: null, crm_plan_entry_id: -42, plan_date: day });
  }
  return rows;
}

function runCursorTextTests() {
  assert.equal(
    planEntryKeysetAfter({ agent_hr_id: "B-10", crm_plan_entry_id: -1067192245473, plan_date: "2026-10-27" }, { byDate: true }),
    'plan_date.gt.2026-10-27,and(plan_date.eq.2026-10-27,crm_plan_entry_id.gt.-1067192245473),and(plan_date.eq.2026-10-27,and(crm_plan_entry_id.eq.-1067192245473,or(agent_hr_id.gt."B-10",agent_hr_id.is.null)))',
    "a date window walks day, then id, then hr id — and a null hr id still follows a named one",
  );
  assert.equal(
    planEntryKeysetAfter({ agent_hr_id: null, crm_plan_entry_id: 9488980, plan_date: "2026-10-27" }, { byDate: true }),
    "plan_date.gt.2026-10-27,and(plan_date.eq.2026-10-27,crm_plan_entry_id.gt.9488980)",
    "nothing follows a null hr id inside its own (day, id), so the hr clause is dropped",
  );
  assert.equal(
    planEntryKeysetAfter({ agent_hr_id: 'B-"9\\', crm_plan_entry_id: 7, plan_date: null }, { byDate: false }),
    'crm_plan_entry_id.gt.7,and(crm_plan_entry_id.eq.7,or(agent_hr_id.gt."B-\\"9\\\\",agent_hr_id.is.null))',
    "a day or month read walks id then hr id, and the hr id is quoted and escaped",
  );
  assert.throws(() => planEntryKeysetAfter({ agent_hr_id: null, crm_plan_entry_id: null, plan_date: "2026-10-27" }, { byDate: true }), /integer crm_plan_entry_id/);
  assert.throws(() => planEntryKeysetAfter({ agent_hr_id: null, crm_plan_entry_id: "7)", plan_date: "2026-10-27" }, { byDate: true }), /integer crm_plan_entry_id/);
  assert.throws(() => planEntryKeysetAfter({ agent_hr_id: null, crm_plan_entry_id: 7, plan_date: "2026-10-27,x" }, { byDate: true }), /YYYY-MM-DD plan_date/);
}

function runWalkTests() {
  for (const seed of [1, 2, 3, 7, 28]) {
    const table = viewLikeTable(seed);
    const keys = table.map((row) => planEntryKeyOf(row as PlanEntryKey));
    assert.equal(new Set(keys).size, table.length, `seed ${seed}: the fixture's whole keys are unique, as the view's are`);
    assert.ok(
      new Set(table.map((row) => `${row.plan_date}|${row.crm_plan_entry_id}`)).size < table.length,
      `seed ${seed}: the fixture carries tied (day, id) pairs, or the walk proves nothing`,
    );
    for (const pageSize of [1, 2, 3, 5, 8, 13, 1000]) {
      assert.deepEqual(
        walk(table, pageSize, true),
        [...table].sort((left, right) => compareKey(left, right, true)),
        `seed ${seed}, page ${pageSize}: a date window returns every row once, in keyset order`,
      );
      for (const day of new Set(table.map((row) => row.plan_date))) {
        const oneDay = table.filter((row) => row.plan_date === day);
        assert.deepEqual(
          walk(oneDay, pageSize, false),
          [...oneDay].sort((left, right) => compareKey(left, right, false)),
          `seed ${seed}, page ${pageSize}, ${day}: a day read returns every row once, in (id, hr id) order`,
        );
      }
    }
  }
  assert.notEqual(
    planEntryKeyOf({ agent_hr_id: null, crm_plan_entry_id: 1, plan_date: "2026-10-27" }),
    planEntryKeyOf({ agent_hr_id: "", crm_plan_entry_id: 1, plan_date: "2026-10-27" }),
    "a null hr id and an empty one are two keys",
  );
}

/** The code of a top-level function, comments blanked, from its declaration to its closing brace. */
function functionCode(path: string, declaration: string): string {
  const source = stripComments(readFileSync(path, "utf8").replace(/\r\n/g, "\n"));
  const start = source.indexOf(declaration);
  assert.ok(start >= 0, `${declaration} must still exist in ${path}`);
  const rest = source.slice(start);
  const end = rest.indexOf("\n}\n");
  return rest.slice(0, end > 0 ? end : rest.length);
}

function runReaderWiringGuards() {
  const scan = functionCode("src/lib/crm/rep-doctor-lists.ts", "export async function scanPlanEntries");
  const board = functionCode("src/lib/crm/plan-board.ts", "async function fetchPlanRows");
  for (const [name, body] of [["scanPlanEntries", scan], ["fetchPlanRows", board]] as const) {
    assert.doesNotMatch(body, /\.range\(/, `${name} pages by keyset, never by OFFSET`);
    assert.doesNotMatch(body, /\.gt\("crm_plan_entry_id"/, `${name} never pages on the entry id alone — it is not unique in the view`);
    assert.match(
      body,
      /\.order\("crm_plan_entry_id", \{ ascending: true \}\)\s+\.order\("agent_hr_id", \{ ascending: true, nullsFirst: false \}\)/,
      `${name} orders by the cursor's own key, hr id nulls last`,
    );
  }
  assert.match(scan, /query = query\.or\(planEntryKeysetAfter\(cursor, \{ byDate: true \}\)\);/, "a named-agent window walks the date keyset");
  assert.match(scan, /\.gte\("plan_date", cursor\?\.plan_date \?\? from\)/, "each later page starts at the last day read, so the view groups no earlier day");
  assert.match(scan, /\.order\("plan_date", \{ ascending: true \}\)\s+\.order\("crm_plan_entry_id"/, "the named-agent window orders by day first");
  assert.match(scan, /query = query\.or\(planEntryKeysetAfter\(cursor, \{ byDate: false \}\)\);/, "a day walks the (id, hr id) keyset");
  assert.match(scan, /const key = planEntryKeyOf\(row\);/, "a union of two passes deduplicates on the whole key, never the entry id");
  assert.match(board, /\.gte\("plan_date", cursor\?\.plan_date \?\? input\.window\.start\)/, "the board's date window starts each page at the last day read");
  assert.match(board, /query = query\.order\("plan_date", \{ ascending: true \}\);/, "the board's date window orders by day first");
  assert.equal((board.match(/planEntryKeysetAfter\(cursor, \{ byDate: false \}\)/g) ?? []).length, 2, "the board's day read and month read walk (id, hr id)");
  assert.equal((board.match(/planEntryKeysetAfter\(cursor, \{ byDate: true \}\)/g) ?? []).length, 1, "the board's named date window walks the date keyset");
}

export function runCrmPlanEntryKeysetTests() {
  runCursorTextTests();
  runWalkTests();
  runReaderWiringGuards();
  console.log("crm plan entry keyset: OK");
}
