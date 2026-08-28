import assert from "node:assert/strict";

import {
  findPreHireMappingConflict,
  preHireMappingRefusalMessage,
  type MappingCandidateRow,
} from "../src/lib/crm/admin.ts";
import { normalizeCrmName } from "../src/lib/crm/identity.ts";

/**
 * PRE-HIRE MAPPING GUARD — the Unmapped Agents screen must refuse to create the miscredit that
 * tests/crm-pre-hire-attribution.test.ts exists to catch everywhere else.
 *
 * THE INCIDENT THIS PINS (production, 2026-08-28). The attribution guard shipped that morning and
 * cleared every automatically-resolved pre-hire row it walked. 1,373 rows survived it, across three
 * employees, because each of their CRM accounts had been MAPPED by hand from this screen — and the
 * resolver's tier 1 deliberately honours a human decision over the roster date. The largest was
 * 1,136 real doctor calls credited to a rep who joined 170 days after the earliest of them.
 *
 * WHY THE FIX IS HERE AND NOT IN THE RESOLVER. Guarding tier 1 would break the only route by which
 * a blocked row can ever be reassigned to whoever really made it — an admin's mapping is the
 * intended answer to the guard's own alert. crm-pre-hire-attribution section (J) pins that, and
 * section (B) of this file pins that the legitimate correction still goes through. The mistake is
 * made impossible to CREATE instead of overridden after the fact.
 *
 * WHY THE SCREEN COULD NOT SHOW THIS. When a CRM account is handed to a replacement, iReports360
 * rewrites the previous holder's historic rows with the NEW holder's name. So the admin sees one
 * consistent name across the account's whole history and nothing that looks wrong. The hire date is
 * the only evidence there is.
 */
export function runCrmPreHireMappingGuardTests() {
  const label = normalizeCrmName("Soad.Atef ( Cairo East 1 / A )");

  const row = (visitDate: string, rowLabel: string | null = "Soad.Atef ( Cairo East 1 / A )"): MappingCandidateRow => ({
    label: rowLabel,
    visitDate,
  });

  // ── (A) THE HEADLINE. A mapping that would credit work before the person joined is refused ──
  const conflict = findPreHireMappingConflict(
    [row("2026-01-01"), row("2026-03-14"), row("2026-06-01"), row("2026-07-15")],
    { decisionLabel: label, hireDate: "2026-06-20" },
  );
  assert.ok(conflict, "a mapping crediting visits dated before the hire date MUST be refused");
  assert.equal(conflict.count, 3, "every pre-hire row is counted, not just the first");
  assert.equal(conflict.earliest, "2026-01-01", "the earliest offending date is reported");
  assert.equal(conflict.latest, "2026-06-01", "the latest offending date is reported");

  // ── (B) The legitimate correction still goes through ────────────────────────────────────────
  //
  // This is the assertion that keeps the guard from being a cure worse than the disease. The whole
  // point of mapping a handed-over account is to file its history under the person who ACTUALLY
  // held it. That person's hire date precedes the rows, so nothing here may refuse it.
  assert.equal(
    findPreHireMappingConflict([row("2026-01-01"), row("2026-03-14"), row("2026-06-01")], {
      decisionLabel: label,
      hireDate: "2025-02-01",
    }),
    null,
    "mapping the slot to the person who really held it must still be allowed — that is the fix, " +
      "not the bug, and it is the only way a blocked row is ever reassigned",
  );

  // ── (C) The hire date itself is INCLUSIVE ───────────────────────────────────────────────────
  assert.equal(
    findPreHireMappingConflict([row("2026-06-20")], { decisionLabel: label, hireDate: "2026-06-20" }),
    null,
    "a visit ON the hire date was worked — it must not refuse the mapping",
  );
  assert.ok(
    findPreHireMappingConflict([row("2026-06-19")], { decisionLabel: label, hireDate: "2026-06-20" }),
    "one day before the hire date is still refused — there is no grace window here either",
  );

  // ── (D) No hire date recorded refuses nothing ───────────────────────────────────────────────
  //
  // Same rule isAttributableOn follows: an unknown start date is not evidence of anything. Two
  // active reps carry a NULL hire_date in production, and blocking their mappings would strand
  // real accounts with no way to resolve them.
  assert.equal(
    findPreHireMappingConflict([row("2020-01-01")], { decisionLabel: label, hireDate: null }),
    null,
    "an employee with no recorded hire date can still be mapped",
  );

  // ── (E) Label scoping matches the RESOLVER, which is not the same as the stamp ───────────────
  //
  // A row carrying somebody ELSE's label is not claimed by this decision, so it must not refuse it
  // — production slot 1399 carries three different people's names and the other two resolve
  // correctly on their own. But a row with NO label of its own IS claimed by tier 1
  // (`!recordLabel` passes), even though stampUnmappedVisitRows skips it. The refusal has to cover
  // every row the mapping would EVENTUALLY credit, not only the ones stamped the moment it saves.
  assert.equal(
    findPreHireMappingConflict([row("2026-01-01", "Tayseer.Khaled ( Cairo East 1 / E )")], {
      decisionLabel: label,
      hireDate: "2026-06-20",
    }),
    null,
    "another person's rows on a shared slot are not this decision's problem",
  );
  const unlabelled = findPreHireMappingConflict([row("2026-01-01", null)], {
    decisionLabel: label,
    hireDate: "2026-06-20",
  });
  assert.ok(
    unlabelled,
    "a row with NO label is claimed by tier 1 and must refuse the mapping — matching the stamp's " +
      "stricter equality here would let exactly those rows through",
  );
  assert.equal(unlabelled.count, 1, "the unlabelled row is the one counted");

  // A decision recorded without a label applies to the WHOLE slot, so everything on it counts.
  const blanket = findPreHireMappingConflict(
    [row("2026-01-01", "Tayseer.Khaled ( Cairo East 1 / E )"), row("2026-02-01", null), row("2026-03-01")],
    { decisionLabel: null, hireDate: "2026-06-20" },
  );
  assert.ok(blanket, "a label-less decision claims the whole slot, so any pre-hire row refuses it");
  assert.equal(blanket.count, 3, "every row on the slot counts when the decision carries no label");

  // ── (F) Whitespace variance must not defeat the label test ──────────────────────────────────
  //
  // The vendor emits the same person's label with inconsistent internal spacing, which is why both
  // sides go through normalizeCrmName. A raw string compare would read this row as someone else's
  // and wave the mapping through.
  assert.ok(
    findPreHireMappingConflict([row("2026-01-01", "Soad.Atef  ( Cairo East 1 / A )")], {
      decisionLabel: label,
      hireDate: "2026-06-20",
    }),
    "a stray double space in the vendor's label must still match the decision's label",
  );

  // ── (G) A timestamp compares by its DATE part ───────────────────────────────────────────────
  assert.ok(
    findPreHireMappingConflict([row("2026-06-19T23:59:00")], { decisionLabel: label, hireDate: "2026-06-20" }),
    "a timestamp on the day before the hire date refuses the mapping",
  );
  assert.equal(
    findPreHireMappingConflict([row("2026-06-20T00:05:00")], { decisionLabel: label, hireDate: "2026-06-20" }),
    null,
    "a timestamp on the hire date itself does not",
  );

  // ── (H) Nothing to judge ────────────────────────────────────────────────────────────────────
  assert.equal(findPreHireMappingConflict([], { decisionLabel: label, hireDate: "2026-06-20" }), null, "no rows");
  assert.equal(
    findPreHireMappingConflict([row("")], { decisionLabel: label, hireDate: "2026-06-20" }),
    null,
    "a row with no date cannot prove anything and must not refuse the mapping",
  );

  // ── (I) The message has to explain the handover, or the admin just retries ───────────────────
  //
  // The screen showed one consistent name across the whole account, so a bare "invalid mapping"
  // reads as a bug in the tool rather than a real finding about the data.
  const message = preHireMappingRefusalMessage({
    conflict: { count: 1136, earliest: "2026-01-01", latest: "2026-06-01" },
    employeeName: "Soad Atef",
    hireDate: "2026-06-20",
  });
  assert.ok(message.includes("Soad Atef"), "names the employee, never a bare HR ID");
  assert.ok(message.includes("2026-06-20"), "states the hire date being applied");
  assert.ok(message.includes("1136 visits"), "states how many visits would have been miscredited");
  assert.ok(message.includes("2026-01-01") && message.includes("2026-06-01"), "states the offending range");
  assert.ok(
    message.includes("handed-over") || message.includes("previous holder"),
    "explains WHY the account looks correct on screen — otherwise the admin reads this as a tool bug",
  );
  assert.ok(
    /1 visit(?!s)/.test(
      preHireMappingRefusalMessage({
        conflict: { count: 1, earliest: "2026-01-01", latest: "2026-01-01" },
        employeeName: "Gannatallah Amer",
        hireDate: "2026-08-01",
      }),
    ),
    "a single offending visit reads as '1 visit', not '1 visits'",
  );
  assert.ok(
    preHireMappingRefusalMessage({
      conflict: { count: 1, earliest: "2026-01-01", latest: "2026-01-01" },
      employeeName: "Gannatallah Amer",
      hireDate: "2026-08-01",
    }).includes("dated 2026-01-01"),
    "one date is stated once, not as a range from itself",
  );

  // ── (J) The real production shape, end to end ───────────────────────────────────────────────
  //
  // Slot 1391 as it actually stood: every row relabelled to the new holder, 1,136 of them dated
  // across the 170 days before her start date (a rep logs many calls per day, so the dates repeat)
  // and 28 after it. The guard must refuse this, count all 1,136, and ignore the 28 that are hers.
  const dayBefore = (offset: number) =>
    new Date(Date.UTC(2026, 0, 1) + (offset % 170) * 86_400_000).toISOString().slice(0, 10);
  const slot1391: MappingCandidateRow[] = [
    ...Array.from({ length: 1136 }, (_unused, index) => row(dayBefore(index))),
    ...Array.from({ length: 28 }, () => row("2026-07-01")),
  ];
  const production = findPreHireMappingConflict(slot1391, { decisionLabel: label, hireDate: "2026-06-20" });
  assert.ok(production, "the production case refuses");
  assert.equal(production.count, 1136, "all 1,136 pre-hire rows are counted, and none of her own 28");
  assert.equal(production.earliest, "2026-01-01", "the earliest real offending date");
  assert.ok(production.latest < "2026-06-20", "the reported range never reaches into her employment");
}
