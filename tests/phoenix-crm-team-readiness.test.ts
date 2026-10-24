import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildPhoenixTeamReadinessRows,
  judgeTeamReadiness,
  PHOENIX_TEAM_READINESS_WINDOW_DAYS,
  readinessWindowFrom,
  repsWithListLine,
  unreadableTeamReadiness,
  type TeamReadinessFacts,
  type TeamReadinessRepSeat,
} from "../src/lib/crm/phoenix-team-readiness.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * IS THIS TEAM READY TO START IN PHOENIX CRM — the board beside the Start button.
 *
 * The owner rolls Phoenix CRM out one team at a time and only he presses Start. Until this board
 * existed the panel told him what each team IS counted from and nothing about whether it is ready
 * to move, so the judgement was made from memory. These are the two things that would be wrong
 * QUIETLY — both measured on production on 2026-10-03, both of which cost him something that day.
 *
 *  1. 🔴 **"SEATS FILLED" IS THE MISLEADING NUMBER.** Pedia Upper Egypt 1 reads 6 rep seats, all
 *     SIX filled — and five of those reps were hired between 1 and 4 October and carry no
 *     customers at all. One rep of six has a list. A board headlining "6 of 6 filled" calls the
 *     least ready team on the line ready. So the headline is REPS WITH A LIST, and the new hires
 *     are named, because reading the same zero without the hire dates is what cost the round trip.
 *
 *  2. 🔴 **ONE PERSON CAN HOLD TWO SEATS AND INFLATE EVERY COUNT.** Nosiba Salah Hassanin Moussa
 *     (B-1) holds BOTH the Anti-Infective Upper Egypt 1 ACTING_DM seat and the AIF UE1 rep seat
 *     under it. Every person-shaped figure counts distinct PEOPLE, a person's visits are taken ONCE
 *     rather than summed per seat, and the district manager sitting in his own team's rep seat is
 *     NAMED rather than silently folded away.
 *
 * Also pinned, because each is a silent wrong answer rather than a visible break:
 *   - test customers are filtered at the read (`is_test = false`), or the board reports validated
 *     lists that do not exist — all 13 'active' customers on production that day were test rows;
 *   - the "Others" pseudo-DM buckets are dropped (sales-only, no reps, not teams);
 *   - a failed read reads as UNREADABLE, never as zeros — zeros say "nobody has a list";
 *   - the visits come through the CRM read door, never a raw `ireports360_visits` query;
 *   - the owner's two locked looks: square edges, and fits-the-screen (`w-full table-fixed`, a
 *     `<colgroup>` totalling 100%, no sideways scroll at any width, a card half on a phone, and
 *     nothing truncated with an ellipsis).
 */

const ROOT = new URL("../", import.meta.url);

function source(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8"));
}

/** 2026-10-05 — two days after the measurement, so the 1–4 October hires are all in the past. */
const TODAY = "2026-10-05";

function seat(patch: Partial<TeamReadinessRepSeat> = {}): TeamReadinessRepSeat {
  return {
    seatId: "SEAT-REP-1",
    occupantHrId: "PD-0101",
    occupantName: "Rana Hassan",
    customers: 0,
    validated: 0,
    hireDate: "2024-03-01",
    visits: 0,
    ...patch,
  };
}

function team(patch: Partial<TeamReadinessFacts> = {}): TeamReadinessFacts {
  return {
    teamSeatId: "SEAT-PED-DM-UE-1",
    team: "Mahmoud Fathy · Pedia · Upper Egypt 1",
    lineName: "Pedia",
    managerHrId: "PD-0014",
    managerName: "Mahmoud Fathy",
    startedOn: null,
    startsLater: false,
    repSeats: [],
    ...patch,
  };
}

/** The Pedia Upper Egypt 1 shape, exactly as production held it on 2026-10-03. */
function pediaUpperEgypt1(): TeamReadinessFacts {
  return team({
    repSeats: [
      // The one rep who has been there a while — and the only one with a list.
      seat({ seatId: "SEAT-PED-REP-UE1", occupantHrId: "PD-0101", occupantName: "Rana Hassan", customers: 113, visits: 176, hireDate: "2024-03-01" }),
      // Five reps hired between 1 and 4 October, carrying nobody.
      seat({ seatId: "SEAT-PED-REP-UE2", occupantHrId: "PD-0201", occupantName: "Yasser Sobhy", hireDate: "2026-10-01" }),
      seat({ seatId: "SEAT-PED-REP-UE3", occupantHrId: "PD-0202", occupantName: "Mona Kamal", hireDate: "2026-10-01" }),
      seat({ seatId: "SEAT-PED-REP-UE4", occupantHrId: "PD-0203", occupantName: "Amr Nabil", hireDate: "2026-10-03" }),
      seat({ seatId: "SEAT-PED-REP-UE5", occupantHrId: "PD-0204", occupantName: "Hoda Fouad", hireDate: "2026-10-04" }),
      seat({ seatId: "SEAT-PED-REP-UE6", occupantHrId: "PD-0205", occupantName: "Karim Adel", hireDate: "2026-10-04" }),
    ],
  });
}

// ── 1. The headline is REPS WITH A LIST, never seats filled ──────────────────────────────────────
function runHeadlineIsRepsWithAListTests(): void {
  const row = judgeTeamReadiness(pediaUpperEgypt1(), { cairoToday: TODAY });

  assert.equal(row.repSeats, 6, "six rep seats hang from the team");
  assert.equal(row.seatsFilled, 6, "and production had all six of them FILLED — the misleading figure");
  assert.equal(row.vacantSeats, 0);

  assert.equal(row.repsWithList, 1, "🔴 but only ONE of those reps carries a customer");
  assert.equal(
    row.repsWithListLine,
    "1 of 6 reps have a list",
    "🔴 THE HEADLINE IS REPS WITH A LIST. A board printing '6 of 6 filled' calls the least ready team on the line ready.",
  );
  assert.notEqual(row.repsWithListLine, `${row.seatsFilled} of 6 reps have a list`, "seats filled must never become the headline");
  assert.equal(row.verdict, "not_ready", "one list out of six is not ready, whatever the seats say");

  // The new hires explain the five empty lists — by name, so nothing reads as a bug.
  assert.equal(row.newHires, 5, "five of the six were hired inside the window");
  assert.deepEqual(
    row.newHireNames,
    ["Amr Nabil", "Hoda Fouad", "Karim Adel", "Mona Kamal", "Yasser Sobhy"],
    "the new hires are NAMED (alphabetically), never counted anonymously — names, never hr ids",
  );
  assert.ok(
    row.blockers.includes("5 reps have no list yet") && row.blockers.includes("5 reps were hired in the last 30 days"),
    `the two facts sit together so an empty list explains itself, got ${JSON.stringify(row.blockers)}`,
  );
  assert.equal(row.customersCarried, 113);
  assert.equal(row.customersValidated, 0, "production held nothing validated — 0 of 8,344 real customers");

  // A rep hired the day BEFORE the window opens is not a new hire, and an unknown hire date is
  // never read as a recent one — "we do not know" must not become "he just started".
  const edge = judgeTeamReadiness(
    team({
      repSeats: [
        seat({ seatId: "A", occupantHrId: "X-1", occupantName: "On the boundary", hireDate: readinessWindowFrom(TODAY) }),
        seat({ seatId: "B", occupantHrId: "X-2", occupantName: "A day too early", hireDate: "2026-09-04" }),
        seat({ seatId: "C", occupantHrId: "X-3", occupantName: "No hire date", hireDate: null }),
      ],
    }),
    { cairoToday: TODAY },
  );
  assert.equal(readinessWindowFrom(TODAY), "2026-09-05", "the window is the last 30 days, inclusive of its first day");
  assert.deepEqual(edge.newHireNames, ["On the boundary"], "the window's first day counts; the day before it does not, and a null date never does");

  // A full team, and an empty one.
  const whole = judgeTeamReadiness(
    team({ repSeats: [seat({ seatId: "A", occupantHrId: "X-1", customers: 300, validated: 12 }), seat({ seatId: "B", occupantHrId: "X-2", customers: 280 })] }),
    { cairoToday: TODAY },
  );
  assert.equal(whole.verdict, "ready", "every rep has a list — that is ready");
  assert.equal(whole.repsWithListLine, "2 of 2 reps have a list");
  assert.deepEqual(whole.blockers, [], "nothing is in the way, so nothing is listed");
  assert.equal(whole.customersValidated, 12);

  const seatless = judgeTeamReadiness(team({ repSeats: [] }), { cairoToday: TODAY });
  assert.equal(seatless.repsWithListLine, "No rep seat on this team", "a team with no rep seat says so rather than printing '0 of 0'");
  assert.equal(seatless.verdict, "not_ready");
  assert.equal(seatless.readyShare, 0, "and never divides by zero");

  // A vacant seat carrying a list is a different problem from a filled seat with none — and it is
  // the seat, not the person, that holds the customers, so both facts are kept.
  const vacant = judgeTeamReadiness(
    team({
      repSeats: [
        seat({ seatId: "A", occupantHrId: null, occupantName: null, customers: 120, hireDate: null }),
        seat({ seatId: "B", occupantHrId: "X-2", occupantName: "Working rep", customers: 90 }),
      ],
    }),
    { cairoToday: TODAY },
  );
  assert.equal(vacant.seatsWithList, 2, "both SEATS carry a list");
  assert.equal(vacant.repsWithList, 1, "but only one REP does — a vacant seat has nobody to be ready");
  assert.equal(vacant.repsWithListLine, "1 of 2 reps have a list");
  assert.equal(vacant.customersCarried, 210, "the vacant seat's customers are still the team's");
  assert.ok(vacant.blockers.includes("1 rep seat is vacant"), `the vacancy is named, got ${JSON.stringify(vacant.blockers)}`);

  assert.equal(PHOENIX_TEAM_READINESS_WINDOW_DAYS, 30, "the window the owner asked for");
  assert.equal(repsWithListLine(1, 1), "1 of 1 rep has a list", "the singular reads as English");
}

// ── 2. One person, two seats, counted ONCE ───────────────────────────────────────────────────────
function runOnePersonTwoSeatsTests(): void {
  // 🔴 The production case: B-1 holds the ACTING_DM seat AND the AIF UE1 rep seat under it.
  const acting = judgeTeamReadiness(
    team({
      teamSeatId: "SEAT-AIF-ADM-UE-1",
      team: "Nosiba Salah Hassanin Moussa · Anti Infective · Upper Egypt 1",
      lineName: "Anti Infective",
      managerHrId: "B-1",
      managerName: "Nosiba Salah Hassanin Moussa",
      repSeats: [
        seat({ seatId: "SEAT-AIF-REP-UE1", occupantHrId: "B-1", occupantName: "Nosiba Salah Hassanin Moussa", customers: 90, visits: 120 }),
        seat({ seatId: "SEAT-AIF-REP-UE2", occupantHrId: "AI-0026", occupantName: "Hesham Saad", customers: 96, visits: 95 }),
        seat({ seatId: "SEAT-AIF-REP-UE9", occupantHrId: "AI-0012", occupantName: "Mostafa Lotfy", customers: 96, visits: 96 }),
      ],
    }),
    { cairoToday: TODAY },
  );
  assert.equal(
    acting.managerAlsoRepName,
    "Nosiba Salah Hassanin Moussa",
    "🔴 the district manager sitting in one of his own team's rep seats is NAMED, not silently folded away — that is the shape that inflates a count",
  );
  assert.equal(acting.people, 3, "three seats, three people");
  assert.equal(acting.visits, 311, "and each person's visits counted once: 120 + 95 + 96");

  // One PERSON on TWO rep seats — the same inflation, inside the team.
  const doubled = judgeTeamReadiness(
    team({
      managerHrId: "PD-0014",
      managerName: "Mahmoud Fathy",
      repSeats: [
        seat({ seatId: "A", occupantHrId: "B-1", occupantName: "Nosiba Salah Hassanin Moussa", customers: 40, validated: 1, visits: 120 }),
        // The same person, as the organogram's other row spells him — a casing drift must not make two people.
        seat({ seatId: "B", occupantHrId: "b-1", occupantName: "Nosiba Salah Hassanin Moussa", customers: 20, visits: 120 }),
        seat({ seatId: "C", occupantHrId: "AI-2", occupantName: "Soha Ramadan", customers: 0, visits: 10 }),
      ],
    }),
    { cairoToday: TODAY },
  );
  assert.equal(doubled.repSeats, 3, "three rep seats — a seat is a seat");
  assert.equal(doubled.seatsFilled, 3);
  assert.equal(doubled.people, 2, "🔴 but TWO people, whatever the casing of the hr id");
  assert.equal(doubled.seatsWithList, 2, "two SEATS carry a list");
  assert.equal(
    doubled.repsWithList,
    1,
    "🔴 and ONE PERSON has one — the headline counts people, so a two-seat rep cannot make a team look readier than it is",
  );
  assert.equal(doubled.repsWithListLine, "1 of 3 reps have a list");
  assert.equal(doubled.customersCarried, 60, "each seat's own list is real, so the customers DO add up: 40 + 20");
  assert.equal(doubled.customersValidated, 1);
  assert.equal(
    doubled.visits,
    130,
    "🔴 the visits are the PERSON's, so his are taken once: 120 + 10, never 120 + 120 + 10 = 250",
  );
  assert.notEqual(doubled.visits, 250, "summing a two-seat rep's visits per seat is the inflation this pins");

  // A one-seat rep hired inside the window is one new hire, not two.
  const newHireTwice = judgeTeamReadiness(
    team({
      repSeats: [
        seat({ seatId: "A", occupantHrId: "N-9", occupantName: "Twice seated", hireDate: "2026-10-02" }),
        seat({ seatId: "B", occupantHrId: "N-9", occupantName: "Twice seated", hireDate: "2026-10-02" }),
      ],
    }),
    { cairoToday: TODAY },
  );
  assert.equal(newHireTwice.newHires, 1, "one person is one new hire, however many seats he sits on");
  assert.deepEqual(newHireTwice.newHireNames, ["Twice seated"], "and he is named once");

  // A district manager who sits on NO rep seat raises no note at all.
  const plainDm = judgeTeamReadiness(
    team({ managerHrId: "PD-0014", managerName: "Mahmoud Fathy", repSeats: [seat({ seatId: "A", occupantHrId: "X-1", customers: 10 })] }),
    { cairoToday: TODAY },
  );
  assert.equal(plainDm.managerAlsoRepName, null, "the usual shape says nothing — the note is for the exception only");
}

// ── 3. The order, the pseudo-DM buckets, and the start state ─────────────────────────────────────
function runOrderAndExclusionTests(): void {
  const rows = buildPhoenixTeamReadinessRows({
    cairoToday: TODAY,
    teams: [
      team({
        teamSeatId: "SEAT-STARTED",
        team: "Nermeen Salah · Pedia · Delta (1)",
        startedOn: "2026-10-03",
        repSeats: [seat({ seatId: "S1", occupantHrId: "A-1", customers: 803 }), seat({ seatId: "S2", occupantHrId: "A-2", customers: 200 })],
      }),
      team({
        teamSeatId: "SEAT-HALF",
        team: "Half ready · CNS · Giza",
        repSeats: [seat({ seatId: "H1", occupantHrId: "B-2", customers: 370 }), seat({ seatId: "H2", occupantHrId: "B-3", customers: 0 })],
      }),
      team({
        teamSeatId: "SEAT-READY",
        team: "All ready · CNS · Upper Egypt",
        repSeats: [seat({ seatId: "R1", occupantHrId: "C-1", customers: 400 }), seat({ seatId: "R2", occupantHrId: "C-2", customers: 363 })],
      }),
      // The per-line sales-only bucket. It has no reps and is not a team.
      team({ teamSeatId: "SEAT-AIF-OTHERS", team: "Others · Anti Infective", isOtherPseudoDm: true, repSeats: [] }),
    ],
  });

  assert.deepEqual(
    rows.map((row) => row.teamSeatId),
    ["SEAT-READY", "SEAT-HALF", "SEAT-STARTED"],
    "unstarted first and the readiest at the top — he is choosing the next team to press Start on; a started team stays on the board as the comparison",
  );
  assert.ok(
    !rows.some((row) => row.teamSeatId === "SEAT-AIF-OTHERS"),
    "🔴 the 'Others' pseudo-DM bucket is sales-only, holds no reps and is NOT a team",
  );

  const started = rows.find((row) => row.teamSeatId === "SEAT-STARTED");
  assert.ok(started);
  assert.equal(started.started, true);
  assert.equal(started.startedLine, "Counted from Saturday 03 Oct 2026", "a running start says since when, in Cairo words and never a raw date");
  assert.equal(started.verdict, "counted", "a team already counted is not judged as a candidate");

  const later = judgeTeamReadiness(team({ startedOn: "2026-10-10", startsLater: true, repSeats: [seat({ seatId: "A", occupantHrId: "Z-1", customers: 5 })] }), {
    cairoToday: TODAY,
  });
  assert.equal(later.startedLine, "From Saturday 10 Oct 2026", "a start still to come reads as a future one, never as already counted");
  assert.equal(later.started, true, "but it is his decision already, so it is not a team still waiting to be chosen");
  assert.equal(later.verdict, "counted");

  const notStarted = rows.find((row) => row.teamSeatId === "SEAT-READY");
  assert.ok(notStarted);
  assert.equal(notStarted.startedLine, "Not started");
  assert.equal(notStarted.started, false);

  const unreadable = unreadableTeamReadiness(TODAY);
  assert.equal(unreadable.readable, false, "a failed read is UNREADABLE, never zeros — zeros read as 'nobody has a list'");
  assert.deepEqual(unreadable.rows, []);
  assert.equal(unreadable.windowDays, PHOENIX_TEAM_READINESS_WINDOW_DAYS);
}

// ── 4. The reads: test rows out, the door for the visits, and never a thrown page ────────────────
function runReadsTests(): void {
  const server = source("src/lib/crm/phoenix-team-readiness-server.ts");

  assert.match(
    server,
    /\.from\("phoenix_crm_customers"\)[\s\S]{0,200}\.eq\("is_test", false\)/,
    "🔴 the customers read filters test rows AT THE READ — every one of the 13 'active' customers on production was a test row, so without it the board reports validated lists that do not exist",
  );
  assert.match(server, /row\.status === "active"/, "validated is `status = 'active'` — the module's own word for a customer admitted to the list");
  assert.match(
    server,
    /fetchAllRowsKeyset/,
    "the customers read is paged: the table is past PostgREST's 1,000-row ceiling and a short read would UNDERSTATE readiness, hiding a team that is ready",
  );
  assert.match(server, /hire_date/, "the new hires come from employees.hire_date");

  // The visits come through the CRM read door. src/lib/crm has ONE door for the mirror
  // (tests/crm-single-source.test.ts) and this is an ordinary consumer read, not machinery.
  assert.match(server, /\bqueryVisits\b/, "the visits are read through the door");
  assert.doesNotMatch(
    server,
    /\.from\(\s*["'`]ireports360_/,
    "🔴 never a raw ireports360_* query — src/lib/crm has one door for the mirror and this is a consumer read",
  );

  // A failed readiness read must not take the Start button down with it.
  const starts = source("src/lib/crm/phoenix-team-starts-server.ts");
  assert.match(
    starts,
    /loadPhoenixTeamReadiness\([\s\S]{0,200}\.catch\(/,
    "a failed readiness read is caught in the loader — the Start button above it must keep working",
  );
  assert.match(starts, /unreadableTeamReadiness\(cairoToday\)/, "and the board reports itself unreadable rather than printing zeros");
  assert.ok(
    starts.indexOf("buildPhoenixTeamRows({") < starts.indexOf("loadPhoenixTeamReadiness({"),
    "readiness is built from the panel's OWN rows, so the two can never disagree about which teams exist or what each is called",
  );

  // The organogram read must carry the pseudo-DM flag, or the exclusion above is unenforceable.
  const org = source("src/lib/phoenix-crm/server/org.ts");
  assert.match(org, /is_other_pseudo_dm/, "the organogram read selects the pseudo-DM flag");
  assert.match(
    org,
    /"phoenix-crm-org-seats-v4"/,
    "and the cache key moved with the shape — a cached copy WITHOUT the new column must never be served to a reader that needs it",
  );
}

// ── 5. The two locked looks, and the page it sits on ─────────────────────────────────────────────
function runPanelLookTests(): void {
  const panel = source("src/components/crm/crm-phoenix-team-readiness-panel.tsx");

  // THE FITS-THE-SCREEN GOLDEN RULE — table-fixed with a colgroup, and the widths must fit the box.
  assert.match(panel, /<table className="w-full table-fixed">/, "the table is `w-full table-fixed`, never a min-width inside a scroller");
  const widths = [...panel.matchAll(/<col style=\{\{ width: "(\d+)%" \}\} \/>/g)].map((match) => Number(match[1]));
  assert.ok(widths.length >= 4, `the <colgroup> must declare a width per column, found ${widths.length}`);
  assert.equal(
    widths.reduce((sum, width) => sum + width, 0),
    100,
    `the declared widths must total 100% — over it, table-fixed pushes the table wider than its box and .admin-shell CLIPS rather than scrolls (found ${widths.join("+")})`,
  );
  const headers = (panel.match(/<th className=\{?`?\$?\{?THEAD/g) ?? []).length;
  assert.equal(headers, widths.length, `one declared width per header cell — ${headers} headers against ${widths.length} widths`);

  // Desktop table, phone cards — the owner's standing rule, and what the CRM directory sweep pins.
  const tableAt = panel.indexOf("<table");
  assert.ok(tableAt > -1);
  assert.match(
    panel.slice(Math.max(0, tableAt - 640), tableAt),
    /\bmd:block\b/,
    "the table is desktop-only; below md a phone gets the cards instead",
  );
  assert.match(panel, /\bmd:hidden\b/, "and the card half exists — a hidden table with nothing in its place is a blank screen");

  for (const spelling of ["overflow-x-auto", "overflow-x-scroll", "overflow-auto", "overflow-scroll", "min-w-["]) {
    assert.ok(!panel.includes(spelling), `the panel must never carry \`${spelling}\` — a sideways scroll IS the bug the rule names`);
  }

  // THE SQUARE-EDGE GOLDEN RULE, and the no-ellipsis rule. Wrapping wins, always.
  assert.ok(!/\brounded/.test(panel), "no round or semi-round corners, anywhere");
  for (const spelling of ["truncate", "text-ellipsis", "line-clamp", "…"]) {
    assert.ok(!panel.includes(spelling), `nothing is truncated with \`${spelling}\` — where it collides with fitting the screen, wrapping wins`);
  }
  assert.ok(!/className="[^"]*\bwhitespace-nowrap\b/.test(panel), "a name in a card must be free to wrap, or one long name pushes a 375px page sideways");
  assert.match(panel, /break-words/, "and every cell breaks a long word rather than being cut mid-name");

  // NAMES, NEVER CODES OR IDS. The seat id is the key and the payload; it is never printed.
  assert.match(panel, /key=\{row\.teamSeatId\}/, "the seat id is the React key, which is where an id belongs");
  assert.ok(
    !/row\.teamSeatId/.test(panel.replaceAll("key={row.teamSeatId}", "")),
    "and it is used NOWHERE else — a seat id must never reach the screen; names only, in chat and in UI",
  );
  assert.ok(!/\bhrId\b/.test(panel), "no hr id reaches the screen");

  // The verdict is in WORDS as well as colour.
  for (const words of ["Ready to start", "Nearly ready", "Not ready yet", "Counted from Phoenix CRM"]) {
    assert.ok(panel.includes(words), `the verdict says "${words}" in words — colour is a shorthand, never the only carrier`);
  }
  assert.match(panel, /could not be read/, "an unreadable board says so rather than showing zeros");

  // ── The page: beside the Start button, and Super Admin only ─────────────────────────────────────
  const page = source("app/(admin)/admin/crm/page.tsx");
  const gate = page.indexOf("canUseAdminCrmWorkspace(access)");
  const loader = page.indexOf("loadPhoenixTeamStartsPanel()");
  const startsPanel = page.indexOf("<CrmPhoenixTeamStartsPanel");
  const readinessPanel = page.indexOf("<CrmPhoenixTeamReadinessPanel");
  assert.ok(gate > 0 && gate < loader, "the CRM hub is the Super Admin's: everyone else is redirected before anything is read");
  assert.ok(readinessPanel > startsPanel, "readiness sits BESIDE the Start button — same page, right under the panel he starts a team from");
  assert.match(
    page,
    /<CrmPhoenixTeamReadinessPanel data=\{phoenixTeamStarts\?\.readiness \?\? null\} \/>/,
    "it is fed by the same loader as the panel above it, never by a second read or a page of its own",
  );
  assert.ok(
    !page.includes("/api/crm/phoenix-team-readiness"),
    "it needs no route of its own: it renders on the server inside a page already gated to the Super Admin",
  );
}

export function runPhoenixCrmTeamReadinessTests(): void {
  runHeadlineIsRepsWithAListTests();
  runOnePersonTwoSeatsTests();
  runOrderAndExclusionTests();
  runReadsTests();
  runPanelLookTests();
}
