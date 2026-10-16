import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  AUTOPILOT_OPEN_NOTE,
  MAX_OPENINGS_PER_RUN,
  planRequisitionAutopilot,
  vacancySeatKey,
  type AutopilotRequisition,
  type AutopilotSeat,
  type AutopilotVacancyRow,
} from "../src/lib/recruitment/requisition-autopilot.ts";
import { recommendRequisition, type OpenRequisitionOption } from "../src/lib/recruitment/requisition-match.ts";
import type { VacancyOption } from "../src/lib/recruitment/vacancy-options.ts";
import { stripComments } from "./support/comment-strip.ts";

const read = (relative: string) => readFileSync(join(process.cwd(), relative), "utf8");

// The recruitment automation (owner, 2026-10-16): "I want all this process to be automated, opening
// requisition and the end-to-end cycle, I don't want manual work in the recruitment." Opening: raise
// and open at once. Approval: none. Closing: filled automatically. Middle: the system matches and
// recommends, one press by Admin or Talent Acquisition attaches — and Reject is never recommended.

function seat(id: number, overrides: Partial<AutopilotSeat> = {}): AutopilotSeat {
  return {
    areaName: `Area ${id}`,
    jobTitle: "Medical Representative",
    lineName: "CNS",
    replacementForHrId: null,
    seatKey: `seat:${id}`,
    vacancyCode: `VAC-${id}`,
    vacancyId: id,
    ...overrides,
  };
}

function requisition(code: string, vacancyId: number | null, status = "req_open"): AutopilotRequisition {
  return { code, id: `id-${code}`, jobTitle: "Medical Representative", status, vacancyId };
}

// A FILLED row names its hire unless a test says otherwise — a fill needs that proof.
function row(
  id: number,
  status: string,
  seatKey: string | null = `seat:${id}`,
  filledByHrId: string | null = status === "filled" ? "AI-0013" : null,
): AutopilotVacancyRow {
  return { filledByHrId, id, seatKey, status };
}

function testAutopilotPlan() {
  const noOne = () => null;

  // An empty seat with no requisition is OPENED; one already covered by its own row is left alone.
  let plan = planRequisitionAutopilot({
    replacementStatus: noOne,
    requisitions: [requisition("REQ-A", 2)],
    seats: [seat(1), seat(2)],
    vacancyRows: [row(1, "open"), row(2, "open")],
  });
  assert.deepEqual(plan.open.map((entry) => entry.vacancyId), [1], "only the uncovered seat is opened");
  assert.equal(plan.fill.length, 0, "a requisition on an open seat is never closed");

  // ONE SEAT, ONE REQUISITION: a requisition on an OLDER event row of the same seat covers it.
  plan = planRequisitionAutopilot({
    replacementStatus: noOne,
    requisitions: [requisition("REQ-OLD", 90)],
    seats: [seat(3, { seatKey: "seat:shared" })],
    vacancyRows: [row(90, "open", "seat:shared"), row(3, "open", "seat:shared")],
  });
  assert.equal(plan.open.length, 0, "a seat covered through another of its vacancy rows gets no second requisition");

  // …unless that older row is FILLED: then the old one is filled and the seat opens again, same run.
  plan = planRequisitionAutopilot({
    replacementStatus: noOne,
    requisitions: [requisition("REQ-OLD", 90)],
    seats: [seat(3, { seatKey: "seat:shared" })],
    vacancyRows: [row(90, "filled", "seat:shared"), row(3, "open", "seat:shared")],
  });
  assert.deepEqual(plan.fill.map((entry) => entry.code), ["REQ-OLD"], "the requisition on the filled row is filled");
  assert.deepEqual(plan.open.map((entry) => entry.vacancyId), [3], "and the seat that emptied again is opened in the same run");

  // Two open rows of ONE seat open one requisition, not two.
  plan = planRequisitionAutopilot({
    replacementStatus: noOne,
    requisitions: [],
    seats: [seat(4, { seatKey: "seat:twin" }), seat(5, { seatKey: "seat:twin" })],
    vacancyRows: [],
  });
  assert.equal(plan.open.length, 1, "two event rows of one seat open a single requisition");

  // A requisition raised against NO seat covers one empty seat of its title — never a second hire.
  plan = planRequisitionAutopilot({
    replacementStatus: noOne,
    requisitions: [{ code: "REQ-OC", id: "oc", jobTitle: "Office Coordinator", status: "req_open", vacancyId: null }],
    seats: [seat(20, { jobTitle: "Office  Coordinator" }), seat(21, { jobTitle: "office coordinator" })],
    vacancyRows: [],
  });
  assert.deepEqual(plan.open.map((entry) => entry.vacancyId), [21], "a seatless requisition covers one seat of its title, and only one");

  // PARKED seats — the owner's own list — are never opened.
  plan = planRequisitionAutopilot({
    replacementStatus: noOne,
    requisitions: [],
    seats: [seat(6, { areaName: "Nasr City", lineName: "Pedia" }), seat(7, { areaName: "Menoufia 1", lineName: "Anti Infective" })],
    vacancyRows: [],
  });
  assert.equal(plan.open.length, 0, "a parked seat is not opened");
  assert.deepEqual(plan.skipped.map((entry) => entry.reason), ["parked", "parked"]);

  // A replacement opens only once the person replaced has actually left.
  plan = planRequisitionAutopilot({
    replacementStatus: (hrId) => (hrId === "A-1" ? "active" : "resigned"),
    requisitions: [],
    seats: [seat(8, { replacementForHrId: "A-1" }), seat(9, { replacementForHrId: "A-2" })],
    vacancyRows: [],
  });
  assert.deepEqual(plan.open.map((entry) => entry.vacancyId), [9], "the replacement for a resigned person opens");
  assert.deepEqual(plan.skipped, [{ reason: "replacement_still_employed", seat: seat(8, { replacementForHrId: "A-1" }) }]);

  // A seatless requisition is spent only on a seat that would have opened: a PARKED seat of the
  // same title is skipped first, and the requisition still covers the seat after it.
  plan = planRequisitionAutopilot({
    replacementStatus: noOne,
    requisitions: [{ code: "REQ-MR", id: "mr", jobTitle: "Medical Representative", status: "req_open", vacancyId: null }],
    seats: [seat(22, { areaName: "Nasr City", lineName: "Pedia" }), seat(23)],
    vacancyRows: [],
  });
  assert.equal(plan.open.length, 0, "the seatless requisition covers the seat that could open, not the parked one");
  assert.deepEqual(plan.skipped.map((entry) => entry.reason), ["parked"]);

  // CLOSING: only a seat row FILLED BY A NAMED HIRE fills its requisition. Nothing is ever cancelled.
  // A DRAFT a person raised is their work and is never touched.
  plan = planRequisitionAutopilot({
    replacementStatus: noOne,
    requisitions: [
      requisition("REQ-F", 10),
      requisition("REQ-C", 11, "req_on_hold"),
      requisition("REQ-D", 12, "req_draft"),
      requisition("REQ-DONE", 13, "req_filled"),
      requisition("REQ-NOSEAT", null),
      requisition("REQ-NOBODY", 14),
    ],
    seats: [],
    vacancyRows: [row(10, "filled"), row(11, "cancelled"), row(12, "filled"), row(13, "filled"), row(14, "filled", "seat:14", null)],
  });
  assert.deepEqual(plan.fill.map((entry) => entry.code), ["REQ-F"], "filled only on a named hire");
  assert.equal("cancel" in plan, false, "the plan has no cancel step at all");
  assert.equal(plan.retry.length, 0, "a person's draft is never opened");

  // The autopilot's OWN draft — a run that died between the insert and the opening — is opened again.
  plan = planRequisitionAutopilot({
    replacementStatus: noOne,
    requisitions: [{ ...requisition("REQ-STUCK", 15, "req_draft"), notes: AUTOPILOT_OPEN_NOTE }],
    seats: [seat(15)],
    vacancyRows: [row(15, "open")],
  });
  assert.deepEqual(plan.retry.map((entry) => entry.code), ["REQ-STUCK"], "its own stranded draft is retried");
  assert.equal(plan.open.length, 0, "and the seat is not opened a second time");
  assert.ok(MAX_OPENINGS_PER_RUN > 0 && MAX_OPENINGS_PER_RUN <= 8, "a run opens a few, inside the scheduler's 30 seconds");

  // The seat identity is read from ids, never names; a Head Office seat with no line or area has one.
  assert.equal(vacancySeatKey({ seat_id: "abc" }), "seat:abc");
  assert.equal(vacancySeatKey({ area_id: 4, line_id: 2, position_id: 9 }), "place:2|4|9");
  assert.equal(vacancySeatKey({ position_id: 9, vacancy_code: "v-1" }), "place:-|-|9");
  assert.equal(vacancySeatKey({ job_title: "Office Coordinator" }), "place:-|-|office coordinator");
  assert.equal(vacancySeatKey({ vacancy_code: "v-1" }), "code:V-1");
  assert.equal(vacancySeatKey({}), null);
}

const vacancy = (id: number, areaName: string, lineName: string, jobTitle = "Medical Representative"): VacancyOption => ({
  areaName,
  id,
  jobTitle,
  lineName,
  managerHrId: null,
  managerName: null,
  regionName: null,
  standingInFor: null,
});

const VACANCIES = [vacancy(1, "Menoufia 2", "CNS"), vacancy(2, "Sohag 1", "CNS")];
const REQUISITIONS: OpenRequisitionOption[] = [
  { areaName: "Menoufia 2", code: "REQ-M", id: "r-m", jobTitle: "Medical Representative", lineName: "CNS", regionName: null, vacancyId: 1 },
  { areaName: "Sohag 1", code: "REQ-S", id: "r-s", jobTitle: "Medical Representative", lineName: "CNS", regionName: null, vacancyId: 2 },
];

function testRecommendation() {
  const rep = { appliedForJobTitle: "Medical Representative", hasMedicalRepExperience: true };

  // THE WHATSAPP ANSWER IS THE SOURCE OF TRUTH FOR PLACE — it beats a CV address naming elsewhere.
  const tapped = recommendRequisition({
    candidate: { ...rep, address: "Sohag", governorate: "Sohag", preferredAreaName: "Menoufia 2" },
    requisitions: REQUISITIONS,
    vacancies: VACANCIES,
  });
  assert.equal(tapped?.verdict, "attach");
  assert.deepEqual(tapped?.verdict === "attach" ? tapped.options.map((option) => option.code) : [], ["REQ-M"], "the area tapped on WhatsApp decides");
  assert.match(tapped?.reason ?? "", /on WhatsApp/);

  // No WhatsApp answer: the CV's own place.
  const fromCv = recommendRequisition({
    candidate: { ...rep, address: "Sohag", governorate: "Sohag" },
    requisitions: REQUISITIONS,
    vacancies: VACANCIES,
  });
  assert.deepEqual(fromCv?.verdict === "attach" ? fromCv.options.map((option) => option.code) : [], ["REQ-S"], "without a WhatsApp answer the CV address places it");

  // A WhatsApp answer naming no open requisition keeps them shortlisted — it never falls back to the CV.
  const nowhere = recommendRequisition({
    candidate: { ...rep, address: "Sohag", governorate: "Sohag", preferredAreaName: "Aswan" },
    requisitions: REQUISITIONS,
    vacancies: VACANCIES,
  });
  assert.equal(nowhere?.verdict, "keep", "the WhatsApp answer is the truth even when the CV names a seat");

  // Already attached → keep; decided or hired → nothing to recommend.
  assert.equal(
    recommendRequisition({ attachedRequisitionIds: ["r-s"], candidate: { ...rep, address: "Sohag" }, requisitions: REQUISITIONS, vacancies: VACANCIES })?.verdict,
    "keep",
  );
  for (const status of ["hired", "rejected", "sent_to_manager"]) {
    assert.equal(recommendRequisition({ candidate: { ...rep, status }, requisitions: REQUISITIONS, vacancies: VACANCIES }), null, `${status} is not the screen's to place`);
  }
  assert.equal(recommendRequisition({ candidate: rep, requisitions: [], vacancies: VACANCIES })?.verdict, "keep");

  // A SEAT WHOSE "AREA" IS THE COMPANY IS PLACED BY THE JOB ALONE. The Product Manager seat left by
  // the Marketing product manager carries area "Egypt" on production, and the Office Coordinator and
  // Training Manager seats carry "Head office" — names no candidate ever taps on WhatsApp and no CV
  // ever gives as a governorate, so every CV for them came back "keep" while the requisition sat open.
  const pmVacancy = vacancy(10, "Egypt", "Anti Infective", "Product Manager");
  const pmRequisitions: OpenRequisitionOption[] = [
    ...REQUISITIONS,
    { areaName: "Egypt", code: "REQ-PM", id: "r-pm", jobTitle: "Product Manager", lineName: "Anti Infective", regionName: "Egypt", vacancyId: 10 },
  ];
  const pmVacancies = [...VACANCIES, pmVacancy];
  const productManager = { appliedForJobTitle: "Product Manager", currentJobTitle: "Product Manager", hasMedicalRepExperience: false };

  const pmTapped = recommendRequisition({
    candidate: { ...productManager, preferredAreaName: "Cairo" },
    requisitions: pmRequisitions,
    vacancies: pmVacancies,
  });
  assert.equal(pmTapped?.verdict, "attach", "a Product Manager CV reaches the Product Manager requisition");
  assert.deepEqual(
    pmTapped?.verdict === "attach" ? pmTapped.options.map((option) => option.code) : [],
    ["REQ-PM"],
    "and only that one — a country-wide seat is placed by the job, never offered to every CV",
  );

  const pmFromCv = recommendRequisition({
    candidate: { ...productManager, address: "Nasr City, Cairo", governorate: "Cairo" },
    requisitions: pmRequisitions,
    vacancies: pmVacancies,
  });
  assert.deepEqual(
    pmFromCv?.verdict === "attach" ? pmFromCv.options.map((option) => option.code) : [],
    ["REQ-PM"],
    "with no WhatsApp answer the CV's own governorate still reaches it",
  );

  // THE TRAINING SEAT IS THE SAME HOLE — REQ-2026-IEILI2 stands open at head office, and a CV reading
  // "Training Manager" named no job family at all, so it could only ever come back "keep".
  const trainingRequisitions: OpenRequisitionOption[] = [
    ...REQUISITIONS,
    { areaName: "Head office", code: "REQ-TR", id: "r-tr", jobTitle: "Training Manager", lineName: null, regionName: "Egypt", vacancyId: 12 },
  ];
  const trainingVacancies = [...VACANCIES, vacancy(12, "Head office", null, "Training Manager")];
  const training = recommendRequisition({
    candidate: { appliedForJobTitle: "Training Manager", currentJobTitle: "Training Specialist", preferredAreaName: "Cairo" },
    requisitions: trainingRequisitions,
    vacancies: trainingVacancies,
  });
  assert.deepEqual(
    training?.verdict === "attach" ? training.options.map((option) => option.code) : [],
    ["REQ-TR"],
    "a training CV reaches the Training Manager requisition",
  );

  // AND A FIELD TRAINER IS STILL A REPRESENTATIVE. The training family is deliberately narrow — the
  // rep family must keep a CV that merely mentions training in the field.
  const fieldTrainer = recommendRequisition({
    candidate: { appliedForJobTitle: "Medical Representative", currentJobTitle: "Medical Representative and field training", preferredAreaName: "Menoufia 2" },
    requisitions: trainingRequisitions,
    vacancies: trainingVacancies,
  });
  assert.deepEqual(
    fieldTrainer?.verdict === "attach" ? fieldTrainer.options.map((option) => option.code) : [],
    ["REQ-M"],
    "a representative who trains in the field keeps the representative seat",
  );

  // AND IT WIDENS NOTHING ELSE. A District Sales Manager seat whose area merely repeats its region is
  // a REAL place: "Cairo" is not the company, and a candidate who named somewhere else stays put.
  const dsmRequisitions: OpenRequisitionOption[] = [
    { areaName: "Cairo", code: "REQ-DSM", id: "r-dsm", jobTitle: "District Sales Manager", lineName: "Pedia", regionName: "Cairo", vacancyId: 11 },
  ];
  const dsmVacancies = [vacancy(11, "Cairo", "Pedia", "District Sales Manager")];
  assert.equal(
    recommendRequisition({
      candidate: { appliedForJobTitle: "District Sales Manager", preferredAreaName: "Aswan" },
      requisitions: dsmRequisitions,
      vacancies: dsmVacancies,
    })?.verdict,
    "keep",
    "a real area that happens to equal its region is still an area",
  );

  // NEVER RECOMMEND REJECT (owner, 2026-10-16): the verdict vocabulary is exactly attach and keep.
  const source = stripComments(read("src/lib/recruitment/requisition-match.ts"));
  const verdicts = [...source.matchAll(/verdict: "([a-z_]+)"/g)].map((match) => match[1]);
  assert.ok(verdicts.length >= 6, "the verdicts were read");
  assert.deepEqual([...new Set(verdicts)].sort(), ["attach", "keep"], "no verdict other than attach or keep exists");
}

function testWiring() {
  const route = stripComments(read("app/api/cron/recruitment-requisition-autopilot/route.ts"));
  assert.match(route, /assertCronAuthorized\(request, "cron\/recruitment-requisition-autopilot"\)/, "the cron route checks the secret");
  assert.match(route, /withDeadMansSwitch\("phoenix-recruitment-requisition-autopilot"/, "and reports its heartbeat");
  assert.match(
    read("src/lib/observability/job-schedule.ts"),
    /"phoenix-recruitment-requisition-autopilot", kind: "cron", schedule: "27 \* \* \* \*"/,
    "declared hourly on :27",
  );
  assert.match(
    read("scripts/cronjob-sync.mjs"),
    /"recruitment-requisition-autopilot": \{[\s\S]{0,700}?minutes: \[27\]/,
    "and to the scheduler on the same minute",
  );

  const autopilot = stripComments(read("src/lib/recruitment/requisition-autopilot.ts"));
  assert.match(autopilot, /runRequisitionWorkflow\(created\.id, "req_open", systemAccessContext\)/, "a new requisition is opened at once, not left a draft");
  assert.match(autopilot, /resolveHrIdsForRole\("HR Resourcing"/, "owned by the Talent Acquisition seat, read from the role");
  assert.doesNotMatch(autopilot, /req_cancel/, "the autopilot never cancels — he asked for Filled");
  assert.match(autopilot, /plan\.open\.slice\(0, Math\.max\(0, MAX_OPENINGS_PER_RUN - retries\.length\)\)/, "openings are capped per run");
  assert.match(autopilot, /filled_by_hr_id/, "the seat row's hire is read");
  assert.match(
    autopilot,
    /directory\.employees\.find\(\(row\) => canonicalHrIdKey\(row\.hrId\) === holderKey\)/,
    "the owner is the stored spelling of the holder's id, read from the directory",
  );
  assert.doesNotMatch(
    autopilot,
    /\b(?:create|send|enqueue|queue|notify)\w*(?:Notification|Manager|Email|Telegram)\w*\(|deliver\(/,
    "opening a requisition sends no notice",
  );

  const attach = stripComments(read("src/lib/recruitment/requisition-attach.ts"));
  assert.match(attach, /REQUISITION_ATTACH_ROLES = \["Super Admin", "HR Resourcing"\]/, "admin or TA only");
  assert.match(attach, /if \(!canAttachToRequisition\(access\)\)/, "and the service refuses anyone else");
  assert.match(attach, /ATTACH_REFUSED_STATUSES = new Set<string>\(\["hired", "rejected", "sent_to_manager"\]\)/, "a decided CV is refused");
  assert.match(attach, /if \(decided && ATTACH_REFUSED_STATUSES\.has\(decided\)\)/, "and the refusal is checked");
  assert.match(
    stripComments(read("src/lib/recruitment/screening-workspace.ts")),
    /try \{\s*requisitionInputs = await loadRequisitionMatchInputs\(openVacancies\);\s*\} catch/,
    "a failed recommendation read never takes the screening page down",
  );
  assert.match(
    read("supabase/migrations/20261016103744_ats_requisitions_one_active_per_vacancy.sql"),
    /create unique index if not exists ats_requisitions_one_active_per_vacancy\s+on public\.ats_requisitions \(vacancy_id\)/,
    "one active requisition per seat row, held by the database",
  );
  const attachRoute = stripComments(read("app/api/recruitment/candidates/[id]/attach-requisition/route.ts"));
  assert.match(attachRoute, /requireRecruitmentAccess\(request, "candidates", "update"\)/, "the route asserts candidates:update");
  assert.match(
    read("src/lib/security/access-registry.ts"),
    /pattern: "\/api\/recruitment\/candidates\/\*\/attach-requisition", permission: \{ resource: "candidates", action: "update" \}/,
    "registered on candidates:update, above the read-only catch-all",
  );
}

export function runRecruitmentAutomationTests() {
  testAutopilotPlan();
  testRecommendation();
  testWiring();
}
