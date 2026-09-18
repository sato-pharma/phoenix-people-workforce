import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import ExcelJS from "exceljs";

import {
  bookingLink,
  buildInterviewCalendarExportModel,
  buildInterviewCalendarPdfHtml,
  buildInterviewCalendarWorkbook,
  interviewCalendarFilename,
} from "../src/lib/recruitment/interview-calendar-export.ts";
import { createAccessContext, systemAccessContext } from "../src/lib/auth/permissions.ts";
import { validateInterviewBookingInput } from "../src/lib/recruitment/interview-calendar.ts";
import {
  canBookInterviews,
  interviewCalendarBaseFor,
  interviewCalendarHref,
  isInterviewCalendarOwner,
  resolveCalendarRole,
  roleMeets,
  type InterviewBooking,
} from "../src/lib/recruitment/interview-calendar-types.ts";
import {
  cairoDateKey,
  cairoLocalToUtc,
  cairoMinutesOfDay,
  formatTimeOfDay,
  formatWeekOf,
  formatWeekRange,
  isBookableDay,
  isBookableWindow,
  isDateKey,
  monthGrid,
  slotFor,
  slotStarts,
  upcomingWeekStart,
  weekDays,
  weekInstantRange,
  weekStartFor,
} from "../src/lib/recruitment/interview-calendar-week.ts";
import {
  createZoomMeeting,
  deleteZoomMeeting,
  readZoomConfig,
  resetZoomTokenCacheForTests,
  zoomMeetingBody,
  type ZoomConfig,
} from "../src/lib/zoom/meetings.ts";
import { stripComments } from "./support/comment-strip.ts";

const read = (relative: string) => readFileSync(join(process.cwd(), relative), "utf8");

/**
 * The interview calendar — the owner's request of 2026-09-18, in his words: "on the CV without any
 * steps from screening or from recruitment or from WhatsApp application screening tab from any
 * screen, any CV … I have the option to schedule an interview", then a date, a time, In office or
 * Zoom, a week grid like his own Google sheet, a PDF and an Excel export in which "I click on name
 * the CV appear", and sharing "from Phoenix itself" as editor, commenter or viewer.
 *
 * His answers when asked: the candidate is sent NOTHING (calendar only); only he and the people he
 * shares with can see it; Phoenix creates the Zoom meeting; Sunday to Thursday, 9:00 AM to 5:00 PM,
 * in half-hour rows.
 */
export async function runInterviewCalendarTests() {
  runWeekTests();
  runAddressTests();
  runRoleTests();
  runValidationTests();
  await runZoomTests();
  await runExportTests();
  runWiringTests();
}

// ── 1 · The week: Sunday to Thursday, 9 to 5, in Cairo ─────────────────────────────────────────
function runWeekTests() {
  // 2026-09-18 is a Friday, 2026-09-20 a Sunday.
  assert.equal(weekStartFor("2026-09-18"), "2026-09-13", "a Friday belongs to the week it ends");
  assert.equal(weekStartFor("2026-09-19"), "2026-09-13", "and so does a Saturday");
  assert.equal(weekStartFor("2026-09-20"), "2026-09-20", "a Sunday starts its own week");
  assert.deepEqual(
    weekDays("2026-09-22"),
    ["2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24"],
    "the grid is Sunday to Thursday — the owner's choice — whatever day it is asked from",
  );

  const starts = slotStarts();
  assert.equal(starts.length, 16, "9:00 AM to 5:00 PM is sixteen half-hour rows");
  assert.equal(formatTimeOfDay(starts[0]), "9:00 AM");
  assert.equal(formatTimeOfDay(starts[starts.length - 1]), "4:30 PM", "the last row starts at 4:30 PM");
  assert.equal(formatTimeOfDay(720), "12:00 PM", "noon is 12:00 PM, never 0:00 PM");
  assert.equal(slotFor(9 * 60 + 15), 9 * 60, "a 9:15 interview is drawn in the 9:00 row");

  assert.equal(isBookableDay("2026-09-18"), false, "no interview on a Friday");
  assert.equal(isBookableDay("2026-09-19"), false, "or a Saturday");
  assert.equal(isBookableDay("2026-09-20"), true);
  assert.equal(isBookableDay("2026-09-24"), true, "Thursday is the last interview day");
  assert.equal(isDateKey("2026-02-30"), false, "a date that does not exist is refused, not rolled into March");

  assert.equal(isBookableWindow(8 * 60 + 30, 30), false, "nothing before 9:00 AM");
  assert.equal(isBookableWindow(9 * 60, 30), true);
  assert.equal(isBookableWindow(16 * 60 + 30, 30), true, "a 4:30 PM half hour ends at 5:00 PM exactly");
  assert.equal(isBookableWindow(16 * 60 + 30, 45), false, "and nothing runs past 5:00 PM");
  assert.equal(isBookableWindow(9 * 60 + 5, 30), false, "starts fall on a quarter hour");

  // THE CAIRO TRAP. The server runs in UTC; Cairo is two or three hours ahead. Just after midnight
  // on a Friday in Cairo it is still Thursday in UTC, and a calendar keyed on the server's clock
  // would open on a week with no interview day left in it.
  assert.equal(upcomingWeekStart(new Date("2026-09-18T09:00:00Z")), "2026-09-20", "on a Friday the calendar opens on the coming week");
  assert.equal(upcomingWeekStart(new Date("2026-09-17T20:30:00Z")), "2026-09-13", "Thursday 11:30 PM in Cairo is still this week");
  assert.equal(
    upcomingWeekStart(new Date("2026-09-17T21:30:00Z")),
    "2026-09-20",
    "Friday 12:30 AM in Cairo is Friday, though UTC still reads Thursday",
  );

  // DAYLIGHT SAVING. Egypt keeps it again since 2023 (+3 in summer, +2 in winter), so the offset
  // cannot be a constant. 9:00 AM must be 9:00 AM in Cairo on both sides of the change.
  assert.equal(cairoLocalToUtc("2026-09-20", 9 * 60).toISOString(), "2026-09-20T06:00:00.000Z", "summer: Cairo is UTC+3");
  assert.equal(cairoLocalToUtc("2026-11-01", 9 * 60).toISOString(), "2026-11-01T07:00:00.000Z", "winter: Cairo is UTC+2");
  assert.equal(cairoLocalToUtc("2027-01-10", 14 * 60 + 30).toISOString(), "2027-01-10T12:30:00.000Z");
  for (const [key, minutes] of [
    ["2026-09-20", 9 * 60],
    ["2026-10-29", 16 * 60 + 30],
    ["2026-11-01", 9 * 60 + 15],
    ["2027-04-25", 12 * 60],
  ] as const) {
    const instant = cairoLocalToUtc(key, minutes);
    assert.equal(cairoDateKey(instant), key, `${key} round-trips to the same Cairo day`);
    assert.equal(cairoMinutesOfDay(instant), minutes, `${key} round-trips to the same Cairo time`);
  }
  const range = weekInstantRange("2026-09-22");
  assert.equal(range.from.toISOString(), "2026-09-19T21:00:00.000Z", "the week's query starts at Sunday midnight in Cairo");
  assert.equal(range.to.toISOString(), "2026-09-26T21:00:00.000Z", "and ends at the next Sunday's midnight");

  const september = monthGrid(2026, 8);
  assert.equal(september.length, 5, "September 2026 is five Sunday-first rows");
  assert.deepEqual(september[0].slice(0, 3), [null, null, "2026-09-01"], "1 September 2026 is a Tuesday");
  assert.deepEqual(september[4], ["2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", null, null, null]);
  assert.ok(september.every((row) => row.length === 7), "every row is a whole week");

  assert.equal(formatWeekRange("2026-09-20"), "20 – 24 September 2026");
  assert.equal(formatWeekRange("2026-09-27"), "27 September – 1 October 2026", "a week across a month names both");
  assert.equal(formatWeekRange("2025-12-28"), "28 December 2025 – 1 January 2026", "and across a year, both years");
  assert.equal(formatWeekOf("2026-09-23"), "Week of: 20 September", "the grid is headed the way the owner's sheet is");
}

// ── 2 · A link stays in the shell it was pressed in ────────────────────────────────────────────
function runAddressTests() {
  assert.equal(interviewCalendarBaseFor("/recruitment/screening"), "/recruitment/interview-calendar");
  assert.equal(interviewCalendarBaseFor("/hr/recruitment"), "/hr/recruitment/interview-calendar", "the HR shell keeps its own address");
  assert.equal(interviewCalendarBaseFor("/hr"), "/hr/recruitment/interview-calendar");
  assert.equal(interviewCalendarBaseFor("/hrm/anything"), "/recruitment/interview-calendar", "only /hr itself is the HR shell");
  assert.equal(
    interviewCalendarBaseFor("/employee-portals/recruitment-candidates"),
    "/employee-portals/interview-calendar",
    "the portal has its own twin",
  );
  assert.equal(interviewCalendarBaseFor(null), "/recruitment/interview-calendar");
  assert.equal(interviewCalendarHref(), "/recruitment/interview-calendar");
  const id = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
  assert.equal(
    interviewCalendarHref({ base: "/hr/recruitment/interview-calendar", open: id, weekStart: "2026-09-20" }),
    `/hr/recruitment/interview-calendar?week=2026-09-20&open=${id}`,
  );
}

// ── 3 · Who may do what: owner, editor, commenter, viewer ──────────────────────────────────────
function runRoleTests() {
  const table: Array<[Parameters<typeof roleMeets>[0], boolean, boolean, boolean, boolean]> = [
    // role        view   comment book   share
    ["owner", true, true, true, true],
    ["editor", true, true, true, false],
    ["commenter", true, true, false, false],
    ["viewer", true, false, false, false],
    [null, false, false, false, false],
  ];
  for (const [role, view, comment, book, share] of table) {
    assert.equal(roleMeets(role, "view"), view, `${role ?? "nobody"} viewing`);
    assert.equal(roleMeets(role, "comment"), comment, `${role ?? "nobody"} leaving notes`);
    assert.equal(roleMeets(role, "book"), book, `${role ?? "nobody"} booking, moving and cancelling`);
    assert.equal(roleMeets(role, "share"), share, `${role ?? "nobody"} sharing — only the owner shares`);
    assert.equal(canBookInterviews(role), book, "the Schedule interview button follows the same rule as the server");
  }
  assert.equal(resolveCalendarRole({ isOwner: true, shareLevel: "viewer" }), "owner", "the owner cannot demote himself by sharing");
  assert.equal(resolveCalendarRole({ isOwner: false, shareLevel: "commenter" }), "commenter");
  assert.equal(resolveCalendarRole({ isOwner: false, shareLevel: null }), null, "no share row, no calendar");

  // The owner, as a real session carries him. createAccessContext is what the session builds, and
  // it gives a signed-in Super Admin scope "company", not "system" — a scope-only owner test
  // locked him out of his own calendar (2026-09-18, caught before merge).
  const owner = createAccessContext({ hrId: "B-10", role: "Super Admin" });
  assert.equal(isInterviewCalendarOwner(owner), true, "the signed-in Super Admin owns the calendar");
  assert.equal(isInterviewCalendarOwner(systemAccessContext), true, "a system job acts as the owner");
  for (const role of ["CEO", "Finance Manager", "HR Operations", "HR Advisory", "National Sales Manager", "Employee"]) {
    const other = createAccessContext({ hrId: "A-99", role });
    assert.equal(isInterviewCalendarOwner(other), false, `${role} (scope ${other.scope}) is not the owner — only a share row lets them in`);
  }
}

// ── 4 · A booking the server will take ─────────────────────────────────────────────────────────
function runValidationTests() {
  const candidateId = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
  const good = { candidateId, dateKey: "2026-09-20", durationMinutes: 45, notes: "  Bring the offer draft  ", platform: "zoom", startMinutes: 10 * 60 };
  assert.deepEqual(validateInterviewBookingInput(good), {
    candidateId,
    dateKey: "2026-09-20",
    durationMinutes: 45,
    notes: "Bring the offer draft",
    platform: "zoom",
    startMinutes: 600,
  });
  assert.equal(validateInterviewBookingInput({ ...good, notes: "   " }).notes, null, "a blank note is no note");
  assert.throws(() => validateInterviewBookingInput({ ...good, dateKey: "2026-09-18" }), /Sunday to Thursday/, "a Friday is refused");
  assert.throws(() => validateInterviewBookingInput({ ...good, startMinutes: 8 * 60 + 30 }), /9:00 AM or later/);
  assert.throws(() => validateInterviewBookingInput({ ...good, durationMinutes: 60, startMinutes: 16 * 60 + 30 }), /ends by 5:00 PM/);
  assert.throws(() => validateInterviewBookingInput({ ...good, durationMinutes: 20 }), /30, 45 or 60/);
  assert.throws(() => validateInterviewBookingInput({ ...good, platform: "teams" }), /In office or Zoom/);
  assert.throws(() => validateInterviewBookingInput({ ...good, candidateId: "B-10" }), /candidate/, "the candidate is a record id");
  assert.throws(() => validateInterviewBookingInput({ ...good, dateKey: "2026-02-30" }), /date/);
}

// ── 5 · Phoenix makes the Zoom meeting ─────────────────────────────────────────────────────────
async function runZoomTests() {
  assert.equal(readZoomConfig({}), null, "no Zoom variables, no Zoom — the booking still saves");
  assert.equal(
    readZoomConfig({ ZOOM_ACCOUNT_ID: "acc", ZOOM_CLIENT_ID: "cid", ZOOM_CLIENT_SECRET: "sec" }),
    null,
    "all four are needed; three is not connected",
  );
  const config = readZoomConfig({
    ZOOM_ACCOUNT_ID: "﻿acc",
    ZOOM_CLIENT_ID: " cid ",
    ZOOM_CLIENT_SECRET: "sec",
    ZOOM_HOST_USER: "host@example.com",
  }) as ZoomConfig;
  assert.equal(config.accountId, "acc", "a byte-order mark Railway stored inside a value is stripped (AGENTS.md §2.3)");
  assert.equal(config.clientId, "cid");

  const input = { dateKey: "2026-11-01", durationMinutes: 45, startMinutes: 9 * 60 + 30, topic: "Interview · Mona Ali" };
  assert.deepEqual(zoomMeetingBody(input), {
    duration: 45,
    settings: { join_before_host: false, waiting_room: true },
    start_time: "2026-11-01T09:30:00",
    timezone: "Africa/Cairo",
    topic: "Interview · Mona Ali",
    type: 2,
  }, "a scheduled meeting at the Cairo wall-clock time, with no zone on the time — Zoom does the daylight saving");

  resetZoomTokenCacheForTests();
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const zoom = async (url: string, init?: RequestInit) => {
    calls.push({ init, url });
    if (url.startsWith("https://zoom.us/oauth/token")) {
      return new Response(JSON.stringify({ access_token: "tok-1", expires_in: 3599 }), { status: 200 });
    }
    if (url.endsWith("/meetings") && init?.method === "POST") {
      return new Response(JSON.stringify({ id: 88012345678, join_url: "https://us06web.zoom.us/j/88012345678" }), { status: 201 });
    }
    if (init?.method === "DELETE") return new Response(null, { status: 404 });
    return new Response(JSON.stringify({ message: "unexpected" }), { status: 500 });
  };

  const meeting = await createZoomMeeting(config, input, zoom);
  assert.deepEqual(meeting, { id: "88012345678", joinUrl: "https://us06web.zoom.us/j/88012345678" });
  assert.equal(calls.length, 2, "one sign-in, one meeting");
  assert.equal(calls[0].url, "https://zoom.us/oauth/token?grant_type=account_credentials&account_id=acc");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(
    (calls[0].init?.headers as Record<string, string>).Authorization,
    `Basic ${Buffer.from("cid:sec").toString("base64")}`,
    "Server-to-Server OAuth signs in with the client id and secret",
  );
  assert.equal(calls[1].url, "https://api.zoom.us/v2/users/host%40example.com/meetings", "the meeting is made for the host user");
  assert.equal((calls[1].init?.headers as Record<string, string>).Authorization, "Bearer tok-1");
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), zoomMeetingBody(input));

  await createZoomMeeting(config, input, zoom);
  assert.equal(calls.length, 3, "the token is reused until it expires — one call for the second meeting");

  await deleteZoomMeeting(config, "88012345678", zoom);
  assert.equal(calls.length, 4, "a meeting Zoom no longer has counts as deleted");

  resetZoomTokenCacheForTests();
  const refusing = async (url: string) =>
    url.startsWith("https://zoom.us/oauth/token")
      ? new Response(JSON.stringify({ reason: "Invalid client_id or client_secret" }), { status: 400 })
      : new Response("{}", { status: 500 });
  await assert.rejects(
    () => createZoomMeeting(config, input, refusing),
    /Zoom refused Phoenix's sign-in \(400: Invalid client_id or client_secret\)/,
    "a refusal says what Zoom said, so the calendar can show it",
  );
  resetZoomTokenCacheForTests();
}

// ── 6 · The export: the owner's week grid, every name a link to its CV ─────────────────────────
function booking(overrides: Partial<InterviewBooking> & Pick<InterviewBooking, "id" | "candidateName" | "dateKey" | "startMinutes">): InterviewBooking {
  return {
    bookedByName: "Omar Gawish",
    candidateId: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
    candidateJobTitle: null,
    comments: [],
    createdAt: "2026-09-18T10:00:00.000Z",
    durationMinutes: 30,
    notes: null,
    platform: "in_office",
    startsAt: "2026-09-20T06:00:00.000Z",
    updatedAt: "2026-09-18T10:00:00.000Z",
    zoomError: null,
    zoomJoinUrl: null,
    zoomStatus: "not_needed",
    ...overrides,
  };
}

async function runExportTests() {
  const early = booking({ candidateName: "Mona Ali", dateKey: "2026-09-20", id: "00000000-0000-4000-8000-000000000001", startMinutes: 9 * 60 });
  const second = booking({
    candidateName: `Karim <b>"Adel"</b> & Sons`,
    dateKey: "2026-09-20",
    id: "00000000-0000-4000-8000-000000000002",
    startMinutes: 9 * 60 + 15,
  });
  const zoom = booking({
    candidateJobTitle: "Medical Rep",
    candidateName: "Sara Hassan",
    dateKey: "2026-09-21",
    durationMinutes: 45,
    id: "00000000-0000-4000-8000-000000000003",
    platform: "zoom",
    startMinutes: 10 * 60,
    zoomJoinUrl: "https://us06web.zoom.us/j/88012345678",
    zoomStatus: "created",
  });
  const late = booking({ candidateName: "Late Entry", dateKey: "2026-09-22", id: "00000000-0000-4000-8000-000000000004", startMinutes: 17 * 60 });

  const model = buildInterviewCalendarExportModel({
    bookings: [zoom, late, second, early],
    now: new Date("2026-09-18T12:00:00Z"),
    origin: "https://phoenix-hr.satopharma.com/",
    weekStart: "2026-09-23",
  });
  assert.equal(model.weekStart, "2026-09-20", "any day of the week exports that week");
  assert.deepEqual(model.days.map((day) => day.weekday), ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday"]);
  assert.deepEqual(
    model.slots[0].perDay[0].map((entry) => entry.id),
    [early.id, second.id],
    "two interviews in one half hour are both drawn, in time order — neither overwrites the other",
  );
  assert.deepEqual(model.slots[2].perDay[1].map((entry) => entry.id), [zoom.id], "Monday 10:00 AM");
  assert.deepEqual(model.offGrid.map((entry) => entry.id), [late.id], "an interview outside 9 to 5 is set aside, never lost");
  assert.equal(model.bookings.length, 4, "and the list under the grid still holds every interview");

  const link = bookingLink(model, zoom);
  assert.equal(
    link,
    `https://phoenix-hr.satopharma.com/recruitment/interview-calendar?week=2026-09-20&open=${zoom.id}`,
    "a name opens that interview on the calendar with its CV up",
  );
  assert.equal(interviewCalendarFilename(model, "pdf"), "interview-calendar-20-24-september-2026.pdf", "the file is named by its week, in words");
  assert.equal(interviewCalendarFilename(model, "xlsx"), "interview-calendar-20-24-september-2026.xlsx");

  // THE PDF — the owner's first choice, "I click on name the CV appear even in the export".
  const html = buildInterviewCalendarPdfHtml(model);
  for (const entry of [early, zoom]) {
    assert.ok(
      // `&amp;` because it is an attribute in HTML; Chromium decodes it back when it writes the PDF link.
      html.includes(`<a class="name" href="${bookingLink(model, entry).replace(/&/g, "&amp;")}">${entry.candidateName}</a>`),
      `${entry.candidateName}'s name is a link in the PDF`,
    );
  }
  assert.ok(html.includes("Karim &lt;b&gt;&quot;Adel&quot;&lt;/b&gt; &amp; Sons"), "a name is text, never markup");
  assert.ok(!html.includes(`<b>"Adel"</b>`), "so nothing a CV calls itself can draw into the document");
  assert.ok(html.includes("Week of: 20 September"), "headed the way the owner's sheet is");
  assert.ok(html.includes(`href="https://us06web.zoom.us/j/88012345678"`), "a Zoom interview carries its link");
  assert.ok(html.includes("border-radius: 0 !important"), "square edges, the house rule");
  assert.doesNotMatch(html, /border-radius:\s*[1-9]/, "and no corner is rounded anywhere");

  // THE WORKBOOK — every name a real hyperlink, in the grid AND in the list.
  const workbook = new ExcelJS.Workbook();
  const buffer = await buildInterviewCalendarWorkbook(model);
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const linksIn = (sheetName: string) => {
    const sheet = workbook.getWorksheet(sheetName);
    assert.ok(sheet, `the workbook has a ${sheetName} sheet`);
    const found: Array<{ text: string; hyperlink: string }> = [];
    sheet.eachRow((row) =>
      row.eachCell((cell) => {
        const value = cell.value as { hyperlink?: string; text?: unknown } | null;
        if (value && typeof value === "object" && typeof value.hyperlink === "string") {
          found.push({ hyperlink: value.hyperlink, text: String(value.text ?? "") });
        }
      }),
    );
    return found;
  };
  const gridLinks = linksIn("Week");
  for (const entry of [early, second, zoom]) {
    assert.ok(
      gridLinks.some((cell) => cell.hyperlink === bookingLink(model, entry) && cell.text.startsWith(entry.candidateName)),
      `${entry.candidateName} is a link in the week grid`,
    );
  }
  const listLinks = linksIn("Interviews");
  for (const entry of [early, second, zoom, late]) {
    assert.ok(
      listLinks.some((cell) => cell.hyperlink === bookingLink(model, entry) && cell.text === entry.candidateName),
      `${entry.candidateName} is a link in the list — the off-grid one included`,
    );
  }
}

// ── 7 · The wiring: every route gated, nothing sent to the candidate, a button on every CV ─────
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} still exists`);
  const next = source.indexOf("\nexport ", start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(process.cwd(), dir))) {
    const relative = `${dir}/${entry}`;
    if (statSync(join(process.cwd(), relative)).isDirectory()) out.push(...routeFiles(relative));
    else if (entry === "route.ts") out.push(relative);
  }
  return out;
}

function runWiringTests() {
  const domain = stripComments(read("src/lib/recruitment/interview-calendar.ts"));

  // The calendar's own gate is inside every domain function that writes or reads beyond the week.
  const gates: Record<string, "view" | "comment" | "book" | "share"> = {
    addInterviewComment: "comment",
    cancelInterviewBooking: "book",
    createInterviewBooking: "book",
    getInterviewCalendarCandidateFile: "view",
    listInterviewCalendarCandidateFiles: "view",
    listInterviewCalendarShares: "share",
    retryInterviewZoomMeeting: "book",
    searchInterviewCalendarPeople: "share",
    shareInterviewCalendar: "share",
    unshareInterviewCalendar: "share",
    updateInterviewBooking: "book",
  };
  for (const [name, need] of Object.entries(gates)) {
    assert.match(
      functionBody(domain, name),
      new RegExp(`requireInterviewCalendarRole\\(access, "${need}"\\)`),
      `${name} must pass the calendar's gate for "${need}"`,
    );
  }

  // Every route resolves who is asking, every write is same-origin first, and every handler reaches
  // a gate — its own, or the one inside the domain function it calls.
  const gatedCalls = [
    "requireInterviewCalendarRole(access,",
    "resolveInterviewCalendarRole(access)",
    ...Object.keys(gates).map((name) => `${name}(access`),
  ];
  const routes = routeFiles("app/api/recruitment/interview-calendar");
  assert.ok(routes.length >= 11, `the calendar's routes were found (${routes.length})`);
  for (const file of routes) {
    const source = stripComments(read(file));
    const handlers = source.split(/(?=export async function (?:GET|POST|PATCH|PUT|DELETE)\()/).slice(1);
    assert.ok(handlers.length > 0, `${file} exports a handler`);
    for (const handler of handlers) {
      const method = /export async function (\w+)/.exec(handler)?.[1] ?? "?";
      const where = `${file} ${method}`;
      const resolved = handler.indexOf("resolveAccessContext(request)");
      assert.ok(resolved > 0, `${where} must resolve who is asking`);
      if (method !== "GET") {
        const csrf = handler.indexOf("assertSameOriginMutation(request)");
        assert.ok(csrf > 0 && csrf < resolved, `${where} must refuse a cross-site write before anything else`);
      }
      assert.ok(gatedCalls.some((call) => handler.includes(call)), `${where} must reach the calendar's gate`);
    }
  }

  // THE CANDIDATE IS SENT NOTHING — the owner's answer. Only the person a calendar is shared with
  // hears about it, in the app.
  assert.doesNotMatch(domain, /@\/lib\/(email|whatsapp)|sendEmail|sendWhatsApp|resend/i, "the calendar sends no email or WhatsApp");
  assert.match(domain, /channels: \["in_app", "push"\]/, "the one notice is in-app to the person it was shared with");

  // The tables are service-role only.
  const migration = read("supabase/migrations/20260918195837_ats_interview_calendar.sql");
  for (const table of ["ats_interview_bookings", "ats_interview_calendar_shares", "ats_interview_booking_comments"]) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security;`), `${table} has RLS on`);
    assert.match(migration, new RegExp(`revoke all on table public\\.${table} from anon, authenticated;`), `${table} is closed to the browser key`);
  }
  assert.doesNotMatch(migration, /grant [^;]* to (anon|authenticated)/i, "and nothing grants it back");

  // A button that would answer "Forbidden" is worse than none.
  const button = stripComments(read("src/components/recruitment/interview-calendar/schedule-interview-button.tsx"));
  assert.match(button, /if \(!canBookInterviews\(me\.role\)\) return null;/, "the button draws only for someone who can book");

  // "from any screen, any CV".
  const surfaces: Array<[string, string]> = [
    ["src/components/recruitment/workstation/workstation-review-header.tsx", "screening"],
    ["src/components/recruitment/recruitment-workspace.tsx", "the recruitment profile and its CV previews"],
    ["src/components/recruitment/whatsapp-applicants-search.tsx", "WhatsApp Applicants"],
    ["src/components/recruitment/candidate-record-page.tsx", "the candidate's own page"],
    ["src/components/recruitment/candidate-folders-tab.tsx", "the folders' CV preview"],
    ["src/components/recruitment/manager-engagement-view.tsx", "the manager-engagement CV preview"],
    ["src/components/employee-portal/candidate-cv-actions.tsx", "the portal's CV preview"],
  ];
  for (const [file, where] of surfaces) {
    assert.match(stripComments(read(file)), /<ScheduleInterviewButton\b/, `${where} offers Schedule interview`);
  }
  const header = stripComments(read("src/components/recruitment/workstation/workstation-review-header.tsx"));
  const decisions = header.slice(header.indexOf("const decisions = ("), header.indexOf("const afterBands = ("));
  const linkedIn = decisions.indexOf('label="LinkedIn"');
  const schedule = decisions.indexOf('label="Schedule interview"');
  const shortlist = decisions.indexOf('label="Shortlist"');
  assert.ok(
    linkedIn > 0 && linkedIn < schedule && schedule < shortlist,
    "on screening it sits in the strip BOTH bands render, with the ways of reaching the person and before the verdicts",
  );
  assert.match(
    stripComments(read("src/components/recruitment/cv-preview-modal.tsx")),
    /\{headerActions\}/,
    "the CV preview draws what its caller hands it, which is how a preview anywhere gets the button",
  );
}
