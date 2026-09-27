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
const CONTROL = "src/components/business-review/scope-filter.client.tsx";
const PAGE = "app/employee-portals/business-review/page.tsx";
const PORTAL = "src/components/business-review/portal-review.client.tsx";

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

  // ------------------------------------------------------------------ 9. the control, and the wiring
  {
    const control = stripComments(readFileSync(CONTROL, "utf8"));
    const page = stripComments(readFileSync(PAGE, "utf8"));

    // The options come from the scoped choices, never from a hard-coded list of lines or regions.
    // A hard-coded "Pedia" would offer a district manager a line he cannot see, and a picker wider
    // than its viewer is a defect this repo already has a rule about.
    assert.ok(control.includes("choices"), `${CONTROL}: the options must come from filterChoices.`);
    for (const literal of ['"Pedia"', '"CNS"', '"Anti-Infective"', '"Cairo"', '"Alex-BHR"']) {
      assert.ok(
        !control.includes(literal),
        `${CONTROL}: ${literal} is hard-coded. Every option must be derived from the viewer's own ` +
          `scope, or the control offers territories he will be refused.`,
      );
    }

    // One control must not silently undo another. Narrowing the territory has to carry the chosen
    // metrics; choosing metrics has to carry the narrowing; changing the window has to keep both.
    assert.ok(
      /metrics\.map\(\(metric\) => \(\s*<input key=\{metric\} name="m"/.test(control),
      `${CONTROL}: the chosen metrics must ride along as hidden inputs, or narrowing to a district ` +
        `silently resets what the page is showing back to that level's defaults.`,
    );
    assert.ok(
      page.includes("hidden={carry}"),
      `${PAGE}: the export links and the metric picker must carry the applied filter, or applying ` +
        `metrics throws the territory narrowing away.`,
    );
    assert.ok(
      page.includes("windowHidden={appliedParams}"),
      `${PAGE}: the PERIOD filter must carry the narrowing, or changing the month silently widens ` +
        `the view back to the whole scope.`,
    );

    // A "Clear" that is a submit cannot empty the selects sitting beside it.
    assert.ok(
      /href=\{action\}/.test(control),
      `${CONTROL}: Clear must be a link to the bare page — a submit button carries the very values ` +
        `it is meant to remove.`,
    );

    // And the drop must be visible, because the server narrows a forwarded link rather than
    // refusing it.
    assert.ok(control.includes("dropped"), `${CONTROL}: a dropped filter must be shown to the viewer.`);

    // The screen and the export must narrow through the SAME module, or a file disagrees with the
    // page it was exported from — the one outcome this directory exists to prevent.
    assert.ok(
      page.includes("territoriesInScope(scope,") && page.includes("resolveReviewFilter("),
      `${PAGE}: the page must narrow through the same module the export route uses.`,
    );
  }

  // ------------------------------------------------------------------ 10. the folded long lists
  {
    const portal = stripComments(readFileSync(PORTAL, "utf8"));

    assert.ok(portal.includes("function LongList("), `${PORTAL}: the long-list fold is missing.`);

    // The 144-row area table was 69% of a 10.1-screen page. It must be folded.
    assert.match(
      portal,
      /<LongList count=\{visibleAreas\.length\} label="areas">/,
      `${PORTAL}: the areas list must be folded by default — it was 7,376px of a 10,676px page.`,
    );

    // Every fold must be closed, or the page renders inside a disclosure that never ends.
    const opens = (portal.match(/<LongList /g) ?? []).length;
    const closesCount = (portal.match(/<\/LongList>/g) ?? []).length;
    assert.equal(opens, closesCount, `${PORTAL}: ${opens} folds opened but ${closesCount} closed.`);
    assert.ok(opens >= 3, `${PORTAL}: expected the long lists to be folded, found ${opens}.`);

    // 🔴 FOLDING IS NOT CAPPING. The fold must render its children whole — a slice here would drop
    // rows silently, and a reader would quote a total that is not the total. That is strictly worse
    // than the scrolling it replaced.
    const body = /function LongList\([\s\S]*?\n\}/.exec(portal);
    assert.ok(body, `${PORTAL}: could not read the LongList body.`);
    // A POSITIVE check, not a blacklist.
    //
    // 🔴 The first draft of this forbade `.slice(` and was SATISFIED by
    // `[].slice.call(children, 0, 10)` — found by breaking the fold into a cap and watching
    // nothing fire. A blacklist only ever bans the spellings you thought of.
    //
    // What must be TRUE is that both paths render the children whole: the short-list early
    // return, and the folded body.
    const whole = (body[0].match(/\{children\}/g) ?? []).length;
    assert.ok(
      whole >= 2,
      `${PORTAL}: both the unfolded and the folded path must render {children} whole — found ` +
        `${whole}. Folding hides rows behind one click; capping removes them, and nothing on the ` +
        `page would say so, so a reader would quote a total that is not the total.`,
    );
    assert.ok(
      !/children\s*[.[(]/.test(body[0]),
      `${PORTAL}: the children must not be indexed, called or sliced on their way to the page.`,
    );
    assert.ok(
      body[0].includes("{num(count)}"),
      `${PORTAL}: the summary must carry the REAL row count, so a folded list still says how big it is.`,
    );
    assert.ok(
      /count <= LONG_LIST_ROWS/.test(body[0]),
      `${PORTAL}: a short list must not be folded — a disclosure around five rows is furniture.`,
    );

    // The square-edge golden rule reaches a disclosure too. Measured on production: every control
    // on this page computes to a 0px radius.
    assert.ok(
      !/rounded(-[a-z0-9]+)?["'\s]/.test(body[0]),
      `${PORTAL}: the fold must not introduce a rounded corner.`,
    );
  }

  // ------------------------------------------------------------------ 11. the three stay separate
  {
    const portal = stripComments(readFileSync(PORTAL, "utf8"));

    // 🔒 OWNER DECISION, 2026-09-26. Achievement, Band and Payout were merged into one column that
    // day on his instruction, and he reversed it the same day: "no leave separated".
    //
    // This pin exists because the measurement that argued for the merge is STILL TRUE — 1,129 cells
    // on this page wrap onto three or more lines, these three among the worst. Any later session
    // that measures the page will reach the same conclusion and merge them again, which is
    // re-litigating a decision already made. The page's length is handled by folding instead.
    assert.equal(
      (portal.match(/>Band<\/th>/g) ?? []).length,
      2,
      `${PORTAL}: Band stays its own column in both tables — owner decision 2026-09-26, do not merge.`,
    );
    assert.equal(
      (portal.match(/>Payout<\/th>/g) ?? []).length,
      2,
      `${PORTAL}: Payout stays its own column in both tables — owner decision 2026-09-26, do not merge.`,
    );
    assert.ok(
      !portal.includes("Achievement · band · payout"),
      `${PORTAL}: the merged column was reversed by the owner on 2026-09-26 ("no leave separated").`,
    );
  }

  // ------------------------------------------------------------------ 12. multiple regions and areas
  //
  // Owner, 2026-09-27: "make me able to filter by region or by area ... and also multiple regions
  // and multiple areas." Several values narrow to their UNION, and the widening guarantee holds for
  // a list exactly as it does for one value — an out-of-scope entry is dropped, never added.
  {
    const scoped = territoriesInScope(company, BY_LINE);

    const twoRegions = resolveReviewFilter(company, scoped, { region: ["Alex-BHR", "Cairo"] });
    assert.deepEqual(codes(twoRegions.territories), ["cns:AX1", "cns:AX2", "cns:CA1", "pedia:AX1"], "the union of both regions");
    assert.equal(twoRegions.level, "district");
    assert.deepEqual([...twoRegions.applied.regions].sort(), ["Alex-BHR", "Cairo"]);
    assert.equal(twoRegions.label, "All lines · 2 regions");
    assert.deepEqual(filterParams(twoRegions.applied).region, ["Alex-BHR", "Cairo"], "several regions serialize as repeated params");

    const twoAreas = resolveReviewFilter(company, scoped, { area: ["AX2", "CA1"], line: "cns" });
    assert.deepEqual(codes(twoAreas.territories), ["cns:AX2", "cns:CA1"]);
    assert.equal(twoAreas.label, "CNS · 2 areas");
    assert.deepEqual(filterParams(twoAreas.applied).area, ["AX2", "CA1"]);

    // 🔴 A LIST CANNOT WIDEN EITHER. A district manager asking for his own area and a foreign one
    // keeps only his; the foreign one is dropped and named, never added.
    const dmScoped = territoriesInScope(dmScope, BY_LINE);
    const mixed = resolveReviewFilter(dmScope, dmScoped, { area: ["AX2", "CA1"] });
    assert.deepEqual(codes(mixed.territories), ["cns:AX2"], "the in-scope area applies; the foreign one is not added");
    assert.match(mixed.dropped.join(" "), /not in your scope/);
    assert.deepEqual(mixed.applied.areaCodes, ["AX2"]);

    // A single value still serializes as a plain string, so one-value links are byte-identical.
    const one = resolveReviewFilter(company, scoped, { region: "Cairo" });
    assert.equal(filterParams(one.applied).region, "Cairo");
  }

  // ------------------------------------------------------------------ 13. the admin page wires it too
  //
  // Owner, 2026-09-27: he asked for the filter on the ADMIN account, for district managers and reps.
  // The admin page must narrow through the SAME module — a param read straight as scope is the defect
  // the whole file guards — and it must NOT show a Line control, because its own view tabs set the line.
  {
    const admin = stripComments(readFileSync("app/(admin)/business-review/page.tsx", "utf8"));
    assert.ok(
      admin.includes("territoriesInScope(scope,") && admin.includes("resolveReviewFilter("),
      "app/(admin)/business-review/page.tsx: the admin filter must narrow through the same module the export route uses.",
    );
    assert.ok(
      admin.includes("hideLine"),
      "app/(admin)/business-review/page.tsx: the admin filter must hide its Line control — the view tabs own the line.",
    );
    assert.ok(
      !/loadReviewPortalScope\(\{[^}]*params\./.test(admin),
      "app/(admin)/business-review/page.tsx: no request value may reach loadReviewPortalScope — scope is the session's alone.",
    );
  }
}
