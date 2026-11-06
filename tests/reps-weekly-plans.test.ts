import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import {
  FIELD_WEEK_LENGTH,
  FIELD_WEEK_START_DOW,
  formatPlanDay,
  formatPlanWeekLabel,
  listPlanWeeks,
  resolvePlanWeek,
  weekContains,
  weekEndFor,
  weekStartFor,
} from "../src/lib/crm/plan-week.ts";
import { buildPlanDoctorDays } from "../src/lib/crm/plan-doctors.ts";
import type { PlanEntryRow } from "../src/lib/crm/plan-board.ts";
import {
  PLAN_STATUS_AREA_MANAGER_VERIFIED,
  PLAN_STATUS_NEW,
  PLAN_STATUS_SUPERVISOR_VERIFIED,
} from "../src/lib/crm/plan-verification.ts";
import {
  countRepPlanStatuses,
  PLAN_STATUS_FILTERS,
  repMatchesPlanStatusFilter,
  resolvePlanStatusFilter,
} from "../src/lib/crm/plan-status-filter.ts";
import { foldRepPlanStatus } from "../src/lib/crm/reps-weekly-plans-board.ts";

/**
 * Reps Weekly Plans — tab two of the Reps List board, specified by the owner on 2026-09-01: "another
 * tab called Reps Weekly Plans... I can filter by medical rep name, and then I can choose the week,
 * either historical or in the future. If historical, I see the status of this plan — was it verified
 * or no. And if it will be not yet, I have a verify button that every district manager can verify
 * his medical reps plan."
 *
 * FOUR THINGS ARE PINNED HERE, and each of them fails silently rather than loudly.
 *
 * 1. THE FIELD WEEK RUNS SATURDAY TO FRIDAY. Every calendar helper in JavaScript assumes Sunday, and
 *    an off-by-one here does not throw — it moves a whole week's plans one day, so a manager opening
 *    "this week" is shown six of his rep's days plus one of last week's, and the Saturday he is
 *    actually being asked to verify is on the previous page. Nothing on screen would say so.
 *
 * 2. NOT FILED IS NOT PENDING. A rep who filed nothing and a rep waiting on his manager's signature
 *    are different facts, and only the second is the manager's move. Folding them together turns "he
 *    did not plan his week" into "you have not signed it" — it points the blame at the wrong person,
 *    and it is one `?? 0` away at all times.
 *
 * 3. THE FITS-THE-SCREEN GOLDEN RULE. Every other table that renders these same plan rows goes
 *    through `PortalDesktopTable` over a min-width floor of 720–1240px, which is exactly the
 *    horizontal scroll the owner's golden rule forbids. Reusing one of them would look like a
 *    tidy-up and would reintroduce the scroll on the board he asked to be phone-friendly.
 *
 * 4. THE SERVER/CLIENT BOUNDARY OF THE STATUS FORMATTERS. `planStatusClass` and `planStatusLabel`
 *    are called from a SERVER component here. Defined inside — or imported through — a "use client"
 *    module they reach the server as client references rather than functions, and every plan fails
 *    to render. That already happened once, one file over, to `planPeriodText`.
 *
 * ## Why this board exists at all, which is the finding worth keeping
 *
 * `/admin/plan-verification` verifies plans and has since it shipped. But it lives in the ADMIN
 * shell, and `portalShellRoles` puts District Manager and Regional Manager — the only two seats
 * holding `crm_plans:approve` — in the EMPLOYEE PORTAL. `app/(admin)/layout.tsx` redirects every
 * portal-mode viewer out of `/admin/**`, `portal-twins.ts` registers no twin for it, and the portal
 * builds its own sidebar so the row never appeared either. The two roles the feature was written for
 * could not reach the only screen that used their permission, leaving Super Admin the sole account
 * able to press Verify. Nothing errored, nothing 403'd, and CI was green throughout — which is why
 * the portal half of this tab is asserted below by name.
 */
export async function runRepsWeeklyPlansTests() {
  // ---------------------------------------------------------------------------------------------
  // 1. The field week is Saturday to Friday
  // ---------------------------------------------------------------------------------------------
  {
    assert.equal(FIELD_WEEK_START_DOW, 6, "the field week starts on Saturday (getUTCDay() === 6)");
    assert.equal(FIELD_WEEK_LENGTH, 7, "a week is seven days");

    // 2026-08-29 is a Saturday and 2026-09-04 the Friday that closes its week. Both verified against
    // the runtime rather than assumed, so a wrong literal here cannot quietly define the week.
    assert.equal(new Date("2026-08-29T00:00:00Z").getUTCDay(), 6, "2026-08-29 must really be a Saturday");
    assert.equal(new Date("2026-09-04T00:00:00Z").getUTCDay(), 5, "2026-09-04 must really be a Friday");

    assert.equal(weekStartFor("2026-08-29"), "2026-08-29", "a Saturday is its own week start");
    assert.equal(weekStartFor("2026-09-04"), "2026-08-29", "the Friday closing the week belongs to it");
    assert.equal(weekEndFor("2026-08-29"), "2026-09-04", "the week ends on the Friday six days later");

    // Every one of the seven days must land on the SAME Saturday. This is the assertion a
    // Sunday-based helper fails: it would split this week across two.
    const days = ["2026-08-29", "2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"];
    for (const day of days) {
      assert.equal(
        weekStartFor(day),
        "2026-08-29",
        `${day} is inside the Saturday-to-Friday week starting 2026-08-29 — a Sunday-start convention would move it`,
      );
      assert.ok(weekContains("2026-08-29", day), `${day} must be reported inside its own week`);
    }

    // The day either side is NOT in it, which is what an off-by-one breaks.
    assert.equal(weekStartFor("2026-08-28"), "2026-08-22", "the Friday BEFORE belongs to the previous week");
    assert.equal(weekStartFor("2026-09-05"), "2026-09-05", "the next Saturday opens the next week");
    assert.ok(!weekContains("2026-08-29", "2026-08-28"), "the previous Friday is not in this week");
    assert.ok(!weekContains("2026-08-29", "2026-09-05"), "the next Saturday is not in this week");
    assert.ok(!weekContains("2026-08-29", null), "no date at all is in no week");
  }

  // ---------------------------------------------------------------------------------------------
  // 2. The picker offers future weeks FIRST
  // ---------------------------------------------------------------------------------------------
  {
    const weeks = listPlanWeeks({ back: 5, forward: 2, todayIso: "2026-09-01" });
    assert.equal(weeks.length, 8, "back + forward + the current week");
    assert.equal(weeks[0]?.offset, 2, "the furthest FUTURE week is first — a plan is verified before the week it covers, so next week is what this tab is opened to act on");
    assert.equal(weeks.at(-1)?.offset, -5, "the oldest week is last");

    for (let index = 1; index < weeks.length; index += 1) {
      assert.equal(
        weeks[index]!.offset,
        weeks[index - 1]!.offset - 1,
        "offsets must descend one week at a time, with no gap and no repeat",
      );
    }

    const current = weeks.filter((week) => week.offset === 0);
    assert.equal(current.length, 1, "exactly one week is 'this week'");
    assert.equal(current[0]?.key, "2026-08-29", "and it is the Saturday of the week holding 2026-09-01");
    assert.equal(current[0]?.end, "2026-09-04", "its end is the Friday");

    // Every option is a real Saturday. A key that is not one would make `?week=` resolve to a
    // different week than the one the option named.
    for (const week of weeks) {
      assert.equal(new Date(`${week.key}T00:00:00Z`).getUTCDay(), 6, `${week.key} must be a Saturday`);
      assert.equal(week.key, weekStartFor(week.key), "an offered key must be its own week start");
    }
  }

  // ---------------------------------------------------------------------------------------------
  // 3. A hand-typed week never throws and never lands mid-week
  // ---------------------------------------------------------------------------------------------
  {
    assert.equal(resolvePlanWeek("2026-08-29", "2026-09-01"), "2026-08-29", "a valid Saturday is taken as given");
    assert.equal(
      resolvePlanWeek("2026-09-02", "2026-09-01"),
      "2026-08-29",
      "a mid-week date is NORMALISED to its Saturday rather than used as a week start — otherwise the board would read a seven-day window straddling two field weeks and show a rep's Wednesday-to-Tuesday",
    );
    for (const junk of ["", "next week", "2026-13-45", "../../etc/passwd", null, undefined]) {
      assert.equal(
        resolvePlanWeek(junk, "2026-09-01"),
        "2026-08-29",
        "junk falls back to the current week — the falls-back-never-throws posture every other filter on these boards has",
      );
    }
  }

  // ---------------------------------------------------------------------------------------------
  // 4. NOT FILED is not PENDING
  // ---------------------------------------------------------------------------------------------
  {
    assert.equal(
      foldRepPlanStatus([]),
      null,
      "a rep who filed NOTHING is null, never 0 — 0 is New, which reads as 'filed and awaiting you' and blames the manager for a week the rep never planned",
    );
    assert.equal(foldRepPlanStatus([{ status: 0 }]), 0, "one pending plan is pending");
    assert.equal(foldRepPlanStatus([{ status: 1 }]), 1, "one supervisor-verified plan is verified");
    assert.equal(
      foldRepPlanStatus([{ status: 1 }, { status: 0 }]),
      0,
      "the LOWEST wins: a rep with one signed plan and one pending plan still needs his manager",
    );
    assert.equal(
      foldRepPlanStatus([{ status: 2 }, { status: 1 }]),
      1,
      "two signed plans fold to the lower signature, never to the higher",
    );
    assert.equal(
      foldRepPlanStatus([{ status: null }]),
      0,
      "a plan with no status recorded counts as New — that is what the vendor sends on a fresh plan, and reading it as verified would sign something nobody signed",
    );
    assert.equal(
      foldRepPlanStatus([{ status: null }, { status: 2 }]),
      0,
      "and it still wins over a signed one",
    );
  }

  // ---------------------------------------------------------------------------------------------
  // 5. The labels are words, never raw codes
  // ---------------------------------------------------------------------------------------------
  {
    const label = formatPlanWeekLabel("2026-08-29");
    assert.ok(!label.includes(","), `the week label must carry no comma: got "${label}" — en-GB inserts one after the weekday and the picker has no room for it`);
    assert.ok(!label.includes("Sept"), `en-GB abbreviates September to four letters, which makes the picker ragged: got "${label}"`);
    assert.ok(label.includes("Sat") && label.includes("Fri"), `the label must name both ends of the week: got "${label}"`);
    assert.ok(label.includes("2026"), `the label must carry the year: got "${label}"`);
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(label), `no raw ISO date may reach a label — owner's standing rule that a screen never shows a raw code: got "${label}"`);

    const day = formatPlanDay("2026-08-30");
    assert.equal(day, "Sun 30 Aug", `one planned day reads as a person says it: got "${day}"`);
    assert.ok(!/\d{4}/.test(day), "a day inside a week the heading already dated needs no year");
  }

  // ---------------------------------------------------------------------------------------------
  // 6. THE FITS-THE-SCREEN GOLDEN RULE
  // ---------------------------------------------------------------------------------------------
  {
    const board = readFileSync("src/components/crm/reps-weekly-plans-board.tsx", "utf8");
    const tables = readFileSync("src/components/crm/reps-list-tables.tsx", "utf8");

    // THE DOCTORS TABLE MOVED on 2026-09-01, into the contact list's own file — the owner asked for
    // it to be "exactly as the contact list", and the only way two tables stay exactly alike is for
    // there to be one of them. So the golden rule is asserted where the table now LIVES, and the
    // board is still checked for the pattern it must never grow back.
    assert.ok(
      board.includes("<PlanDoctorsTable days={board.days} />"),
      "the board must render the CONTACT LIST's own table for the plan's doctors — a second table written beside it could match on the day it was written and silently stop matching on the next change to a cell",
    );

    const start = tables.indexOf("function PlanDayTable(");
    const end = tables.indexOf("export function PlanDoctorsTable(");
    assert.ok(start > 0 && end > start, "PlanDayTable and PlanDoctorsTable must both exist, in that order");
    // Sliced between two NAMED anchors rather than at byte offsets: a fixed window false-fails the
    // moment anything above it shifts, which is a trap this repo has already paid for once.
    const plans = tables.slice(start, end);

    // The NAME is allowed to appear elsewhere — a comment explaining why it is not used is the thing
    // stopping the next session from "tidying up" by reaching for it. Importing or rendering it is
    // what is forbidden.
    assert.ok(
      !plans.includes("<PortalDesktopTable") && !/import \{[^}]*PortalDesktopTable/.test(tables),
      "the doctors table must NOT use PortalDesktopTable: all three tables in plan-verification-tables.tsx do, over min-width floors of 720-1240px, and a min-width floor IS the horizontal scroll the owner's golden rule forbids",
    );
    for (const [what, source] of [
      ["the plans table", plans],
      ["the board around it", board],
    ] as const) {
      assert.ok(
        !source.includes("minWidth=") && !source.includes("min-w-["),
        `no min-width floor anywhere on ${what} — that is the bug, not the fix`,
      );
      assert.ok(
        !source.includes("overflow-x-auto"),
        `no horizontal scroll container on ${what}: \`overflow-x-auto\` over a min-width is exactly the pattern the golden rule names`,
      );
      assert.ok(
        !source.includes("truncate") && !source.includes("text-ellipsis") && !source.includes("…"),
        `nothing on ${what} may be truncated with an ellipsis — a standing owner rule, and the reason wrapping is the permitted way to fit`,
      );
    }

    assert.ok(
      plans.includes('<table className="w-full table-fixed border-collapse text-left text-sm">'),
      "the table must be w-full table-fixed, so the columns share whatever width the viewport has",
    );
    assert.ok(plans.includes("<colgroup>"), "table-fixed without a colgroup lets the browser guess the widths");

    // The widths must actually add up. A colgroup summing to more than 100% reintroduces the
    // overflow the golden rule forbids, and one summing to less leaves a gap on the right.
    const widths = [...plans.matchAll(/<col className="w-\[(\d+)%\]" \/>/g)].map((match) => Number(match[1]));
    assert.equal(widths.length, 6, `the doctors table declares six column widths: found ${widths.length}`);
    assert.equal(
      widths.reduce((total, width) => total + width, 0),
      100,
      `the column widths must sum to exactly 100%: got ${widths.join(" + ")}`,
    );

    assert.ok(
      plans.includes('className="hidden md:block"'),
      "the table is desktop-only — the owner's admin-shell rule: desktop gets tables, mobile never does",
    );
    assert.ok(
      plans.includes("renderCard={"),
      "and mobile gets CARDS. Without them a phone would show nothing at all where the table was, which reads as an empty plan",
    );
  }

  // ---------------------------------------------------------------------------------------------
  // 6b. THE TABLE IS THE CONTACT LIST'S OWN — same columns, same cells
  //
  // The owner, 2026-09-01: "you will show the address exactly as the contact list, exactly as the
  // contact list, as we are showing in the contact list. You will make the table exactly as in the
  // contact list." Copying six headings is the easy half and the half that decays. What makes it
  // real is that both tables render the SAME cell components over the SAME row type, so a change to
  // one reaches both — and that is what these assertions pin.
  // ---------------------------------------------------------------------------------------------
  {
    const tables = readFileSync("src/components/crm/reps-list-tables.tsx", "utf8");
    const plans = tables.slice(
      tables.indexOf("function PlanDayTable("),
      tables.indexOf("export function PlanDoctorsTable("),
    );
    const contacts = tables.slice(
      tables.indexOf("function GroupTable("),
      tables.indexOf("export function RepsListContacts("),
    );

    for (const heading of ["Contact", "Specialty", "List", "Brick", "Confidence", "Address"]) {
      assert.ok(
        plans.includes(`<th className={THEAD}>${heading}</th>`),
        `the plan's doctors carry the contact list's own "${heading}" column`,
      );
      assert.ok(
        contacts.includes(`<th className={THEAD}>${heading}</th>`),
        `and the contact list still has "${heading}" itself — otherwise the two have drifted and this test is pinning a shape that no longer exists`,
      );
    }

    // Phoenix CRM swaps the Confidence column for its own buttons and, on the owner's 2026-09-25
    // instruction, moves Address to sit right after the brick with Actions as the LAST column. The
    // plan table above always shows Confidence, so pinning the swap and the order here keeps the
    // teeth: dropping the Actions column, or letting Actions drift back ahead of Address, fails this.
    const actionsAt = contacts.indexOf('<th className={THEAD}>Actions</th>');
    assert.ok(actionsAt >= 0, "Phoenix CRM's list still renders an Actions header where Confidence would otherwise be");
    assert.ok(
      contacts.lastIndexOf('<th className={THEAD}>Address</th>') < actionsAt,
      "and in Phoenix CRM the Address column comes before Actions — the address sits right after the brick",
    );
    assert.equal(
      contacts.indexOf("<th className={THEAD}>", actionsAt + 1),
      -1,
      "and Actions is the last column header — nothing is rendered after it",
    );

    // The cells themselves, not lookalikes. AddressCell is the one that matters most: it holds the
    // per-segment <bdi> that stops a bilingual address rendering backwards, the Maps link and the
    // "seen <date>" stamp — three things a re-implementation gets subtly wrong.
    for (const cell of [
      "<AddressCell locality=",
      "<ConfidenceChip onOpen=",
      "<ContactCell onOpenInsights=",
      "LIST_LABEL[",
    ]) {
      assert.ok(plans.includes(cell), `the plan's table must render the contact list's own ${cell} cell`);
    }
    assert.ok(
      !plans.includes("polishAddress("),
      "and must NOT polish the address itself — that is AddressCell's job, and a second call site is a second place for the bidi handling to drift",
    );
  }

  // ---------------------------------------------------------------------------------------------
  // 6c. THE PLAN IS GROUPED DAY BY DAY
  //
  // The owner, 2026-09-01: "when you are showing the rep plan, differentiate day by day, group day
  // by day." Three things here fail quietly rather than loudly: an undated row sorting FIRST makes a
  // whole plan read as broken before the reader has seen a real day; a doctor who is not on the
  // rep's list vanishing hides 18.4% of August's plan rows; and losing the AM-before-PM order inside
  // a day makes the block unusable as a route.
  // ---------------------------------------------------------------------------------------------
  {
    const entry = (over: Partial<PlanEntryRow>): PlanEntryRow => ({
      address: null,
      ampm: null,
      contactCrmId: null,
      contactName: "Doctor",
      frequency: null,
      grade: null,
      onRepList: false,
      planDate: null,
      region: null,
      speciality: null,
      ...over,
    });

    const days = buildPlanDoctorDays(
      [
        entry({ ampm: "PM", contactCrmId: 2, contactName: "Zeinab", planDate: "2026-08-30" }),
        entry({ ampm: "AM", contactCrmId: 3, contactName: "Bassem", planDate: "2026-08-30" }),
        entry({ ampm: "AM", contactCrmId: 4, contactName: "Adel", planDate: "2026-08-30" }),
        entry({ ampm: "AM", contactCrmId: 5, contactName: "Undated" }),
        entry({ ampm: "AM", contactCrmId: 6, contactName: "Hanan", planDate: "2026-08-29" }),
      ],
      new Map([[3, { brick: { heading: "بشتيل", mapped: true }, contact: { name: "Bassem" } as never }]]),
    );

    assert.deepEqual(
      days.map((day) => day.date),
      ["2026-08-29", "2026-08-30", null],
      "days come out in calendar order and the UNDATED block sorts LAST — the mirror reads them nulls-first, which grouped by day would open every such plan with the heading 'No day recorded'",
    );
    assert.equal(days[0].label, "Sat 29 Aug", "the heading is how a person says the day, never a raw ISO date");
    assert.equal(days[2].label, "No day recorded", "and the undated block says so in words rather than showing a blank");
    assert.deepEqual(
      days[1].rows.map((row) => row.entry.contactName),
      ["Adel", "Bassem", "Zeinab"],
      "inside a day: AM before PM, then by name — the order a manager reads a route in",
    );
    assert.equal(days[1].rows.length, 3, "every planned call keeps its row");
    assert.ok(days[1].rows[1].contact !== null, "a doctor on the rep's list carries his contact row");
    assert.equal(
      days[1].rows[0].contact,
      null,
      "and one who is NOT on it keeps his row with contact:null — 1,796 of August's 9,769 doctor-plan pairs are off-list, and dropping them would hide a rep planning outside his own assignment, which is one of the more useful things a verifying manager can be shown",
    );
    assert.equal(days[1].rows[1].contact?.brick.heading, "بشتيل", "the brick comes from the contact list's own grouping");

    const keys = new Set(days.flatMap((day) => day.rows.map((row) => row.key)));
    assert.equal(keys.size, 5, "every row's React key is distinct — the same doctor can legitimately be planned twice");

    assert.deepEqual(buildPlanDoctorDays([], new Map()), [], "an empty plan is an empty array, never a fabricated day");
  }

  // ---------------------------------------------------------------------------------------------
  // 7. The status formatters are callable from the SERVER
  // ---------------------------------------------------------------------------------------------
  {
    const vocabulary = readFileSync("src/lib/crm/plan-verification.ts", "utf8");
    // The directive is a FILE-LEADING one, so that is what is checked. The string itself appears in
    // this module's prose, explaining the trap — which is exactly the comment worth keeping.
    assert.ok(
      !vocabulary.trimStart().startsWith('"use client"') && !vocabulary.trimStart().startsWith("'use client'"),
      "plan-verification.ts must carry NO directive: it is called from both sides, and a directive would hand the server a client reference instead of a function",
    );
    assert.ok(
      vocabulary.includes("export function planStatusClass("),
      "the status COLOUR lives beside the status LABEL, in the module with no directive — defined inside plan-verify-button.tsx it could not be called from a server component",
    );

    const board = readFileSync("src/components/crm/reps-weekly-plans-board.tsx", "utf8");
    assert.ok(
      !board.startsWith('"use client"'),
      "the board itself is a SERVER component — marking it client would ship the whole doctors table to the browser and move the access decision off the server",
    );
    assert.ok(
      /import \{[\s\S]{0,200}planStatusClass,[\s\S]{0,200}\} from "@\/lib\/crm\/plan-verification"/.test(board),
      "the server board must import planStatusClass from the no-directive module, never from plan-verify-button.tsx — that import is the exact shape of the planPeriodText failure one file over",
    );
    assert.ok(
      !/planStatusClass[\s\S]{0,80}from "@\/components\/crm\/plan-verify-button"/.test(board),
      "and specifically NOT through the client button",
    );
  }

  // ---------------------------------------------------------------------------------------------
  // 8. The plans tab has its OWN gate, on BOTH doors
  // ---------------------------------------------------------------------------------------------
  {
    const pages = [
      { path: "app/(admin)/admin/reps-list/page.tsx", what: "the admin door" },
      { path: "app/employee-portals/reps-list/page.tsx", what: "the PORTAL door — the only one a district manager has" },
    ];

    for (const page of pages) {
      const source = readFileSync(page.path, "utf8");

      assert.ok(
        source.includes("RepsWeeklyPlansBoardView"),
        `${page.what} must render the plans tab at all`,
      );
      assert.ok(
        source.includes("canAccessPlanVerification(access)") && source.includes('canAccess(access, "crm_plans", "read")'),
        `${page.what} must gate the plans tab on the PLAN role list and crm_plans:read — Reps List admits National Sales Manager and SFE Manager, and plan verification deliberately admits neither`,
      );
      assert.ok(
        source.includes('canAccess(access, "phoenix_crm", "approve")'),
        `${page.what} must read Phoenix CRM's approve separately from read: more seats may read a plan than may approve one, and the decide route asks that same grant`,
      );
      assert.ok(
        source.includes("getPlanVerificationScope(access)"),
        `${page.what} must build the plans tab from the PLAN scope`,
      );
      assert.ok(
        source.includes("getDoctorListScope(access)"),
        `${page.what} must still build the contact tab from the Reps List scope — one scope for both tabs would either widen who may sign a plan or narrow who may read a list`,
      );
      assert.ok(
        /const tab = resolveRepsListTab\(.*, canSeePlans\)/.test(source),
        `${page.what} must resolve the tab THROUGH the gate, so a hand-typed ?tab=plans from a seat without it lands on the contact list rather than on a refusal (the call-rate tab moved to the KPIs board on 2026-09-21, so the resolver no longer takes canSeeCallRate)`,
      );
    }

    // The portal page is the whole point of this build, so it is asserted by name rather than only
    // through the loop above: without it the two roles holding crm_plans:approve have no door.
    const portal = readFileSync("app/employee-portals/reps-list/page.tsx", "utf8");
    // The CALL, not the import. Asserting the name alone passed on a page that imported the board
    // and never invoked it — which is precisely the shape of the bug this whole tab exists to fix:
    // everything present, nothing reachable, no error anywhere.
    assert.ok(
      portal.includes("await getRepsWeeklyPlansBoard({"),
      "the PORTAL page must CALL the weekly-plans board. District Manager and Regional Manager are portal-shell roles and are redirected out of /admin/**, so this page is the only screen from which either can verify a plan",
    );
    assert.ok(
      portal.includes("<RepsWeeklyPlansBoardView"),
      "and must render it — a loaded board nothing renders is the same invisible feature by another route",
    );
  }

  // ---------------------------------------------------------------------------------------------
  // 9. The plans tab appears only for a viewer who may verify
  // ---------------------------------------------------------------------------------------------
  {
    const tabs = readFileSync("src/components/crm/reps-list-tabs.tsx", "utf8");
    assert.ok(
      tabs.includes('if (canSeePlans) tabs.push({ key: "plans", label: "Reps weekly plans" });'),
      "a viewer who may not verify plans is offered NO plans tab — a tab that answers 'not available to your role' when pressed is worse than no tab",
    );
    assert.ok(
      tabs.includes('if (value === "plans" && canSeePlans) return "plans";'),
      "and a hand-typed ?tab=plans resolves through the same gate",
    );
    assert.ok(
      tabs.includes('query.set("tab", "plans")') && tabs.includes('query.set("week", input.week)'),
      "switching to the plans tab must carry the week, or every switch silently resets it",
    );
    assert.ok(
      /if \(input\.selection\.rep\) query\.set\("rep", input\.selection\.rep\)/.test(tabs),
      "switching tabs KEEPS the rep: a manager who has just read a rep's contact list and presses Plans means THAT rep's plans",
    );

    const filters = readFileSync("src/components/crm/reps-list-filters.tsx", "utf8");
    assert.ok(
      filters.includes("preserve"),
      "the shared cascade must carry the tab and week through a pick, or choosing a line on the plans tab bounces the manager back to tab one on the current week",
    );
  }

  // ---------------------------------------------------------------------------------------------
  // 10. Plans are matched to reps on the NUMERIC agent id
  // ---------------------------------------------------------------------------------------------
  {
    const lib = readFileSync("src/lib/crm/reps-weekly-plans-board.ts", "utf8");
    assert.ok(
      lib.includes("plansByAgent.get(rep.agentCrmId)"),
      "reps and plans are joined on the numeric CRM agent id",
    );
    assert.ok(
      !/plansBy(HrId|Hr)|\.agentHrId\)/.test(lib),
      "NEVER on the hr id: hr ids are mixed case in this database, so a plain equality under-returns — and an under-returning join here would tell a district manager his rep filed nothing, which is an accusation and the worst direction for this error to fall in",
    );
    assert.ok(
      lib.includes("getPlanVerificationScope") || lib.includes("PlanVerificationScope") || lib.includes("CrmManagerScope"),
      "the module is built around the plan scope",
    );
    assert.ok(
      /if \(input\.scope\.kind === "none"\)/.test(lib),
      "a seat with no reports returns an explained empty board, never an unscoped one",
    );
  }

  // ---------------------------------------------------------------------------------------------
  // 11. THE BUTTON APPROVES A PHOENIX WEEK, AND AN OLD-CRM PLAN IS READ-ONLY
  //
  // iReports360 was retired on 6 November 2026, and the Verify and Unverify that wrote into it went
  // with it (owner: "phx crm replaced the old crm so any module was wired with old crm must wire with
  // phx crm"). A plan filed in Phoenix CRM is approved through Phoenix CRM's own decide route, the one
  // the Team tab posts to; an old-CRM plan shows the status the old CRM last held, and nothing to press.
  // ---------------------------------------------------------------------------------------------
  {
    const button = readFileSync("src/components/crm/plan-verify-button.tsx", "utf8");
    assert.ok(
      button.includes('fetch("/api/phoenix-crm/plans/decide"') &&
        button.includes('JSON.stringify({ action: "approve", expectedVersion: plan.phoenixVersion, planId: plan.phoenixPlanId })'),
      "the button posts Phoenix CRM's own approve, with the plan's own id and the version it was read at",
    );
    assert.ok(
      !button.includes("/api/crm/plan-verification") && !button.includes('"unverify"') && !button.includes('"return"'),
      "nothing writes into the old CRM, and a return (a note and a day) is made on the Team tab",
    );
    assert.ok(
      /canApprove &&\s*phoenixStatus === "submitted"/.test(button) && button.includes("const phoenixPlan = plan.crmPlanId < 0;"),
      "only a sent Phoenix week, for a viewer holding phoenix_crm:approve, offers Approve — an old-CRM plan (positive id) never does",
    );
    assert.ok(
      /armed \? "Confirm — approves the week in Phoenix" : "Approve"/.test(button),
      "the approve is armed: the first click arms, the second commits, on a board where the plan under the cursor changes with every click of the rep picker",
    );
    assert.ok(
      button.includes("setError(payload.message ??") && button.includes("startTransition(() => router.refresh())"),
      "a refusal shows the route's own words, and the board is re-read so the status beside them is the plan's current one",
    );
    assert.ok(
      button.includes('approved: { className: "text-emerald-700", words: "Approved in Phoenix" }'),
      "an approved week says where it was approved",
    );
  }

  await runPlanStatusFilterTests();
}

/**
 * The status filter — the owner, 2026-09-02: make "the admin, or any role who has the authority"
 * able to "filter by verified plan and non-verified plan".
 *
 * FOUR THINGS ARE PINNED HERE, and every one of them fails silently rather than loudly.
 *
 * 1. "NOT FILED" NEVER BECOMES "AWAITING". `foldRepPlanStatus` returns null for a rep who filed
 *    nothing, and `planStatus ?? PLAN_STATUS_NEW` turns that null into New — so a predicate that
 *    asks about the status before asking whether anything was filed puts every rep who filed
 *    nothing into the manager's "waiting on you" list. He would then open a rep to verify a plan
 *    that does not exist. It is one reordered line away at all times, and nothing on screen says so.
 *
 * 2. THE TILES COUNT THE WEEK, NOT THE FILTER. They double as the filter, so counting the filtered
 *    list would zero every tile except the active one — including the tile the manager has to press
 *    to widen again. The filter would be a door that locks behind him, and it would look like data.
 *
 * 3. AN UNKNOWN `?status=` WIDENS, NEVER NARROWS. A stale or misspelt value resolving to an empty
 *    board reads as "no rep in your reach filed a plan this week" — a statement about the reps
 *    rather than about the URL, and the kind a manager acts on.
 *
 * 4. THE FILTER SURVIVES EVERY OTHER CONTROL. The cascade, the week picker and "Back to all reps"
 *    each rebuild the URL from their own parameters, so any one of them that forgets `status`
 *    silently widens the board back to all seventy reps — while appearing to have worked, because
 *    the thing the manager actually pressed did change.
 */
async function runPlanStatusFilterTests() {
  // ---------------------------------------------------------------------------------------------
  // 12a. The resolver widens on anything it does not recognise
  // ---------------------------------------------------------------------------------------------
  {
    for (const value of PLAN_STATUS_FILTERS) {
      assert.equal(resolvePlanStatusFilter(value), value, `${value} is a real filter and must survive the resolver`);
    }
    assert.equal(resolvePlanStatusFilter(undefined), "all", "no parameter means every rep");
    assert.equal(resolvePlanStatusFilter(""), "all", "an empty parameter means every rep");
    assert.equal(resolvePlanStatusFilter("  VERIFIED  "), "verified", "trimmed and lower-cased, like every other filter");
    assert.equal(
      resolvePlanStatusFilter("pending"),
      "all",
      "an unrecognised value must WIDEN to every rep, never narrow to none — an empty board reads as 'nobody filed a plan this week', which is a statement about the reps rather than about the URL",
    );
  }

  // ---------------------------------------------------------------------------------------------
  // 12b. A rep who filed NOTHING is never counted as awaiting the manager
  // ---------------------------------------------------------------------------------------------
  {
    const missing = { planStatus: null, plansFiled: 0 };
    const pending = { planStatus: PLAN_STATUS_NEW, plansFiled: 1 };
    const verified = { planStatus: PLAN_STATUS_SUPERVISOR_VERIFIED, plansFiled: 1 };
    const areaVerified = { planStatus: PLAN_STATUS_AREA_MANAGER_VERIFIED, plansFiled: 1 };

    assert.ok(
      repMatchesPlanStatusFilter(missing, "missing"),
      "a rep who filed nothing belongs to 'no plan filed'",
    );
    assert.ok(
      !repMatchesPlanStatusFilter(missing, "awaiting"),
      "and NEVER to 'awaiting you'. `planStatus ?? PLAN_STATUS_NEW` reads a rep who filed nothing as pending, so asking the status before asking whether anything was filed would put every one of them on the manager's to-verify list — and send him to open a plan that does not exist",
    );
    assert.ok(
      !repMatchesPlanStatusFilter(missing, "verified"),
      "nor to 'verified' — nobody signed a plan that was never filed",
    );

    assert.ok(repMatchesPlanStatusFilter(pending, "awaiting"), "a filed, unsigned plan is the manager's move");
    assert.ok(!repMatchesPlanStatusFilter(pending, "missing"), "and it is emphatically not a missing plan");
    assert.ok(repMatchesPlanStatusFilter(verified, "verified"), "a supervisor-verified plan is verified");
    assert.ok(
      repMatchesPlanStatusFilter(areaVerified, "verified"),
      "so is an AREA MANAGER's signature — Phoenix cannot take it back, but the plan is signed off in the CRM and belongs with the verified ones",
    );

    for (const rep of [missing, pending, verified, areaVerified]) {
      assert.ok(repMatchesPlanStatusFilter(rep, "all"), "'all' is the only filter that spans every group");
    }
  }

  // ---------------------------------------------------------------------------------------------
  // 12c. The four counts PARTITION the week — no rep counted twice, none dropped
  // ---------------------------------------------------------------------------------------------
  {
    const reps = [
      { planStatus: null, plansFiled: 0 },
      { planStatus: null, plansFiled: 0 },
      { planStatus: PLAN_STATUS_NEW, plansFiled: 1 },
      { planStatus: PLAN_STATUS_SUPERVISOR_VERIFIED, plansFiled: 1 },
      { planStatus: PLAN_STATUS_AREA_MANAGER_VERIFIED, plansFiled: 1 },
      // A rep with two plans, one still pending: the lowest status wins, so he is awaiting.
      { planStatus: PLAN_STATUS_NEW, plansFiled: 2 },
    ];
    const counts = countRepPlanStatuses(reps);

    assert.deepEqual(
      counts,
      { all: 6, awaiting: 2, missing: 2, verified: 2 },
      "the four tiles over a known week",
    );
    assert.equal(
      counts.awaiting + counts.verified + counts.missing,
      counts.all,
      "the three groups must PARTITION the reach: a rep in none of them vanishes from a board that still claims to show everybody, and a rep in two is counted twice in the same row of tiles",
    );
    for (const filter of PLAN_STATUS_FILTERS) {
      assert.equal(
        reps.filter((rep) => repMatchesPlanStatusFilter(rep, filter)).length,
        counts[filter],
        `the ${filter} tile must equal what the ${filter} filter actually shows — a tile reading 3 that filters to 2 is a board arguing with itself, and neither number looks wrong on its own`,
      );
    }
    assert.deepEqual(
      countRepPlanStatuses([]),
      { all: 0, awaiting: 0, missing: 0, verified: 0 },
      "a viewer who reaches nobody gets zeroes, not a crash",
    );
  }

  // ---------------------------------------------------------------------------------------------
  // 12d. The board filters the GRID but never the LOOKUP, and the tiles read the unfiltered counts
  // ---------------------------------------------------------------------------------------------
  {
    const lib = readFileSync("src/lib/crm/reps-weekly-plans-board.ts", "utf8");
    assert.ok(
      /const counts = countRepPlanStatuses\(cascade\.repsIgnoringRep\.map\(withPlanStatus\)\);/.test(lib),
      "the counts are taken over the list the status filter has NOT been applied to — counting the filtered one zeroes every tile the manager is not looking at, including the one he must press to widen again",
    );
    assert.ok(
      /repsIgnoringRep/.test(lib) && !/const counts = countRepPlanStatuses\(allReps\)/.test(lib),
      "and over the list the REP filter has not been applied to either: `cascade.reps` is narrowed to one person the moment ?rep= is set, which had the picker offering 'Verified (0)' on a week holding 61 verified reps — the picker drops the rep when it navigates, so its counts must describe where it goes",
    );

    const cascadeSource = readFileSync("src/lib/crm/reps-list-board.ts", "utf8");
    assert.ok(
      cascadeSource.includes("repsMatching(tree, { ...selection, rep: undefined })") &&
        cascadeSource.includes("const reps: RepsListRep[] = selection.rep") &&
        cascadeSource.includes("? repsIgnoringRep.filter((rep) => rep.repKey === selection.rep)"),
      "the cascade builds the wide list first and narrows to `reps` from it, so the two can never describe different weeks — `repsMatching` applies the rep level itself (coverage-filters.ts), which is what made the narrow list the only one available",
    );
    assert.ok(
      /const reps = allReps\.filter\(\(rep\) => repMatchesPlanStatusFilter\(rep, base\.statusFilter\)\);/.test(lib),
      "and the grid is the filtered list",
    );
    assert.ok(
      /const selected = cascade\.selected\s*\?\s*\(allReps\.find/.test(lib),
      "the SELECTED rep is looked up in the unfiltered list: searching the filtered one would make a link carrying both ?rep= and a ?status= he does not match render 'filed no weekly plan' for a rep who filed one — the board accusing him of something the URL did",
    );

    const view = readFileSync("src/components/crm/reps-weekly-plans-board.tsx", "utf8");
    assert.ok(
      !/reps\.filter\(\(rep\) => rep\.plansFiled > 0\)/.test(view),
      "the view no longer counts the tiles for itself — that arithmetic moved into countRepPlanStatuses so the tiles and the filter cannot disagree",
    );
    for (const key of ["counts.all", "counts.awaiting", "counts.verified", "counts.missing"]) {
      assert.ok(view.includes(`String(${key})`), `the tiles read ${key} from the board`);
    }
    assert.ok(
      view.indexOf("<div className=\"grid grid-cols-2 gap-2 p-5 pb-0 sm:grid-cols-4\">") <
        view.indexOf("{reps.length === 0 ? ("),
      "the tiles are rendered OUTSIDE the empty branch: they are the filter as well as the count, so hiding them on an empty slice removes the only control that widens it again",
    );
  }

  // ---------------------------------------------------------------------------------------------
  // 12e. Every other control carries the filter through
  // ---------------------------------------------------------------------------------------------
  {
    const view = readFileSync("src/components/crm/reps-weekly-plans-board.tsx", "utf8");
    assert.ok(
      /if \(board\.statusFilter !== "all"\) query\.set\("status", board\.statusFilter\);/.test(view),
      "'Back to all reps' keeps the filter: a manager who narrowed to the three plans waiting on him, opened one and signed it expects to come back to the other two, not to all seventy",
    );
    assert.ok(
      /status: statusFilter === "all" \? undefined : statusFilter/.test(view),
      "and so does the shared cascade, through its preserve map",
    );

    const week = readFileSync("src/components/crm/plan-week-picker.tsx", "utf8");
    assert.ok(
      /if \(status && status !== "all"\) next\.set\("status", status\);/.test(week),
      "stepping to another week keeps the filter — dropping it would silently widen the board back to every rep while looking like it worked, because the week did change",
    );

    const picker = readFileSync("src/components/crm/plan-status-picker.tsx", "utf8");
    assert.ok(
      picker.includes('next.set("tab", "plans")') && picker.includes('next.set("week", week)'),
      "the status picker carries the tab and the week, or every pick bounces the manager back to the contact list on the current week",
    );
    assert.ok(
      !/next\.set\("rep"|next\.set\("plan"/.test(picker),
      "and deliberately DROPS the rep: with one still selected his plan fills the screen and the grid stays hidden, so the filter appears to do nothing on the one interaction whose whole purpose is visible",
    );
    assert.ok(
      /if \(value && value !== "all"\) next\.set\("status", value\)/.test(picker),
      "'all' clears the parameter rather than writing status=all, so the plain board and the cleared board are one URL",
    );

    // Both shells, not just the admin one. District Manager and Regional Manager — the two seats
    // this tab was built for — are PORTAL seats, so a filter threaded through the admin page alone
    // would be invisible to exactly the people the owner named.
    for (const page of ["app/(admin)/admin/reps-list/page.tsx", "app/employee-portals/reps-list/page.tsx"]) {
      const source = readFileSync(page, "utf8");
      assert.ok(
        source.includes("status: params?.status"),
        `${page} must pass the status through, or the filter is inert in that shell — and the portal is where the district and regional managers actually work`,
      );
    }
  }

  // ---------------------------------------------------------------------------------------------
  // 12f. The status picker is a CLIENT module, so nothing it loads may reach the server
  // ---------------------------------------------------------------------------------------------
  {
    // This is the bug the section exists to catch, and the reason `plan-status-filter.ts` is its own
    // file. The picker first imported PLAN_STATUS_FILTERS — a VALUE, so not erased the way a type
    // import is — from `reps-weekly-plans-board.ts`, which reaches plan-board → contact-lists →
    // manager-scope → employee-directory → employee-photo → node:crypto. Webpack refused the bundle
    // outright, the tab 500'd, and a cold `tsc --noEmit` had passed clean moments earlier: which
    // bundle a module lands in is not a type question, so nothing short of loading the page in a
    // browser could see it. Walking the graph here is the cheaper detector, and it fails with the
    // chain rather than with a symptom.
    const clientEntry = "src/components/crm/plan-status-picker.tsx";

    const resolveSpecifier = (specifier: string, fromFile: string): string | null => {
      if (specifier.startsWith("@/")) {
        // `@/*` maps to `./*` FIRST and `./src/*` second (tsconfig.json), which is why
        // `@/lib/utils` is the root file and not the one under src/.
        const tail = specifier.slice(2);
        for (const root of ["", "src/"]) {
          for (const suffix of [".ts", ".tsx", "/index.ts", ""]) {
            const candidate = `${root}${tail}${suffix}`;
            if (existsSync(candidate)) return candidate;
          }
        }
        return null;
      }
      if (!specifier.startsWith(".")) return null; // a package: not ours to walk
      const parts = `${fromFile.split("/").slice(0, -1).join("/")}/${specifier}`.split("/");
      const stack: string[] = [];
      for (const part of parts) {
        if (part === "." || part === "") continue;
        if (part === "..") stack.pop();
        else stack.push(part);
      }
      const base = stack.join("/");
      for (const suffix of ["", ".ts", ".tsx", "/index.ts"]) {
        if (existsSync(`${base}${suffix}`)) return `${base}${suffix}`;
      }
      return null;
    };

    const trail = new Map<string, string[]>([[clientEntry, [clientEntry]]]);
    const queue = [clientEntry];
    const walked: string[] = [];

    while (queue.length > 0) {
      const file = queue.shift() as string;
      walked.push(file);
      const source = readFileSync(file, "utf8");
      // Value imports only. `import type { X } from "m"` is erased by the compiler and never
      // reaches a bundle; `import { a, type B }` does load the module, so it is followed.
      const pattern = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?(?:[^;'"]*?\sfrom\s+)?["']([^"']+)["']/g;
      for (const match of source.matchAll(pattern)) {
        const [, typeOnly, specifier] = match;
        if (typeOnly) continue;
        assert.ok(
          !specifier.startsWith("node:") && specifier !== "fs" && specifier !== "crypto",
          `${clientEntry} is a "use client" module and must never load a node builtin. It reaches ${specifier} through:\n  ${(trail.get(file) ?? [file]).join("\n  → ")}\nThe fix is not to make the import conditional — move the value into a module both halves can hold, as plan-status-filter.ts was.`,
        );
        const resolved = resolveSpecifier(specifier, file);
        if (!resolved || trail.has(resolved)) continue;
        trail.set(resolved, [...(trail.get(file) ?? [file]), resolved]);
        queue.push(resolved);
      }
    }

    // The walk itself has to be shown to do something: a resolver that silently matched nothing
    // would make every assertion above pass on an empty graph, which is the failure mode this whole
    // suite exists to distrust.
    assert.ok(
      walked.includes("src/lib/crm/plan-status-filter.ts"),
      `the walk must actually reach the filter module through the picker's imports — it visited ${walked.length} file(s): ${walked.join(", ")}`,
    );
    assert.ok(
      !walked.includes("src/lib/crm/reps-weekly-plans-board.ts"),
      "the client picker must not load the board module at all: it is the server half, and its dependency chain is what broke the browser bundle",
    );

    const filter = readFileSync("src/lib/crm/plan-status-filter.ts", "utf8");
    assert.ok(
      !/^\s*"use (client|server)"/m.test(filter),
      "plan-status-filter.ts carries NO directive on purpose: the server board and the client picker both hold it, and either directive would hand one of them a module it cannot use",
    );
  }
}
