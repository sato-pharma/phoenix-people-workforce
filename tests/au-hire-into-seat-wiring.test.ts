import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

// Regression guard for "au.hire_into_seat has no application caller" (fixed for the
// REPLACEMENT-hire case by supabase/migrations/20260728010000_au_wire_hire_into_seat_on_vacancy_fill.sql).
//
// Design recap: public.position_vacancies.replacement_for_hr_id already links a new hire back
// to exactly who they're replacing (set by the same resignation flow that calls
// au.resign_occupant). When src/lib/employees/vacancy-closer.ts's closeVacancyOnHire() later
// closes that vacancy (status -> 'filled', filled_by_hr_id = the new hire), a trigger on
// public.position_vacancies resolves the departed predecessor's LAST au seat via
// au.f_last_occupied_seat_by_hr_id and re-occupies it via au.hire_into_seat. Brand-new headcount
// (no replacement_for_hr_id) is deliberately out of scope — there is no title -> seat_tier
// mapping anywhere in this codebase, and inventing one here would be the first thing to trust
// job_title for something consequential (src/lib/employees/access-role.ts says explicitly why
// not to: "a job title is descriptive only and is NEVER a permission source").
//
// This guard reads supabase/migrations and reasons about the LATEST definition of each object,
// same technique as tests/au-seat-occupant-resolver.test.ts, for the same reason: `create or
// replace` means the last migration wins.
export function runAuHireIntoSeatWiringTests() {
  const dir = "supabase/migrations";
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .filter((f) => /^\d{14}_/.test(f))
    .sort();

  const HEADER = /^create\s+(?:or\s+replace\s+)?(function|view|trigger)\s+([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?)/gim;

  function statementBody(sql: string, start: number, kind: string): string {
    const rest = sql.slice(start);
    if (kind === "function") {
      const tag = /(\$[a-z_]*\$)/i.exec(rest);
      if (tag) {
        const open = rest.indexOf(tag[1]);
        const close = rest.indexOf(tag[1], open + tag[1].length);
        if (close > 0) return rest.slice(0, close + tag[1].length);
      }
    }
    const semi = rest.indexOf(";");
    return semi > 0 ? rest.slice(0, semi + 1) : rest;
  }

  function stripLineComments(sql: string): string {
    return sql
      .split("\n")
      .map((line) => {
        const idx = line.indexOf("--");
        return idx >= 0 ? line.slice(0, idx) : line;
      })
      .join("\n");
  }

  const latest = new Map<string, { file: string; body: string }>();
  // Keyed separately from `latest`: the FULL lowercased text of whichever file most recently
  // defined each object — revoke/grant statements are separate SQL statements that follow a
  // CREATE FUNCTION's closing dollar-quote, so they are never part of `statementBody`'s slice.
  const fullFileByName = new Map<string, string>();

  for (const file of files) {
    const raw = readFileSync(`${dir}/${file}`, "utf8");
    const rawLower = stripLineComments(raw).toLowerCase();
    HEADER.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = HEADER.exec(raw)) !== null) {
      const [, kind, rawName] = match;
      // The trigger's own header is `create ... trigger <trigger_name> ... on <table>` — the
      // second capture group after "trigger" is the trigger's NAME, not a schema.table, so key
      // it distinctly from function/view names (which are always schema-qualified in this repo).
      const name = kind === "trigger" ? `trigger:${rawName.toLowerCase()}` : rawName.toLowerCase();
      const body = stripLineComments(statementBody(raw, match.index, kind));
      latest.set(name, { file, body: body.toLowerCase() });
      fullFileByName.set(name, rawLower);
    }
  }

  // ── Sanity: the scan is actually reading the live migrations directory ──────
  for (const expected of [
    "au.f_last_occupied_seat_by_hr_id",
    "public.phx_hire_into_seat_on_vacancy_filled",
    "trigger:trg_position_vacancies_hire_into_seat",
  ]) {
    assert.ok(
      latest.has(expected),
      `${expected} must be defined by a migration in ${dir} — if this fails the guard is scanning the wrong tree, not that the object is gone`,
    );
  }

  const flat = (name: string) => latest.get(name)!.body.replace(/\s+/g, " ");

  // ── 1. The seat-resolution helper: correct table, correct normalization, unambiguous ──
  const helper = flat("au.f_last_occupied_seat_by_hr_id");
  for (const [pattern, why] of [
    [/occupant_canonical_hr_id\s*=\s*lower\(btrim\(p_hr_id\)\)/, "must match on the generated occupant_canonical_hr_id, not raw occupant_hr_id — a casing/whitespace difference must not silently miss the predecessor's seat"],
    [/node_type\s*=\s*'person'/, "must exclude vacant_placeholder rows — only a real occupant's span identifies a seat worth re-hiring into"],
    [/effective_to\s+is\s+not\s+null/, "must restrict to CLOSED spans — au.occupancy_history has no per-hr_id uniqueness (confirmed live: an acting-DM occupant already holds 2 simultaneous open person spans), so an open span cannot mean 'the seat they left'"],
    [/order\s+by\s+oh\.effective_to\s+desc/, "must order by effective_to DESC, not effective_from — resign_occupant only ever closes whichever seat a person currently holds, so the most-recently-CLOSED row is the seat held immediately before departure, regardless of how many earlier transfers preceded it"],
  ] as Array<[RegExp, string]>) {
    assert.ok(pattern.test(helper), `au.f_last_occupied_seat_by_hr_id ${why}`);
  }

  // ── 2. The trigger function: replacement-only, fail-safe, observable ────────
  const trg = flat("public.phx_hire_into_seat_on_vacancy_filled");
  for (const [pattern, why] of [
    [/old\.replacement_for_hr_id/, "must read OLD.replacement_for_hr_id, not NEW — closeVacancyOnHire() clears this column to NULL in the SAME update that sets status='filled', so NEW would always be empty"],
    [/au\.f_last_occupied_seat_by_hr_id/, "must resolve the seat through the helper, not re-inline the occupancy-history predicate — that duplication is exactly the class of bug PR #1395 had to consolidate"],
    [/au\.hire_into_seat/, "must hire through au.hire_into_seat, not write au.occupancy_history directly"],
    [/exception\s+when\s+others/, "must catch failures — hiring an employee is business-critical and must never fail because an internal reporting-model side effect threw"],
    [/insert\s+into\s+public\.audit_logs/, "must write an audit_logs row — replacement_for_hr_id is cleared by the same update that fires this trigger, so audit_logs is the only durable record of what this trigger did (au.f_line_area_occupancy_drift cannot detect a silently-skipped hire, since both au tables would simply agree the seat is still vacant)"],
    [/at\s+time\s+zone\s+'africa\/cairo'/, "must extract the effective date via Cairo-local conversion, not a bare ::date cast on a timestamptz — this exact codebase has a documented history of UTC/Cairo date-boundary bugs (see 20260725130000_probation_provision_cairo_timezone_fix.sql)"],
  ] as Array<[RegExp, string]>) {
    assert.ok(pattern.test(trg), `public.phx_hire_into_seat_on_vacancy_filled ${why}`);
  }
  assert.ok(
    !/update\s+au\.line_area_map/.test(trg) && !/insert\s+into\s+au\.occupancy_history/.test(trg),
    "public.phx_hire_into_seat_on_vacancy_filled must not write au tables directly — it must delegate to au.hire_into_seat (which itself calls au.sync_area_state_for_seat), not duplicate that logic",
  );

  // ── 3. The trigger definition: fires only on a genuine fill transition ──────
  const trgDef = flat("trigger:trg_position_vacancies_hire_into_seat");
  assert.ok(
    /after\s+update\s+on\s+public\.position_vacancies/.test(trgDef),
    "the trigger must be AFTER UPDATE ON public.position_vacancies",
  );
  assert.ok(
    /new\.status\s*=\s*'filled'/.test(trgDef) && /old\.status\s+is\s+distinct\s+from\s+'filled'/.test(trgDef),
    "the trigger's WHEN clause must require a transition INTO 'filled' (new='filled' AND old IS DISTINCT FROM 'filled') — firing on every update, or on updates that don't change status, would re-run the hire logic on unrelated edits to an already-filled vacancy",
  );
  assert.ok(
    /execute\s+function\s+public\.phx_hire_into_seat_on_vacancy_filled/.test(trgDef),
    "the trigger must execute public.phx_hire_into_seat_on_vacancy_filled",
  );

  // ── 4. Security: neither new function is directly callable by anon/authenticated ────
  // Revoke/grant are separate statements that follow a function's closing dollar-quote, so
  // they live in the FULL file text, not the per-statement `body` slice used above.
  for (const [name, fnSig] of [
    ["au.f_last_occupied_seat_by_hr_id", "au.f_last_occupied_seat_by_hr_id(text)"],
    ["public.phx_hire_into_seat_on_vacancy_filled", "public.phx_hire_into_seat_on_vacancy_filled()"],
  ] as Array<[string, string]>) {
    const fullText = fullFileByName.get(name)!.replace(/\s+/g, " ");
    const escaped = fnSig.replace(/[.()]/g, "\\$&");
    assert.ok(
      new RegExp(`revoke execute on function ${escaped} from public, anon, authenticated`).test(fullText),
      `${fnSig} must revoke execute from public, anon, authenticated — the public schema's default ACL auto-grants EXECUTE to authenticated on every new function`,
    );
    assert.ok(
      new RegExp(`grant execute on function ${escaped} to service_role`).test(fullText),
      `${fnSig} must grant execute to service_role — otherwise even the intended (trigger-invoked) path has no explicit grant to fall back on`,
    );
  }

  // ── 5. The seat starts on the job offer's start date, never the day they accepted ──
  // Owner, 2026-11-03: "the start date must follow the date, the start date in the job offer, not the
  // date when he accepted". filled_at is the moment the record is created at acceptance.
  assert.ok(
    /select e\.hire_date, .*from public\.employees e/.test(trg),
    "HEADLINE: the seat date must be read from the Employee Master's hire_date, which carries the job offer's start date",
  );
  assert.ok(
    /v_effective_date := v_hire_date/.test(trg),
    "HEADLINE: the Master's hire date must be the date handed to au.hire_into_seat for someone arriving",
  );
  assert.ok(
    !/v_effective_date date := coalesce\( \(new\.filled_at/.test(trg),
    "HEADLINE: the seat date must not default to filled_at, which is the acceptance day",
  );
  assert.ok(
    /v_created_day >= v_fill_day or v_has_accepted_offer/.test(trg),
    "only someone arriving through this fill takes a date before it — a long-standing employee's hire date of years ago must not backdate the seat",
  );

  // A start before the vacant row began closes that row empty, and leaving before the start leaves an
  // empty span: readers treat spans as half-open, so an inverted row would match nothing and read wrong.
  const hire = flat("au.hire_into_seat");
  assert.ok(
    /set effective_to = greatest\(p_effective_date, v_cur\.effective_from\)/.test(hire),
    "HEADLINE: au.hire_into_seat must close the vacant row at the start date, never before that row began",
  );
  assert.ok(
    /values \(p_seat_id,p_hr_id,'person',p_effective_date,'hire'/.test(hire),
    "au.hire_into_seat must keep the person's own date as their start, unclamped — a start before the predecessor's last day is a real hand-over",
  );
  const resign = flat("au.resign_occupant");
  assert.ok(
    /v_end := greatest\(p_effective_date, v_cur\.effective_from\)/.test(resign) &&
      /set effective_to = v_end/.test(resign) &&
      /values \(p_seat_id,null,'vacant_placeholder',v_end,'resign'/.test(resign),
    "HEADLINE: au.resign_occupant must never write an end before the span began — someone who declines before their start leaves an empty span",
  );

  // A later Master correction moves the seat, or the mismatch returns the first time HR corrects a date.
  const follow = flat("public.phx_seat_start_follows_hire_date");
  for (const [pattern, why] of [
    [/set effective_from = new\.hire_date/, "must move the seat's start to the corrected hire date"],
    [/effective_to is null/, "must move only an open span — a closed one is history"],
    [/event_type = 'hire'/, "must move only a hire — a transfer's date is the day of the move"],
    [/old\.hire_date is null or oh\.effective_from = old\.hire_date/, "must move only a span that was following the Master, so a long-standing employee seated on a fill day keeps that day"],
    [/insert into public\.audit_logs/, "must leave an audit row — a hire-date save writes none of its own"],
    [/exception when others/, "must never fail a Master save"],
  ] as Array<[RegExp, string]>) {
    assert.ok(pattern.test(follow), `public.phx_seat_start_follows_hire_date ${why}`);
  }
  assert.ok(
    /after update of hire_date on public\.employees/.test(flat("trigger:trg_employees_seat_start_follows_hire_date")),
    "HEADLINE: a change to the Master's hire date must fire the seat-start trigger",
  );
}
