import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { employeePortalDevPreviewData } from "../src/lib/employee-portal/dev-preview-data.ts";
import type { MedicalRepPortalData } from "../src/lib/employee-portal/service.ts";
import { shouldRecordShownIncentive } from "../src/lib/incentives/shown-figures-store.ts";
import { shownIncentiveFigure, shownIncentiveFingerprint } from "../src/lib/incentives/shown-figures.ts";

// ─────────────────────────────────────────────────────────────────────────────
// THE INCENTIVE FIGURE A PERSON WAS SHOWN IS STORED, AND READS BACK UNCHANGED
// (enterprise audit REC-066, F-PAY-007 and F-PAY-008; 14 Nov 2026).
//
// Owner, 14 Nov 2026: "when first shown". The person's own Incentive tab stores the figure it showed,
// with its inputs, the first time, and again only when it changes; he reads the history on Employee
// 360, nobody else does; nothing pays from it. This file pins:
//   1. the stored record is the tab's own figure, never a recalculation, and none is stored when the
//      tab showed none;
//   2. the same figure has the same fingerprint (one row), a changed figure a new one (a new row), so a
//      past figure is never rewritten — the acceptance criterion: it reads back unchanged;
//   3. only the person's own real session stores it — not a manager on Employee 360, a test account,
//      a seat view or a preview session;
//   4. the read-back is the Super Admin's alone;
//   5. the table is service-role only, and its upsert never sends the first-shown time or touches the
//      locked scheme;
//   6. F-PAY-008: a rep's own figure reads the closing engine's rows, published months only.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

const BASE = employeePortalDevPreviewData as unknown as MedicalRepPortalData;
function payload(change: (data: MedicalRepPortalData) => void = () => {}): MedicalRepPortalData {
  const data = structuredClone(BASE);
  data.sales.incentiveSemesterPeriods = ["2026-03", "2026-01", "2026-02"];
  change(data);
  return data;
}

function testTheRecordIsTheTabsOwnFigure() {
  // HEADLINE: what is stored is what the tab showed — its payout, achievement and inputs, read off the payload.
  const data = payload();
  const figure = shownIncentiveFigure(data);
  assert.ok(figure, "a tab with a semester target shows a figure");
  assert.equal(figure.hrId, data.employee.hrId);
  assert.equal(figure.payoutEgp, data.payroll.incentive, "the payout the tab printed");
  assert.equal(figure.achievementPercent, data.sales.overviewAchievementPercent, "the achievement the tab printed");
  assert.equal(figure.basicSalary, data.payroll.basicSalary);
  assert.equal(figure.semesterLabel, data.sales.incentiveSemesterLabel);
  assert.deepEqual(figure.periods, ["2026-01", "2026-02", "2026-03"], "the months counted, in order");
  assert.equal(figure.pediaSplit, null, "no split off the Pedia line");

  const pedia = shownIncentiveFigure(
    payload((d) => {
      d.sales.pediaSplit = {
        satoAchievementPercent: 70.25,
        satoSales: 100,
        satoTarget: 142.35,
        satoHalfAmount: 0,
        satoHalfWithheld: true,
        totalHalfAmount: 30000,
        payoutAmount: 30000,
        payoutPercentage: 45.5,
        semesterTargetIncentive: 65940,
      };
      d.payroll.incentive = 30000;
    }),
  );
  assert.equal(pedia?.pediaSplit?.satoHalfWithheld, true, "a withheld Sato half is kept as shown");
  assert.equal(pedia?.payoutEgp, 30000);

  // The tab showed no figure: nothing is stored.
  assert.equal(shownIncentiveFigure(payload((d) => { d.empty.profile = true; })), null, "no linked profile");
  assert.equal(shownIncentiveFigure(payload((d) => { d.sales.incentiveClosingUnread = true; })), null, "a manager's closing that could not be read");
  assert.equal(shownIncentiveFigure(payload((d) => { d.sales.incentiveSemesterTarget = 0; })), null, "\"No target yet\" is not a figure");
  assert.equal(shownIncentiveFigure(payload((d) => { d.sales.incentiveSemesterLabel = null; })), null, "no semester");
}

function testAPastFigureIsNeverRewritten() {
  // HEADLINE: one figure, one fingerprint; any change in it is a new fingerprint, so a new row.
  const figure = shownIncentiveFigure(payload())!;
  const again = shownIncentiveFigure(payload())!;
  assert.equal(shownIncentiveFingerprint(figure), shownIncentiveFingerprint(again), "the same figure shown twice is one row");
  assert.equal(
    shownIncentiveFingerprint(figure),
    shownIncentiveFingerprint(shownIncentiveFigure(payload((d) => { d.sales.overviewAchievementPercent += 0.0000001; }))!),
    "a float's last digit is not a new figure",
  );
  const changes: Array<[string, (d: MedicalRepPortalData) => void]> = [
    ["the payout", (d) => { d.payroll.incentive += 1; }],
    ["the achievement", (d) => { d.sales.overviewAchievementPercent += 0.5; }],
    ["a restated sales total", (d) => { d.sales.incentiveSemesterSales += 1000; }],
    ["the basic", (d) => { d.payroll.basicSalary += 100; }],
    ["a month added", (d) => { d.sales.incentiveSemesterPeriods = ["2026-01", "2026-02", "2026-03", "2026-04"]; }],
    ["the notice", (d) => { d.sales.incentiveWindowNotice = "April is not loaded yet."; }],
    ["the Sato half", (d) => {
      d.sales.pediaSplit = { satoAchievementPercent: 91, satoSales: 1, satoTarget: 1, satoHalfAmount: 10, satoHalfWithheld: false, totalHalfAmount: 10, payoutAmount: 20, payoutPercentage: 50, semesterTargetIncentive: 1 };
    }],
  ];
  for (const [what, change] of changes) {
    assert.notEqual(shownIncentiveFingerprint(shownIncentiveFigure(payload(change))!), shownIncentiveFingerprint(figure), `${what} changed is a new row`);
  }
  // The Sato half alone differing is a new row too — the split is part of the fingerprint.
  const splitA = payload((d) => { d.sales.pediaSplit = { satoAchievementPercent: 91, satoSales: 1, satoTarget: 1, satoHalfAmount: 10, satoHalfWithheld: false, totalHalfAmount: 10, payoutAmount: 20, payoutPercentage: 50, semesterTargetIncentive: 1 }; });
  const splitB = payload((d) => { d.sales.pediaSplit = { satoAchievementPercent: 79, satoSales: 1, satoTarget: 1, satoHalfAmount: 10, satoHalfWithheld: false, totalHalfAmount: 10, payoutAmount: 20, payoutPercentage: 50, semesterTargetIncentive: 1 }; });
  assert.notEqual(shownIncentiveFingerprint(shownIncentiveFigure(splitA)!), shownIncentiveFingerprint(shownIncentiveFigure(splitB)!), "a different Sato achievement is a new row");

  const store = read("src/lib/incentives/shown-figures-store.ts");
  assert.match(store, /onConflict: "hr_id,fingerprint"/, "a figure already stored is matched on the person and its fingerprint");
  assert.equal(/first_shown_at:/.test(store.slice(store.indexOf(".upsert("), store.indexOf("onConflict"))), false, "the upsert never sends the first-shown time, so it is kept");
  assert.equal(/\.(update|delete)\(/.test(store), false, "nothing rewrites or removes a stored figure");
}

function testOnlyThePersonsOwnRealSessionStoresIt() {
  // HEADLINE: their own figure, seen by them.
  const data = payload();
  const own = { hrId: data.employee.hrId, source: "session" as const, seatView: null, testPersona: null };
  assert.equal(shouldRecordShownIncentive(own, data), true, "the person's own tab");
  assert.equal(shouldRecordShownIncentive({ ...own, hrId: "B-999" }, data), false, "someone else's figure");
  assert.equal(shouldRecordShownIncentive({ ...own, hrId: null }, data), false, "no person");
  assert.equal(shouldRecordShownIncentive({ ...own, source: "dev-header" as never }, data), false, "a preview session");
  assert.equal(shouldRecordShownIncentive({ ...own, seatView: {} as never }, data), false, "a seat view");
  assert.equal(shouldRecordShownIncentive({ ...own, testPersona: {} as never }, data), false, "a test account");

  // Written from the two own-view pages, after the payload, never from Employee 360.
  for (const file of ["app/employee-portals/incentive/page.tsx", "src/components/workspace/admin-shell-employee-pages.tsx"]) {
    const text = read(file);
    const load = text.indexOf("getEmployeePortalIncentiveData(access)");
    const store = text.indexOf("await recordShownIncentive(access, data);");
    assert.ok(load >= 0 && store > load, `${file} stores the figure its own tab just loaded`);
  }
  for (const file of ["src/lib/employee-360/personnel-records.ts", "src/lib/employee-360/person-incentive.ts", "src/components/employee-360/incentive-section.tsx"]) {
    assert.equal(read(file).includes("recordShownIncentive"), false, `${file}: a manager looking is not the person being shown`);
  }
}

function testTheReadBackIsTheSuperAdminsAlone() {
  const section = read("src/components/employee-360/incentive-section.tsx");
  const gate = section.indexOf('props.access.role === "Super Admin"');
  const load = section.indexOf("loadShownIncentiveHistory(props.target.hrId)");
  assert.ok(gate >= 0 && load > gate && load - gate < 200, "the history is read only behind the Super Admin test");
  assert.match(section, /\{shownHistory !== undefined \? <ShownIncentiveHistory rows=\{shownHistory\} \/> : null\}/, "and drawn only when it was read");
  const users = [...listFiles("src"), ...listFiles("app")].filter((file) => read(file).includes("loadShownIncentiveHistory("));
  assert.deepEqual(users.sort(), ["src/components/employee-360/incentive-section.tsx", "src/lib/incentives/shown-figures-store.ts"], "no other reader");
}

function testTheTableIsServiceRoleOnly() {
  const migrations = readdirSync(join(ROOT, "supabase/migrations")).filter((name) => name.endsWith("_incentive_shown_figures.sql"));
  assert.equal(migrations.length, 1, "one migration creates it");
  const sql = read(`supabase/migrations/${migrations[0]}`);
  assert.match(sql, /alter table public\.incentive_shown_figures enable row level security;/);
  assert.match(sql, /revoke all on public\.incentive_shown_figures from public, anon, authenticated;/);
  assert.match(sql, /constraint incentive_shown_figures_person_figure_key unique \(hr_id, fingerprint\)/);
  assert.match(sql, /references public\.employees \(hr_id\) on update cascade on delete restrict/, "keyed to the person like every money table");
  assert.equal(/grant [^;]* to (anon|authenticated)/i.test(sql), false, "no browser role is granted");
  // The locked scheme is read by nothing new.
  for (const file of ["src/lib/incentives/shown-figures.ts", "src/lib/incentives/shown-figures-store.ts"]) {
    assert.equal(/from "[^"]*incentives\/(scheme-2026|pedia-split)"/.test(read(file)), false, `${file} never calculates`);
  }
}

function testARepsFigureReadsPublishedClosingRows() {
  // F-PAY-008, checked 14 Nov 2026: a rep's rows come from the closing engine, published months only.
  const canonical = read("src/lib/employee-portal/portal-sales-canonical.ts");
  assert.match(canonical, /loadAchievementRange\(SALES_HISTORY_FLOOR, to\)/, "the closing engine's rows");
  assert.match(canonical, /rows\.filter\(\(row\) => isSalesPeriodReleased\(row\.period, row\.lineCode, publishedKeys\)\)/, "published months only, per line");
  assert.match(read("src/lib/employee-portal/service.ts"), /const canonicalRows = await loadCanonicalPortalSalesRows\(normalizedFilters\);/, "and the portal reads them");
}

function listFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) listFiles(path, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

export function runIncentiveShownFiguresTests() {
  testTheRecordIsTheTabsOwnFigure();
  testAPastFigureIsNeverRewritten();
  testOnlyThePersonsOwnRealSessionStoresIt();
  testTheReadBackIsTheSuperAdminsAlone();
  testTheTableIsServiceRoleOnly();
  testARepsFigureReadsPublishedClosingRows();
}
