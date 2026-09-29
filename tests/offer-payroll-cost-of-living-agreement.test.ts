import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  offerCostOfLivingDrift,
  payrollCostOfLivingForTitle,
} from "../src/lib/offers/cost-of-living-agreement.ts";
import { resolveTitleAllowances } from "../src/lib/payroll/salary-autofill.ts";

/**
 * The offer's cost of living and payroll's must keep meaning the same money (owner, 2026-09-29).
 *
 * An offer carries ONE cost-of-living figure per title; the employee record carries TWO —
 * `extra_cost_of_living` and `fuel_allowance`. The letter's figure is the sum of payroll's pair, and
 * on 2026-09-29 every active title agreed: MR 2,500 = 2,000 + 500, DSM 3,500 = 3,000 + 500,
 * NSM 5,500 = 5,000 + 500.
 *
 * Nothing enforced that. The offer side is DATA typed on the Job titles tab; payroll's is CODE.
 * Change either alone and the letter's compensation table and the hire it produces describe
 * different money — silently, because each side stays internally consistent.
 *
 * The guard is in two halves because the drift can come from two places, and only one of them is
 * in this repository:
 *
 *   CODE side  — pinned HERE. A change to the payroll allowances fails this test.
 *   DATA side  — flagged on the screen where the figure is typed, since CI cannot see the table.
 *
 * Neither half refuses anything. A figure the owner deliberately changes is legitimate; what must
 * not happen is the two drifting apart with nobody told.
 */
export function runOfferPayrollCostOfLivingAgreementTests() {
  // ── 1 · The payroll side of every title an offer is written for ─────────────────────────────
  //
  // These three are the active offer catalogue as read from production on 2026-09-29, with the
  // offer's own figure beside them. If payroll's numbers move, this fails and whoever moved them
  // has to decide what happens to the letters — which is the entire point.
  const catalogue: { extraCostOfLiving: number; fuel: number; offer: number; title: string }[] = [
    { title: "Medical Representative", offer: 2500, extraCostOfLiving: 2000, fuel: 500 },
    { title: "District Sales Manager", offer: 3500, extraCostOfLiving: 3000, fuel: 500 },
    { title: "National Sales Manager", offer: 5500, extraCostOfLiving: 5000, fuel: 500 },
  ];

  for (const row of catalogue) {
    const allowances = resolveTitleAllowances(row.title, null);
    assert.equal(
      allowances.extraCostOfLiving,
      row.extraCostOfLiving,
      `${row.title}: payroll's cost of living moved — the offer catalogue says ${row.offer} and must be changed with it`,
    );
    assert.equal(
      allowances.fuelAllowance,
      row.fuel,
      `${row.title}: payroll's fuel allowance moved — the offer catalogue says ${row.offer} and must be changed with it`,
    );
    assert.equal(
      payrollCostOfLivingForTitle(row.title),
      row.offer,
      `${row.title}: the letter's cost of living and payroll's pair must be the same money`,
    );
  }

  // ── 2 · Agreement reads as silence ──────────────────────────────────────────────────────────
  for (const row of catalogue) {
    assert.equal(
      offerCostOfLivingDrift({ costOfLiving: row.offer, jobTitle: row.title }),
      null,
      `${row.title} agrees today, so nothing is said`,
    );
  }

  // ── 3 · Drift says both numbers, and what it means ──────────────────────────────────────────
  //
  // Naming only one of them would leave the reader to go and look the other up, which on a screen
  // where the figure is being typed is the same as saying nothing.
  const drift = offerCostOfLivingDrift({ costOfLiving: 3000, jobTitle: "Medical Representative" });
  assert.ok(drift, "a figure that disagrees with payroll must be reported");
  assert.match(drift ?? "", /3,000/, "it names what the letter would say");
  assert.match(drift ?? "", /2,500/, "and what a hire on that title is actually paid");
  assert.match(drift ?? "", /2,000 cost of living \+ 500 fuel/, "broken down, so the sum is checkable on sight");
  assert.match(drift ?? "", /different money/, "and says plainly what the consequence is");

  // ── 4 · What is NOT a drift ─────────────────────────────────────────────────────────────────
  //
  // Each of these would otherwise cry wolf, and a warning that fires on half-typed input is a
  // warning people learn to scroll past.
  assert.equal(offerCostOfLivingDrift({ costOfLiving: "", jobTitle: "Medical Representative" }), null, "an empty box is somebody mid-edit");
  assert.equal(offerCostOfLivingDrift({ costOfLiving: "abc", jobTitle: "Medical Representative" }), null, "an unreadable value is not a disagreement");
  assert.equal(offerCostOfLivingDrift({ costOfLiving: 0, jobTitle: "Medical Representative" }), null, "nor is zero");
  assert.equal(offerCostOfLivingDrift({ costOfLiving: 2500, jobTitle: "   " }), null, "nor a title nobody has typed yet");

  // ── 5 · It reads payroll, it never restates it ──────────────────────────────────────────────
  //
  // A second copy of those figures in this module would be the very drift it exists to catch.
  const source = readFileSync("src/lib/offers/cost-of-living-agreement.ts", "utf8");
  assert.match(source, /resolveTitleAllowances/, "payroll's own resolver is the only source of its pair");

  // The header quotes the real figures on purpose — that is documentation, not a second opinion.
  // Stripped once here, and deliberately on a line of its own: the heredoc-backslash sweep is
  // line-scoped, so a single-backslash escape sharing a line with a regex constructor reads to it
  // as a halved escape. Keeping the two apart is the fix; widening that sweep is not.
  const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const literal of ["2000", "3000", "5000", "2500", "3500", "5500"]) {
    assert.ok(
      !new RegExp(`(?<![\\d,\\w])${literal}(?![\\d])`).test(codeOnly),
      `the module must not hard-code ${literal} — it would be a second opinion on the same money`,
    );
  }

  // ── 6 · The screen actually says it ─────────────────────────────────────────────────────────
  //
  // A guard nobody can see is not a guard. This is the half CI cannot otherwise reach: the data
  // side of the drift is only ever visible where the figure is typed.
  const tab = readFileSync("src/components/offers/offer-job-titles.tsx", "utf8");
  assert.match(tab, /offerCostOfLivingDrift\(\{/, "the Job titles tab computes it");
  assert.match(tab, /\{newTitleCostOfLivingDrift \?/, "and renders it beside the cost-of-living box");
  assert.ok(
    !/disabled=\{[^}]*Drift/.test(tab) && !/return;[^}]*Drift/.test(tab),
    "it FLAGS and never refuses — a deliberate change must still be savable",
  );
}
