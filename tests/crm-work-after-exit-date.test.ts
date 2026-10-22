import assert from "node:assert/strict";

import {
  crmLabelAreaAndLine,
  crmLabelMatchesSeat,
  summarizeCrmWorkAfterDate,
} from "../src/lib/resignations/crm-work-after-date.ts";

/**
 * The exit forms' warning counts only the leaver's own CRM work after the date being saved
 * (owner, 2026-10-22: Shimaa Ibrahim worked 5 to 10 September after a last day of 2 September;
 * Ahmed Nabil worked 1 to 6 October after a last day of 30 September).
 */
export function runCrmWorkAfterExitDateTests() {
  // Ahmed Nabil's shape: stamped to him on his own account after 30 Sep, a Pedia DM beside him on
  // 6 Oct, and one row before the date that must not count.
  const ahmed = summarizeCrmWorkAfterDate(
    [
      { agent_crm_id: 1537, agent_hr_id: "AI-0002", double_hr_id: null, visit_date: "2026-09-30" },
      { agent_crm_id: 1537, agent_hr_id: "AI-0002", double_hr_id: null, visit_date: "2026-10-01" },
      { agent_crm_id: 1537, agent_hr_id: "ai-0002", double_hr_id: null, visit_date: "2026-10-03" },
      { agent_crm_id: 1537, agent_hr_id: "AI-0002", double_hr_id: "PD-0012", visit_date: "2026-10-06" },
      { agent_crm_id: 1537, agent_hr_id: "AI-0002", double_hr_id: "PD-0012", visit_date: "2026-10-06" },
    ],
    { afterDate: "2026-09-30", crmIds: [1537], hrId: "AI-0002" },
  );
  assert.equal(ahmed.visits, 4, "the row ON the last working day is not after it; the four after are counted");
  assert.deepEqual(ahmed.days, ["2026-10-01", "2026-10-03", "2026-10-06"]);
  assert.equal(ahmed.firstDay, "2026-10-01");
  assert.equal(ahmed.lastDay, "2026-10-06", "the warning names the last day the CRM shows him working");
  assert.deepEqual(ahmed.daysWithManager, ["2026-10-06"], "a manager beside him on his own visit is reported");

  // Shimaa Ibrahim's shape: after her record ended the sync stamps nobody, so her visits sit
  // UNSTAMPED on her account and must still count.
  const shimaa = summarizeCrmWorkAfterDate(
    [
      { agent_crm_id: 1303, agent_hr_id: null, double_hr_id: "AI-0014", visit_date: "2026-09-05" },
      { agent_crm_id: "1303", agent_hr_id: "", double_hr_id: null, visit_date: "2026-09-10" },
    ],
    { afterDate: "2026-09-02", crmIds: ["1303"], hrId: "AI-0017" },
  );
  assert.equal(shimaa.visits, 2, "unstamped rows on the person's own CRM account are their work");
  assert.equal(shimaa.lastDay, "2026-09-10");

  // A reused account: the successor's stamped rows are the successor's and never count, and an
  // unstamped row on somebody else's account never counts either.
  const reused = summarizeCrmWorkAfterDate(
    [
      { agent_crm_id: 1303, agent_hr_id: "AI-0025", double_hr_id: null, visit_date: "2026-10-01" },
      { agent_crm_id: 9999, agent_hr_id: null, double_hr_id: null, visit_date: "2026-10-02" },
    ],
    { afterDate: "2026-09-02", crmIds: [1303], hrId: "AI-0017" },
  );
  assert.equal(reused.visits, 0, "a successor's rows on the reused account are never the leaver's work");
  assert.equal(reused.firstDay, null);

  // A manager leaving: the rep's row naming him as the double is his field day, and is not reported
  // as "a manager beside him".
  const manager = summarizeCrmWorkAfterDate(
    [{ agent_crm_id: 1459, agent_hr_id: "B-152", double_hr_id: "PD-0012", visit_date: "2026-10-04" }],
    { afterDate: "2026-10-01", crmIds: [], hrId: "PD-0012" },
  );
  assert.equal(manager.visits, 1, "a manager's double visit after the date is his work");
  assert.deepEqual(manager.daysWithManager, [], "his own double visit is not someone else beside him");

  // The CRM account label names the seat: the retired codes read as the live ones, and a different
  // area or line never matches.
  assert.deepEqual(crmLabelAreaAndLine("Norhan.Gamal ( Sharkia 1 / A )"), { area: "sharkia 1", line: "A" });
  assert.deepEqual(crmLabelAreaAndLine("Warda.Farhat  ( Menofia 1 / E )"), { area: "menofia 1", line: "A" });
  assert.deepEqual(crmLabelAreaAndLine("( Behera 1 / F )"), { area: "behera 1", line: "P" });
  assert.equal(crmLabelAreaAndLine("Ahmed.Helal"), null, "a label with no ( Area / Line ) part names no seat");
  assert.equal(
    crmLabelMatchesSeat("Norhan.Gamal ( Sharkia 1 / A )", { areaName: "Sharkia 1", lineName: "Anti Infective" }),
    true,
    "Shimaa Ibrahim's seat finds the Sharkia 1 / A account her visits sit on unstamped",
  );
  assert.equal(
    crmLabelMatchesSeat("Norhan.Gamal ( Sharkia 1 / A )", { areaName: "Sharkia 1", lineName: "Pedia" }),
    false,
    "the same area on another line is somebody else's account",
  );
  assert.equal(
    crmLabelMatchesSeat("X ( Sharkia 2 / A )", { areaName: "Sharkia 1", lineName: "Anti Infective" }),
    false,
    "another area never matches",
  );

  // An unusable visit date is ignored rather than counted.
  const junk = summarizeCrmWorkAfterDate(
    [{ agent_crm_id: 1, agent_hr_id: "X-1", double_hr_id: null, visit_date: null }],
    { afterDate: "2026-01-01", crmIds: [], hrId: "X-1" },
  );
  assert.equal(junk.visits, 0);
}
