import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { HR_ROLE_BUNDLES } from "../src/lib/auth/hr-functions.ts";
import { sourcesFor } from "../src/lib/hr/command-center.ts";
import {
  buildHiringQualityKpis,
  buildMonthMarks,
  buildOfferConversionKpis,
  buildWeekDays,
  joinersBetween,
  kpi,
  KPI_WINDOW_DAYS,
  RECRUITING_TASK_KEYS,
  TALENT_ACQUISITION_SEAT,
  type TalentInterview,
  type TalentJoiner,
} from "../src/lib/hr/talent-acquisition-logic.ts";
import type { OfferRecord } from "../src/lib/offers/types.ts";
import { countDistinctPeople } from "../src/lib/recruitment/interview-volume.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * The Talent Acquisition seat's own landing page.
 *
 * WHAT THIS PINS AND WHY EACH RULE IS HERE. The owner asked on 13 October 2026 for Yomna Gamal's
 * overview to be rebuilt "from scratch" against her handbook, and named four things in the same
 * breath — keep `Live candidates, by pipeline stage`, keep the live calendar, keep `Job offers, by
 * status`, and *"totally donot show employee requests"*. Three of those four are invisible when
 * they break: a chart moved to another band still renders, a support tile arriving back on the page
 * renders, and a rate printed as 0% renders most convincingly of all. So each is a rule here.
 *
 * THE ONE THAT MATTERS MOST IS THE NULL. Production on 13 October 2026 holds **36 probation cases
 * and 0 decided**, and `rollupOutcomes` returns `passRate: 0` on that — which, printed, tells a
 * person on her first morning that no new hire has ever passed probation. Every KPI on this page is
 * therefore built through `kpi()`, which derives the rate from the denominator and returns NULL
 * when there is nothing to divide by. Assertions 1 and 2 pin that from both directions.
 *
 * SOURCE-LEVEL ASSERTIONS STRIP COMMENTS FIRST, with `stripComments` from
 * `tests/support/comment-strip.ts` — not a hand-rolled line filter, which `comment-strip-ratchet`
 * refuses and which would read the body of a multi-line JSX comment as code. It is not optional
 * rigour here: both new components discuss employee requests at length, by name, because that is
 * exactly where the mistake would be made, so a raw-source search for those words would fail on a
 * correct page and a raw-source `assert.match` would pass on a broken one.
 */

const LOGIC = "src/lib/hr/talent-acquisition-logic.ts";
const DATA = "src/lib/hr/talent-acquisition-overview.ts";
const PAGE_COMPONENT = "src/components/hr/talent-acquisition-overview.tsx";
const CALENDAR_COMPONENT = "src/components/hr/talent-acquisition-calendar.tsx";
const ROUTE = "app/(admin)/admin/hr-command-center/page.tsx";
const GENERIC_COMPONENT = "src/components/hr/hr-command-center.tsx";

function codeOf(file: string): string {
  return stripComments(readFileSync(file, "utf8"));
}

/** An offer with only the fields these builders read. The rest of OfferRecord is prose and money. */
function offer(input: {
  createdAt?: string | null;
  employeeHrId?: string | null;
  id: string;
  startDate?: string;
  status: "accepted" | "declined" | "draft" | "sent" | "withdrawn";
}) {
  return {
    candidateName: `Candidate ${input.id}`,
    // `in`, not `??` — an explicit `createdAt: null` is the UNDATED letter this page must count OUT
    // of the window, and a `??` default would quietly turn it into a dated one and prove nothing.
    createdAt: "createdAt" in input ? input.createdAt : "2026-10-01T00:00:00.000Z",
    employeeHrId: input.employeeHrId ?? null,
    id: input.id,
    startDate: input.startDate ?? "2026-11-01",
    status: input.status,
    title: "Medical Representative",
  } as unknown as OfferRecord;
}

// ── 1. A rate is NULL on an empty denominator, never zero ─────────────────────────────────────
function testARateIsNeverDrawnAsZero() {
  const empty = kpi({
    caption: "c",
    denominator: 0,
    denominatorLabel: "cases decided",
    emptyLabel: "No probation window has been decided yet.",
    href: "/hr/probation/dashboard",
    hrefLabel: "l",
    key: "k",
    label: "Probation retention",
    numerator: 0,
    numeratorLabel: "passed probation",
  });
  assert.equal(
    empty.rate,
    null,
    "a KPI with nothing to divide by must carry rate === null. A zero here is printed as 0%, and " +
      "on probation retention that sentence reads 'no new hire has ever passed' — which is what " +
      "production's 36 open / 0 decided cases would have said on her first morning",
  );

  const measured = kpi({
    caption: "c",
    denominator: 36,
    denominatorLabel: "offers answered",
    emptyLabel: "e",
    href: "/hr/offers",
    hrefLabel: "l",
    key: "k",
    label: "Offer acceptance",
    numerator: 26,
    numeratorLabel: "offers accepted",
  });
  // The control: without it, a kpi() that returned null for everything would satisfy the above.
  assert.equal(
    Math.round((measured.rate ?? 0) * 100),
    72,
    "a KPI with a real denominator must carry the real rate — 26 of 36 is 72%, which is what " +
      "production's accepted/declined split actually was on 2026-10-13",
  );

  // The PAGE must honour it. A component that printed `rate ?? 0` would undo every line above.
  const component = codeOf(PAGE_COMPONENT);
  assert.match(
    component,
    /kpi\.rate !== null/,
    "the KPI card must branch on `rate !== null` and print `emptyLabel` on the null side. Without " +
      "that branch the data layer's null is formatted as 0% and this whole rule is decorative",
  );
  assert.match(
    component,
    /\{kpi\.emptyLabel\}/,
    "the null side of that branch must render `emptyLabel` — the sentence saying what the measure " +
      "WOULD show. Rendering nothing would make a measure with no data look like a measure that " +
      "does not exist",
  );
}

// ── 2. Her handbook's two KPI families count what their captions say ──────────────────────────
function testTheOfferConversionFamilyCountsAnsweredOffersOnly() {
  const offers = [
    offer({ employeeHrId: "B-99", id: "a1", status: "accepted" }),
    offer({ id: "a2", status: "accepted" }),
    offer({ id: "a3", status: "accepted" }),
    offer({ id: "d1", status: "declined" }),
    // Neither answered nor refused. A letter nobody has replied to is not a decision yet, and
    // counting it as a non-acceptance would make a busy week read as a bad one.
    offer({ id: "s1", status: "sent" }),
    offer({ id: "w1", status: "withdrawn" }),
    offer({ id: "dr1", status: "draft" }),
  ];

  const [acceptance, offerToJoin] = buildOfferConversionKpis(offers);

  assert.equal(
    acceptance.denominator,
    4,
    "offer acceptance divides by the offers that were ANSWERED — accepted plus declined. A sent, " +
      "withdrawn or draft letter in the denominator would punish the seat for a candidate who has " +
      "simply not replied",
  );
  assert.equal(acceptance.numerator, 3, "and the numerator is the accepted ones");

  assert.equal(
    offerToJoin.denominator,
    3,
    "offer-to-join divides by the ACCEPTED offers, not by every offer — the question is whether " +
      "the people who said yes actually arrived",
  );
  assert.equal(
    offerToJoin.numerator,
    1,
    "and its numerator is the accepted offers carrying an employee record from the joining form. " +
      "Measured against production on 2026-10-13 that was 2 of 26, because HR records most " +
      "acceptances by hand — so the caption must say the figure counts the FORM, not the joining",
  );
  // Twice, because the caption has to do two things: say what the top half counts, and say what a
  // LOW figure actually means. Breaking only the first mention left a one-match assertion green.
  assert.equal(
    (offerToJoin.caption.match(/joining form/g) ?? []).length,
    2,
    "the offer-to-join caption must name the joining form where it defines the numerator AND where " +
      "it explains a low reading. The gap it measures is a RECORDING gap — measured 2026-10-13, 2 " +
      "of 26 accepted offers carry an employee record — and a reader who took 8% for a joining " +
      "rate would be reading a crisis that is not there",
  );

  for (const measure of buildOfferConversionKpis([])) {
    assert.equal(
      measure.rate,
      null,
      `${measure.key} must be null with no offers at all, not 0% — the seat opens on 18 October ` +
        "2026 and a 0% acceptance on day one would be a verdict on nobody",
    );
  }
}

function testHiringQualityWindowsBothHalvesAndNullsTheUndecided() {
  const volume = {
    fromIso: "2026-07-15T00:00:00.000Z",
    interviews: 63,
    people: 58,
    truncated: false,
  };
  const offers = [
    offer({ createdAt: "2026-09-20T10:00:00.000Z", id: "in-1", status: "sent" }),
    offer({ createdAt: "2026-10-01T10:00:00.000Z", id: "in-2", status: "accepted" }),
    // BEFORE the window. The letters in this system predate the interview calendar by eleven days,
    // so a lifetime numerator over a windowed denominator is the defect this excludes.
    offer({ createdAt: "2026-01-02T10:00:00.000Z", id: "out-1", status: "accepted" }),
    // No timestamp at all. Counted OUT rather than in: an undated letter cannot be shown to belong
    // to the window, and assuming it does inflates the only half the seat is measured on.
    offer({ createdAt: null, id: "out-2", status: "accepted" }),
  ];

  const [ratio] = buildHiringQualityKpis({ offers, probation: null, volume });
  assert.equal(
    ratio.denominator,
    58,
    "interview-to-offer divides by DISTINCT PEOPLE interviewed, not by bookings — a candidate who " +
      "came back for a second round must not count twice against the seat",
  );
  assert.equal(
    ratio.numerator,
    2,
    "and its numerator counts only the offer letters written INSIDE the same window. Both halves " +
      "on one window is the whole rule: production holds offers from eleven days before the " +
      "calendar existed, so a lifetime numerator would divide them by 90 days of interviews",
  );
  assert.match(
    ratio.caption,
    new RegExp(String(KPI_WINDOW_DAYS)),
    "the caption must name the window in days. An unnamed window is the defect the owner caught on " +
      "the Hired tile when he asked how it could read what it read",
  );

  // Production's real probation shape on 2026-10-13: 36 cases, NONE decided.
  const [, retention] = buildHiringQualityKpis({
    offers,
    probation: { passCount: 0, total: 0 },
    volume,
  });
  assert.equal(
    retention.rate,
    null,
    "probation retention must be null when nothing has been decided. `rollupOutcomes` returns " +
      "passRate: 0 on exactly that input, and production had 36 open cases and 0 verdicts on the " +
      "day this page was built — reading passRate here instead of deriving it is the bug",
  );
  assert.match(
    retention.emptyLabel,
    /decided/,
    "and its empty label must say a window has not been DECIDED — not that there are no cases, " +
      "which would be false with 36 of them running",
  );

  // A read that failed contributes NO measure rather than a zero one.
  assert.deepEqual(
    buildHiringQualityKpis({ offers, probation: null, volume: null }).map((one) => one.key),
    [],
    "with neither source loaded the band must be empty. A card for a measure whose source refused " +
      "would be a figure invented out of a failure",
  );
}

// ── 3. The interview denominator's own three decisions ────────────────────────────────────────
function testDistinctPeopleCollapsesRoundsAndKeepsOutsiders() {
  assert.equal(
    countDistinctPeople([
      { candidate_id: "c-1", external_name: null },
      { candidate_id: "c-1", external_name: null },
      { candidate_id: "c-2", external_name: null },
    ]),
    2,
    "two bookings for one candidate are ONE person. The hiring flow has four interview rounds on " +
      "paper, so counting bookings would divide the offers by up to four times the people",
  );
  assert.equal(
    countDistinctPeople([
      { candidate_id: null, external_name: "Mona Fathy" },
      { candidate_id: null, external_name: " mona fathy " },
    ]),
    1,
    "an outside person is keyed on their name, trimmed and case-folded — the same person typed " +
      "twice is one person",
  );
  // The honest limit, written down rather than implied: the key is a free-text name, so a name
  // typed with different INNER spacing is two people to this count. It is recorded as a fact
  // because the alternative — collapsing whitespace — starts merging people who share a name, and
  // the denominator it feeds is better slightly high than quietly wrong.
  assert.equal(
    countDistinctPeople([
      { candidate_id: null, external_name: "Mona Fathy" },
      { candidate_id: null, external_name: "Mona  Fathy" },
    ]),
    2,
    "and inner spacing is NOT normalised — if this ever returns 1, the keying was widened, which " +
      "also merges two different people who share a name",
  );
  assert.equal(
    countDistinctPeople([{ candidate_id: null, external_name: "  " }]),
    0,
    "a booking naming nobody is counted as an interview and as NO person — inventing a distinct " +
      "person for a data fault inflates the denominator and flatters the ratio",
  );
  assert.equal(
    countDistinctPeople([{ candidate_id: null, external_name: "Mona" }]),
    1,
    "the control: an outside person with a real name must still count, or the denominator silently " +
      "drops everyone booked without a recruitment record",
  );
}

// ── 4. The week strip and the joining days ────────────────────────────────────────────────────
function testTheWeekStripPlacesEveryInterviewAndJoiningDay() {
  const interviews: TalentInterview[] = [
    {
      candidateName: "Later",
      dateKey: "2026-10-18",
      href: "/x",
      id: "i2",
      interviewerName: null,
      platformLabel: "Zoom",
      startMinutes: 14 * 60,
      timeLabel: "14:00 - 14:30",
    },
    {
      candidateName: "Earlier",
      dateKey: "2026-10-18",
      href: "/x",
      id: "i1",
      interviewerName: "Yasmeena El Safory",
      platformLabel: "In person",
      startMinutes: 9 * 60,
      timeLabel: "09:00 - 09:30",
    },
    {
      candidateName: "Another day",
      dateKey: "2026-10-20",
      href: "/x",
      id: "i3",
      interviewerName: null,
      platformLabel: "Phone",
      startMinutes: 11 * 60,
      timeLabel: "11:00 - 11:30",
    },
  ];
  const joiners: TalentJoiner[] = [
    { dateKey: "2026-10-18", href: "/o", id: "o1", name: "New Starter", title: "Medical Rep" },
  ];

  const days = buildWeekDays("2026-10-18", interviews, joiners, new Date("2026-10-20T09:00:00Z"));

  assert.equal(
    days.length,
    5,
    "the strip is the company's five-day working week, Sunday to Thursday. Seven columns would " +
      "put two permanently empty days on somebody's landing page",
  );
  assert.deepEqual(
    days.map((day) => day.dateKey),
    ["2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22"],
    "and it starts on the Sunday it was given",
  );
  assert.deepEqual(
    days[0].interviews.map((one) => one.candidateName),
    ["Earlier", "Later"],
    "a day's interviews read in time order, whatever order the calendar returned them in",
  );
  assert.deepEqual(
    days[0].joiners.map((one) => one.name),
    ["New Starter"],
    "and a joining day lands on its own day",
  );
  assert.deepEqual(
    days.map((day) => day.isToday),
    [false, false, true, false, false],
    "exactly one day is today, taken from the Cairo date of the instant passed in — not from the " +
      "server's own zone, and not from the browser's",
  );
}

function testOnlyAnAcceptedOfferDrawsAJoiningDay() {
  const offers = [
    offer({ id: "yes", startDate: "2026-10-18", status: "accepted" }),
    // A start date on a letter nobody has answered is a PROPOSAL. Drawing it would put somebody in
    // the diary who has not said yes.
    offer({ id: "sent", startDate: "2026-10-19", status: "sent" }),
    offer({ id: "declined", startDate: "2026-10-20", status: "declined" }),
    offer({ id: "withdrawn", startDate: "2026-10-21", status: "withdrawn" }),
    // Outside the span asked for.
    offer({ id: "later", startDate: "2026-12-01", status: "accepted" }),
  ];

  assert.deepEqual(
    joinersBetween(offers, "2026-10-18", "2026-10-22").map((one) => one.id),
    ["yes"],
    "only an ACCEPTED offer whose start date falls inside the span is a joining day. A sent, " +
      "declined or withdrawn letter is not somebody arriving, and a December start is not this week",
  );
}

// ── 5. The month grid marks a spanning item on every day it covers ────────────────────────────
function testAMultiDayHolidayIsMarkedOnEveryDayItCovers() {
  const weeks: Parameters<typeof buildMonthMarks>[0] = [
    [
      { date: null, inMonth: false },
      { date: "2026-10-18", inMonth: true },
      { date: "2026-10-19", inMonth: true },
      { date: "2026-10-20", inMonth: true },
      { date: "2026-10-21", inMonth: true },
      { date: "2026-10-22", inMonth: true },
      { date: "2026-10-23", inMonth: true },
    ],
  ];
  const marks = buildMonthMarks(
    weeks,
    [
      {
        endDate: "2026-10-21",
        source: "holiday",
        startDate: "2026-10-19",
        title: "A three-day holiday",
      },
      { endDate: null, source: "birthday", startDate: "2026-10-18", title: "Somebody's birthday" },
      // Entirely outside the grid — it must not appear anywhere.
      { endDate: "2026-09-02", source: "event", startDate: "2026-09-01", title: "Last month" },
    ] as unknown as Parameters<typeof buildMonthMarks>[1],
    [
      {
        candidateName: "Interviewee",
        dateKey: "2026-10-20",
        href: "/x",
        id: "i1",
        interviewerName: null,
        platformLabel: "Zoom",
        startMinutes: 540,
        timeLabel: "09:00 - 09:30",
      },
    ],
    [{ dateKey: "2026-10-18", href: "/o", id: "o1", name: "New Starter", title: "Medical Rep" }],
  );

  assert.deepEqual(
    ["2026-10-19", "2026-10-20", "2026-10-21"].map(
      (day) => marks[day]?.filter((mark) => mark.kind === "holiday").length ?? 0,
    ),
    [1, 1, 1],
    "a three-day holiday is marked on all three days. Drawing it only on its first cell makes a " +
      "three-day holiday read as a one-day one, and the month grid is the one surface where that " +
      "difference is visible at a glance",
  );
  assert.equal(
    marks["2026-10-22"],
    undefined,
    "and the day after it carries nothing — the span is inclusive of its end, not open-ended",
  );
  assert.deepEqual(
    (marks["2026-10-18"] ?? []).map((mark) => mark.kind).sort(),
    ["birthday", "joining"],
    "an item with no end date covers its start day alone, and a joining day is laid over the " +
      "company's own marks rather than replacing them",
  );
  assert.deepEqual(
    (marks["2026-10-20"] ?? []).map((mark) => mark.kind).sort(),
    ["holiday", "interview"],
    "and an interview sits on the same day as the holiday it falls inside",
  );
  assert.ok(
    !Object.values(marks).flat().some((mark) => mark.title === "Last month"),
    "an item outside the grid's own days must not be marked at all",
  );
}

// ── 6. "totally donot show employee requests" ─────────────────────────────────────────────────
function testEmployeeRequestsIsOffThePageAndStillInHerSeat() {
  assert.ok(
    !RECRUITING_TASK_KEYS.includes("answer-support-requests"),
    "the support desk's task must not be in the allow-list this page passes to HrTodayPanel — " +
      '"totally donot show employee requests" (owner, 2026-10-13)',
  );
  assert.deepEqual(
    [...RECRUITING_TASK_KEYS].sort(),
    [
      "advance-interviews",
      "chase-offers",
      "close-filled-requisitions",
      "raise-requisitions",
      "screen-candidates",
    ],
    "and the list is an ALLOW-list of her recruiting queues, not a block-list of one. " +
      "`buildHrTodayTasks` is driven by her whole bundle, so a function added to it later would " +
      "put a queue on this page in silence",
  );

  // Not a single mention in the CODE of either new component or of the loader. Comments stripped
  // first, because all three files discuss this rule at length and by name — see the file header.
  for (const file of [DATA, LOGIC, PAGE_COMPONENT, CALENDAR_COMPONENT]) {
    const code = codeOf(file);
    assert.ok(
      !/supportRequests|support-requests|listAllSupportRequests/.test(code),
      `${file} names the support-request source in its code. This page must not read it, link to ` +
        "it or render it — and not reading it is also why the band cannot come back by accident",
    );
  }

  // The GRANT is untouched. He said not to SHOW it; taking the function away would be a different
  // instruction, and the sidebar row and her permissions still depend on it.
  assert.ok(
    (HR_ROLE_BUNDLES[TALENT_ACQUISITION_SEAT] as readonly string[]).includes("employee_requests"),
    "employee_requests must STAY in her bundle. The owner's words were about this page; removing " +
      "the function would shut the HR Support Requests screen she still works, which he did not ask for",
  );
  assert.ok(
    sourcesFor(TALENT_ACQUISITION_SEAT).includes("supportRequests"),
    "so the seat still DECLARES that source — the page simply never asks for it. If this ever " +
      "fails, the grant was removed rather than the band, which is the opposite of the instruction",
  );
}

// ── 7. Both charts he named by name, each in its own band ─────────────────────────────────────
function testBothChartsHeNamedSurviveOnTheirOwnBands() {
  const data = codeOf(DATA);
  assert.match(
    data,
    /OFFERS_BY_STATUS_CHART_KEY/,
    'the Job-offers chart must be identified by the exported key, not by rebuilding the chart or ' +
      "matching its title. A title match would silently stop working the day the caption is reworded",
  );
  assert.match(
    data,
    /chart\.key !== OFFERS_BY_STATUS_CHART_KEY/,
    "the Filling-the-field band must EXCLUDE the offers chart, and the Offer-conversion band take " +
      'it — "Job offers, by status" belongs beside the two rates it explains (owner, 2026-10-13)',
  );
  assert.match(
    data,
    /buildRecruitingCharts/,
    "both charts come from the generic page's own builder. A second copy of either would let one " +
      "seat's two pages print two different answers, which is the founding rule of command-center.ts",
  );

  const component = codeOf(PAGE_COMPONENT);
  assert.match(
    component,
    /<HrCommandCharts charts=\{\[data\.offerChart\]\}/,
    "and the offers chart is drawn by HrCommandCharts — the same component, so his chart keeps the " +
      "caption, the colour and the footer link he already approved",
  );
  assert.match(
    component,
    /<HrCommandCharts charts=\{data\.field\.charts\}/,
    "as is the pipeline chart in the Filling-the-field band",
  );
}

// ── 8. The identity strip, and the four props the owner said not to touch ─────────────────────
function testTheIdentityStripIsTheGenericPagesByteForByte() {
  const mine = codeOf(PAGE_COMPONENT);
  const generic = codeOf(GENERIC_COMPONENT);

  const strip = /<PhoenixIdentityStrip\s+([\s\S]*?)\/>/;
  const minePropsMatch = strip.exec(mine);
  const genericPropsMatch = strip.exec(generic);
  assert.ok(
    minePropsMatch && genericPropsMatch,
    "both landing components must render <PhoenixIdentityStrip …/>. If this cannot find it, the " +
      'strip was removed or renamed — "donot touch photo or identity banner" (owner, 2026-10-13)',
  );

  const props = (source: string) =>
    source
      .trim()
      .split(/\s+/)
      .filter((token) => token.includes("="))
      .sort();
  assert.deepEqual(
    props(minePropsMatch![1]),
    props(genericPropsMatch![1]),
    "the strip must receive the SAME four props on both pages, written the same way. The owner's " +
      'instruction was "do not touch, do not ever touch" (2026-10-12) and "donot touch photo or ' +
      'identity banner" (2026-10-13) — a fifth prop, a renamed one or a reordered value is a touch',
  );
  assert.ok(
    !/CeoHeroIdentity/.test(mine),
    "and it must not also draw the dark band. Two identities on one page is the defect " +
      "tests/workspace-single-hero.test.ts exists for, reached by a different route",
  );
}

// ── 9. The house look: square edges, no sideways scroll, no ellipsis ──────────────────────────
function testTheNewComponentsObeyTheThreeGoldenRules() {
  const offences: string[] = [];
  for (const file of [PAGE_COMPONENT, CALENDAR_COMPONENT]) {
    const code = codeOf(file);

    // `rounded-full` is a CIRCLE, not a corner — the generic page's icon badge and the charts'
    // legend dots both use it, and the square-edge rule is about corners.
    for (const hit of code.match(/rounded-(?!full\b)[a-z0-9[\]-]+/g) ?? []) {
      offences.push(`${file} carries ${hit} — the square-edge golden rule allows no rounded corner`);
    }
    for (const hit of code.match(/overflow-x-auto|min-w-\[|min-width/g) ?? []) {
      offences.push(
        `${file} carries ${hit} — "never a horizontal scroll" is the rule, and an overflow over a ` +
          "min-width IS the bug rather than the fix. Fit by merging or wrapping",
      );
    }
    for (const hit of code.match(/truncate|text-ellipsis|line-clamp-/g) ?? []) {
      offences.push(`${file} carries ${hit} — text is never truncated; wrapping wins`);
    }
    // The ellipsis character itself, in rendered copy.
    if (code.includes("…")) {
      offences.push(`${file} contains an ellipsis character in its code`);
    }
  }
  assert.deepEqual(
    offences,
    [],
    "a new landing page must wear the house look:\n  " + offences.join("\n  "),
  );

  // And the month grid must not have been lifted from the one component that breaks the rule.
  const calendar = codeOf(CALENDAR_COMPONENT);
  assert.match(
    calendar,
    /grid-cols-7/,
    "the month is a seven-column grid whose cells get NARROWER as the screen does — never a table " +
      "with a minimum width, which is what a sideways scroll is made of",
  );
}

/**
 * ── 9b. THE CALENDAR IS A RULED SHEET, NOT A GRID OF BOXES ────────────────────────────────────
 *
 * The owner sent the week back on 13 October 2026 with the whole instruction in four words:
 * "godmode heavy full premium polish". What he was looking at was three nested frames around every
 * booking — a bordered card per interview, inside a bordered card per day, inside the bordered
 * panel — plus a fourth bordered chip for the platform inside the innermost one. Five bookings down
 * a column drew ten hairlines that carried no meaning, and a day with one booking read as a card
 * that had failed to fill.
 *
 * THE FIX IS SUBTRACTION, SO IT IS EXACTLY THE KIND OF WORK A LATER SESSION UNDOES BY "TIDYING".
 * Adding `border border-slate-200` back to a row looks like consistency with every other card in
 * the app; it is the defect he rejected. These four pins hold the sheet:
 *
 *   1. the week is ONE frame with 1px rules showing through the grid's own `gap-px`
 *   2. a booking is a RULED ROW — a bottom hairline that the last row drops, never a box
 *   3. the platform is a WORD in faint caps, never a bordered chip
 *   4. the month's cells draw no border of their own; the grid draws every rule once
 *
 * The same `gap-px`-over-a-hairline-ground is why no rule is ever doubled and why nothing needs a
 * responsive border: it is drawn once at every breakpoint, including the one-column phone week.
 */
function testTheCalendarIsARuledSheetRatherThanNestedBoxes() {
  const calendar = codeOf(CALENDAR_COMPONENT);

  const sheet = /grid grid-cols-1 gap-px border border-slate-200 bg-slate-200\/80[^"]*lg:grid-cols-5/;
  assert.match(
    calendar,
    sheet,
    "the week stopped being one sheet — the five days are ruled apart by the grid's own `gap-px` " +
      "over a hairline ground, which draws each rule exactly ONCE at every breakpoint. A gap plus a " +
      "border per column is the doubled 2px line, and a border per column is the boxed week the " +
      'owner rejected on 2026-10-13 ("godmode heavy full premium polish")',
  );

  const body = (name: string) => {
    const start = calendar.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} must still exist in the calendar component`);
    // `export function` ends a body too — `MonthCell` is followed by the exported component, and
    // slicing only to the next bare `function` swallowed the whole panel into the cell. Measured,
    // while proving this section red.
    const rest = calendar.slice(start + 1);
    const end = /\n(?:export )?function /.exec(rest)?.index;
    return end === undefined ? rest : rest.slice(0, end);
  };

  const row = body("InterviewRow");
  assert.match(
    row,
    /border-b border-slate-100[^"]*last:border-b-0/,
    "a booking must be a RULED ROW: one bottom hairline, dropped on the last row so the column does " +
      "not close with a rule it does not need",
  );
  assert.ok(
    !/\bborder border-/.test(row),
    "a booking was put back in a box. Three nested frames around one line of type is precisely what " +
      "he sent the week back for — a row's only frame is its left margin edge",
  );
  assert.ok(
    !/bg-slate-50|bg-orange-100|border border-/.test(row.split("platformLabel")[0] ?? ""),
    "the platform became a chip again — it is the least important thing on the row, and a bordered " +
      "filled box made it the loudest. It is a word in faint caps, which is also what the house ink " +
      "rule asks for (no filled areas)",
  );

  const cell = body("MonthCell");
  assert.ok(
    !/\bborder border-|border-slate-200 bg-white/.test(cell),
    "the month cells took their own borders back. The grid's hairline ground draws every rule once; " +
      "a border per cell draws the inner ones twice and thickens them to 2px",
  );
  assert.match(
    calendar,
    /grid grid-cols-7 gap-px border border-slate-200 bg-slate-200\/80/,
    "and the month grid must be the one carrying that ground, or the cells sit on nothing and the " +
      "month loses its rules altogether",
  );
}

// ── 10. A failed read is SAID, never drawn as a quiet day ─────────────────────────────────────
function testAFailedCalendarReadIsStatedRatherThanDrawnEmpty() {
  const calendar = codeOf(CALENDAR_COMPONENT);
  // The `{` matters: the Mine view branches on `!calendar.interviewsLoaded`, which contains these
  // same characters, so an unanchored match stayed GREEN with the week's own branch removed.
  // Measured, while proving this assertion red.
  assert.match(
    calendar,
    /\{calendar\.interviewsLoaded \? \(/,
    "the week must branch on `interviewsLoaded` and say so when the read refused. An empty week " +
      "drawn from a failed read tells her she has nothing on, which is the one wrong answer a " +
      "diary can give",
  );
  assert.equal(
    (calendar.match(/<CouldNotLoad what=/g) ?? []).length,
    3,
    "and all three views must have that fallback — the week, her own agenda and the month. A view " +
      "without one is a view that draws a refused read as a quiet day",
  );
  assert.match(
    calendar,
    /calendar\.monthItemsLoaded \? null :/,
    "and the month must say when the COMPANY half did not answer — the grid, her interviews and " +
      "the joining days are standing either way, so this is a notice above a real month",
  );

  const data = codeOf(DATA);
  assert.match(
    data,
    /if \(!calendar\.interviewsLoaded\) pageUnavailable\.push/,
    "and both failures must reach the page's own unavailable notice, so a reader is told by name " +
      "which figure is missing rather than being left to notice",
  );
  assert.ok(
    !/safe\("interviewVolume"|safe\("interviewCalendar"/.test(data),
    "this page's private reads must NOT be recorded as SourceKeys. That union is the generic " +
      "command centre's declared source catalogue, which every HR seat's loader is built from — " +
      "widening it for one bespoke page is how a page stops being gated on its bundle",
  );
}

// ── 11. The page is gated on her seat, and only hers ──────────────────────────────────────────
function testTheRouteServesTheNewPageToHerSeatAlone() {
  const route = codeOf(ROUTE);
  assert.match(
    route,
    /hrBundleForRole\(access\.role\) === TALENT_ACQUISITION_SEAT/,
    "the split must be the same lookup that gates the address, so the two branches cannot disagree " +
      "about who is who",
  );
  assert.match(
    route,
    /<HrCommandCenter\b/,
    "and every OTHER HR seat must still get the generic command centre, untouched. A route that " +
      "stopped rendering it would have moved one seat's rebuild onto everybody",
  );
  assert.match(
    route,
    /isTalentAcquisition\s*\n?\s*\?\s*getTalentAcquisitionOverview/,
    "only ONE loader may run. The two overlap on offers, the recruitment dashboard and the " +
      "directory, so running both to choose a component afterwards doubles every read on her home page",
  );

  const data = codeOf(DATA);
  assert.match(
    data,
    /if \(seat !== TALENT_ACQUISITION_SEAT\) return null/,
    "and the loader refuses any other seat outright, rather than trusting the route to have asked " +
      "the right question",
  );
  assert.match(
    data,
    /sourcesFor\(seat\)/,
    "every fetch is still gated on her function bundle. A bespoke page that read whatever it liked " +
      "would walk straight past the guarantee at the top of command-center.ts",
  );
}

// ── 12. The two sources workforce_context gained are declared, not assumed ────────────────────
function testTheProbationAndVacationSourcesAreDeclaredOnHerBundle() {
  const sources = sourcesFor(TALENT_ACQUISITION_SEAT);
  for (const source of ["probationOutcomes", "vacationsToday"] as const) {
    assert.ok(
      sources.includes(source),
      `${source} must be declared by one of her functions. This page reads it for the probation ` +
        "KPI and the vacation panel, and a page doing work under her session that the permission " +
        "catalogue never granted is the thing sourcesFor exists to prevent",
    );
  }
  assert.match(
    codeOf(DATA),
    /canViewProbationAnalytics\(access\)/,
    "and the probation read must additionally pass the same predicate the Outcomes analytics page " +
      "passes — `getProbationOutcomesAnalytics` takes no AccessContext and asserts nothing itself",
  );
}

// ── 13. One pendings panel, behind one button that really opens it ────────────────────────────
function testThePendingsPanelIsOneDisclosureWiredToItsButton() {
  const component = codeOf(PAGE_COMPONENT);

  assert.equal(
    (component.match(/<HrTodayPanel\b/g) ?? []).length,
    1,
    "exactly one HrTodayPanel. Two would be two answers to 'what needs me', which is the defect " +
      "the owner removed from the generic page on 2026-10-13",
  );
  assert.match(
    component,
    /openAll/,
    "and it opens with every task expanded — somebody who has just pressed 'Needs attention' has " +
      "asked for the pendings, not for the most urgent one",
  );
  assert.match(
    component,
    /aria-controls=\{PENDINGS_PANEL_ID\}/,
    "the button must name the panel it controls",
  );
  assert.match(
    component,
    /id=\{PENDINGS_PANEL_ID\}/,
    "and the panel must carry that same id from the same constant, so the two cannot drift into a " +
      "dangling aria reference",
  );
  assert.match(
    component,
    /aria-expanded=\{showPendings\}/,
    "and it is a disclosure, so it says whether it is open",
  );
}

export function runTalentAcquisitionOverviewTests() {
  testARateIsNeverDrawnAsZero();
  testTheOfferConversionFamilyCountsAnsweredOffersOnly();
  testHiringQualityWindowsBothHalvesAndNullsTheUndecided();
  testDistinctPeopleCollapsesRoundsAndKeepsOutsiders();
  testTheWeekStripPlacesEveryInterviewAndJoiningDay();
  testOnlyAnAcceptedOfferDrawsAJoiningDay();
  testAMultiDayHolidayIsMarkedOnEveryDayItCovers();
  testEmployeeRequestsIsOffThePageAndStillInHerSeat();
  testBothChartsHeNamedSurviveOnTheirOwnBands();
  testTheIdentityStripIsTheGenericPagesByteForByte();
  testTheNewComponentsObeyTheThreeGoldenRules();
  testTheCalendarIsARuledSheetRatherThanNestedBoxes();
  testAFailedCalendarReadIsStatedRatherThanDrawnEmpty();
  testTheRouteServesTheNewPageToHerSeatAlone();
  testTheProbationAndVacationSourcesAreDeclaredOnHerBundle();
  testThePendingsPanelIsOneDisclosureWiredToItsButton();
}
