import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { offerLetterLapsed } from "../src/lib/offers/dates.ts";
import { buildOfferHireDraft } from "../src/lib/offers/hire-draft.ts";
import { deriveSalaryFromNet } from "../src/lib/payroll/salary-autofill.ts";
import { formatSeatOfferOut, offerSeatKeyForVacancy } from "../src/lib/offers/seat-offer-label.ts";
import type { OfferVacancyOption } from "../src/lib/offers/types.ts";

/**
 * The offer out on a vacant seat, and the package landing in the right salary box
 * (owner, 2026-09-29: "show the offer out on the organogram's vacant seats and make it grab as
 * much data when add employee as it can").
 *
 * Two things, one PR, because they are the same sentence: a seat with a letter against it should
 * say so, and pressing Add employee on that letter should arrive with everything the system can
 * already work out.
 */
export function runOfferOutOnSeatsTests() {
  // ── 1 · THE PACKAGE IS THE NET. This was a live defect, fixed here ──────────────────────────
  //
  // The hire draft carried `offer.totalMonthly` into `grossSalary`. It is the NET: measured on
  // production against every accepted offer whose employee record also exists, all five agree to
  // the pound, and the real gross sits 1,600-1,900 EGP ABOVE it. A gross box filled with a net
  // figure is wrong in a way nobody re-reads.
  //
  // Asserted as the SHAPE of the returned draft, so the old field cannot quietly come back.
  const seat: OfferVacancyOption = {
    areaId: 1089,
    areaName: "Alex East",
    departmentId: 1,
    jobTitle: "Medical Representative",
    lineId: 2,
    lineName: "Pedia",
    managerHrId: "PD-0012",
    managerName: "Mohamed Alaa Eleiwa Abozaid",
    positionId: 2,
    positionTitle: "Medical Representative",
    regionName: "Alex-BHR",
    vacancyCode: "VAC-B82-E3Z",
    vacancyId: 351,
  };
  const draft = buildOfferHireDraft({
    offer: {
      candidateName: "Mariam Younan Gaber",
      startDate: "01 October 2026",
      title: "Medical Representative",
      totalMonthly: 17500,
    },
    vacancy: seat,
  });

  assert.equal(draft.netSalary, "17500", "the agreed package goes in the NET box");
  assert.ok(
    !Object.prototype.hasOwnProperty.call(draft, "grossSalary"),
    "and NOT the gross box — gross is derived above the net and is always larger",
  );

  // ── 2 · The form's own chain reproduces the real hires from that one number ─────────────────
  //
  // This is the whole of "grab as much data as it can": nothing here computes a salary, it hands
  // the net to `deriveSalaryFromNet` — the system's single authority, which delegates base and
  // basic to the owner-locked policy.ts — and checks the answer against what HR actually saved for
  // these people. If this ever disagrees, the prefill is putting wrong money on a real screen.
  const realHires = [
    { name: "Mariam Younan Gaber", net: 17500, base: 15000, basic: 10500, gross: 19102.5 },
    { name: "Farah Mossad Elshikh", net: 18000, base: 15500, basic: 10850, gross: 19727.5 },
    { name: "Marina Osama", net: 17000, base: 14500, basic: 10150, gross: 18477.5 },
    { name: "Taha Sheeba", net: 17500, base: 15000, basic: 10500, gross: 19102.5 },
  ];
  for (const hire of realHires) {
    const derived = deriveSalaryFromNet({
      employeeHrId: "",
      extraCostOfLiving: null,
      fuelAllowance: null,
      jobTitle: "Medical Representative",
      netSalary: hire.net,
    });
    assert.ok(derived, `${hire.name}: the chain must answer for a real package`);
    assert.equal(derived.baseSalary, hire.base, `${hire.name}: base salary matches the saved record`);
    assert.equal(derived.basicSalary, hire.basic, `${hire.name}: basic salary matches the saved record`);
    assert.equal(derived.grossSalary, hire.gross, `${hire.name}: gross matches the saved record`);
    assert.equal(derived.extraCostOfLiving, 2000, `${hire.name}: cost of living is the title's own`);
    assert.equal(derived.fuelAllowance, 500, `${hire.name}: fuel is the title's own`);
  }

  // A package of zero derives nothing, rather than a chart of zeroes that looks filled in.
  assert.equal(
    deriveSalaryFromNet({ employeeHrId: "", extraCostOfLiving: null, fuelAllowance: null, jobTitle: "Medical Representative", netSalary: 0 }),
    null,
    "no package, no derivation",
  );

  // ── 3 · The prefill runs that chain, rather than leaving the boxes empty ────────────────────
  const employees = readFileSync("src/components/employees/employee-management.tsx", "utf8");
  // The call is now split across two statements so the notice can report what landed in the form
  // (see tests/offer-prefill-notice-net.test.ts); what this pins is unchanged — the prefill goes
  // through the form's own salary chain, and the RESULT of that is what setForm receives.
  assert.match(
    employees,
    /const filled = withSalaryAutofill\(\{ \.\.\.emptyForm, \.\.\.payload\.draft \}, new Set\(\)\);/,
    "arriving from an offer fills every derived salary box, exactly as typing the net by hand would",
  );
  assert.match(employees, /setForm\(filled\);/, "and that filled form is the one the boxes render from");

  // ── 4 · The seat's own line ─────────────────────────────────────────────────────────────────
  assert.equal(
    formatSeatOfferOut({ candidateName: "Norhan Gamal", offerId: "offer-norhan", reference: "SP-HR-MR-2026-030", startDate: "01 October 2026", status: "sent" }),
    "Offer out — Norhan Gamal, starts 01 October 2026",
  );
  assert.equal(
    formatSeatOfferOut({ candidateName: "Norhan Gamal", offerId: "offer-norhan", reference: null, startDate: "01 October 2026", status: "accepted" }),
    "Offer accepted — Norhan Gamal, starts 01 October 2026",
    "an accepted letter reads differently from one still waiting — planning a line, those are different facts",
  );
  assert.equal(
    formatSeatOfferOut({ candidateName: "Norhan Gamal", offerId: "offer-norhan", reference: null, startDate: null, status: "sent" }),
    "Offer out — Norhan Gamal",
    "no start date, no trailing comma",
  );
  assert.equal(offerSeatKeyForVacancy(385), "vacancy:385", "a Head Office vacancy has no AU seat, so it is keyed by its row id");

  // ── 5 · Only a VACANT seat carries one ──────────────────────────────────────────────────────
  //
  // Reading the map for an occupied chair is the first step towards labelling a filled seat with
  // somebody else's letter, so the guard is asserted rather than trusted.
  const auSource = readFileSync("src/lib/reports/organogram-au-source.ts", "utf8");
  assert.match(
    auSource,
    /pendingOffer: occupied \? null : \(offerOutBySeat\.get\(s\.seat_id\) \?\? null\)/,
    "an occupied seat never carries a pending offer",
  );
  // The live chart reads the map; a past month's picture (`asOfMonth`) starts from an empty one, as
  // an offer is a fact about today's empty chair. Either way it is ONE read for the whole chart.
  assert.match(
    auSource,
    /const offerLoad\b[^;]*loadOfferOutBySeat\(\);[\s\S]*const offerOutBySeat\b[^;]*= await offerLoad;/,
    "the map is read once for the whole chart, not per node",
  );
  assert.equal(
    (auSource.match(/loadOfferOutBySeat\(\)/g) ?? []).length,
    1,
    "and there is exactly one call, so it cannot drift into a per-node read",
  );

  // ── 6 · It sits BESIDE "Vacant", never instead of it ────────────────────────────────────────
  //
  // The seat IS still vacant — an offer records intent and the hire is what fills it — so
  // replacing the chip would say the chair is taken when nobody has been hired. The chip and the
  // line have to coexist, and that is what this counts.
  const chart = readFileSync("src/components/organogram/org-chart.tsx", "utf8");
  assert.match(chart, /\{isVacancy \? \(\s*<span[^>]*>\s*Vacant/, "the Vacant chip is still there");
  assert.match(chart, /isVacancy && row\.pendingOffer/, "and the offer line is drawn in addition to it, on vacant seats only");
  assert.match(
    chart,
    /whitespace-normal break-words/,
    "a long candidate name WRAPS inside the node — the owner's standing rule is that text is never cut off",
  );

  // ── 7 · Only a letter that is still in play ─────────────────────────────────────────────────
  //
  // A declined or withdrawn offer on a seat would say the chair is spoken for when it is free,
  // which is the worse of the two mistakes: it stops somebody hiring.
  const seatOffers = readFileSync("src/lib/offers/seat-offers.ts", "utf8");
  assert.match(seatOffers, /\.in\("status", \["sent", "accepted"\]\)/, "only sent and accepted letters reach a seat");
  assert.match(seatOffers, /if \(row\.status !== "open"\) continue;/, "and only while the vacancy itself is still open");
  // The offer id must be SELECTED and carried onto the label, or the chart's one-press hire of an
  // accepted offer falls back to the seat-only prefill and opens the form blank on name and id.
  assert.match(seatOffers, /\.select\("id, candidate_name,/, "the offer id is selected, not dropped");
  assert.match(seatOffers, /offerId: String\(row\.id \?\? ""\)\.trim\(\)/, "and carried onto the seat's offer label");
  assert.ok(
    !/from "@\/lib\/recruitment/.test(seatOffers),
    "the offers module stays independent of recruitment, here as everywhere else in it",
  );

  // ── 8 · The client bundle never reaches the database ────────────────────────────────────────
  //
  // The chart is a client component. It imports the LABEL, which is pure; importing it from the
  // reader would have pulled the service-role Supabase client into the browser bundle. The same
  // split, for the same reason, as vacancy-label.ts next door.
  assert.match(
    chart,
    /import \{ formatSeatOfferOut \} from "@\/lib\/offers\/seat-offer-label"/,
    "the chart imports the pure label, never the reader",
  );
  const label = readFileSync("src/lib/offers/seat-offer-label.ts", "utf8");
  // Its IMPORTS, not its prose — the file explains in a comment why it is separate from the reader,
  // and naming the client there is the explanation, not a dependency.
  const labelImports = label.match(/^import .*$/gm) ?? [];
  assert.deepEqual(labelImports, [], "the label module imports nothing at all, least of all a database client");
  // organogram-head-office.ts documents itself as pure and database-free so its placement rules
  // stay unit-testable; it needs the key helper, which is why the helper lives in the pure module.
  const headOffice = readFileSync("src/lib/reports/organogram-head-office.ts", "utf8");
  assert.ok(
    !/from "@\/lib\/offers\/seat-offers"/.test(headOffice),
    "the Head Office builder stays free of the reader, and so of the Supabase client",
  );

  // ── 9 · A SENT letter past its valid-until day is over (production, 2026-10-26) ──────────────
  //
  // Two duplicate letters to Bassant Samir Mousa, valid until 21 October and never answered, kept a
  // Pedia Giza chair reading "Offer out … starts 25 October 2026" after her candidate record had
  // been rejected — the chair looked spoken for when it was free.
  assert.equal(offerLetterLapsed("21 October 2026", "2026-10-26"), true, "a letter valid until 21 October is over on the 26th");
  assert.equal(offerLetterLapsed("21 October 2026", "2026-10-22"), true, "and on the 22nd, the first day after it");
  assert.equal(offerLetterLapsed("21 October 2026", "2026-10-21"), false, "but its own valid-until day still counts");
  assert.equal(offerLetterLapsed("1 November 2026", "2026-10-26"), false, "a letter still inside its window stays");
  assert.equal(offerLetterLapsed("2026-10-21", "2026-10-26"), true, "an ISO date reads the same way");
  assert.equal(offerLetterLapsed("", "2026-10-26"), false, "a missing date is never declared over on a guess");
  assert.equal(offerLetterLapsed("sometime soon", "2026-10-26"), false, "nor an unreadable one");
  assert.match(
    seatOffers,
    /\.select\("id, candidate_name, reference, start_date, status, valid_until, vacancy_id"\)/,
    "the reader selects valid_until",
  );
  assert.match(
    seatOffers,
    /row\.status === "accepted" \|\| !offerLetterLapsed\(row\.valid_until, today\)/,
    "a lapsed SENT letter is dropped, and an ACCEPTED one is always kept",
  );
  assert.match(seatOffers, /const today = todayInCairo\(\);/, "and the day is Cairo's, not the server's");
}
