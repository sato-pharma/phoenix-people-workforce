import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createAccessContext } from "../src/lib/auth/permissions.ts";
import { mayReadBooking, suggestInterviewForManager, type InterviewCalendarCaller } from "../src/lib/recruitment/interview-calendar.ts";

// The owner, 2026-10-26: "choose Ali Muhammad Ali and choose Zahra, the PDA Cairo district manager,
// and share. Only the interviews related to them appear." One interviewer's interviews are shared
// with one manager interview by interview; Phoenix suggests the manager's own ones from the org tree.
export function runInterviewManagerShareTests() {
  // Zahraa holds the PEDIA Cairo DM seat: line Pedia, region Cairo, no area.
  const cairoDm = { area: null, line: "Pedia", region: "Cairo" };
  assert.equal(
    suggestInterviewForManager(cairoDm, { area: "Heliopolis", line: "Pedia", region: "Cairo" }).suggested,
    true,
    "a Pedia interview for an area in Cairo is suggested to the Cairo DM",
  );
  const alex = suggestInterviewForManager(cairoDm, { area: "Alex East", line: "Pedia", region: "Alex-BHR" });
  assert.equal(alex.suggested, false, "an Alex East interview is NOT suggested to the Cairo DM");
  assert.match(alex.reason, /Alex East is in Alex-BHR, not Cairo/, "and the reason names both regions");
  const noArea = suggestInterviewForManager(cairoDm, { area: null, line: "Pedia", region: null });
  assert.equal(noArea.suggested, false, "an interview with no area is never suggested — the owner ticks it");
  assert.match(noArea.reason, /No area set/, "and it says so");
  assert.equal(
    suggestInterviewForManager(cairoDm, { area: "Somewhere New", line: "Pedia", region: null }).suggested,
    false,
    "an area the org tree does not know is never suggested",
  );
  assert.equal(
    suggestInterviewForManager(cairoDm, { area: "Heliopolis", line: "CNS", region: "Cairo" }).suggested,
    false,
    "another line's interview in the same region is not theirs",
  );
  assert.equal(
    suggestInterviewForManager(cairoDm, { area: "Behira (1)", line: "PEDIA", region: "cairo" }).suggested,
    true,
    "names compare loosely: case, spaces and brackets are ignored",
  );

  // An area-level manager is matched on the area itself.
  const areaManager = { area: "Behira 1", line: "Pedia", region: "Alex-BHR" };
  assert.equal(suggestInterviewForManager(areaManager, { area: "Behira (1)", line: "Pedia", region: "Alex-BHR" }).suggested, true, "Behira (1) is Behira 1");
  assert.equal(suggestInterviewForManager(areaManager, { area: "Alex East", line: "Pedia", region: "Alex-BHR" }).suggested, false, "a neighbouring area in the same region is not an area manager's");

  // A national manager (line only) is suggested everything on their line.
  const nsm = { area: null, line: "Pedia", region: null };
  assert.equal(suggestInterviewForManager(nsm, { area: null, line: "Pedia", region: null }).suggested, true, "the line's NSM gets the line's interviews");
  assert.equal(suggestInterviewForManager(nsm, { area: null, line: "CNS", region: null }).suggested, false, "but not another line's");

  // READ: a District Manager at the own-only tier reads an interview shared with them, and only that one.
  const zahraa = createAccessContext({ hrId: "PD-0031", role: "District Manager" });
  const asInterviewer: InterviewCalendarCaller = { access: zahraa, link: null, own: "interviewer" };
  const at = "2026-10-26T08:30:00.000Z";
  assert.equal(
    mayReadBooking(asInterviewer, { interviewer_hr_id: "A-12", shared_with_hr_ids: ["PD-0031"], starts_at: at }),
    true,
    "an interview shared with them is on their calendar",
  );
  assert.equal(
    mayReadBooking(asInterviewer, { interviewer_hr_id: "A-12", shared_with_hr_ids: ["PD-0099"], starts_at: at }),
    false,
    "an interview shared with somebody else is not",
  );
  assert.equal(mayReadBooking(asInterviewer, { interviewer_hr_id: "A-12", shared_with_hr_ids: [], starts_at: at }), false, "nor one shared with nobody");

  // The save touches only the chosen interviewer's upcoming interviews, writes the manager's id, and
  // notifies in-app and push — never email.
  const domain = readFileSync(join(process.cwd(), "src/lib/recruitment/interview-calendar.ts"), "utf8");
  const save = domain.slice(domain.indexOf("export async function saveInterviewManagerShare("), domain.indexOf("async function notifyInterviewsShared("));
  assert.match(save, /requireCalendarAccess\(caller, "share", null\)/, "only the calendar owner may share interviews");
  assert.match(save, /const rows = await upcomingInterviewsOf\(interviewer\.hrId, now\)/, "only that interviewer's upcoming interviews are touched");
  assert.match(save, /shared_with_hr_ids: next/, "the manager is written onto the booking");
  const notify = domain.slice(domain.indexOf("async function notifyInterviewsShared("), domain.indexOf("// ── Finding a candidate from an empty cell"));
  assert.match(notify, /channels: \["in_app", "push"\]/, "the manager is told in Phoenix and on their phone");
  assert.doesNotMatch(notify, /"email"|"telegram"/, "never by email or Telegram");
}
