import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

import { FORM_OPEN_SECONDS_MAX, clampFormOpenSeconds } from "../src/lib/phoenix-crm/entry-rules.ts";

/**
 * Phoenix CRM — D3: how long a visit took, recorded in silence.
 *
 * Owner, 2026-09-26, Golden Rule #1: "never make the medical rep feel that the system is here to
 * catch him … every violation is recorded in the admin and the SFE account."
 *
 * ## 🔴 The rule this file exists to pin: THE REP NEVER LEARNS THIS EXISTS
 *
 * A visit that took eleven seconds from the door photo to Save proves nothing on its own. It is one
 * signal among several for the Super Admin's board, where a rep whose every visit lasts EXACTLY the
 * same number of seconds is worth a quiet look and a rep who is simply quick is not. The moment it
 * appears on his screen — as a figure, a warning, or a field he can see — it stops being evidence and
 * becomes a lesson in what to defeat.
 *
 * ## The two are not the same kind of fact, and that is why there are two
 *
 *   * `dwell_seconds` is SERVER-DERIVED — `now()` minus the visit's own server-issued `captured_at`.
 *     The phone sends nothing and cannot forge it.
 *   * `form_open_seconds` is what the PHONE counted, and is unverifiable alone. It is here precisely
 *     because a forged one is CONSTANT, which is a far louder signal than any single value.
 *
 * ## And neither can cost him a visit
 *
 * A phone sending "abc" seconds, or nothing at all, saves exactly as it always did. `::integer` on a
 * free-text value would abort the whole save, so the function strips to digits instead.
 */

const MIGRATION = "supabase/migrations/20260926234500_phoenix_crm_visit_dwell.sql";

function source(path: string): string {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
}

function sql(): string {
  return stripSqlComments(readFileSync(new URL(`../${MIGRATION}`, import.meta.url), "utf8").replace(/\r\n/g, "\n"));
}

export function runPhoenixCrmVisitDwellTests(): void {
  // ── 🔴 The rep never learns it exists ─────────────────────────────────────────────────────────
  //
  // `tests/phoenix-crm-blind-half.test.ts` sweeps every rep-facing file for the two column names and
  // pins that the only mention in visits.ts lies inside saveVisit. What is checked HERE is the thing
  // that sweep cannot see: that no screen puts a DURATION into words, under any name.
  {
    for (const path of ["src/components/phoenix-crm/visits-tab.tsx", "mobile/src/features/crm/visits-screen.tsx"]) {
      const code = source(path);
      // Phrases that could only ever be about timing HIM. Deliberately not a bare /\bseconds?\b/:
      // the voice note's own `seconds` prop is a recording's length and has nothing to do with this,
      // and /\btook you\b/ matched "what took you there" on the off-plan reason box — a false positive
      // that would have made the guard the thing people edit rather than obey.
      for (const banned of [
        /\bhow long\b/i,
        /\byou (were|spent|took)\b[^\n]{0,24}\b(second|minute|hour)/i,
        /\btoo (quick|fast|short)\b/i,
        /\btimed\b/i,
        /\bstopwatch\b/i,
        /\bvisit duration\b/i,
        /\bdwell\b/i,
      ]) {
        assert.doesNotMatch(code, banned, `${path} tells the rep his visit is being timed`);
      }
      // What it DOES do: a ref set in an EFFECT, read once in the event handler, and passed into the
      // draft. `useRef(Date.now())` was the first shape and React's own purity rule refuses it — an
      // impure call during render moves the start of the clock on every re-render.
      assert.ok(code.includes("const openedAtRef = useRef<number | null>(null);"), `${path} holds the clock in a ref, not in state`);
      assert.match(code, /useEffect\(\(\) => \{\s*openedAtRef\.current = Date\.now\(\);\s*\}, \[\]\);/, `${path} starts it once, after mount`);
      assert.ok(code.includes("function draft(visitId: string, formOpenSeconds: number | null): Draft {"), `${path} takes the reading as an argument`);
      // 🔴 The reading is taken AT THE BUTTON and handed in. React's purity rule refuses `Date.now()`
      // anywhere it cannot prove is an event handler, and it cannot prove that of `save` — so the two
      // earlier shapes, `useRef(Date.now())` and a call inside `save`, were both rejected. A re-render
      // must never be able to move the clock, and this is the position that guarantees it.
      assert.ok(
        code.includes("draft(visitId, openedAt === null ? null : Math.max(0, Math.round((savedAt - openedAt) / 1000)))"),
        `${path} measures against the moment the button was pressed`,
      );
      assert.ok(code.includes("async function save(savedAt: number) {"), `${path} takes that moment as an argument`);
      assert.match(code, /on(Click|Press)=\{\(\) => void save\(Date\.now\(\)\)\}/, `${path} reads the clock at the button itself`);
      assert.equal(
        (code.match(/openedAtRef/g) ?? []).length,
        3,
        `${path} touches the clock exactly three times — declare it, start it, read it. A fourth use is something on screen.`,
      );
    }
  }

  // ── Clamped, never refused ────────────────────────────────────────────────────────────────────
  {
    assert.equal(clampFormOpenSeconds(90), 90);
    assert.equal(clampFormOpenSeconds("90"), 90);
    // 🔴 `Number(null)` and `Number("")` are both 0, so "the body said nothing" and "he saved in under
    // a second" would collapse into one — and the second is the reading that matters most. The parser
    // separates them by TYPE before it does any arithmetic.
    assert.equal(clampFormOpenSeconds(0), 0, "a real zero from the phone survives the parser");
    assert.equal(clampFormOpenSeconds(""), null, "and an empty string is not a zero");
    assert.equal(clampFormOpenSeconds(FORM_OPEN_SECONDS_MAX + 5000), FORM_OPEN_SECONDS_MAX);
    for (const junk of ["abc", null, undefined, -4, Number.NaN, {}, [], true]) {
      assert.equal(clampFormOpenSeconds(junk), null, `${String(junk)} is dropped, never thrown on`);
    }
  }

  // ── The two columns, and the ceiling they share ───────────────────────────────────────────────
  {
    const text = sql();
    assert.match(
      text,
      /alter table public\.phoenix_crm_visits\s+add column if not exists dwell_seconds integer,\s+add column if not exists form_open_seconds integer;/,
    );
    // Nullable with no default: a 0 on every visit already on file would be a measurement nobody took.
    assert.equal(/add column if not exists (dwell_seconds|form_open_seconds)[^,;]*\b(not null|default)\b/.test(text), false);
    for (const column of ["dwell_seconds", "form_open_seconds"]) {
      assert.match(
        text,
        new RegExp(String.raw`constraint phoenix_crm_visits_${column}\s+check \(${column} is null or ${column} between 0 and 7200\)`),
        `${column} is held to the 2 hours a photo slot lasts`,
      );
    }
  }

  // ── dwell is the SERVER's, form_open is the PHONE's ───────────────────────────────────────────
  {
    const text = sql();
    const start = text.indexOf("create or replace function public.phoenix_crm_save_visit(");
    assert.ok(start >= 0, "the migration re-creates phoenix_crm_save_visit");
    const body = text.slice(start);

    // 🔴 Derived from the server's own captured_at, never read from the body. A phone that could send
    // its own dwell could report thirty minutes at every door and nothing would ever disagree.
    assert.match(body, /v_dwell := least\(greatest\(floor\(extract\(epoch from \(now\(\) - v_captured_at\)\)\)::bigint, 0\), 7200\)::integer;/);
    assert.equal(/p ->> 'dwell_seconds'/.test(body), false, "dwell is never taken from the request body");

    // Digits only: `(p ->> 'form_open_seconds')::integer` on "abc" aborts the whole save, and no rep
    // loses a visit he actually made over a stopwatch.
    assert.match(body, /regexp_replace\(coalesce\(p ->> 'form_open_seconds', ''\), '\[\^0-9\]', '', 'g'\)/);
    assert.equal(/\(p ->> 'form_open_seconds'\)::integer/.test(body), false, "a raw cast would raise on free text");

    // It must be computed AFTER captured_at is settled, or it measures nothing.
    assert.ok(
      body.indexOf("v_date := (v_captured_at at time zone 'Africa/Cairo')::date;") < body.indexOf("v_dwell :="),
      "the dwell is taken after the capture time is known",
    );

    // Neither may refuse a visit.
    for (const raise of body.match(/raise exception '[^']+'/g) ?? []) {
      assert.doesNotMatch(raise, /dwell|form_open|second/i, `${raise} refuses a visit over a stopwatch`);
    }

    // A zero from the phone is "it said nothing", not "he was there no time".
    assert.match(body, /v_dwell, nullif\(v_form_open, 0\)/);
  }

  // ── Written, and read back nowhere ────────────────────────────────────────────────────────────
  {
    const visits = source("src/lib/phoenix-crm/server/visits.ts");
    assert.ok(visits.includes("form_open_seconds: visit.formOpenSeconds"), "the save sends the phone's count");
    assert.equal((visits.match(/form_open_seconds/g) ?? []).length, 1, "and names it exactly once in the whole file");
    assert.equal(visits.includes("dwell_seconds"), false, "the server derives the dwell itself — this file never names it");
    assert.ok(source("src/lib/phoenix-crm/entry-rules.ts").includes("formOpenSeconds: clampFormOpenSeconds(body.formOpenSeconds)"));
  }

  console.log("phoenix-crm visit dwell: OK");
}
