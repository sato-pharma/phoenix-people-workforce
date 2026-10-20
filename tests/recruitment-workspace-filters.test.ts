// Pins src/lib/recruitment/workspace/filters.ts — every workspace filter as the URL holds it and as the
// database filter receives it.
//
// Why each case matters:
//   * Filters "start clean on every visit" (owner, 20 Oct 2026): a clean filter set serialises to NO
//     query, so /recruitment with nothing after it is the clean view.
//   * A malformed value is DROPPED, never guessed — a typo in a shared link must not widen a filter.
//   * Received dates are CAIRO days. Cairo leaves summer time on the night of 29-30 October 2026
//     (UTC+3 -> UTC+2), so the 29th is a 25-hour day; a range computed with a fixed offset loses or
//     double-counts an hour of CVs there.
//   * "to" is inclusive: a to-date keeps the whole day, a to-time keeps its whole minute.
//   * The viewer's allowed tabs and the Talent Acquisition fence come from the SESSION. A URL that
//     names them changes nothing — otherwise a hand-edited link could unhide HR applicants.

import assert from "node:assert/strict";

import {
  activeFilterCount,
  cairoToday,
  cairoWallClockToUtc,
  emptyWorkspaceFilters,
  parseWorkspaceFilters,
  receivedRange,
  receivedRangeProblem,
  serializeWorkspaceFilters,
  workspaceDbParams,
  type WorkspaceFilters,
} from "../src/lib/recruitment/workspace/filters.ts";
import { NEEDS_PLACING, workspaceViewer } from "../src/lib/recruitment/workspace/role-tabs.ts";
import { OVERDUE_SENT_DAYS, OVERDUE_SHORTLIST_DAYS } from "../src/lib/recruitment/workspace/vocabulary.ts";

const FOLDER_ID = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
const CANDIDATE_ID = "6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b";

function range(overrides: Partial<WorkspaceFilters>, now: Date) {
  return receivedRange({ ...emptyWorkspaceFilters(), ...overrides }, now);
}

export function runRecruitmentWorkspaceFiltersTests() {
  // ── Clean means no query ──
  assert.equal(serializeWorkspaceFilters(emptyWorkspaceFilters()).toString(), "", "a clean visit has no query");
  assert.deepEqual(parseWorkspaceFilters(new URLSearchParams("")), emptyWorkspaceFilters());
  assert.equal(activeFilterCount(emptyWorkspaceFilters()), 0);

  // ── Round trip ──
  const full: WorkspaceFilters = {
    ...emptyWorkspaceFilters(),
    answers: { background: ["Pharmacy", "Science"], field_age_band: ["__missing__"] },
    archived: "include",
    area: "ALX-BHR",
    callResults: ["no_answer", "call_back"],
    candidate: CANDIDATE_ID,
    folderIds: [FOLDER_ID],
    fromDate: "2026-10-01",
    fromTime: "09:15",
    missing: true,
    overdue: false,
    region: "AB",
    returned: true,
    search: "ahmed 0100",
    sources: ["whatsapp", "interview_calendar"],
    statuses: ["new", "shortlisted"],
    tab: "medical_rep",
    toDate: "2026-10-20",
    toTime: "17:30",
  };
  const query = serializeWorkspaceFilters(full);
  assert.deepEqual(parseWorkspaceFilters(new URLSearchParams(query.toString())), full, "every filter survives the URL");
  // status, source, date, two answers, missing, call, returned, overdue, folder, archived, search.
  assert.equal(activeFilterCount(full), 12, "tab, place and the opened CV are not counted as filters");

  // A quick pick wins over a typed range, and the typed range is not written beside it.
  const picked = serializeWorkspaceFilters({ ...full, datePick: "last_7" });
  assert.equal(picked.get("date"), "last_7");
  assert.equal(picked.get("from"), null);
  assert.equal(picked.get("to"), null);

  // ── Malformed values are dropped, never guessed ──
  const junk = parseWorkspaceFilters(
    new URLSearchParams(
      [
        "tab=hr",
        "region=AB;drop",
        "status=new,deleted",
        "source=fax,email",
        "date=forever",
        "from=2026-02-30",
        "fromTime=09:00",
        "to=2026-10-20",
        "toTime=25:00",
        "call=maybe,interested",
        "folder=not-a-uuid," + FOLDER_ID,
        "archived=sometimes",
        "missing=perhaps",
        "candidate=42",
        "a.bad key=x",
        "a.background=",
      ].join("&"),
    ),
  );
  assert.equal(junk.tab, null, "an unknown tab is dropped");
  assert.equal(junk.region, null, "a region that is not a code is dropped");
  assert.deepEqual(junk.statuses, ["new"]);
  assert.deepEqual(junk.sources, ["email"]);
  assert.equal(junk.datePick, null);
  assert.equal(junk.fromDate, null, "30 February is not a date");
  assert.equal(junk.fromTime, null, "a time without its date is dropped");
  assert.equal(junk.toDate, "2026-10-20");
  assert.equal(junk.toTime, null, "25:00 is not a time");
  assert.deepEqual(junk.callResults, ["interested"]);
  assert.deepEqual(junk.folderIds, [FOLDER_ID]);
  assert.equal(junk.archived, "exclude", "an unknown archive mode falls back to hiding the archive");
  assert.equal(junk.missing, null);
  assert.equal(junk.candidate, null);
  assert.deepEqual(junk.answers, {}, "a malformed answer key, or an empty value list, is dropped");

  // ── Cairo days, across the end of summer time ──
  // 2 Nov 2026 is winter time (UTC+2); 27 Oct, seven days back, is still summer time (UTC+3).
  const nov2 = new Date("2026-11-02T10:00:00Z");
  assert.equal(cairoToday(nov2), "2026-11-02");
  assert.deepEqual(range({ datePick: "last_7" }, nov2), {
    from: "2026-10-26T21:00:00.000Z",
    to: "2026-11-02T22:00:00.000Z",
  }, "last 7 days = 27 Oct 00:00 (UTC+3) to the end of 2 Nov (UTC+2)");

  // The 29th is the 25-hour day: midnight to midnight spans the clock going back.
  assert.deepEqual(range({ fromDate: "2026-10-29", toDate: "2026-10-29" }, nov2), {
    from: "2026-10-28T21:00:00.000Z",
    to: "2026-10-29T22:00:00.000Z",
  }, "a to-date keeps its whole Cairo day, all 25 hours of it");
  assert.equal(
    Date.parse("2026-10-29T22:00:00.000Z") - Date.parse("2026-10-28T21:00:00.000Z"),
    25 * 3600_000,
  );

  // Summer time, mid-July (UTC+3).
  const july15 = new Date("2026-07-15T12:00:00Z");
  assert.deepEqual(range({ datePick: "today" }, july15), {
    from: "2026-07-14T21:00:00.000Z",
    to: "2026-07-15T21:00:00.000Z",
  });
  assert.deepEqual(range({ datePick: "yesterday" }, july15), {
    from: "2026-07-13T21:00:00.000Z",
    to: "2026-07-14T21:00:00.000Z",
  });
  assert.deepEqual(range({ datePick: "this_month" }, july15), {
    from: "2026-06-30T21:00:00.000Z",
    to: "2026-07-15T21:00:00.000Z",
  });
  assert.equal(range({ datePick: "last_30" }, july15).from, "2026-06-15T21:00:00.000Z");

  // Just after Cairo midnight is already "today" in Cairo while UTC still says yesterday.
  assert.equal(cairoToday(new Date("2026-07-14T21:30:00Z")), "2026-07-15");

  // Times: from-time starts at its minute; to-time keeps its whole minute.
  assert.deepEqual(
    range({ fromDate: "2026-07-15", fromTime: "09:15", toDate: "2026-07-15", toTime: "17:30" }, july15),
    { from: "2026-07-15T06:15:00.000Z", to: "2026-07-15T14:31:00.000Z" },
    "to 17:30 keeps a CV received at 17:30:59",
  );
  assert.equal(cairoWallClockToUtc("2026-07-15", "00:00").toISOString(), "2026-07-14T21:00:00.000Z");
  assert.equal(cairoWallClockToUtc("2026-11-15", "00:00").toISOString(), "2026-11-14T22:00:00.000Z");

  assert.deepEqual(range({}, july15), { from: null, to: null }, "no date filter is any time");
  assert.equal(
    receivedRangeProblem({ ...emptyWorkspaceFilters(), fromDate: "2026-07-16", toDate: "2026-07-15" }, july15),
    "The “to” date is before the “from” date.",
  );
  assert.equal(receivedRangeProblem({ ...emptyWorkspaceFilters(), fromDate: "2026-07-15", toDate: "2026-07-15" }, july15), null);

  // ── The database's p: the session decides the tabs and the fence, never the URL ──
  const ta = workspaceViewer({ role: "HR Resourcing", scope: "self" });
  const forged = parseWorkspaceFilters(
    new URLSearchParams("tab=hr_section_head&allowed_tabs=hr_section_head&hide_hr_people=false&q=sara"),
  );
  const p = workspaceDbParams(forged, ta, { now: july15 });
  assert.equal(p.hide_hr_people, true, "the fence comes from the session");
  assert.deepEqual(
    p.allowed_tabs,
    ["medical_rep", "district_manager", "product_manager", "rm_am_nsm", "office_coordinator", "other", NEEDS_PLACING],
    "allowed_tabs come from the session — the URL's are ignored",
  );
  assert.equal((p.allowed_tabs as string[]).includes("hr_section_head"), false);
  assert.equal(p.tab, "hr_section_head", "the tab asked for is passed on — and the database answers nothing for it");
  assert.equal(p.search, "sara");
  assert.equal(p.overdue_shortlist_days, OVERDUE_SHORTLIST_DAYS);
  assert.equal(p.overdue_sent_days, OVERDUE_SENT_DAYS);
  assert.equal(p.archived, "exclude");

  // Scope "all" — a search across every tab — drops the tab and its places.
  const placed = { ...emptyWorkspaceFilters(), area: "ALX-BHR", region: "AB", search: "sara", tab: "medical_rep" as const };
  const everywhere = workspaceDbParams(placed, ta, { scope: "all" });
  assert.equal("tab" in everywhere, false, "scope all drops the tab");
  assert.equal("region" in everywhere, false);
  assert.equal("area" in everywhere, false);
  const inTab = workspaceDbParams(placed, ta);
  assert.equal(inTab.tab, "medical_rep");
  assert.equal(inTab.region, "AB");
  assert.equal(inTab.area, "ALX-BHR");

  // No tab chosen = the viewer's first tab; Folders is not a tab filter.
  assert.equal(workspaceDbParams(emptyWorkspaceFilters(), ta).tab, "medical_rep");
  assert.equal("tab" in workspaceDbParams({ ...emptyWorkspaceFilters(), tab: "folders" }, ta), false);

  // Only what is set travels; the CV-text matches and the expanded folders arrive from the caller.
  const extras = workspaceDbParams(
    { ...emptyWorkspaceFilters(), answers: { background: ["Pharmacy"], salary: [] }, folderIds: [FOLDER_ID] },
    ta,
    { candidateIds: [CANDIDATE_ID], folderIdsExpanded: [FOLDER_ID, CANDIDATE_ID], searchIds: [CANDIDATE_ID] },
  );
  assert.deepEqual(extras.answers, { background: ["Pharmacy"] }, "an answer with no ticked value is not a filter");
  assert.deepEqual(extras.folder_ids, [FOLDER_ID, CANDIDATE_ID], "the subtree the caller expanded wins");
  assert.deepEqual(extras.search_ids, [CANDIDATE_ID]);
  assert.deepEqual(extras.candidate_ids, [CANDIDATE_ID]);
  assert.equal("statuses" in extras, false);
  assert.equal("from" in extras, false);
}
