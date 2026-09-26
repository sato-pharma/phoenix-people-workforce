import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { ReviewLine } from "@/lib/business-review/canonical";
import type { ReviewPortalScope } from "@/lib/business-review/portal-scope";
import {
  filterChoices,
  filterParams,
  resolveReviewFilter,
  territoriesInScope,
  type FilterableTerritory,
} from "@/lib/business-review/scope-filter";
import type { AreaSummary } from "@/lib/business-review/types";

import { stripComments } from "./support/comment-strip.ts";

/**
 * "Export what I am filtered to, inside what I am allowed to see" — the owner's 2026-09-26 ruling.
 *
 * 🔴 THE ONE PROPERTY THIS FILE EXISTS FOR: A FILTER CAN ONLY EVER NARROW. The request arrives in
 * a URL, from links people send each other, so every value in it is untrusted. If a filter could
 * ADD a territory, a medical rep would export the whole company by editing an address bar — and
 * this module hands out a performance document about named people.
 *
 * The protection is structural rather than remembered: `territoriesInScope()` does not take the
 * request at all, and `resolveReviewFilter()` only removes. The tests below check both the property
 * itself (the result is always a subset) and the structure that guarantees it.
 *
 * The second theme is HONESTY. Out-of-scope values are dropped rather than refused, because a
 * district manager opening a company-wide link should get his own district instead of an error page.
 * That is only safe while the LABEL names what was applied — a deck headed "All company" holding
 * one district is a lie told in a meeting.
 */

const FILTER = "src/lib/business-review/scope-filter.ts";

const area = (
  line: string,
  code: string,
  name: string,
  dmSeatId: string | null,
  dm: string,
  region: string,
): AreaSummary => ({ area: name, areaCode: code, dm, dmSeatId, region }) as unknown as AreaSummary;

/** Two lines, two regions, three districts — enough for every narrowing to be distinguishable. */
const BY_LINE: Partial<Record<ReviewLine, AreaSummary[]>> = {
  cns: [
    area("cns", "AX1", "Alex Center", "SEAT-CNS-SAAD", "Saad Mohamed Saad Salama", "Alex-BHR"),
    area("cns", "AX2", "Alex East", "SEAT-CNS-SAAD", "Saad Mohamed Saad Salama", "Alex-BHR"),
    area("cns", "CA1", "Nasr City", "SEAT-CNS-MINA", "Mina Farouk Nawar Rizkallah", "Cairo"),
  ],
  pedia: [area("pedia", "AX1", "Alex Center", "SEAT-PED-ALAA", "Mohamed Alaa Eleiwa Abozaid", "Alex-BHR")],
};

const company: ReviewPortalScope = { kind: "company", label: "Super Admin · all three lines", viewerName: "B-10" };
const dmScope: ReviewPortalScope = {
  dmSeatIds: ["SEAT-CNS-SAAD"],
  kind: "seats",
  label: "District Manager · own district",
  line: "cns",
  viewerName: "Saad",
};
const repScope: ReviewPortalScope = {
  hrId: "B-500",
  kind: "rep",
  label: "Medical Rep · own territory",
  line: "cns",
  viewerName: "A Rep",
};

const codes = (t: readonly FilterableTerritory[]) => t.map((x) => `${x.line}:${x.areaCode}`).sort();

export function runBusinessReviewScopeFilterTests() {
  // ------------------------------------------------------------------ 1. the scope, before any filter
  {
    assert.deepEqual(
      codes(territoriesInScope(company, BY_LINE)),
      ["cns:AX1", "cns:AX2", "cns:CA1", "pedia:AX1"],
      "a company viewer sees every line that was loaded",
    );
    assert.deepEqual(
      codes(territoriesInScope(dmScope, BY_LINE)),
      ["cns:AX1", "cns:AX2"],
      "a district manager sees his own seat's areas, on his own line — never Mina's, never Pedia's",
    );
    assert.deepEqual(
      codes(territoriesInScope({ kind: "none", reason: "no" }, BY_LINE)),
      [],
      "a refused scope sees nothing",
    );
  }

  // ------------------------------------------------------------------ 2. 🔴 a filter can only narrow
  {
    const scoped = territoriesInScope(dmScope, BY_LINE);

    // Every one of these is a real attempt to widen: another line, another manager's seat, an area
    // he does not hold, a region he is not in, and all of them at once.
    const attempts = [
      { line: "pedia" },
      { dm: "SEAT-CNS-MINA" },
      { area: "CA1" },
      { region: "Cairo" },
      { area: "CA1", dm: "SEAT-CNS-MINA", line: "pedia", region: "Cairo" },
      { line: "CNS" }, // his own line, different case — must still narrow, never widen
    ];

    const allowed = new Set(codes(scoped));
    for (const attempt of attempts) {
      const result = resolveReviewFilter(dmScope, scoped, attempt);
      for (const got of codes(result.territories)) {
        assert.ok(
          allowed.has(got),
          `FILTER WIDENED A SCOPE: ${JSON.stringify(attempt)} produced ${got}, which is outside the ` +
            `district manager's own territory. This is the defect the whole module exists to prevent.`,
        );
      }
      assert.ok(
        result.territories.length <= scoped.length,
        `${JSON.stringify(attempt)} produced MORE territories than the scope holds`,
      );
    }

    // And each refusal is named rather than silent.
    const crossSeat = resolveReviewFilter(dmScope, scoped, { dm: "SEAT-CNS-MINA" });
    assert.match(crossSeat.dropped.join(" "), /not in your scope/, "a dropped filter must say so");
    assert.equal(crossSeat.applied.dmSeatId, null, "an out-of-scope district must not be recorded as applied");
  }

  // ------------------------------------------------------------------ 3. a rep cannot be widened at all
  {
    const scoped = territoriesInScope(repScope, { cns: [BY_LINE.cns![0]] });
    const result = resolveReviewFilter(repScope, scoped, { area: "CA1", dm: "SEAT-CNS-MINA", line: "pedia" });
    assert.deepEqual(codes(result.territories), ["cns:AX1"], "a rep keeps exactly his own areas");
    assert.equal(result.level, "rep", "and nothing he can pass changes the catalogue he gets");
  }

  // ------------------------------------------------------------------ 4. the narrowing the owner asked for
  {
    const scoped = territoriesInScope(company, BY_LINE);

    // "Super Admin wants to export CNS line only"
    const cnsOnly = resolveReviewFilter(company, scoped, { line: "cns" });
    assert.deepEqual(codes(cnsOnly.territories), ["cns:AX1", "cns:AX2", "cns:CA1"]);
    assert.equal(cnsOnly.level, "line");
    assert.equal(cnsOnly.label, "CNS line");

    // "...or Pedia line only for the region of [a named manager] only" — a line AND a region.
    const pediaRegion = resolveReviewFilter(company, scoped, { line: "pedia", region: "Alex-BHR" });
    assert.deepEqual(codes(pediaRegion.territories), ["pedia:AX1"]);
    assert.equal(pediaRegion.level, "district", "anything narrower than a line answers district questions");
    assert.equal(pediaRegion.label, "Pedia · Alex-BHR region");

    // "if a district manager wants to export for only one area, he can filter on the area"
    const oneArea = resolveReviewFilter(dmScope, territoriesInScope(dmScope, BY_LINE), { area: "AX2" });
    assert.deepEqual(codes(oneArea.territories), ["cns:AX2"]);
    assert.equal(oneArea.label, "CNS · Alex East");

    // "...or to export for his total region"
    const wholeRegion = resolveReviewFilter(dmScope, territoriesInScope(dmScope, BY_LINE), { region: "Alex-BHR" });
    assert.deepEqual(codes(wholeRegion.territories), ["cns:AX1", "cns:AX2"]);

    // Nothing chosen at all, as Super Admin: the whole company, and the level says so. This is the
    // case that used to REFUSE, which is why the owner could not export anything on his own account.
    const everything = resolveReviewFilter(company, scoped, {});
    assert.equal(everything.level, "company");
    assert.equal(everything.label, "All company");
    assert.equal(everything.territories.length, 4);
  }

  // ------------------------------------------------------------------ 5. an area code is per LINE
  {
    const scoped = territoriesInScope(company, BY_LINE);
    // "Alex Center" is AX1 on CNS and AX1 on Pedia — two different territories sharing a code.
    const both = resolveReviewFilter(company, scoped, { area: "AX1" });
    assert.deepEqual(codes(both.territories), ["cns:AX1", "pedia:AX1"], "the code alone means both lines");
    assert.equal(both.label, "All lines · Alex Center", "and the label must not claim one line");

    const one = resolveReviewFilter(company, scoped, { area: "AX1", line: "pedia" });
    assert.deepEqual(codes(one.territories), ["pedia:AX1"]);
    assert.equal(one.label, "Pedia · Alex Center");

    const choices = filterChoices(scoped);
    assert.equal(choices.areas.length, 4, "the picker must offer the code once PER LINE, never collapsed");
    assert.deepEqual(choices.lines.map((l) => l.value), ["cns", "pedia"], "in catalogue order, loaded lines only");
    assert.deepEqual(choices.regions, ["Alex-BHR", "Cairo"]);
    assert.equal(choices.districts.length, 3);
  }

  // ------------------------------------------------------------------ 6. the choices never exceed the scope
  {
    const choices = filterChoices(territoriesInScope(dmScope, BY_LINE));
    assert.deepEqual(choices.lines.map((l) => l.value), ["cns"], "a DM is offered only his own line");
    assert.deepEqual(choices.regions, ["Alex-BHR"], "and only his own region");
    assert.deepEqual(
      choices.districts.map((d) => d.seatId),
      ["SEAT-CNS-SAAD"],
      "a picker wider than its viewer is the defect the CEO/district rule already names",
    );
  }

  // ------------------------------------------------------------------ 7. a link reproduces the view
  {
    const scoped = territoriesInScope(company, BY_LINE);
    const result = resolveReviewFilter(company, scoped, { area: "AX1", line: "cns" });
    assert.deepEqual(filterParams(result.applied), { area: "AX1", line: "cns" });
    // Only what was APPLIED travels — a dropped value must never reappear in a shared link.
    const dropped = resolveReviewFilter(dmScope, territoriesInScope(dmScope, BY_LINE), { dm: "SEAT-CNS-MINA" });
    assert.deepEqual(filterParams(dropped.applied), {}, "a dropped filter must not be written back into a link");
  }

  // ------------------------------------------------------------------ 8. the structure that guarantees it
  {
    const source = stripComments(readFileSync(FILTER, "utf8"));

    // `territoriesInScope` must not be able to read the request — if it could, the guarantee stops
    // being structural and becomes something a later edit can forget.
    const fn = /export function territoriesInScope\(([\s\S]*?)\)\s*:/.exec(source);
    assert.ok(fn, `${FILTER}: territoriesInScope must stay exported with an explicit signature.`);
    assert.ok(
      !/request|Request/.test(fn[1]),
      `${FILTER}: territoriesInScope must NOT take the request. Scope comes from the session alone; ` +
        `the moment a request value reaches this function, a filter can widen a scope.`,
    );

    // And the narrowing must only ever filter — never concat, push or spread new entries in.
    const resolver = /export function resolveReviewFilter\([\s\S]*?\n\}/.exec(source);
    assert.ok(resolver, `${FILTER}: resolveReviewFilter must stay exported.`);
    assert.ok(
      !/territories\s*=\s*\[\s*\.\.\.territories\s*,|territories\.push\(|territories\.concat\(/.test(resolver[0]),
      `${FILTER}: resolveReviewFilter must only REMOVE territories. Adding one is how a URL parameter ` +
        `becomes a scope.`,
    );
  }
}
