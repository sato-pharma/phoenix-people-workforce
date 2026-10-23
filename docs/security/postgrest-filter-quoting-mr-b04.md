# MR-B04 — a value spliced into a PostgREST filter is quoted by ONE builder, or its line is a written-down exemption

The account behind the rule in `.claude/rules/database.md` ("Reads and filters"). Two sweeps in
`tests/postgrest-search-filter.test.ts` enforce it, and they run in the required `checks` job.

## The defect class

PostgREST filters travel as text. In `or(...)` and in a raw filter string, `,` separates
conditions, `.` separates column-operator-value, and `(` `)` group. So a value spliced in bare —
`` `hr_id.ilike.${value}` `` — lets whatever the value contains rewrite the query that reads it. An
hr id carrying a comma does not fail; it **widens the read**, and the page renders rows that answer
a different question. Nothing logs it.

`src/lib/supabase/search-filter.ts` holds the one escaping primitive, `quotePostgrestValue`: it
escapes `\` first, then `"`, and wraps the result in double quotes. Everything else in that file
(`quotedOrClause`, `quotedInList`, `ilikeAnyFilter`, `ilikeContainsValue`, `ilikeExactValue`,
`searchableTerm`) is built on it. **A second local helper is the defect, not a style difference** —
the whole point of the sweeps is that there is exactly one place where the escaping is decided.

## Sweep 1 — a single value after `.ilike.` or `.eq.`

Every tracked `src`/`app` `.ts`/`.tsx` file, comments stripped. A splice is accepted when the
expression calls one of the shared producers, is a `Number(...)`, or is an identifier whose own
nearest-preceding `const` initializer calls one. **Eight exemptions**, each keyed by file plus the
exact trimmed line — so moving code keeps its exemption and *editing* that line loses it, which is
the behaviour a break proof pins.

Fixed under it (#6350, #6357): 14 call sites across payroll, CRM, outstation, offers, market
awareness, notifications, the action centre, internal messages, recruitment and the employee
portal, plus three local copies of the list builder collapsed into the shared one.

## Sweep 2 — the `in.(…)` member list

`in.(…)` is a different grammar, and the first sweep deliberately left it out. Quoting the list as
one value is wrong: inside it, `,` separates **members** and `(` `)` close the list, so **every
member is quoted individually** — that is `quotedInList`, which returns the comma-joined quoted
members without the parens.

Two shapes carry it, and both break the same way:

| Shape | Example |
| --- | --- |
| spliced into a filter string | `` `actor_login_id.in.(${quotedInList(ids)})` `` |
| the typed builder handed a RAW list | ``.not("hr_id_key", "in", `(${quotedInList(keep)})`)`` |

The method call quotes nothing — supabase-js passes the string through — so `.not(col, "in", "(a,b)")`
is the same transport as the filter-string form.

**The census, measured 2026-10-23 on the fixed tree: 33 in-list splices in 13 files — 11 call a
shared producer directly, 5 resolve one hop back through a `const`, and 17 are written-down
exemptions** (14 keys; three lines carry more than one splice). The exemption count is asserted
after the list, so an exemption that stops being reached is red too.

### Three distinct grades of defect existed, not one

1. **No escaping at all.** `src/lib/rep-ranks/server/compute.ts` wrapped each `hr_id_key` in bare
   quotes (`` `"${key}"` ``), and `src/lib/automated-payroll/carry-forward.ts` joined the
   `employee_hr_id_compact` keep-list with no quoting whatever. Both are `.not(…, "in", …)` deletes:
   a member that closed the list early would have **widened a DELETE**. Neither can fire today —
   `compactHrKey` and the rank key both guarantee a safe charset — so this was armed, not fired.
2. **`"` escaped, `\` not.** Two copies of the same helper, `textInFilter` in
   `src/lib/employees/employee-directory.ts` and in `src/lib/reports/vacancies.ts`, did
   `value.replace(/"/g, '\\"')`. A member carrying a backslash loses it; a member **ending** in one
   escapes the closing quote and swallows the rest of the list. Both fed a raw `in.(…)` list of hr
   ids.
3. **Correct but duplicated.** `src/lib/security/login-security.ts` mapped `quotePostgrestValue`
   over the array and joined it by hand — the right escaping, reached by a second route. Replaced
   by the one builder so the sweep has a single thing to look for.

### Why an exemption rather than a fix, per family

- **Numeric id lists** — the largest family. `crm/reads.ts` (`clean = ids.map(Number).filter(Number.isFinite)`),
  `manager-old-crm-weeks.ts` (`ReadonlyArray<number>`), `idInFilter`/`inFilter` (`number[]`). Digits
  have no grammar to break, and quoting them would change the transport for no gain.
- **A module's own literal vocabulary** — `ACTIVE_EMPLOYMENT_STATUSES`, `NO_ACTOR_EXPECTED`,
  `SIGNBOARD_REREAD_REASONS`/`SIGNBOARD_BACKLOG_REASONS`, `resolveDirectOrderStatusGroupFilter`'s
  status set. Written out as literals in the file that uses them; no input reaches them.
- **Already filtered to a safe charset** — `recruitment/workspace/completeness.ts` filters `codes`
  through `/^[a-z0-9_]+$/` one line above the splice.
- **Uuids read back out of the database** — `direct-orders/service.ts`'s `id.in.(…)` arm. Quoting a
  uuid column's members changes what the database is asked and cannot be verified without a live
  probe, which the brief forbids. Sweep 1 exempts the same shape for the same reason.

## The break proofs

Seven, run 2026-10-23 in `_wt-b04-in-lists`, one per fix plus two on the sweep's own mechanism. Each
one copies the file's bytes aside, mutates the fix back to its pre-fix shape, runs the test file,
requires the **named** assertion to fire, restores from the byte copy and confirms the sha256 is
byte-identical. `git checkout -- <file>` is never used to restore — it would wipe the uncommitted
fix itself.

```
PROVED  src/lib/employees/employee-directory.ts  — textInFilter escaped `"` but not `\`
PROVED  src/lib/reports/vacancies.ts             — the second copy of the same helper
PROVED  src/lib/rep-ranks/server/compute.ts      — bare quotes, no escaping at all
PROVED  src/lib/automated-payroll/carry-forward.ts — keep-list members not quoted at all
PROVED  src/lib/security/login-security.ts       — a correct but duplicate list builder
PROVED  src/lib/crm/reads.ts                     — the one-hop const rule reads the INITIALIZER
PROVED  src/lib/crm/reads.ts                     — editing an exempted line loses its exemption
7/7 break proofs executed and restored; the test is GREEN after restoring every file
```

The last two matter because `crm/reads.ts` holds an unquoted numeric `const list` and a quoted
`const list = quotedInList(values)` in **neighbouring functions**. Nearest-preceding resolution is
what keeps the two apart, and it is proved rather than assumed.

## What is NOT in scope, and why

`.gte.`, `.lte.` and `.is.` stay out of both sweeps: their values are dates, numbers and
`null`/`true`/`false`, where a quoted value is either wrong or meaningless. Broadening a regex until
it covers every operator is exactly what the brief for this work ruled out — the answer for each
grammar is the builder that fits it, not one pattern stretched over all of them.

Nothing was read from or written to any database for this work, and no crafted request was sent to
production or staging. The sweeps are static reads of tracked source.
