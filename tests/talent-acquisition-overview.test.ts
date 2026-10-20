import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { HR_ROLE_BUNDLES } from "../src/lib/auth/hr-functions.ts";
import { sourcesFor } from "../src/lib/hr/command-center.ts";
import {
  addDaysToKey,
  breakdownBarPercent,
  buildCvsReceivedTile,
  buildHiringQualityKpis,
  buildLineVacancyTiles,
  buildMonthMarks,
  buildOfferConversionKpis,
  cairoMinutesNow,
  dateBlockParts,
  daysBetweenKeys,
  daysUntilLabel,
  groupRecruitingTiles,
  joinersArriving,
  joinersBetween,
  JOINERS_WINDOW_DAYS,
  offerStartKey,
  kpi,
  KPI_WINDOW_DAYS,
  kpiWindowFromIso,
  liveLetterKeys,
  longDayLabel,
  orderTodaysInterviews,
  rateMeterPercent,
  RECRUITING_TASK_KEYS,
  startClockParts,
  startedOfferIds,
  TALENT_ACQUISITION_SEAT,
  TALENT_KEPT_BUILDER_TILE_KEYS,
} from "../src/lib/hr/talent-acquisition-logic.ts";
import type { OfferRecord } from "../src/lib/offers/types.ts";
import { countDistinctPeople, countOfferedPeople } from "../src/lib/recruitment/interview-volume.ts";
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
/** The rebuilt page's own parts (owner, 2026-10-16) — one frame, one rail, three panels. */
const PANEL_COMPONENT = "src/components/hr/talent-acquisition/panel.tsx";
const RAIL_COMPONENT = "src/components/hr/talent-acquisition/command-rail.tsx";
const TODAY_COMPONENT = "src/components/hr/talent-acquisition/today-interviews.tsx";
const JOINERS_COMPONENT = "src/components/hr/talent-acquisition/joiners-arriving.tsx";
const CV_COMPONENT = "src/components/hr/talent-acquisition/cv-arrivals.tsx";
const NEW_PARTS = [PANEL_COMPONENT, RAIL_COMPONENT, TODAY_COMPONENT, JOINERS_COMPONENT, CV_COMPONENT];
/** The real interview calendar — the component her week tab MOUNTS, rather than imitates. */
const SIBLING_GRID = "src/components/recruitment/interview-calendar/interview-calendar-view.tsx";
const ROUTE = "app/(admin)/admin/hr-command-center/page.tsx";
const GENERIC_COMPONENT = "src/components/hr/hr-command-center.tsx";

function codeOf(file: string): string {
  return stripComments(readFileSync(file, "utf8"));
}

/** An offer with only the fields these builders read. The rest of OfferRecord is prose and money. */
function offer(input: {
  candidateEmail?: string;
  createdAt?: string | null;
  employeeHrId?: string | null;
  id: string;
  startDate?: string;
  status: "accepted" | "declined" | "draft" | "sent" | "withdrawn";
}) {
  return {
    candidateEmail: input.candidateEmail ?? "",
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

  // Interview to offer, Offer acceptance and Offer to join are KEY CARDS (owner, 2026-10-16): the
  // whole card is the link, in the page's one card frame, and the caption was MOVED to the tooltip
  // and the accessible name, never dropped.
  const keyCard = component.slice(component.indexOf("function KpiCard"), component.indexOf("function UnavailableNotice"));
  assert.match(keyCard, /<Link\b/, "a measure is drawn as a key card that is itself the link");
  assert.match(keyCard, /CARD_MOTION_CLASS/, "the key card moves like every other card on the page — one hover lift, one focus ring");
  // THE SCOREBOARD (owner, 2026-10-16: "add colors to her page and some artistic touches her page is
  // so pale and poor"): the three measures stand on the page's one dark band.
  assert.ok(
    component.includes("bg-[linear-gradient(135deg,#000000_0%,#070707_55%,#1C0E02_100%)]"),
    "the conversion measures stand on the dark scoreboard, in the Phoenix hero's own black and ember",
  );
  assert.ok(
    component.includes("className={adminHeroGridOverlayClassName}"),
    "which wears the platform hero's own grid and glows, never a one-off texture",
  );
  // PHOENIX TONES ONLY (owner, 2026-10-16: "too much like this, stick to phx identity" — the four-hue
  // version was shown and refused). No decorative second hue on any part of the page.
  // The month grid is covered too: it kept sky, fuchsia, indigo and green marks after the rest of the
  // page was re-toned, and the owner's ruling is about the page, not the parts that were rebuilt.
  for (const file of [PAGE_COMPONENT, CALENDAR_COMPONENT, ...NEW_PARTS]) {
    const code = codeOf(file);
    for (const hue of [/\b(?:bg|text|border|from|to|via)-(?:sky|blue|indigo|violet|purple|fuchsia|cyan|teal)-\d/, /#0A527D|#0A6BA6|#1482C2|#06121F/i]) {
      assert.ok(!hue.test(code), `${file} paints a second hue (${hue}) — her page wears the Phoenix identity only`);
    }
  }
  const tileCode = component.slice(component.indexOf("function MetricTile"), component.indexOf("function KpiCard"));
  assert.ok(
    tileCode.includes("tabular-nums ${toneClass}"),
    "a figure keeps the builder's tone colour — amber waiting, rose a problem",
  );
  assert.ok(!tileCode.includes("tabular-nums ${tone."), "and the decoration never paints the number itself");
  // HIS OWN DASHBOARD'S CARD (owner, 2026-10-16: "awful", then "audit the b-10 dashboard and take
  // ideas from it in design"): one frame for all eight — no per-tone bar, no watermark, no medallion.
  assert.doesNotMatch(tileCode, /toneBarClass|medallion|opacity-\[0\.07\]|<Icon\b/, "a figure card carries no tone bar, watermark or icon — the dressed card was refused");
  assert.match(tileCode, /text-3xl font-black/, "the figure is the B-10 card's text-3xl");
  // NEVER CUT A WORD (owner, 2026-10-16: "never the ever tranculte text"). The band is a flex item
  // with overflow hidden, which may shrink below its content: it was cut to 120px of 232.
  assert.ok(
    component.includes('className="relative flex flex-auto shrink-0 flex-col overflow-hidden border border-[#1a1a1a]'),
    "the Conversion band never shrinks below its own text",
  );
  assert.match(keyCard, /title=\{kpi\.caption\}/, "the caption stays reachable on the card as its tooltip");
  assert.match(
    keyCard,
    /aria-label=\{`\$\{kpi\.label\}: \$\{spokenFigure\}\. \$\{kpi\.caption\}/,
    "and in its accessible name, which also says the figure and both halves — an aria-label replaces the card's content, so a screen reader would otherwise never hear the percentage",
  );
  assert.match(keyCard, /whitespace-nowrap[^"]*text-\[2rem\]/, "the percentage never wraps its % onto a second line");
  assert.doesNotMatch(keyCard, /<figure|<figcaption/, "the large captioned figure is gone");
  // The meter reads the rate through the one helper that returns NULL for a null rate, and is drawn
  // only when that helper gave a number — so a measure with nothing to divide by draws no bar.
  assert.match(keyCard, /rateMeterPercent\(kpi\.rate\)/, "the meter's fill comes from rateMeterPercent");
  assert.match(keyCard, /meter !== null \?/, "and no meter is drawn for a null rate");
  // The card LIES DOWN at every width (owner, 2026-10-16, "fit the keycards where i marked"): the
  // band stands in the ~116px of air beside her portrait, and a standing card is taller than that.
  assert.doesNotMatch(keyCard, /:contents|:flex-col|:order-/, "the key card never stands up — it must fit the air beside the portrait");

  // ...and the three stand in ONE ROW, in the order he named them.
  assert.match(
    component,
    /\["interview-to-offer", "offer-acceptance", "offer-to-join"\]/,
    "the key-card row holds Interview to offer, Offer acceptance, Offer to join, in that order",
  );
  assert.ok(
    component.includes('3: "@min-[600px]:grid-cols-3"'),
    "three lying-down key cards share one row once their band holds 600px",
  );
  // THE CONVERSION BAND STANDS IN THE AIR BESIDE HER PORTRAIT (owner, 2026-10-16, circling it: "fit
  // the keycards where i marked") — handed to the strip as its `reserve`, so it sits under the notice
  // rail and above the command rail, never back on the figures' ground.
  assert.match(
    component,
    /<PhoenixIdentityStrip[^>]*\breserve=\{conversionBand\}/,
    "the Conversion band is the strip's reserve — it stands beside her portrait",
  );
  assert.equal(component.split('aria-label="Conversion"').length - 1, 1, "and is drawn once, there and nowhere else");
  const stripAt = component.indexOf("<PhoenixIdentityStrip");
  const railAt = component.indexOf("<TaCommandRail");
  const groupsAt = component.indexOf("{groups.map(");
  const todayAt = component.indexOf("<TaTodayInterviews");
  const calendarAt = component.indexOf("<TalentAcquisitionCalendar");
  assert.ok(
    stripAt > -1 && stripAt < railAt && railAt < groupsAt && groupsAt < todayAt && todayAt < calendarAt,
    "the page reads top to bottom: identity strip (conversion beside the portrait), command rail, the three groups, today, the calendar",
  );

  // THE SIX FIGURES IN THREE LABELLED GROUPS (owner, 2026-10-16, "Three labelled groups"), every
  // card the same width in ONE ROW once the container holds 1120px — one column per card.
  assert.match(component, /groupRecruitingTiles\(data\.field\.tiles\)/, "the figures are grouped by the pure helper");
  assert.ok(
    component.includes('6: "@min-[1120px]:grid-cols-6"'),
    "all six figures share ONE row once their CONTAINER holds 1120px, whatever the window is",
  );
  assert.ok(component.includes('3: "@min-[1120px]:col-span-3"'), "a group of three spans three of those columns");
  assert.ok(component.includes('2: "@min-[1120px]:col-span-2"'), "and a group of two spans two");
  assert.match(component, /<TaCaption caption=\{group\.caption\} label=\{group\.label\} \/>/, "each group wears its caption");
  assert.equal(component.split("<MetricTile ").length - 1, 1, "the figures are drawn once, inside their groups");

  // Her "On a vacation today" panel carries NO links (owner, 2026-10-16, option "hide the link and
  // the row links, keep the panel"): the Vacation Report scopes her seat to her own leave, so the
  // button and every row link landed her on a page that could not show the person named above it.
  assert.ok(
    component.includes("<HrOnVacationToday linked={false} rows={data.onVacationToday} />"),
    "her page mounts the absence panel with its links switched off",
  );
  const absencePanel = codeOf("src/components/hr/hr-on-vacation-today.tsx");
  const reportButtonAt = absencePanel.indexOf("Open the Vacation Report");
  const linkedGuardAt = absencePanel.lastIndexOf("{linked ? (", reportButtonAt);
  assert.ok(
    reportButtonAt > -1 && linkedGuardAt > -1 && absencePanel.slice(linkedGuardAt, reportButtonAt).includes("<div"),
    "the Open the Vacation Report button sits inside the linked guard, so it exists only when the panel is linked",
  );
  assert.ok(
    absencePanel.includes("<RowShell href={linked ? row.href : null}>"),
    "a row is a link only when the panel is linked",
  );
  assert.match(
    component,
    /flex min-h-\[34px\] items-center[^"]*@min-\[480px\]:min-h-\[23px\]/,
    "a figure's label sits in a box as tall as its longest wrap (three lines on a phone, two from 480px), so a wrapped label and a one-line label put their figures on the same line",
  );
  assert.ok(component.includes("@container relative overflow-hidden border-b"), "the cards and today share ONE container");

  // The Hired window lives on the command rail, at its right — never between or under the card rows.
  const rail = codeOf(RAIL_COMPONENT);
  assert.match(rail, /<HiredWindowPicker\b/, "the Hired window is drawn by the command rail");
  assert.ok(!component.includes("<HiredWindowPicker"), "and nowhere else on the page");
  assert.ok(rail.includes("@min-[720px]:ml-auto"), "it sits at the right of that bar once the bar has room");
  assert.ok(rail.includes("pageHeaderRailClassName"), "the rail wears the platform's own page-header edge");

  // Duplicates removed (owner, 2026-10-16, "remove duplicates", all four ticked): the band headers
  // and the two charts whose every number is already a card, the second count beside Needs
  // attention, and the awaiting-reply chip. Each is refused by name so it cannot drift back.
  for (const file of [PAGE_COMPONENT, RAIL_COMPONENT]) {
    const code = codeOf(file);
    assert.ok(!code.includes("hr-group-offer-conversion"), `${file}: the Offer conversion band is gone`);
    assert.ok(!code.includes("hr-group-filling-the-field"), `${file}: the Filling the field band is gone`);
    assert.ok(!code.includes("hr-group-hiring-quality"), `${file}: the Hiring quality band is gone`);
    assert.ok(!code.includes("HrCommandCharts"), `${file}: neither duplicate chart is drawn any more`);
    assert.ok(!code.includes("to action"), `${file}: no second count sits beside Needs attention`);
    assert.ok(!/awaiting reply/i.test(code), `${file}: the awaiting-reply chip is gone`);
  }
  // The rail's one addition is a PART of the one total, drawn only when there is something overdue.
  assert.match(rail, /overdueCount > 0 \?/, "the overdue chip is drawn only when something is overdue");
  assert.match(
    component,
    /task\.urgency === "overdue"/,
    "and it counts the pendings already past due — a part of the Needs attention total, never a second total",
  );
}

// ── 1b. The pure helpers behind the rebuilt page ─────────────────────────────────────────────
function testTheRebuiltPagesPureHelpers() {
  // Date keys move in whole days, with no clock — across a month end, a year end and a DST change.
  assert.equal(addDaysToKey("2026-10-16", 14), "2026-10-30", "fourteen days from 16 October is 30 October");
  assert.equal(addDaysToKey("2026-12-25", 10), "2027-01-04", "and the arithmetic crosses a year end");
  assert.equal(
    addDaysToKey("2026-04-23", 7),
    "2026-04-30",
    "and a DST change (Egypt moves its clocks in late April) moves nothing — a date key has no hour",
  );
  assert.equal(daysBetweenKeys("2026-10-16", "2026-10-18"), 2, "Friday to Sunday is two days");
  assert.equal(daysBetweenKeys("2026-10-18", "2026-10-16"), -2, "and backwards is negative");

  assert.equal(daysUntilLabel("2026-10-16", "2026-10-16"), "Today");
  assert.equal(daysUntilLabel("2026-10-16", "2026-10-17"), "Tomorrow");
  assert.equal(daysUntilLabel("2026-10-16", "2026-10-25"), "In 9 days");
  assert.equal(
    daysUntilLabel("2026-10-16", "2026-10-14"),
    "Started 2 days ago",
    "a date already passed never prints a negative count",
  );
  assert.deepEqual(dateBlockParts("2026-10-18"), { day: "18", month: "Oct", weekday: "Sun" });
  assert.equal(longDayLabel("2026-10-16"), "Friday 16 October");

  // The meter: NULL in, NULL out — and never past its own track.
  assert.equal(rateMeterPercent(null), null, "a null rate draws no meter at all, never an empty one");
  assert.equal(rateMeterPercent(0.66), 66);
  assert.equal(rateMeterPercent(1.4), 100, "interview-to-offer can pass 100%, and the bar stops at its track");
  assert.equal(rateMeterPercent(0), 0, "a real zero is a real zero — it is a rate, not an absence");

  // Breakdown bars are relative to the LARGEST group, and a single CV is still visibly a bar.
  assert.equal(breakdownBarPercent(11, 11), 100);
  assert.equal(breakdownBarPercent(1, 60), 4, "one CV beside sixty is still a 4% bar, not an invisible sliver");
  assert.equal(breakdownBarPercent(0, 11), 0);

  // The three groups, and NOTHING DROPPED.
  const keys = [
    "vacants-pedia",
    "vacants-anti-infective",
    "vacants-cns",
    "cvs-received",
    "hired",
    "offers-sent",
  ];
  const grouped = groupRecruitingTiles(keys.map((key) => ({ key })));
  assert.deepEqual(
    grouped.map((group) => [group.label, group.tiles.map((tile) => tile.key)]),
    [
      ["Seats", ["vacants-pedia", "vacants-anti-infective", "vacants-cns"]],
      ["Candidates", ["cvs-received"]],
      ["Outcomes", ["hired", "offers-sent"]],
    ],
    "the six figures sort into Seats, Candidates and Outcomes, in his reading order",
  );
  assert.deepEqual(
    groupRecruitingTiles([...keys, "a-ninth-figure"].map((key) => ({ key })))
      .at(-1)
      ?.tiles.map((tile) => tile.key),
    ["hired", "offers-sent", "a-ninth-figure"],
    "a figure no group names joins the LAST group — a figure the builder emits is never silently dropped",
  );
  assert.deepEqual(
    groupRecruitingTiles([{ key: "cvs-received" }]).map((group) => group.key),
    ["candidates"],
    "a group with no figures is left out, so no caption sits over an empty row",
  );
  // The shared builder's own keys are the contract for the two figures kept from it.
  const builder = codeOf("src/lib/hr/command-center.ts");
  assert.deepEqual([...TALENT_KEPT_BUILDER_TILE_KEYS], ["hired", "offers-sent"], "her page keeps exactly Hired and Offers Out from the shared builder");
  for (const key of TALENT_KEPT_BUILDER_TILE_KEYS) {
    assert.ok(
      builder.includes(`tile("${key}"`),
      `command-center.ts no longer emits the "${key}" figure — the group it belongs to would lose it silently`,
    );
  }

  // Vacants by line: the figure is the line's empty seats, the caption is actual against total.
  const lineTiles = buildLineVacancyTiles({
    activeLineNames: [...Array(35).fill("Pedia"), ...Array(37).fill("Anti Infective"), ...Array(33).fill("CNS"), "Head Office", null],
    openSeatLineNames: ["Pedia", "Anti Infective", "Anti Infective", "CNS", "CNS", "CNS", "Head Office"],
  });
  assert.deepEqual(
    lineTiles.map((tile) => [tile.key, tile.label, tile.value, tile.sub]),
    [
      ["vacants-pedia", "Vacants · Pedia", 1, "35 of 36 seats filled"],
      ["vacants-anti-infective", "Vacants · Anti Infective", 2, "37 of 39 seats filled"],
      ["vacants-cns", "Vacants · CNS", 3, "33 of 36 seats filled"],
    ],
    "Pedia, Anti Infective, CNS in his order, each counting only its own line (Head Office and a line-less row are in none)",
  );
  assert.equal(
    buildLineVacancyTiles({ activeLineNames: ["Pedia"], openSeatLineNames: [] })[0]?.tone,
    "emerald",
    "a line with no empty seat reads as good, not amber",
  );
  const cvTile = buildCvsReceivedTile(163, "in October");
  assert.deepEqual([cvTile.key, cvTile.value, cvTile.sub], ["cvs-received", 163, "received in October"]);

  // Today's interviews: ENDED once the END has passed, NEXT is the first not ended.
  const interview = (id: string, startMinutes: number) => ({
    candidateName: `Person ${id}`,
    dateKey: "2026-10-18",
    durationMinutes: 30,
    href: "#",
    id,
    interviewerName: null,
    jobTitle: null,
    platformLabel: "Zoom",
    startMinutes,
    timeLabel: "",
  });
  const ordered = orderTodaysInterviews([interview("c", 660), interview("a", 540), interview("b", 600)], 610);
  assert.deepEqual(ordered.map((one) => one.id), ["a", "b", "c"], "the rows run in the order they happen");
  assert.deepEqual(
    ordered.map((one) => [one.done, one.next]),
    [
      [true, false],
      [false, true],
      [false, false],
    ],
    "at 10:10 the 9:00 has ended, and the 10:00 is NEXT although it started — its candidate is still in the room",
  );
  assert.ok(
    orderTodaysInterviews([interview("a", 540)], 1_000).every((one) => one.done && !one.next),
    "after the last interview nothing is next",
  );
  assert.deepEqual(startClockParts(540), { suffix: "AM", time: "9:00" }, "the Today panel reads the calendar's own 12-hour clock");
  assert.deepEqual(startClockParts(14 * 60 + 30), { suffix: "PM", time: "2:30" });
  assert.deepEqual(startClockParts(12 * 60), { suffix: "PM", time: "12:00" }, "noon is 12:00 PM, not 0:00");
  assert.equal(
    cairoMinutesNow(new Date("2026-10-16T07:30:00.000Z")),
    10 * 60 + 30,
    "07:30 UTC is 10:30 in Cairo on 16 October 2026 (UTC+3, summer time)",
  );

  // Joiners: the window starts TODAY, and offers that did not load are NOT "nobody joining".
  const arriving = joinersArriving(
    [
      offer({ id: "today", startDate: "2026-10-16", status: "accepted" }),
      offer({ id: "edge", startDate: "2026-10-30", status: "accepted" }),
      offer({ id: "past", startDate: "2026-10-15", status: "accepted" }),
      offer({ id: "far", startDate: "2026-10-31", status: "accepted" }),
    ],
    "2026-10-16",
  );
  assert.equal(arriving.toKey, "2026-10-30", "the window is fourteen days, today counted as day 0");
  assert.deepEqual(
    arriving.rows.map((row) => row.id).sort(),
    ["edge", "today"],
    "a joiner starting TODAY is on the panel, and so is the fourteenth day; yesterday and day fifteen are not",
  );
  assert.equal(arriving.loaded, true);
  assert.deepEqual(
    joinersArriving(undefined, "2026-10-16"),
    { fromKey: "2026-10-16", loaded: false, rows: [], toKey: "2026-10-30" },
    "offers that did not load give loaded: false — the panel then says it could not tell",
  );
  assert.equal(JOINERS_WINDOW_DAYS, 14, "the window he chose: joiners arriving in 14 days");

  // THE STORED SHAPE. `offers.start_date` is text the way the LETTER prints it ("18 October 2026"),
  // not `yyyy-mm-dd`, so every fixture above is a shape production does not hold. Read as a slice of
  // ten characters it fell outside every window and the panel said nobody was joining while four
  // accepted offers started on 17 and 18 October.
  const stored = joinersArriving(
    [
      offer({ id: "dsm", startDate: "17 October 2026", status: "accepted" }),
      offer({ id: "rep", startDate: "18 October 2026", status: "accepted" }),
      offer({ id: "bare-day", startDate: "9 November 2026", status: "accepted" }),
      offer({ id: "started", startDate: "11 October 2026", status: "accepted" }),
      offer({ id: "unreadable", startDate: "next month", status: "accepted" }),
      offer({ id: "blank", startDate: "", status: "accepted" }),
    ],
    "2026-10-16",
  );
  assert.deepEqual(
    stored.rows.map((row) => [row.id, row.dateKey]),
    [
      ["dsm", "2026-10-17"],
      ["rep", "2026-10-18"],
    ],
    "a letter-date start reads as its real day; one already started, one past day fourteen, one that cannot be read and a blank one are not on the panel",
  );
  // Once an offer has an employee record, THAT record's hire date is the day: a letter said 17
  // October while the employee record said 24 October (measured 2026-10-16), and 24 is the day
  // attendance and payroll start. The id is matched through the canonical key, so case never hides it.
  const hired = joinersArriving(
    [
      {
        ...offer({ id: "moved", startDate: "17 October 2026", status: "accepted" }),
        employeeHrId: "PD-0028",
      } as unknown as OfferRecord,
      offer({ id: "no-record", startDate: "18 October 2026", status: "accepted" }),
    ],
    "2026-10-16",
    undefined,
    new Map([["pd-0028", "2026-10-24"]]),
  );
  assert.deepEqual(
    hired.rows.map((row) => [row.id, row.dateKey]),
    [
      ["no-record", "2026-10-18"],
      ["moved", "2026-10-24"],
    ],
    "an offer WITH an employee record joins on that record's hire date; one without keeps the letter's",
  );
  assert.equal(
    joinersArriving(
      [offer({ id: "far", startDate: "17 October 2026", status: "accepted" })],
      "2026-10-16",
      undefined,
      new Map([["x-1", "2026-10-24"]]),
    ).rows.length,
    1,
    "an unrelated hire date changes nothing",
  );
  assert.equal(offerStartKey("1 november 2026"), "2026-11-01", "a bare day and any capitalisation read");
  assert.equal(offerStartKey("2026-10-18"), "2026-10-18", "an ISO start date still reads");
}

// ── 1c. The three panels he chose say a failure, and say an empty day, differently ────────────
function testTheTodayPanelsNeverDrawAFailureAsAQuietDay() {
  for (const [file, gate, what] of [
    [TODAY_COMPONENT, /!today\.loaded \?/, "today's interviews"],
    [JOINERS_COMPONENT, /!joiners\.loaded \?/, "the joiners"],
    [CV_COMPONENT, /!digest \?/, "today's CVs"],
  ] as const) {
    const code = codeOf(file);
    assert.match(code, gate, `${what} must branch on the read having LOADED before it branches on empty`);
    assert.match(code, /<TaCouldNotLoad what=/, `${what} must draw the named failure notice on a failed read`);
    assert.match(code, /<TaEmpty\b/, `${what} must draw its own calm empty state on a genuinely empty day`);
  }
  const cv = codeOf(CV_COMPONENT);
  assert.match(
    cv,
    /if \(cvToday\.status === "hidden"\) return null;/,
    "a seat that may not read candidates gets NO CVs panel — never a 'could not load' for something it was never allowed to see",
  );
  assert.ok(cv.includes("digest.byPlace"), "the CVs panel lists the digest's tab-and-place breakdown");
  assert.ok(!cv.includes("byJobTitle"), "and no longer the CV-read 'Applying for' — a CV never decides where a person is filed");
  assert.match(cv, /href=\{placeHref\(place\)\}/, "each tab-and-place line opens that tab in the workspace");
  assert.ok(cv.includes("digest.bySource"), "and its channel breakdown");
  assert.ok(!/and \$\{|more`|\.slice\(0, ?\d/.test(cv), "every group is listed — no 'and N more', no cut list");

  const data = codeOf(DATA);
  assert.match(
    data,
    /canAccess\(access, "candidates", "read"\)/,
    "the CVs are asked for only when her seat may read candidates",
  );
  assert.match(
    data,
    /buildTodaysCvDigest\(now, \{ hideHrPeople: workspaceViewer\(access\)\.hidesHrPeople \}\)/,
    "and counted by the 18:00 summary's own builder, so the two never disagree — fenced for her seat, so no HR applicant is counted",
  );
  assert.match(data, /listInterviewCalendarDay\(caller, todayKey\)/, "today's interviews come through the calendar's own day reader and gate");
  assert.match(
    data,
    /joinersArriving\(loaded\.offers, calendar\.todayKey, undefined, hireDates\)/,
    "the joiners are the offers and the directory already loaded — no new read, and the Employee Master's start date wins over the letter's",
  );
  for (const line of [
    'pageUnavailable.push("CVs received today")',
    'if (!today.loaded) pageUnavailable.push("Today\'s interviews")',
  ]) {
    assert.ok(data.includes(line), `a failed read must reach the page's notice by name: ${line}`);
  }

  // The frame: a zero count is not drawn beside an empty state that already says "none".
  const panel = codeOf(PANEL_COMPONENT);
  assert.match(panel, /typeof count === "number" && count > 0 \?/, "a zero count chip is never drawn");
  assert.match(panel, /@container relative flex/, "every panel is its own container, so its insides follow its width");
}

// ── 2. Her handbook's two KPI families count what their captions say ──────────────────────────
function testTheOfferConversionFamilyCountsAnsweredOffersOnly() {
  const fromIso = "2026-07-15T00:00:00.000Z";
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

  const [acceptance, offerToJoin] = buildOfferConversionKpis(offers, { fromIso, started: new Set(["a1"]) });

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
    "and its numerator is the accepted offers whose person has STARTED — an active employee whose " +
      "first day has arrived. It used to count the employee records the joining form created, " +
      "which read 22 of 22 while four of those people had not yet had a first day",
  );
  assert.equal(offerToJoin.numeratorLabel, "employee started", "the label says what it counts");
  assert.doesNotMatch(
    offerToJoin.caption,
    /joining form/,
    "the card no longer counts the form, so its caption must not tell a reader it does — only 3 of " +
      "22 accepted letters came through the form, the rest were Add Employee",
  );
  assert.match(offerToJoin.caption, /first day/, "the caption says a started person is one whose first day has arrived");

  // BOTH CARDS COUNT THE SAME WINDOW (owner, 2026-10-16: "window all three"). They had read the
  // newest 200 letters with no date filter beneath a "Last 90 days" header.
  const aged = [
    offer({ createdAt: "2026-01-02T10:00:00.000Z", id: "old-yes", status: "accepted" }),
    offer({ createdAt: "2026-01-03T10:00:00.000Z", id: "old-no", status: "declined" }),
    // Undated: counted OUT, because it cannot be shown to belong to the window.
    offer({ createdAt: null, id: "undated", status: "accepted" }),
    offer({ createdAt: "2026-10-01T10:00:00.000Z", id: "new-yes", status: "accepted" }),
    offer({ createdAt: "2026-10-02T10:00:00.000Z", id: "new-no", status: "declined" }),
  ];
  const [windowedAcceptance, windowedJoin] = buildOfferConversionKpis(aged, {
    fromIso,
    started: new Set(["old-yes", "undated", "new-yes"]),
  });
  assert.deepEqual(
    [windowedAcceptance.numerator, windowedAcceptance.denominator],
    [1, 2],
    "offer acceptance counts only the letters written inside the window — a January answer is not this quarter's",
  );
  assert.deepEqual(
    [windowedJoin.numerator, windowedJoin.denominator],
    [1, 1],
    "offer-to-join windows the same way, and a started person whose letter is outside it is not counted",
  );

  // Without the Employee Master there is no way to know who started: the card is ABSENT, never 0 of N.
  assert.deepEqual(
    buildOfferConversionKpis(offers, { fromIso, started: null }).map((one) => one.key),
    ["offer-acceptance"],
    "an unavailable directory leaves the join card out — 0 of 3 would say nobody arrived",
  );
  assert.deepEqual(buildOfferConversionKpis(undefined, { fromIso, started: new Set() }), [], "no offers read, no cards");

  for (const measure of buildOfferConversionKpis([], { fromIso, started: new Set() })) {
    assert.equal(
      measure.rate,
      null,
      `${measure.key} must be null with no offers at all, not 0% — the seat opens on 18 October ` +
        "2026 and a 0% acceptance on day one would be a verdict on nobody",
    );
  }
}

function testWhoHasStartedIsAnActiveEmployeeWhoseFirstDayHasArrived() {
  const accepted = (id: string, employeeHrId: string | null, startDate?: string) =>
    offer({ employeeHrId, id, startDate, status: "accepted" });
  const offers = [
    accepted("started", "PD-0001"),
    accepted("later", "PD-0002"),
    accepted("left", "PD-0003"),
    accepted("no-record", null),
    accepted("from-letter", "PD-0005", "9 October 2026"),
    accepted("no-date", "PD-0006", ""),
    // The mixed-case spelling production really stores must still find the employee.
    accepted("mixed-case", "pd-0007"),
    // A letter that is only SENT has no employee record that counts, even if one is pointed at it.
    offer({ employeeHrId: "PD-0008", id: "sent", status: "sent" }),
  ];
  const started = startedOfferIds(offers, {
    activeHrIds: new Set(["pd-0001", "pd-0002", "pd-0005", "pd-0006", "pd-0007", "pd-0008"]),
    hireDateByHrId: new Map([
      ["pd-0001", "2026-10-01"],
      ["pd-0002", "2026-10-18"],
      ["pd-0007", "2026-10-16"],
    ]),
    todayKey: "2026-10-16",
  });
  assert.deepEqual(
    [...started].sort(),
    ["from-letter", "mixed-case", "started"],
    "started = accepted, an ACTIVE employee, and a first day on or before today. 'later' has a record " +
      "but its first day is the 18th; 'left' is not active; 'no-record' has no employee at all; " +
      "'from-letter' has no hire date on the Master so the letter's own date (9 October) stands; " +
      "'no-date' has no first day anywhere, so none has arrived; and 'sent' is not an acceptance",
  );
  assert.equal(
    startedOfferIds(offers, { activeHrIds: new Set(), hireDateByHrId: undefined, todayKey: "2026-10-16" }).size,
    0,
    "no active employee, nobody started",
  );
}

function testHiringQualityCountsTheSamePeopleOnBothSides() {
  const volume = {
    fromIso: "2026-07-15T00:00:00.000Z",
    interviews: 63,
    offered: 15,
    people: 58,
    truncated: false,
  };

  const [ratio] = buildHiringQualityKpis({ volume });
  assert.equal(
    ratio.denominator,
    58,
    "interview-to-offer divides by DISTINCT PEOPLE interviewed, not by bookings — a candidate who " +
      "came back for a second round must not count twice against the seat",
  );
  assert.equal(
    ratio.numerator,
    15,
    "and its numerator is how many OF THOSE PEOPLE hold a live offer letter — the same people, not " +
      "every letter written in the window. The old figure read 66% against a like-for-like 22% on " +
      "2026-10-16 because it counted withdrawn letters, test letters and people never on the calendar",
  );
  assert.equal(ratio.numeratorLabel, "holding an offer letter", "the label names the people, not the letters");
  assert.match(
    ratio.caption,
    new RegExp(String(KPI_WINDOW_DAYS)),
    "the caption must name the window in days. An unnamed window is the defect the owner caught on " +
      "the Hired tile when he asked how it could read what it read",
  );
  assert.doesNotMatch(
    ratio.caption,
    /Above 100%/,
    "a subset cannot pass 100%, so the apology the old caption carried is gone",
  );

  // The owner removed probation retention from her overview on 2026-10-16 — the band holds the
  // interview-to-offer ratio and nothing else.
  assert.deepEqual(
    buildHiringQualityKpis({ volume }).map((one) => one.key),
    ["interview-to-offer"],
    "the hiring-quality band is the interview-to-offer ratio alone — probation retention was " +
      "removed from her overview on the owner's word and must not come back",
  );

  // A read that failed contributes NO measure rather than a zero one — whether the interviews
  // could not be read or the letters to match them to were not available.
  assert.deepEqual(
    buildHiringQualityKpis({ volume: null }).map((one) => one.key),
    [],
    "with no interview count the band must be empty. A card for a measure whose source refused " +
      "would be a figure invented out of a failure",
  );
  assert.deepEqual(
    buildHiringQualityKpis({ volume: { ...volume, offered: null } }).map((one) => one.key),
    [],
    "with the interviews read but no letters to match them to, the card is left out and not drawn as 0%",
  );
  assert.equal(kpiWindowFromIso(new Date("2026-10-16T12:00:00.000Z")), "2026-07-18T12:00:00.000Z", "the window is 90 days back from the instant");
}

function testAnInterviewedPersonIsMatchedToALetterByPointerOrAddressNeverByName() {
  const letters = liveLetterKeys([
    offer({ candidateEmail: "Mona@Example.com ", id: "L-sent", status: "sent" }),
    offer({ candidateEmail: "sara@example.com", id: "L-accepted", status: "accepted" }),
    offer({ candidateEmail: "hend@example.com", id: "L-declined", status: "declined" }),
    // A withdrawn letter was pulled and a draft was never written to anyone: neither is an offer
    // the person holds, so neither may lift the ratio.
    offer({ candidateEmail: "withdrawn@example.com", id: "L-withdrawn", status: "withdrawn" }),
    offer({ candidateEmail: "draft@example.com", id: "L-draft", status: "draft" }),
  ]);
  assert.deepEqual([...letters.ids].sort(), ["L-accepted", "L-declined", "L-sent"], "live = sent, accepted or declined");
  assert.ok(letters.emails.has("mona@example.com"), "an address is trimmed and lower-cased before it is compared");
  assert.ok(!letters.emails.has("withdrawn@example.com") && !letters.emails.has("draft@example.com"), "and a pulled or unwritten letter holds nobody");

  const candidates = new Map([
    ["c-pointer", { email: null, offerId: "L-accepted" }],
    ["c-email", { email: " HEND@example.com", offerId: null }],
    ["c-withdrawn", { email: "withdrawn@example.com", offerId: "L-withdrawn" }],
    ["c-nothing", { email: "nobody@example.com", offerId: null }],
    ["c-twice", { email: null, offerId: "L-sent" }],
  ]);
  const rows = [
    { candidate_id: "c-pointer", external_name: null },
    { candidate_id: "c-email", external_name: null },
    { candidate_id: "c-withdrawn", external_name: null },
    { candidate_id: "c-nothing", external_name: null },
    // Two rounds for one person: one person, offered once.
    { candidate_id: "c-twice", external_name: null },
    { candidate_id: "c-twice", external_name: null },
    // An outside person is matched on the address typed on the booking, and never on the name.
    { candidate_id: null, external_email: "MONA@example.com", external_name: "Mona" },
    { candidate_id: null, external_email: "other@example.com", external_name: "Sara" },
    // A booking naming nobody is no person at all.
    { candidate_id: null, external_name: "  " },
  ];
  assert.equal(
    countOfferedPeople(rows, candidates, letters),
    4,
    "offered = the pointer (c-pointer), the record's address (c-email), one person across two rounds " +
      "(c-twice) and the outside address (Mona). The withdrawn letter, the stranger and a name that " +
      "happens to match another letter's do not count",
  );
  assert.ok(
    countOfferedPeople(rows, candidates, letters) <= countDistinctPeople(rows),
    "the top half is a subset of the bottom half by construction, so the ratio can never pass 100%",
  );
  assert.equal(
    countOfferedPeople(rows, new Map(), { emails: new Set(), ids: new Set() }),
    0,
    "no letters, no offered people",
  );
}

function testTheLoaderHandsTheConversionCardsTheLettersAndTheMaster() {
  const data = codeOf(DATA);
  assert.match(
    data,
    /countInterviewVolume\(KPI_WINDOW_DAYS, now, loaded\.offers \? liveLetterKeys\(loaded\.offers\) : undefined\)/,
    "the interview count is handed the live letters it matches its people against; without offers it gets none and the card is left out",
  );
  assert.match(data, /buildHiringQualityKpis\(\{ volume \}\)/, "the ratio is built from the matched count alone, not from a second, wider list of letters");
  assert.match(
    data,
    /buildOfferConversionKpis\(loaded\.offers, \{\s*fromIso: volume\?\.fromIso \?\? kpiWindowFromIso\(now\),\s*started: startedOffers,/,
    "both conversion cards are cut at the same window start as the interview count",
  );
  assert.match(
    data,
    /startedOffers = loaded\.directory\s*\?\s*startedOfferIds\(/,
    "who has started comes from the directory the page already loaded, and is null without it",
  );
  assert.match(
    data,
    /isActiveLifecycleStatus\(employee\.employmentStatus\)/,
    "started asks the lifecycle status only, not the organogram's visibility test — a new hire not drawn there yet has still started",
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

// ── 4. Only an accepted offer is somebody arriving ──────────────────────
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
        durationMinutes: 30,
        href: "/x",
        id: "i1",
        interviewerName: null,
        jobTitle: null,
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
  for (const file of [DATA, LOGIC, PAGE_COMPONENT, CALENDAR_COMPONENT, ...NEW_PARTS]) {
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

// ── 7. The two charts he once named are GONE — as duplicates of the cards, on his word ──────────
//
// On 13 October 2026 he named "Live candidates, by pipeline stage" and "Job offers, by status" to
// keep. On 16 October he ticked both as duplicates of the cards ("remove duplicates") — every number
// either chart drew is a figure card on the same page. So the loader no longer builds them for this
// page at all (building data nothing draws is a read on every page load for nobody), and the page
// draws none. The generic page keeps its own builder and both charts, untouched.
function testTheTwoDuplicateChartsAreNeitherBuiltNorDrawn() {
  const data = codeOf(DATA);
  for (const name of ["buildRecruitingCharts", "OFFERS_BY_STATUS_CHART_KEY", "HrCommandChart", "offerChart"]) {
    assert.ok(
      !data.includes(name),
      `the loader still carries ${name}. Both charts were removed as duplicates of the cards on ` +
        "2026-10-16 — building them again is the first step to drawing them again",
    );
  }
  for (const file of [PAGE_COMPONENT, ...NEW_PARTS]) {
    assert.ok(!/<HrCommandCharts/.test(codeOf(file)), `${file} draws a chart: every figure on her page is a card`);
  }
  assert.match(
    codeOf("src/lib/hr/command-center.ts"),
    /export function buildRecruitingCharts/,
    "and the generic page's builder is still there — the removal was this page's, not every seat's",
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
    props(minePropsMatch![1]).filter((prop) => prop !== "reserve={conversionBand}"),
    props(genericPropsMatch![1]),
    "the strip must receive the SAME four identity props on both pages, written the same way. The " +
      'owner\'s instruction was "do not touch, do not ever touch" (2026-10-12) and "donot touch photo ' +
      'or identity banner" (2026-10-13) — a renamed prop or a reordered value is a touch. The ONE ' +
      'addition is reserve, his own (2026-10-16, "fit the keycards where i marked")',
  );
  assert.ok(props(minePropsMatch![1]).includes("reserve={conversionBand}"), "her page fills the air beside the portrait");
  // Every OTHER landing keeps the strip exactly as it was: given no reserve, the notices still fill
  // the air with their shut peek — "i donot want this blanque area empty like this" (2026-10-13).
  const stripCode = codeOf("src/components/phoenix-signature-card/PhoenixIdentityStrip.tsx");
  assert.ok(
    stripCode.includes('<PhoenixIdentityNotices className="flex-1" reservesAir={Boolean(photoSrc)} />'),
    "a strip given no reserve still draws the notices' peek in the air",
  );
  assert.match(stripCode, /\{reserve \? \(/, "and only a strip given a reserve puts something else there");
  assert.ok(
    !/CeoHeroIdentity/.test(mine),
    "and it must not also draw the dark band. Two identities on one page is the defect " +
      "tests/workspace-single-hero.test.ts exists for, reached by a different route",
  );
}

// ── 9. The house look: square edges, no sideways scroll, no ellipsis ──────────────────────────
function testTheNewComponentsObeyTheThreeGoldenRules() {
  const offences: string[] = [];
  for (const file of [PAGE_COMPONENT, CALENDAR_COMPONENT, ...NEW_PARTS]) {
    const code = codeOf(file);

    // `rounded-full` is a CIRCLE, not a corner — the generic page's icon badge and the charts'
    // legend dots both use it, and the square-edge rule is about corners.
    for (const hit of code.match(/rounded-(?!full\b)[a-z0-9[\]-]+/g) ?? []) {
      offences.push(`${file} carries ${hit} — the square-edge golden rule allows no rounded corner`);
    }
    // EVERY spelling of a width FLOOR, not just the Tailwind one: a JSX `style={{ minWidth: 900 }}`
    // is the same defect and slipped past this check on 13 October 2026, while the week grid's own
    // pins were being proven by breaking them. `min-w-0` is deliberately absent — it is the
    // opposite rule, the thing that lets a flex or grid child shrink instead of forcing a row wide.
    for (const hit of
      code.match(/overflow-x-auto|min-w-\[|min-w-(?:max|min|fit|full|screen)|min-width|minWidth/g)
      ?? []) {
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
 * ── 9b. HER WEEK **IS** THE INTERVIEW CALENDAR, NOT A COPY OF IT ───────────────────────────────
 *
 * The owner, 13 October 2026, in order: **"2 OUT OF 10"**, then **"BULLSHIT ,, AUDIT THE INTERVIEW
 * CALENDER"**, then **"FULL INTERVIW CALENDAR FEAATURES"**.
 *
 * Three week layouts were written for this page in one day and all three were rejected. The last of
 * them wore `interview-calendar-view.tsx`'s own tokens — its table, its 46px rows, its zebra, its
 * orange edge — and it was still wrong, because a grid that LOOKS like the interview calendar still
 * cannot do what the interview calendar does: move between weeks, pick a week, press a free half
 * hour to book someone, open a candidate's CV, read an interview's Zoom link and panel and outcome
 * and notes, run a session, export the week as PDF or Excel, ask for an interview. His answer was
 * not "wear its skin" but "have its features", and there is exactly one way to have all of them.
 *
 * SO THE PINS BELOW ARE ABOUT THE EMBEDDING, AND THEY ARE DELIBERATELY NEGATIVE AS WELL AS POSITIVE.
 * A later session that "improves" this panel by writing a week grid here again would pass every
 * design-token test ever written and still undo his instruction — so this test refuses a second week
 * layout in this file at all: no table, no half-hour rail, no slot cell, no booking chip. The whole
 * week is four props handed to the real component, and the one thing that may be asserted about how
 * it LOOKS is that it is the same component the recruitment team uses, which is a fact about the
 * import, not about a class name.
 */
function testHerWeekIsTheInterviewCalendarItself() {
  const calendar = codeOf(CALENDAR_COMPONENT);

  assert.match(
    calendar,
    /import \{ InterviewCalendarView \} from "@\/components\/recruitment\/interview-calendar\/interview-calendar-view";/,
    "the week tab must MOUNT the real interview calendar. Every feature he asked for — the week " +
      "navigation and week picker, booking a free time, the sessions, the CV previews, the interview " +
      "detail, the exports, Request an interview — lives in that component and in no other",
  );
  assert.ok(
    codeOf(SIBLING_GRID).includes("export function InterviewCalendarView("),
    "and the component must still be exported from the path this page imports it from. A rename " +
      "that left this import dangling would take her whole week down, and the week is the page",
  );

  const mounted = /<InterviewCalendarView\b[\s\S]*?\/>/.exec(calendar)?.[0] ?? "";
  assert.notEqual(mounted, "", "it must be RENDERED, not merely imported");
  for (const [prop, why] of [
    [
      "abilities={calendar.interviewCalendar.abilities}",
      "her abilities inside the calendar — search candidates, add one to Recruitment — are a SERVER " +
        "decision, resolved by the same `interviewCalendarAbilities` the recruitment page calls",
    ],
    [
      "canRequest={calendar.interviewCalendar.canRequest}",
      "Request an interview is one of the features he named. Omitting the prop defaults it to false " +
        "and silently removes the button from her page alone",
    ],
    [
      "initialWeek={calendar.weekStart}",
      "the week it opens on comes from the server, so the first paint is not a week behind",
    ],
    [
      "role={calendar.interviewCalendar.role}",
      "and her tier on the calendar is resolved by `resolveInterviewCalendarRole`, never assumed " +
        "here — it is what decides whether she may book and move interviews or only read them",
    ],
    [
      "todayKey={todayKey}",
      "today is the server's Cairo date, the same one the month grid marks. Letting the component " +
        "fall back to its own would put two different todays in one panel across a Cairo midnight",
    ],
    [
      "zoomConnected={calendar.interviewCalendar.zoomConnected}",
      "and whether Zoom is wired at all, so the screen does not offer a meeting it cannot create",
    ],
  ] as const) {
    assert.ok(mounted.includes(prop), why);
  }
  assert.ok(
    !/lockedWeek=/.test(mounted),
    "and `lockedWeek` must NOT be passed. It is the prop a week-limited share link uses to freeze " +
      "the calendar on one week — passing it here would delete the week navigation he explicitly " +
      "asked for, from the one page he asked for it on",
  );

  // THE NEGATIVE HALF: no second week layout in this file, ever again.
  for (const [pattern, what] of [
    [/<table\b/, "a <table>"],
    [/\bslotStarts\(/, "a half-hour rail of its own"],
    [/h-\[46px\]/, "a slot cell"],
    [/border-l-\[3px\]/, "a booking chip"],
    [/<colgroup\b/, "a column group"],
  ] as const) {
    assert.ok(
      !pattern.test(calendar),
      `this file carries ${what} again. The week is the real interview calendar — a hand-written ` +
        "grid here is the thing three rejections in one day were about, and it passes every " +
        "design-token test while still not being able to book an interview",
    );
  }

  assert.match(
    calendar,
    /\{calendar\.interviewCalendar \? \(/,
    "and a week drawn with NO ROLE resolved must be refused rather than rendered. The component " +
      "needs a role to decide what to offer, and a blank week is the one wrong answer a diary gives",
  );

  const data = codeOf(DATA);
  for (const resolver of [
    "resolveInterviewCalendarRole(access)",
    "interviewCalendarAbilities(access)",
    "mayRequestInterviews(access)",
    "isZoomConfigured()",
  ]) {
    assert.ok(
      data.includes(resolver),
      `${resolver} must be the source of that prop — the same four answers ` +
        "`app/(admin)/recruitment/interview-calendar/page.tsx` resolves for the full page. A prop " +
        "computed some other way here is a second opinion about what she may do",
    );
  }
  assert.match(
    data,
    /upcomingWeekStart\(now\)/,
    "and the week it opens on must be `upcomingWeekStart`, not the week today sits in. They differ " +
      "on a FRIDAY and a SATURDAY, which are not working days here: the week containing today is " +
      "then Sunday-to-Thursday entirely in the past, so her landing page would open every weekend " +
      "on a week that is over — which reads as a week with nothing in it",
  );
}

// ── 9c. The month grid still draws every rule exactly once ─────────────────────────────────────
function testTheMonthGridDrawsEveryRuleOnce() {
  const calendar = codeOf(CALENDAR_COMPONENT);
  const start = calendar.indexOf("function MonthCell(");
  assert.notEqual(start, -1, "MonthCell must still exist in the calendar component");
  const rest = calendar.slice(start + 1);
  const end = /\n(?:export )?function /.exec(rest)?.index;
  const cell = end === undefined ? rest : rest.slice(0, end);
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
  assert.match(
    calendar,
    /\{!calendar\.mineLoaded \? \(/,
    "her OWN agenda must branch on `mineLoaded` and say so when that read refused. `mine.length " +
      "=== 0` printed from a failed read says 'you are not on an interview in the next three " +
      "weeks', which is the one wrong answer a diary can give — and the answer that makes somebody " +
      "miss an interview. The week needs no such branch: the embedded calendar reads its own weeks " +
      "and reports its own failures",
  );
  assert.equal(
    (calendar.match(/<CouldNotLoad what=/g) ?? []).length,
    3,
    "and all three views must have that fallback — no role on the calendar at all, her own agenda, " +
      "and the company half of the month. A view without one is a view that draws a refused read " +
      "as a quiet day",
  );
  assert.match(
    calendar,
    /calendar\.monthItemsLoaded \? null :/,
    "and the month must say when the COMPANY half did not answer — the grid, her interviews and " +
      "the joining days are standing either way, so this is a notice above a real month",
  );

  const data = codeOf(DATA);
  for (const [line, what] of [
    ['if (!calendar.interviewCalendar) pageUnavailable.push("Interview calendar")', "the week"],
    ['if (!calendar.mineLoaded) pageUnavailable.push("Your own interviews")', "her own agenda"],
    ['if (!calendar.monthItemsLoaded) pageUnavailable.push("Company calendar")', "the month"],
  ] as const) {
    assert.ok(
      data.includes(line),
      `a failure of ${what} must reach the page's own unavailable notice BY NAME, so a reader is ` +
        "told which part of the calendar is missing rather than being left to notice. A notice that " +
        "says 'something' is a notice nobody can act on",
    );
  }
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

// ── 12. The vacation source is declared, not assumed; the probation read is gone ───────────────
function testTheVacationSourceIsDeclaredOnHerBundleAndProbationIsNotRead() {
  const sources = sourcesFor(TALENT_ACQUISITION_SEAT);
  assert.ok(
    sources.includes("vacationsToday"),
    "vacationsToday must be declared by one of her functions. This page reads it for the vacation " +
      "panel, and a page doing work under her session that the permission catalogue never granted " +
      "is the thing sourcesFor exists to prevent",
  );
  const data = codeOf(DATA);
  assert.doesNotMatch(
    data,
    /getProbationOutcomesAnalytics|probationOutcomes/,
    "her overview no longer reads probation outcomes — the owner removed the Probation retention " +
      "card on 2026-10-16 (\"remove this section from ta overview\")",
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
  // The button lives on the command rail; the page hands it the panel's id and its open state from
  // the SAME constant and the SAME state the panel itself is drawn from.
  const rail = codeOf(RAIL_COMPONENT);
  assert.match(rail, /aria-controls=\{panelId\}/, "the button must name the panel it controls");
  assert.match(rail, /aria-expanded=\{open\}/, "and it is a disclosure, so it says whether it is open");
  assert.equal((rail.match(/Needs attention/g) ?? []).length, 1, "and there is exactly one Needs attention button");
  assert.match(component, /panelId=\{PENDINGS_PANEL_ID\}/, "the rail is given the panel's id from the constant");
  assert.match(component, /open=\{showPendings\}/, "and the panel's own open state");
  assert.match(
    component,
    /id=\{PENDINGS_PANEL_ID\}/,
    "and the panel must carry that same id from the same constant, so the two cannot drift into a " +
      "dangling aria reference",
  );
}

// ── 14. The open page re-reads itself ─────────────────────────────────────────────────────────
function testTheOpenPageRefreshesItsOwnFigures() {
  const component = codeOf(PAGE_COMPONENT);
  assert.match(
    component,
    /window\.setInterval\(refreshIfVisible, OVERVIEW_REFRESH_MS\)/,
    "the overview must re-read its server data on a timer — she leaves it open all day, and the " +
      "route is force-dynamic, so without this every figure is frozen at the moment she opened it",
  );
  assert.match(
    component,
    /addEventListener\("visibilitychange", refreshIfVisible\)/,
    "and it must refresh the moment she comes back to the tab, not wait out the interval",
  );
  assert.match(
    component,
    /visibilityState === "visible"/,
    "a hidden tab must not keep polling the database",
  );
  assert.match(
    component,
    /clearInterval\(timer\)[\s\S]*removeEventListener\("visibilitychange"/,
    "and both are released when the page unmounts",
  );

  // THE EMBEDDED WEEK GRID FETCHES ITSELF, so `router.refresh()` alone never reached it: a booking
  // added at 14:30 arrived in Today and on the month within a minute and not on the week.
  const calendar = codeOf(CALENDAR_COMPONENT);
  assert.match(calendar, /refreshToken=\{calendar\.refreshedAt\}/, "the week grid is handed the server's refresh instant");
  assert.match(
    codeOf("src/components/recruitment/interview-calendar/interview-calendar-view.tsx"),
    /\}, \[api, refreshToken, weekStart\]\);/,
    "and its fetch effect re-reads the week when that instant changes",
  );
  assert.match(codeOf(DATA), /refreshedAt: now\.getTime\(\)/, "the loader stamps every render with it");
}

// ── 15. A read that gave up is NAMED, never drawn as a calm answer ────────────────────────────────
function testAGivenUpReadIsNamedNeverDrawnAsAnAllClear() {
  const data = codeOf(DATA);
  assert.match(
    data,
    /openVacancyReadFailed\(\)[\s\S]*pageUnavailable\.push\("Vacant seats"\)/,
    "the open-vacancy read returns [] on a timeout, so the page asks whether it did and names 'Vacant seats' rather than printing '0 vacant, every seat filled' in green",
  );
  assert.match(data, /loaded\.directory && !vacanciesUnreadable/, "and the vacancy tiles are left out in that case");
  assert.match(
    data,
    /failedMonthWeeks > 0\) pageUnavailable\.push\("Month interviews"\)/,
    "a month week that refused takes its interviews off the grid, and says so",
  );
  assert.match(
    codeOf("src/lib/employees/vacancy-closer.ts"),
    /vacancyReadState\(\)\.failed = true/,
    "the closer records the failure instead of swallowing it silently",
  );
}

export function runTalentAcquisitionOverviewTests() {
  testARateIsNeverDrawnAsZero();
  testTheRebuiltPagesPureHelpers();
  testTheTodayPanelsNeverDrawAFailureAsAQuietDay();
  testTheOfferConversionFamilyCountsAnsweredOffersOnly();
  testWhoHasStartedIsAnActiveEmployeeWhoseFirstDayHasArrived();
  testHiringQualityCountsTheSamePeopleOnBothSides();
  testAnInterviewedPersonIsMatchedToALetterByPointerOrAddressNeverByName();
  testTheLoaderHandsTheConversionCardsTheLettersAndTheMaster();
  testDistinctPeopleCollapsesRoundsAndKeepsOutsiders();
  testOnlyAnAcceptedOfferDrawsAJoiningDay();
  testAGivenUpReadIsNamedNeverDrawnAsAnAllClear();
  testAMultiDayHolidayIsMarkedOnEveryDayItCovers();
  testEmployeeRequestsIsOffThePageAndStillInHerSeat();
  testTheTwoDuplicateChartsAreNeitherBuiltNorDrawn();
  testTheIdentityStripIsTheGenericPagesByteForByte();
  testTheNewComponentsObeyTheThreeGoldenRules();
  testHerWeekIsTheInterviewCalendarItself();
  testTheMonthGridDrawsEveryRuleOnce();
  testAFailedCalendarReadIsStatedRatherThanDrawnEmpty();
  testTheRouteServesTheNewPageToHerSeatAlone();
  testTheVacationSourceIsDeclaredOnHerBundleAndProbationIsNotRead();
  testThePendingsPanelIsOneDisclosureWiredToItsButton();
  testTheOpenPageRefreshesItsOwnFigures();
}
