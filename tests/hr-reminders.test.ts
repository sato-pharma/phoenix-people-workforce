import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { REMINDER_OVERSEER_ROLE, REMINDER_TEAM_ROLES, reminderAudienceFor } from "../src/lib/hr-reminders/access.ts";
import {
  addDays,
  addMonths,
  bucketForNotes,
  canChangeReminder,
  canSeeReminder,
  clockFromDatabase,
  commentAudience,
  daysBetween,
  dedupeHrIds,
  describeSharing,
  filterByOwner,
  formatClock,
  formatDayLong,
  formatTimeSpan,
  groupByDay,
  initialsOf,
  isIsoDay,
  monthWeeks,
  normaliseSharing,
  parseCommentBody,
  parseReminderDraft,
  relativeDayLabel,
  sharingKind,
  startOfWeek,
  weekOf,
  weekdayName,
  type ReminderAudience,
} from "../src/lib/hr-reminders/logic.ts";
import {
  REMINDER_BODY_MAX,
  REMINDER_COMMENT_MAX,
  REMINDER_TITLE_MAX,
  type ReminderRecord,
  type ReminderView,
} from "../src/lib/hr-reminders/types.ts";
import { HR_ROLE_BUNDLES } from "../src/lib/auth/hr-functions.ts";
import { permissionMatrix } from "../src/lib/auth/permissions.ts";
import { findAccessRegistryEntry } from "../src/lib/security/access-registry.ts";
import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

/**
 * HR Reminders — the HR team's shared notes (owner, 2026-10-17).
 *
 * The brief, and where each half of it is pinned:
 *
 *   1. who is on the team and how that follows the permission matrix            -> section 1
 *   2. an author keeps a note private, shares it with chosen teammates or with
 *      the whole team; the HR Manager reads every note whatever its sharing; only
 *      the author edits, finishes or removes one                                  -> section 2
 *   3. what an author may type, and what is stored from it                        -> sections 3-4
 *   4. anyone who can see a note can comment, and answer a comment; who is told   -> section 5
 *   5. the week and month grids and the notes buckets                             -> section 6
 *   6. the routes, the registry, the page and the migration that carry it         -> sections 7-9
 *   7. the look: square edges, no ellipsis, no sideways scroll                    -> section 10
 */

const ROOT = process.cwd();
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");

// The people the module was asked for, by their real seats (HR-009 and HR-011 are the live ones).
const OMAR: ReminderAudience = { hrId: "B-10", isOverseer: true };
const YASMEENA: ReminderAudience = { hrId: "HR-009", isOverseer: false };
const YOMNA: ReminderAudience = { hrId: "HR-011", isOverseer: false };
const COORDINATOR: ReminderAudience = { hrId: "HR-014", isOverseer: false };

function note(overrides: Partial<ReminderRecord> = {}): ReminderRecord {
  return {
    body: "",
    color: "orange",
    createdAt: "2026-10-17T10:00:00.000Z",
    doneAt: null,
    doneByHrId: null,
    endsAt: null,
    id: "00000000-0000-4000-8000-000000000001",
    ownerHrId: "HR-009",
    remindOn: null,
    shareWithTeam: false,
    sharedWithHrIds: [],
    startsAt: null,
    status: "open",
    title: "A note",
    updatedAt: "2026-10-17T10:00:00.000Z",
    ...overrides,
  };
}

function view(overrides: Partial<ReminderView> = {}): ReminderView {
  return { ...note(), canChange: false, commentCount: 0, lastCommentAt: null, ownerName: "Yasmeena", ...overrides };
}

export function runHrRemindersTests() {
  // ── 1. The team follows the matrix ───────────────────────────────────────────────────────────
  {
    const matrix = permissionMatrix as Record<string, Record<string, readonly string[] | undefined>>;
    const holders = Object.entries(matrix)
      .filter(([, grants]) => grants.hr_reminders?.includes("read"))
      .map(([role]) => role)
      .sort();
    assert.deepEqual(
      holders,
      [...REMINDER_TEAM_ROLES].sort(),
      "the roles that hold hr_reminders:read and the roles the team picker is built from must be the same list",
    );
    for (const role of REMINDER_TEAM_ROLES) {
      assert.deepEqual(
        [...(matrix[role]?.hr_reminders ?? [])].sort(),
        ["create", "delete", "read", "update"],
        `${role} reads, writes, edits and removes — and holds no approve, because no note is signed off`,
      );
    }
    assert.ok((REMINDER_TEAM_ROLES as readonly string[]).includes(REMINDER_OVERSEER_ROLE), "the overseer seat is on the team");
    assert.ok(
      (HR_ROLE_BUNDLES["HR Operations"] as readonly string[]).includes("team_reminders") &&
        (HR_ROLE_BUNDLES["HR Resourcing"] as readonly string[]).includes("team_reminders"),
      "both HR seats get the module through the function catalogue, not a literal role block",
    );

    assert.deepEqual(reminderAudienceFor({ hrId: "hr-011", role: "HR Resourcing" }), { hrId: "HR-011", isOverseer: false });
    assert.equal(reminderAudienceFor({ hrId: "B-10", role: "Super Admin" })?.isOverseer, true, "the Super Admin seat is the overseer");
    assert.equal(
      reminderAudienceFor({ hrId: "PHX-1", role: "Super Admin" })?.hrId,
      "B-10",
      "the console login is the same person as B-10, so a note written from either belongs to one author",
    );
    assert.equal(reminderAudienceFor({ hrId: "", role: "Super Admin" }), null, "a session with no HR id sees nothing");
    assert.equal(reminderAudienceFor({ hrId: "HR-009", role: "HR Operations" })?.isOverseer, false, "only the Super Admin seat oversees");
  }

  // ── 2. Who sees, who changes ─────────────────────────────────────────────────────────────────
  {
    const privateNote = note({ ownerHrId: "HR-009" });
    assert.equal(canSeeReminder(YASMEENA, privateNote), true, "an author always sees their own note");
    assert.equal(canSeeReminder(YOMNA, privateNote), false, "a private note is invisible to a teammate");
    assert.equal(canSeeReminder(COORDINATOR, privateNote), false);
    assert.equal(canSeeReminder(OMAR, privateNote), true, "the HR Manager sees every note, however private");

    const toYomna = note({ ownerHrId: "HR-009", sharedWithHrIds: ["HR-011"] });
    assert.equal(canSeeReminder(YOMNA, toYomna), true, "named teammate sees it");
    assert.equal(canSeeReminder(COORDINATOR, toYomna), false, "a teammate who was not named does not");
    assert.equal(canSeeReminder({ hrId: "hr-011", isOverseer: false }, toYomna), true, "ids match in any casing");

    const toTeam = note({ ownerHrId: "HR-009", shareWithTeam: true });
    for (const viewer of [OMAR, YASMEENA, YOMNA, COORDINATOR]) {
      assert.equal(canSeeReminder(viewer, toTeam), true, `${viewer.hrId} sees a note shared with the whole team`);
    }
    assert.equal(canSeeReminder({ hrId: "", isOverseer: false }, toTeam), false, "a viewer with no id sees nothing, even a team note");

    // The brief, both directions at once: Yasmeena <-> Talent Acquisition choose independently, and the
    // HR Manager sees both whichever way they chose.
    const fromYasmeena = note({ ownerHrId: "HR-009", sharedWithHrIds: [] });
    const fromYomna = note({ ownerHrId: "HR-011", sharedWithHrIds: ["HR-009"] });
    assert.equal(canSeeReminder(YOMNA, fromYasmeena), false, "Yasmeena chose not to share with Talent Acquisition");
    assert.equal(canSeeReminder(YASMEENA, fromYomna), true, "Talent Acquisition chose to share with Yasmeena");
    assert.equal(canSeeReminder(OMAR, fromYasmeena) && canSeeReminder(OMAR, fromYomna), true, "and he sees both in every case");

    // Only the author changes a note — not the overseer, not a named teammate.
    assert.equal(canChangeReminder(YASMEENA, privateNote), true);
    assert.equal(canChangeReminder({ hrId: "hr-009", isOverseer: false }, privateNote), true, "author match ignores casing");
    assert.equal(canChangeReminder(OMAR, privateNote), false, "the HR Manager reads and comments; the note stays in its author's words");
    assert.equal(canChangeReminder(YOMNA, toYomna), false, "being shared a note does not make it yours");
    assert.equal(canChangeReminder({ hrId: "", isOverseer: false }, privateNote), false);

    assert.equal(sharingKind(note()), "private");
    assert.equal(sharingKind(note({ sharedWithHrIds: ["HR-011"] })), "people");
    assert.equal(sharingKind(note({ shareWithTeam: true, sharedWithHrIds: ["HR-011"] })), "team", "the team flag wins over a named list");

    const team = [
      { hrId: "HR-009", name: "Yasmeena Khaled" },
      { hrId: "HR-011", name: "Yomna Gamal" },
    ];
    assert.equal(describeSharing(note(), team, "Yasmeena Khaled"), "Private to Yasmeena Khaled");
    assert.equal(describeSharing(note({ shareWithTeam: true }), team, "Yasmeena Khaled"), "Shared with the whole team");
    assert.equal(describeSharing(note({ sharedWithHrIds: ["hr-011"] }), team, "Yasmeena Khaled"), "Shared with Yomna Gamal");
  }

  // ── 3. What an author may type ───────────────────────────────────────────────────────────────
  {
    const minimal = parseReminderDraft({ title: "  Call the bank  " });
    assert.ok(minimal.ok);
    if (minimal.ok) {
      assert.equal(minimal.value.title, "Call the bank");
      assert.equal(minimal.value.remindOn, null, "no day = a plain note");
      assert.equal(minimal.value.color, "orange");
      assert.equal(minimal.value.shareWithTeam, false);
      assert.deepEqual(minimal.value.sharedWithHrIds, [], "private by default");
    }

    const full = parseReminderDraft({
      body: "line one\r\nline two  ",
      color: "ink",
      endsAt: "10:30",
      remindOn: "2026-10-18",
      sharedWithHrIds: ["HR-011", "hr-011", 7, null, "HR-014"],
      startsAt: "09:00",
      title: "Interview prep",
    });
    assert.ok(full.ok);
    if (full.ok) {
      assert.equal(full.value.body, "line one\nline two", "the details are trimmed and CRLF becomes LF");
      assert.deepEqual(
        full.value.sharedWithHrIds.map((hrId) => hrId.toLowerCase()),
        ["hr-011", "hr-014"],
        "a repeated or non-string name is dropped",
      );
    }

    const refused = (input: unknown) => {
      const result = parseReminderDraft(input);
      assert.equal(result.ok, false, `expected a refusal for ${JSON.stringify(input)}`);
      return result.ok ? "" : result.message;
    };
    assert.match(refused(null), /object/i);
    assert.match(refused({ title: "   " }), /title/i);
    assert.match(refused({ title: "x".repeat(REMINDER_TITLE_MAX + 1) }), new RegExp(String(REMINDER_TITLE_MAX)));
    assert.match(refused({ body: "x".repeat(REMINDER_BODY_MAX + 1), title: "t" }), new RegExp(String(REMINDER_BODY_MAX)));
    assert.match(refused({ remindOn: "2026-02-31", title: "t" }), /real calendar day/i, "a day that does not exist is refused, not rolled into March");
    assert.match(refused({ remindOn: "18/10/2026", title: "t" }), /real calendar day/i);
    assert.match(refused({ startsAt: "09:00", title: "t" }), /day before/i, "a time needs a day");
    assert.match(refused({ endsAt: "10:00", remindOn: "2026-10-18", title: "t" }), /start time before an end/i);
    assert.match(refused({ endsAt: "09:00", remindOn: "2026-10-18", startsAt: "09:00", title: "t" }), /after the start/i, "an end equal to the start is refused");
    assert.match(refused({ endsAt: "08:00", remindOn: "2026-10-18", startsAt: "09:00", title: "t" }), /after the start/i);
    assert.match(refused({ remindOn: "2026-10-18", startsAt: "25:00", title: "t" }), /09:30/);
    assert.match(refused({ color: "magenta", title: "t" }), /colour/i);
    assert.match(refused({ sharedWithHrIds: "HR-011", title: "t" }), /team list/i);

    assert.equal(isIsoDay("2028-02-29"), true, "a leap day is a day");
    assert.equal(isIsoDay("2026-02-29"), false);
    assert.equal(isIsoDay("2026-2-3"), false);
    assert.equal(isIsoDay(20261018), false);
    assert.equal(clockFromDatabase("09:30:00"), "09:30", "the database speaks HH:MM:SS, the app HH:MM");
    assert.equal(clockFromDatabase(null), null);
    assert.equal(clockFromDatabase("garbage"), null);
  }

  // ── 4. What is stored for the sharing the author chose ───────────────────────────────────────
  {
    const teamIds = ["B-10", "HR-009", "HR-011"];
    assert.deepEqual(
      normaliseSharing({ shareWithTeam: true, sharedWithHrIds: ["HR-011"] }, "HR-009", teamIds),
      { shareWithTeam: true, sharedWithHrIds: [] },
      "sharing with the team already covers everyone, so the named list is not kept as a second statement",
    );
    assert.deepEqual(
      normaliseSharing({ shareWithTeam: false, sharedWithHrIds: ["hr-009", "HR-011", "hr-011", "ZZ-99"] }, "HR-009", teamIds),
      { shareWithTeam: false, sharedWithHrIds: ["HR-011"] },
      "the author is never in their own list, a repeat is one name, and someone outside the HR team is dropped",
    );
    assert.deepEqual(
      normaliseSharing({ shareWithTeam: false, sharedWithHrIds: ["HR-011"] }, "HR-009", []),
      { shareWithTeam: false, sharedWithHrIds: [] },
      "when the roster cannot be read nobody is named — private is the safe failure",
    );
    assert.equal(dedupeHrIds(["HR-009", "hr-011", "hr-009", null, undefined, "  "]).length, 2);
    assert.equal(dedupeHrIds(["HR-009", "hr-011", "hr-009"])[0], "HR-009", "first met, in stored casing");
  }

  // ── 5. Comments: what may be written, and who hears about it ─────────────────────────────────
  {
    assert.equal(parseCommentBody("   \n ").ok, false);
    assert.equal(parseCommentBody("x".repeat(REMINDER_COMMENT_MAX + 1)).ok, false);
    assert.equal(parseCommentBody(undefined).ok, false);
    const fine = parseCommentBody("  Thanks, done.\r\nSee you at 9.  ");
    assert.ok(fine.ok);
    if (fine.ok) assert.equal(fine.body, "Thanks, done.\nSee you at 9.");

    // Omar comments on Yasmeena's note that she shared with Yomna: both hear about it, he does not.
    assert.deepEqual(
      commentAudience({ authorHrId: "B-10", ownerHrId: "HR-009", priorCommenterHrIds: [], sharedWithHrIds: ["HR-011"] }),
      ["HR-009", "HR-011"],
    );
    // Yasmeena replies to him: he is a prior commenter now, so he is told; she is not told of her own words.
    assert.deepEqual(
      commentAudience({ authorHrId: "HR-009", ownerHrId: "HR-009", priorCommenterHrIds: ["B-10"], sharedWithHrIds: [] }),
      ["B-10"],
      "the HR Manager hears the reply to his comment, and the author is never told about their own",
    );
    assert.deepEqual(
      commentAudience({ authorHrId: "hr-011", ownerHrId: "HR-009", priorCommenterHrIds: ["HR-011", "b-10", "B-10"], sharedWithHrIds: ["HR-011"] }),
      ["HR-009", "B-10"],
      "casing never makes a person two recipients or lets the author through",
    );
    assert.deepEqual(
      commentAudience({ authorHrId: "HR-011", ownerHrId: "HR-009", priorCommenterHrIds: [], sharedWithHrIds: [] }),
      ["HR-009"],
      "a team-wide note pings nobody beyond its author and the people already talking",
    );
    assert.deepEqual(
      commentAudience({ authorHrId: "B-10", ownerHrId: "B-10", priorCommenterHrIds: [], sharedWithHrIds: [] }),
      [],
      "talking to yourself rings no bell",
    );
  }

  // ── 6. Calendar arithmetic and the lists ─────────────────────────────────────────────────────
  {
    // 18 October 2026 is the Sunday Yomna starts; the company week begins on Sunday.
    assert.equal(weekdayName("2026-10-18"), "Sunday");
    assert.equal(startOfWeek("2026-10-24"), "2026-10-18", "a Saturday belongs to the week that began the Sunday before");
    assert.equal(startOfWeek("2026-10-18"), "2026-10-18");
    assert.deepEqual(weekOf("2026-10-21"), [
      "2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24",
    ]);
    assert.equal(formatDayLong("2026-10-18"), "Sunday 18 October");

    assert.equal(addDays("2028-02-28", 1), "2028-02-29");
    assert.equal(addDays("2026-12-31", 1), "2027-01-01");
    assert.equal(addDays("2026-03-01", -1), "2026-02-28");
    assert.equal(addMonths("2026-12-17", 1), "2027-01-01", "months roll the year and always land on the 1st");
    assert.equal(addMonths("2026-03-31", -1), "2026-02-01", "the 31st never overflows into the wrong month");
    assert.equal(daysBetween("2026-10-17", "2026-10-18"), 1);
    assert.equal(relativeDayLabel("2026-10-17", "2026-10-17"), "Today");
    assert.equal(relativeDayLabel("2026-10-18", "2026-10-17"), "Tomorrow");
    assert.equal(relativeDayLabel("2026-10-16", "2026-10-17"), "Yesterday");
    assert.equal(relativeDayLabel("2026-10-22", "2026-10-17"), "Thursday 22 October");

    const october = monthWeeks("2026-10-17");
    assert.equal(october.length, 5);
    assert.equal(october[0][0], "2026-09-27", "October 2026 starts on a Thursday, so the grid opens on the Sunday before it");
    assert.equal(october[4][6], "2026-10-31");
    const february = monthWeeks("2026-02-10");
    assert.equal(february.length, 4, "February 2026 begins on a Sunday and fits four rows exactly");
    const august = monthWeeks("2026-08-15");
    assert.equal(august.length, 6, "a month that starts on a Saturday and holds 31 days needs six rows");
    assert.equal(august[0][0], "2026-07-26");
    assert.equal(august[5][6], "2026-09-05");
    for (const week of [...october, ...february, ...august]) assert.equal(week.length, 7);

    assert.equal(formatClock("00:05"), "12:05 AM");
    assert.equal(formatClock("12:00"), "12:00 PM");
    assert.equal(formatClock("13:30"), "1:30 PM");
    assert.equal(formatClock(null), "");
    assert.equal(formatTimeSpan("09:00", "10:15"), "9:00 AM – 10:15 AM");
    assert.equal(formatTimeSpan("09:00", null), "9:00 AM");
    assert.equal(formatTimeSpan(null, null), "");

    // Ordering: earlier day first, an all-day item before a timed one, then by title.
    const items = [
      view({ id: "a", remindOn: "2026-10-18", startsAt: "14:00", title: "Afternoon" }),
      view({ id: "b", remindOn: "2026-10-18", startsAt: null, title: "All day" }),
      view({ id: "c", remindOn: "2026-10-18", startsAt: "09:00", title: "Morning" }),
      view({ id: "d", remindOn: null, title: "No day" }),
      view({ id: "e", remindOn: "2026-10-19", title: "Next day" }),
    ];
    const byDay = groupByDay(items);
    assert.deepEqual(byDay.get("2026-10-18")?.map((item) => item.id), ["b", "c", "a"]);
    assert.equal([...byDay.values()].flat().some((item) => item.id === "d"), false, "an undated note is not on any calendar day");

    const today = "2026-10-17";
    const buckets = bucketForNotes(
      [
        view({ id: "late", remindOn: "2026-10-10" }),
        view({ id: "now", remindOn: today }),
        view({ id: "soon", remindOn: "2026-10-20" }),
        view({ id: "later", remindOn: "2026-10-30" }),
        view({ id: "plain", remindOn: null, updatedAt: "2026-10-16T10:00:00Z" }),
        view({ id: "plain-newer", remindOn: null, updatedAt: "2026-10-17T10:00:00Z" }),
        view({ doneAt: "2026-10-15T10:00:00Z", id: "done-old", remindOn: "2026-10-01", status: "done" }),
        view({ doneAt: "2026-10-16T10:00:00Z", id: "done-new", remindOn: null, status: "done" }),
      ],
      today,
    );
    assert.deepEqual(buckets.overdue.map((item) => item.id), ["late"]);
    assert.deepEqual(buckets.today.map((item) => item.id), ["now"]);
    assert.deepEqual(buckets.upcoming.map((item) => item.id), ["soon", "later"]);
    assert.deepEqual(buckets.undated.map((item) => item.id), ["plain-newer", "plain"], "plain notes: most recently touched first");
    assert.deepEqual(buckets.done.map((item) => item.id), ["done-new", "done-old"], "a finished item is done, never overdue, and the latest finished leads");

    const owned = [view({ ownerHrId: "HR-009" }), view({ ownerHrId: "hr-011" }), view({ ownerHrId: "B-10" })];
    assert.equal(filterByOwner(owned, "all").length, 3);
    assert.equal(filterByOwner(owned, "HR-011").length, 1, "the owner filter ignores casing");

    assert.equal(initialsOf("Yomna Gamal"), "YG");
    assert.equal(initialsOf("Yasmeena Khaled Ahmed Hussein Elsafory"), "YE");
    assert.equal(initialsOf("omar"), "O");
    assert.equal(initialsOf("   "), "?");
  }

  // ── 7. The routes ────────────────────────────────────────────────────────────────────────────
  {
    const routeFiles: Array<[string, string, string]> = [
      ["app/api/hr-reminders/route.ts", "GET", "read"],
      ["app/api/hr-reminders/route.ts", "POST", "create"],
      ["app/api/hr-reminders/[id]/route.ts", "PATCH", "update"],
      ["app/api/hr-reminders/[id]/route.ts", "DELETE", "delete"],
      ["app/api/hr-reminders/[id]/comments/route.ts", "GET", "read"],
      ["app/api/hr-reminders/[id]/comments/route.ts", "POST", "create"],
    ];
    for (const [file, method, action] of routeFiles) {
      const source = stripComments(read(file));
      const start = source.indexOf(`export async function ${method}(`);
      assert.ok(start >= 0, `${file} exports ${method}`);
      const rest = source.slice(start + 10);
      const next = rest.search(/export async function /);
      const block = next === -1 ? rest : rest.slice(0, next);
      assert.ok(
        block.includes(`assertPermission(access, "hr_reminders", "${action}")`),
        `${file} ${method} asserts hr_reminders:${action} before it does anything`,
      );
      if (method !== "GET") {
        assert.ok(block.includes("assertSameOriginMutation(request)"), `${file} ${method} is a mutation and checks the origin`);
        assert.ok(block.includes("assertApiRateLimit("), `${file} ${method} is rate limited`);
      }
    }
  }

  // ── 8. The registry and the page ─────────────────────────────────────────────────────────────
  {
    const expectations: Array<[string, "GET" | "POST" | "PATCH" | "DELETE", string, boolean]> = [
      ["/api/hr-reminders", "GET", "read", false],
      ["/api/hr-reminders", "POST", "create", true],
      ["/api/hr-reminders/abc", "PATCH", "update", true],
      ["/api/hr-reminders/abc", "DELETE", "delete", true],
      ["/api/hr-reminders/abc/comments", "GET", "read", false],
      ["/api/hr-reminders/abc/comments", "POST", "create", true],
    ];
    for (const [route, method, action, csrf] of expectations) {
      const entry = findAccessRegistryEntry(route, method);
      assert.ok(entry, `${method} ${route} is declared in the access registry`);
      const gate = entry?.permission;
      const requirement = (Array.isArray(gate) ? gate[0] : gate) as { resource?: string; action?: string } | null | undefined;
      assert.equal(requirement?.resource, "hr_reminders", `${method} ${route} is gated on hr_reminders`);
      assert.equal(requirement?.action, action, `${method} ${route} needs ${action}`);
      assert.equal(entry?.csrf.required, csrf, `${method} ${route} csrf.required is ${csrf}`);
      assert.equal(entry?.authMode, "session", `${method} ${route} is a signed-in route`);
    }

    const page = stripComments(read("app/(admin)/hr-reminders/page.tsx"));
    assert.ok(page.includes('canAccess(access, "hr_reminders", "read")'), "the page guards on hr_reminders:read");
    assert.ok(page.includes('redirect("/admin")'), "a seat without the permission is sent back, not shown an empty board");
    assert.ok(existsSync(path.join(ROOT, "app/(admin)/hr-reminders/loading.tsx")), "the page has a loading state");

    const nav = stripComments(read("src/config/system-navigation.ts"));
    assert.ok(nav.includes('href: "/hr/hr-reminders"'), "the HR rail offers the page under the /hr namespace");
    assert.ok(nav.includes('href: "/hr-reminders"'), "the admin hub offers the page");
    assert.ok(nav.includes('"/hr-reminders",'), "the hub's Calendars group lists the page");
    const widths = JSON.parse(read("tests/fixtures/sidebar-label-widths.json")) as { admin?: Record<string, number> };
    assert.equal(typeof widths.admin?.["HR Reminders"], "number", "the label has a measured width in the admin rail");
  }

  // ── 9. The migration: two tables, service role only ──────────────────────────────────────────
  {
    const migrations = readdirSync(path.join(ROOT, "supabase/migrations")).filter((name) => /hr_team_reminders/.test(name));
    assert.equal(migrations.length, 1, "exactly one migration creates the module's tables");
    const sql = stripSqlComments(read(`supabase/migrations/${migrations[0]}`)).toLowerCase();
    for (const table of ["hr_reminders", "hr_reminder_comments"]) {
      assert.ok(sql.includes(`create table if not exists public.${table}`), `${table} is created`);
      assert.ok(sql.includes(`alter table public.${table} enable row level security`), `${table} has RLS on`);
      assert.ok(sql.includes(`revoke all on table public.${table} from anon, authenticated`), `${table} is closed to the browser roles`);
      assert.ok(sql.includes(`grant all on table public.${table} to service_role`), `${table} is open to the service role`);
    }
    assert.equal(
      /\bto\s+(anon|authenticated|public)\b/.test(sql.replace(/revoke[^;]*;/g, "")),
      false,
      "no statement grants either table to a browser role",
    );
    assert.equal(sql.includes("security definer"), false, "no function is created that could run as its owner");
    assert.equal(/drop\s+table|truncate/.test(sql), false, "the migration only adds");
    assert.ok(sql.includes("deleted_at"), "a removed note is soft-deleted, so the HR Manager still has the record");
    for (const check of ["hr_reminders_time_needs_day", "hr_reminders_end_needs_start", "hr_reminders_end_after_start"]) {
      assert.ok(sql.includes(check), `the table itself refuses ${check.replace("hr_reminders_", "")}, matching the parser`);
    }
  }

  // ── 10. The look: square, whole words, nothing scrolls sideways ──────────────────────────────
  {
    const files = [
      ...readdirSync(path.join(ROOT, "src/components/hr-reminders")).map((name) => `src/components/hr-reminders/${name}`),
      "app/(admin)/hr-reminders/page.tsx",
      "app/(admin)/hr-reminders/loading.tsx",
    ];
    assert.ok(files.length >= 9, "the module's components are all swept");
    for (const file of files) {
      const source = stripComments(read(file));
      assert.equal(/\brounded(?!-none)(-[a-z0-9[\]]+)?\b/.test(source), false, `${file}: square edges only — no rounded-* class`);
      assert.equal(/\btruncate\b|text-ellipsis|line-clamp/.test(source), false, `${file}: text is wrapped, never cut with an ellipsis`);
      assert.equal(source.includes("…"), false, `${file}: no ellipsis character in anything shown`);
      assert.equal(/overflow-x-(auto|scroll)/.test(source), false, `${file}: nothing scrolls sideways`);
    }

    const editor = read("src/components/hr-reminders/reminder-editor.tsx");
    assert.ok(editor.includes("@/components/ui/form-tokens"), "the editor wears the one form design");
    const thread = read("src/components/hr-reminders/reminder-thread.tsx");
    assert.ok(thread.includes("@/components/ui/form-tokens"), "the comment box wears the one form design");
    assert.ok(thread.includes("Africa/Cairo"), "a comment's time is shown in Cairo time");
  }
}
