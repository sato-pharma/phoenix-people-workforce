import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

// Recurrence guard for the "a resigned occupant is still the sitting occupant" class.
//
// Root cause shape (Anti Infective NSM B-157, resigned 2026-07-13): a vacated seat keeps
// BOTH the departed person's closed span and a vacant placeholder span. The departed
// person is therefore still the newest NON-NULL occupancy row for that seat, so any
// resolver written as
//     select occupant_hr_id from au.occupancy_history where seat_id = X
//     order by occupancy_id desc limit 1
// keeps naming them. The correct resolvers are period-aware ("the span covering the
// as-of date", au.f_seat_occupant_asof) or current-state ("the open span",
// effective_to is null). The same versioning applies to au.line_area_map, where a
// missing filter is worse than misattribution: the join matches the superseded AND the
// current mapping, so that area's sales are counted twice.
//
// This guard reads supabase/migrations and reasons about the LATEST definition of each
// object, because `create or replace` means the last migration wins — asserting over
// every historical definition would flag bodies the database no longer has.
export function runAuSeatOccupantResolverTests() {
  const dir = "supabase/migrations";
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .filter((f) => /^\d{14}_/.test(f))
    .sort();

  // ── Slice each migration into (object name -> definition body) ──────────────
  // Only the object's OWN statement, so unrelated SQL further down the file can't
  // supply a filter the definition itself is missing.
  const HEADER = /^create\s+(?:or\s+replace\s+)?(function|view)\s+([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)/gim;

  /** Text of one create statement, stopping at its real terminator. */
  function statementBody(sql: string, start: number, kind: string): string {
    const rest = sql.slice(start);
    if (kind === "function") {
      // Dollar-quoted body: cut just after the matching closing tag.
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
  const allSqlNoComments: Array<{ file: string; sql: string }> = [];

  for (const file of files) {
    const raw = readFileSync(`${dir}/${file}`, "utf8");
    allSqlNoComments.push({ file, sql: stripLineComments(raw) });
    HEADER.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = HEADER.exec(raw)) !== null) {
      const [, kind, name] = match;
      const body = stripLineComments(statementBody(raw, match.index, kind));
      latest.set(name.toLowerCase(), { file, body: body.toLowerCase() });
    }
  }

  // ── Sanity: the scan is actually reading the live migrations directory ──────
  // Without this a path/regex regression would make every assertion below vacuously
  // true (the failure mode where a guard reads an archived tree and passes green).
  for (const expected of [
    "au.v_org_tree",
    "au.v_org_structure_kpis",
    "au.f_monthly_attribution",
    "au.f_monthly_achievement",
    "au.f_seat_occupant_asof",
    "au.f_line_area_map_asof",
    "au.sync_area_state_for_seat",
    "au.f_line_area_occupancy_drift",
    "public.au_v_line_area_map",
    "public.au_v_line_area_occupancy_drift",
    "public.phx_resign_employee_and_open_vacancy",
  ]) {
    assert.ok(
      latest.has(expected),
      `${expected} must be defined by a migration in ${dir} — if this fails the guard is scanning the wrong tree, not that the object is gone`,
    );
  }
  assert.ok(files.length > 100, `expected the full migration history in ${dir}, saw ${files.length} files`);

  // ── 1. Every current definition that reads a versioned table must filter it ──
  const unguarded: string[] = [];
  for (const [name, { file, body }] of latest) {
    const readsOccupancy = body.includes("au.occupancy_history");
    const readsLineAreaMap = /\bau\.line_area_map\b/.test(body);
    if (!readsOccupancy && !readsLineAreaMap) continue;
    if (!body.includes("effective_to")) unguarded.push(`${name} (${file})`);
  }
  assert.deepEqual(
    unguarded,
    [],
    "au.occupancy_history and au.line_area_map are period-versioned: the CURRENT definition of anything " +
      "reading them must filter on effective_to (open span) or resolve as-of a date. Unguarded: " +
      unguarded.join(", "),
  );

  // ── 2. The naive "newest row wins" resolver must never appear ───────────────
  const naive = allSqlNoComments
    // [^;] already spans newlines, so no dotAll flag is needed (and `s` would need es2018).
    .filter(({ sql }) => /order\s+by[^;]{0,200}occupancy_id[^;]{0,200}\bdesc\b/i.test(sql))
    .map(({ file }) => file);
  assert.deepEqual(
    naive,
    [],
    "ordering au.occupancy_history by occupancy_id desc resolves a VACATED seat to its departed " +
      `occupant — use au.f_seat_occupant_asof(seat_id, date) instead. Offending migrations: ${naive.join(", ")}`,
  );

  // ── 3. The canonical resolver implements the owner's credit rule ────────────
  //
  // CHANGED 2026-08-01 by owner ruling: credit follows TODAY'S area→person wiring, except that a
  // departed rep keeps the credit for months they actually worked. That is
  //     coalesce(occupant today, occupant at period end)
  // and it supersedes the pure as-of window this section used to pin.
  //
  // It also removes the old `effective_from asc` arm. That arm existed for the seed-baseline case
  // (p_asof precedes the seat's first span) on the reasoning that dropping those periods "would lose
  // their sales entirely" — but it did not merely retain them, it attributed them to the EARLIEST
  // occupant the seat ever had, i.e. someone who never held it in that period. Measured on
  // production it was firing on 100 of 525 (area × period) rows; under the new rule 83 of those
  // resolve to the correct person via the today-arm and only 17 become genuinely unowned. Those 17
  // are not lost either — attribution is area-first, so the value still belongs to its area and only
  // the person is absent, which is the honest answer when nobody holds the seat and nobody did.
  const resolver = latest.get("au.f_seat_occupant_asof")!;
  const normalized = resolver.body.replace(/\s+/g, " ");

  // "Today" must be Cairo's today, not the server's. `latest` lowercases every body, hence the
  // lowercased zone name here.
  //
  // CHANGED 2026-08-01 (20260801180000_cairo_date_in_lifecycle_and_seat_functions.sql): the today-arm
  // used a bare `current_date`. Production Postgres runs TimeZone = UTC, while this function's WRITER
  // (20260728010000_au_wire_hire_into_seat_on_vacancy_fill.sql:130) stamps effective_from in Cairo.
  // Writer-Cairo against reader-UTC means that between Cairo 00:00 and 03:00 — UTC 21:00-24:00 of the
  // previous day — a span opened today is invisible to arm 1. Arm 1 misses, arm 2 answers, and SoS
  // credit silently moves to a different person for those three hours every night. The assertions
  // below therefore pin the ZONED expression: the arm order below is the owner's credit rule, and
  // this is the clock it must read.
  const TODAY_CAIRO = "(now() at time zone 'africa/cairo')::date";
  assert.ok(
    normalized.includes(`oh.effective_from <= ${TODAY_CAIRO}`),
    "arm 1: au.f_seat_occupant_asof must resolve today's occupant first (today's wiring wins), " +
      "and today must be Cairo's today — a bare current_date is the server's UTC day",
  );
  assert.ok(
    !normalized.includes("current_date"),
    "no arm may read an unzoned current_date: the DB is on UTC and the writer stamps Cairo, so an " +
      "unzoned read moves seat credit between people for three hours every night",
  );
  assert.ok(
    normalized.includes("oh.effective_from <= p_asof"),
    "arm 2: it must fall back to the occupant at p_asof, so a departed rep keeps historical credit",
  );
  assert.ok(
    normalized.indexOf(`oh.effective_from <= ${TODAY_CAIRO}`) < normalized.indexOf("oh.effective_from <= p_asof"),
    "today's wiring must be the FIRST coalesce arm — reversed, a transfer would never re-point history",
  );
  assert.ok(
    !/effective_from\s+asc/i.test(normalized),
    "the earliest-ever fallback must stay gone: it invented an owner who never held the seat that period",
  );
  assert.ok(
    normalized.includes(`(oh.effective_to is null or oh.effective_to > ${TODAY_CAIRO})`) &&
      normalized.includes("(oh.effective_to is null or oh.effective_to > p_asof)"),
    "both arms keep the half-open [effective_from, effective_to) window",
  );

  const lamResolver = latest.get("au.f_line_area_map_asof")!;
  assert.ok(
    lamResolver.body.includes("distinct on (m.line_code, m.area_code)"),
    "au.f_line_area_map_asof must return at most one row per (line_code, area_code) — that is what makes " +
      "the attribution joins fan-out-proof after an area is re-mapped to a different seat",
  );

  // ── 4. The attribution engine must reuse the resolvers, not re-inline them ──
  for (const name of ["au.f_monthly_attribution", "au.f_monthly_achievement"]) {
    const { body } = latest.get(name)!;
    assert.ok(
      body.includes("au.f_seat_occupant_asof"),
      `${name} must resolve occupants through au.f_seat_occupant_asof`,
    );
    assert.ok(
      !body.includes("au.occupancy_history"),
      `${name} must not re-inline the occupancy window predicate — six copies is how the naive variant got in`,
    );
    assert.ok(
      body.includes("au.f_line_area_map_asof"),
      `${name} must resolve the (line, area) -> seat mapping through au.f_line_area_map_asof`,
    );
    assert.ok(
      !/\bau\.line_area_map\b/.test(body),
      `${name} must not join au.line_area_map directly — an unfiltered join double-counts sales after a re-map`,
    );
  }

  // ── 5. The current-state views resolve the OPEN span, not the newest one ────
  for (const name of ["au.v_org_tree", "au.v_org_structure_kpis"]) {
    const { body } = latest.get(name)!;
    assert.ok(
      /o\.effective_to\s+is\s+null/.test(body),
      `${name} shows CURRENT occupancy and must join au.occupancy_history on effective_to is null`,
    );
  }
  assert.ok(
    /m\.effective_to\s+is\s+null/.test(latest.get("public.au_v_line_area_map")!.body),
    "public.au_v_line_area_map is the current-state wrapper the Territory drilldown, monthly targets and the " +
      "employee region resolver all read — it must expose only the mapping in force now",
  );

  // ── 6. Resignation vacates the seat via the normalized HR_ID ────────────────
  const resign = latest.get("public.phx_resign_employee_and_open_vacancy")!;
  assert.ok(
    resign.body.includes("occupant_canonical_hr_id = lower(btrim(p_employee_hr_id))"),
    "phx_resign_employee_and_open_vacancy must find the resigning employee's seat via the generated " +
      "occupant_canonical_hr_id — a raw occupant_hr_id comparison misses on any casing/whitespace " +
      "difference and leaves the departed occupant sitting on the seat",
  );
  assert.ok(
    /effective_to\s+is\s+null/.test(resign.body) && resign.body.includes("au.resign_occupant"),
    "phx_resign_employee_and_open_vacancy must close the OPEN span via au.resign_occupant",
  );
  // A resigned employee cannot occupy ANY seat, so EVERY open person-span of theirs must
  // close — not just the first one a `limit 1` happens to return. au.occupancy_history has
  // no per-hr_id uniqueness (B-1, the sole ACTING_DM, holds two open spans at once), so a
  // single-row vacate leaves the second seat showing a departed occupant forever. Fixed in
  // 20260728100000 by looping over all open spans.
  assert.ok(
    /\bfor\s+v_seat_id\s+in\b/.test(resign.body) && /\bloop\b/.test(resign.body),
    "phx_resign_employee_and_open_vacancy must LOOP over every open person-span (for v_seat_id in ... loop), " +
      "not vacate a single row — the model's one dual-seat occupant would otherwise keep a stale occupant on the second seat",
  );
  assert.ok(
    !/\blimit\s+1\b/.test(resign.body),
    "phx_resign_employee_and_open_vacancy must not vacate the au seat with `limit 1` — that closes only one of a " +
      "multi-seat occupant's seats and (without an ORDER BY) does so non-deterministically",
  );

  // The Approvals Hub path (runResignationWorkflow "complete") cannot call the RPC above —
  // it would insert a duplicate resignation row and a duplicate vacancy — so step 5 is also
  // published on its own as public.phx_vacate_au_seats_for_employee. Both copies of the
  // vacate must satisfy the same three properties, or the second path silently reintroduces
  // the stale-occupant bug the first one was fixed for.
  const vacate = latest.get("public.phx_vacate_au_seats_for_employee");
  assert.ok(
    vacate,
    "public.phx_vacate_au_seats_for_employee must be defined by a migration — it is the only route from " +
      "TypeScript into the au model (schema au is not exposed on PostgREST) and the Approvals Hub " +
      "resignation-complete path depends on it to empty the departing employee's seat",
  );
  for (const [pattern, why] of [
    [
      /occupant_canonical_hr_id = lower\(btrim\(p_employee_hr_id\)\)/,
      "must match on the generated canonical HR_ID — a raw occupant_hr_id comparison misses on any " +
        "casing/whitespace difference and then silently vacates nothing at all",
    ],
    [
      /effective_to\s+is\s+null/,
      "must close the OPEN span only — au.occupancy_history is period-versioned",
    ],
    [
      /\bfor\s+v_seat_id\s+in\b[\s\S]*\bloop\b/,
      "must LOOP over every open person-span, because the model's one dual-seat occupant would otherwise " +
        "keep a departed occupant on the second seat",
    ],
    [
      /au\.resign_occupant\(/,
      "must vacate through au.resign_occupant, which is what also moves the area to 'vacant_will_hire' " +
        "via au.sync_area_state_for_seat — a direct write would skip that",
    ],
  ] as Array<[RegExp, string]>) {
    assert.ok(pattern.test(vacate!.body), `public.phx_vacate_au_seats_for_employee ${why}`);
  }
  assert.ok(
    !/\blimit\s+1\b/.test(vacate!.body),
    "public.phx_vacate_au_seats_for_employee must not vacate with `limit 1` — same defect as above, on the " +
      "path that has no transaction wrapping it",
  );

  // ── 7. area_state follows the seat, in BOTH directions ──────────────────────
  // Vacating a seat without releasing its area left six July-2026 rep areas reading
  // 'occupied' with nobody in them. Fixing only the resign side would have inverted the
  // same bug on the next hire, so both transitions are pinned here together.
  const flat = (name: string) => latest.get(name)!.body.replace(/\s+/g, " ");

  const sync = flat("au.sync_area_state_for_seat");
  for (const [pattern, why] of [
    [
      /m\.effective_to\s+is\s+null/,
      "au.line_area_map is period-versioned — only the row in force may move; a superseded mapping is history",
    ],
    [
      /m\.rep_seat_id\s*=\s*p_seat_id/,
      "the match must key on rep_seat_id — the exact FK au.f_monthly_attribution dereferences, and the reason " +
        "the Others rows (rep_seat_id IS NULL on every one) are excluded structurally rather than by convention",
    ],
    [
      /m\.area_state\s*=\s*p_from_state/,
      "the from-state guard is what makes 'other_permanent' / 'other_line_specific' unreachable even if an " +
        "Others row ever acquired a rep seat — those areas are never hired into and must keep their state",
    ],
    [
      /seat_tier\s*=\s*'rep'/,
      "only REP seats may move an area's state — a departing DM/RSM/NSM leaves their areas still staffed, and " +
        "their own vacancy is already represented by the seat (au.v_org_tree / au.v_org_structure_kpis)",
    ],
  ] as Array<[RegExp, string]>) {
    assert.ok(pattern.test(sync), `au.sync_area_state_for_seat must keep the guard: ${why}`);
  }

  const transitions: Array<[string, string]> = [
    ["au.resign_occupant", "'occupied', 'vacant_will_hire'"],
    ["au.hire_into_seat", "'vacant_will_hire', 'occupied'"],
  ];
  for (const [name, args] of transitions) {
    const body = flat(name);
    assert.ok(
      body.includes(`au.sync_area_state_for_seat(p_seat_id, ${args})`),
      `${name} must move the area through au.sync_area_state_for_seat(p_seat_id, ${args}) — otherwise a vacated ` +
        "area keeps reading as staffed (or, on the hire side, a filled area keeps reading as vacant)",
    );
    assert.ok(
      !/update\s+au\.line_area_map/.test(body),
      `${name} must not write au.line_area_map directly — one guarded helper, not a second copy of the ` +
        "predicate (the six-copy occupancy window is exactly what PR #1395 had to consolidate)",
    );
  }

  // Transfers inherit the maintenance by composition (resign(from) then hire(to)).
  assert.ok(
    !/\bau\.line_area_map\b/.test(flat("au.transfer_occupant")),
    "au.transfer_occupant must keep inheriting area_state maintenance from au.resign_occupant + " +
      "au.hire_into_seat rather than carrying a third copy of the update",
  );

  // ── 8. The reconciler that would have caught this in July ───────────────────
  const drift = flat("au.f_line_area_occupancy_drift");
  for (const kind of [
    "occupied_but_seat_vacant",
    "vacant_but_seat_occupied",
    "staffable_row_without_rep_seat",
    "other_row_with_rep_seat",
    "rep_seat_absent_from_map",
    "seat_label_asserts_occupancy",
  ]) {
    assert.ok(
      drift.includes(`'${kind}'`),
      `au.f_line_area_occupancy_drift must still report '${kind}' — the first two are the bug and its inverse, ` +
        "the rest are the shapes that let either one hide behind a row with nothing to reconcile against",
    );
  }
  assert.ok(
    flat("public.au_v_line_area_occupancy_drift").includes("au.f_line_area_occupancy_drift()"),
    "public.au_v_line_area_occupancy_drift is how scripts/au-line-area-occupancy-reconcile-check.ts reads the " +
      "reconciler — the au schema is not exposed on PostgREST, so the wrapper must stay",
  );

  // ── 9. Occupancy is DERIVED into the label, never stored in it ──────────────
  // au.seats.seat_label baked '(VACANT)' in at seed time and nothing maintained it, so
  // SEAT-PED-DM-CA still read "PEDIA Cairo DM (VACANT)" after PD-0006 was seated —
  // the area_state bug one column over. The label is now a NAME; the state is computed
  // from the open occupancy span at read time, where it cannot go stale.
  const orgTree = flat("au.v_org_tree");
  assert.ok(
    /case\s+when\s+o\.occupant_hr_id\s+is\s+null\s+then\s+t\.seat_label\s*\|\|/.test(orgTree),
    "au.v_org_tree must derive seat_display_label from the OPEN occupancy span — storing an occupancy " +
      "suffix in au.seats.seat_label is what made SEAT-PED-DM-CA read VACANT while PD-0006 sat in it",
  );
  assert.ok(
    orgTree.includes("as seat_display_label"),
    "au.v_org_tree must still expose seat_display_label — it is the only non-stale seat label",
  );
  assert.ok(
    flat("public.au_v_org_tree").includes("au.v_org_tree"),
    "public.au_v_org_tree must be re-created alongside au.v_org_tree — `select *` is expanded at create " +
      "time, so the wrapper does not pick up seat_display_label on its own",
  );
}
