import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { judgeSchedule, scheduleDoorAction, scheduleUnjudged, type PhoenixCrmScheduleCheck } from "../src/lib/phoenix-crm/schedule-rules.ts";
import { parseSeatedPlaceDraft } from "../src/lib/phoenix-crm/shared-place-rules.ts";
import {
  addedPagesRefusal,
  bestTimetablePageCheck,
  extraPageRefusal,
  parseAddedPhotoPaths,
  parseExtraPhotoPaths,
  TIMETABLE_ADD_TO_ON_FILE,
  TIMETABLE_EXTRA_PAGES_MAX,
  TIMETABLE_FULL,
  TIMETABLE_TOO_MANY_PAGES,
  timetablePhotosLeft,
} from "../src/lib/phoenix-crm/timetable-pages-rules.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * A polyclinic's TIMETABLE MAY BE SEVERAL PHOTOS, AND A DOCTOR NAMED ON ANY ONE OF THEM IS NAMED ON IT
 * (owner, 25 Nov 2026: "make the rep able to upload multiple photos for a timetable … and every photo
 * appear … he can validate 1, 2, 3 doctors in one timetable if it has their name").
 *
 * Each pin here would break silently: judging only the first photo would hold every doctor whose name is
 * on the second as "not on the timetable", a lost read ranked below a clear board without his name would
 * hold a doctor the night could still find, and pages taken without a fresh first photo would hang a
 * second board's pages on a building's old one.
 */

function code(path: string): string {
  return stripComments(readFileSync(path, "utf8").replace(/\r\n/g, "\n"));
}

function board(personNames: string[], extra: Partial<Parameters<typeof judgeSchedule>[0]> = {}) {
  return {
    croppedFraction: 0.08,
    hoursRead: null,
    legibility: "clear" as const,
    note: null,
    personNames,
    problem: null,
    schedulePresent: true,
    scheduleText: personNames.join(" · "),
    ...extra,
  };
}

function judged(customerName: string, reading: ReturnType<typeof board>): PhoenixCrmScheduleCheck {
  return judgeSchedule({ ...reading, customerName });
}

export async function runPhoenixCrmTimetablePagesTests(): Promise<void> {
  const doctor = "أحمد محمود السيد";
  const page1 = board(["محمد علي حسن", "سارة إبراهيم فؤاد"]);
  const page2 = board(["أحمد محمود السيد", "منى كمال عبد الله"]);

  // 1 ─ The doctor on the SECOND photo is named on the timetable.
  const onlyFirst = judged(doctor, page1);
  assert.equal(onlyFirst.verdict, "other_name", "the first photo alone does not name him — the case this feature exists for");
  assert.equal(scheduleDoorAction(onlyFirst, 0).kind, "hold", "and judged on it alone he would be held as not on the timetable");
  const both = bestTimetablePageCheck([judged(doctor, page1), judged(doctor, page2)]);
  assert.ok(both, "two pages give one verdict");
  assert.equal(both.verdict, "match", "🔴 a doctor named on ANY photo of the timetable is named on it");
  assert.equal(both.page, 2, "and the verdict says which photo named him");
  assert.equal(both.pages, 2, "and how many photos there were");
  assert.equal(scheduleDoorAction(both, 0).kind, "save", "so the door saves him, validated, instead of holding him");
  assert.ok(
    both.personNames.includes("محمد علي حسن") && both.personNames.includes("منى كمال عبد الله"),
    "every page's names are kept on the record, so the reviewer sees the whole board",
  );
  const other = bestTimetablePageCheck([judged("سارة إبراهيم فؤاد", page1), judged("سارة إبراهيم فؤاد", page2)]);
  assert.equal(other?.verdict, "match", "one board validates several doctors: the doctor on the first photo too");
  assert.equal(other?.page, 1);

  // 2 ─ One photo keeps exactly the record it always had.
  const single = judged(doctor, page2);
  assert.equal(bestTimetablePageCheck([single]), single, "a one-photo board is returned untouched");
  assert.equal(single.page, undefined, "and carries no page marks");
  assert.equal(bestTimetablePageCheck([]), null);

  // 3 ─ The order of what speaks for him: a lost read outranks a clear board without his name.
  const lost = scheduleUnjudged("call_failed");
  const unreadable = judged(doctor, board([], { legibility: "unreadable", schedulePresent: null, scheduleText: null }));
  const wall = judged(doctor, board([], { schedulePresent: false, scheduleText: null, problem: "not_a_timetable" }));
  const screen = judged(doctor, board(["أحمد محمود السيد"], { problem: "on_a_screen" }));
  assert.equal(unreadable.verdict, "unjudged");
  assert.equal(wall.verdict, "no_schedule");
  assert.equal(screen.verdict, "no_schedule");
  assert.equal(bestTimetablePageCheck([onlyFirst, lost])?.reason, "call_failed", "🔴 a page nobody could read may hold his name: the door saves on it, as on one photo");
  assert.equal(scheduleDoorAction(bestTimetablePageCheck([onlyFirst, lost]) as PhoenixCrmScheduleCheck, 0).kind, "save");
  assert.equal(bestTimetablePageCheck([unreadable, onlyFirst])?.verdict, "other_name", "a clear board without him says more than an unreadable one");
  assert.equal(bestTimetablePageCheck([wall, unreadable])?.verdict, "unjudged", "an unreadable timetable says more than no timetable");
  assert.equal(bestTimetablePageCheck([wall, screen])?.problem, "on_a_screen", "a timetable on a screen still holds for the administrator rather than being refused");
  assert.equal(
    bestTimetablePageCheck([screen, judged(doctor, page2)])?.verdict,
    "match",
    "a live photo naming him validates beside a screen photo; the screen photo never validates by itself",
  );
  assert.equal(scheduleDoorAction(bestTimetablePageCheck([wall, wall]) as PhoenixCrmScheduleCheck, 0).kind, "retake", "no timetable on any photo is still refused");

  // 4 ─ The extra photos the phone sends.
  assert.deepEqual(parseExtraPhotoPaths(["b.jpg", " c.jpg ", "b.jpg", "a.jpg", ""], "a.jpg"), { ok: true, paths: ["b.jpg", "c.jpg"] }, "unique, trimmed, never the first photo");
  assert.deepEqual(parseExtraPhotoPaths(["b.jpg"], null), { ok: true, paths: [] }, "🔴 no fresh first photo, no pages: a reused board keeps its own");
  assert.deepEqual(parseExtraPhotoPaths("b.jpg", "a.jpg"), { ok: true, paths: [] });
  assert.equal(TIMETABLE_EXTRA_PAGES_MAX, 4, "five photos in all, the database's own CHECK (page_number between 2 and 5)");
  assert.deepEqual(parseExtraPhotoPaths(["1", "2", "3", "4", "5"], "a.jpg"), { ok: false, error: TIMETABLE_TOO_MANY_PAGES });
  assert.equal(extraPageRefusal(3, "This photo shows no timetable."), "Timetable photo 3: This photo shows no timetable.");

  const draftBody = { sharedPlaceId: "3f4a1b2c-5d6e-4f70-8a9b-0c1d2e3f4a5b", timings: [{ weekday: 6, start: "10:00" }] };
  const fresh = parseSeatedPlaceDraft({ ...draftBody, photoPath: "a.jpg", extraPhotoPaths: ["b.jpg"] });
  assert.ok(fresh.ok && fresh.value.extraPhotoPaths.length === 1, "a seating carries the other photos of a fresh board");
  const reused = parseSeatedPlaceDraft({ ...draftBody, photoPath: null, extraPhotoPaths: ["b.jpg"] });
  assert.ok(reused.ok && reused.value.extraPhotoPaths.length === 0, "and none on a reused board");
  assert.equal(parseSeatedPlaceDraft({ ...draftBody, photoPath: "a.jpg", extraPhotoPaths: ["1", "2", "3", "4", "5"] }).ok, false);

  // 5 ─ Both doors judge on every photo, and only a fresh board's pages are written.
  const list = code("src/lib/phoenix-crm/server/list.ts");
  assert.ok(list.includes("readTimetableBoards({") && list.includes("judgeTimetableBoards(boards, subject.name)"), "the seating door reads and judges every photo");
  assert.ok(!list.includes("readPlaceSchedule("), "and never the first photo alone");
  assert.equal(list.split("await addTimetablePages(").length - 1, 2, "Validate and Add another clinic each keep the pages after their save");
  assert.ok(
    list.includes("const newPaths = append ? seatedPhoto.addedPaths : seatedPhoto.extraPaths;"),
    "a fresh board's pages are kept, and on a reused board only the photos ADDED to it, never its own pages again",
  );
  const venue = code("src/lib/phoenix-crm/server/venue-timetable.ts");
  assert.ok(!venue.includes("judgeScheduleBoard("), "the building's own settle and the night judge on every photo too");
  assert.equal(venue.split("judgeTimetableBoards(boards, name)").length - 1, 2);
  const shared = code("src/lib/phoenix-crm/server/shared-places.ts");
  assert.ok(
    shared.includes("return { path: venue.schedulePhotoPath, reused: true, extraPaths: venue.scheduleExtraPhotoPaths, addedPaths };"),
    "a reused board brings its own pages from the server",
  );

  // 6 ─ Every photo appears where the timetable does.
  for (const screen of [
    "src/components/phoenix-crm/shared-place-list-evidence.tsx",
    "src/components/phoenix-crm/shared-place-customers-evidence.tsx",
    "src/components/phoenix-crm/validation-review-queue.tsx",
    "src/components/phoenix-crm/validated-place-list.tsx",
    "src/components/place-review-deck/review-deck-slides.tsx",
  ]) {
    assert.ok(code(screen).includes("<TimetablePages"), `${screen} draws the timetable's other photos`);
  }
  for (const camera of ["src/components/phoenix-crm/shared-place-screens.tsx", "src/components/phoenix-crm/venue-timetable-screen.tsx"]) {
    assert.ok(code(camera).includes("<TimetableExtraPhotos"), `${camera} offers another photo of the timetable`);
  }

  // 7 ─ 🔴 ADD TO THE TIMETABLE ON FILE, OR REPLACE IT — HIS CHOICE (owner, 25 Nov 2026: "The timetable
  // uploaded is already correct. I don't want to replace it ... replace the current timetable or ... add
  // to what exists"). Breaking any pin below sends the rep back to retaking a correct board.
  assert.deepEqual(parseAddedPhotoPaths(["b.jpg", " c.jpg ", "b.jpg", ""], null), { ok: true, paths: ["b.jpg", "c.jpg"] }, "unique and trimmed");
  assert.deepEqual(parseAddedPhotoPaths(["b.jpg"], "a.jpg"), { ok: true, paths: [] }, "🔴 never beside a fresh first photo: that is a replacement");
  assert.deepEqual(parseAddedPhotoPaths(["1", "2", "3", "4", "5"], null), { ok: false, error: TIMETABLE_TOO_MANY_PAGES });
  assert.equal(addedPagesRefusal(0, 4), null, "a one-photo board takes four more");
  assert.equal(addedPagesRefusal(3, 1), null);
  assert.equal(addedPagesRefusal(4, 1), TIMETABLE_FULL, "five photos in all, the database's own CHECK");
  assert.equal(addedPagesRefusal(1, 4), TIMETABLE_FULL);
  assert.equal(addedPagesRefusal(4, 0), null, "a full board still seats a doctor against it");
  assert.equal(timetablePhotosLeft(1), 4);
  assert.equal(timetablePhotosLeft(5), 0);
  assert.equal(timetablePhotosLeft(0), 4, "a count that never arrived is read as the one photo on file");
  const adding = parseSeatedPlaceDraft({ ...draftBody, photoPath: null, addedPhotoPaths: ["n.jpg"] });
  assert.ok(adding.ok && adding.value.addedPhotoPaths.length === 1 && adding.value.photoPath === null, "a seating against the board on file carries the photos added to it");
  const replacing = parseSeatedPlaceDraft({ ...draftBody, photoPath: "a.jpg", addedPhotoPaths: ["n.jpg"] });
  assert.ok(replacing.ok && replacing.value.addedPhotoPaths.length === 0, "and a replacement carries none");

  assert.ok(list.includes("addedPhotoPaths: seatedPhoto.addedPaths,"), "the seating door reads the added photos after the board's own");
  assert.equal(list.split("timetablePages = { append: scanned.append,").length - 1, 2, "both seating doors append, never add a second set of pages");
  const pagesWriter = code("src/lib/phoenix-crm/server/timetable-pages.ts");
  assert.ok(pagesWriter.includes(`input.append ? "phoenix_crm_append_timetable_pages" : "phoenix_crm_add_timetable_pages"`), "an append goes to its own function");
  assert.ok(venue.includes(`callPhoenixCrm<Row>("phoenix_crm_append_timetable_pages"`), "the building's own door adds photos too, and answers its refusals");
  assert.ok(venue.includes(`.neq("schedule_check->>verdict", "match")`), "🔴 a doctor already matched keeps his verdict; every other one is read again");
  assert.ok(!venue.slice(venue.indexOf("export async function addVenueTimetablePages")).includes("phoenix_crm_set_venue_timetable"), "and it never replaces the board");
  assert.ok(code("app/api/phoenix-crm/shared-places/route.ts").includes(`body?.action === "timetable_pages"`));
  for (const screen of [
    "src/components/phoenix-crm/shared-place-screens.tsx",
    "src/components/phoenix-crm/list-customer.tsx",
  ]) {
    const drawn = code(screen);
    assert.ok(drawn.includes("{TIMETABLE_ADD_TO_ON_FILE}") && drawn.includes("SEATED_PLACE_PHOTO_REPLACE"), `${screen} offers both: add to the timetable, or replace it`);
  }
  assert.ok(code("src/components/phoenix-crm/venue-timetable-screen.tsx").includes(`action: "timetable_pages"`), "the building's screen adds in add mode");
  assert.equal(TIMETABLE_ADD_TO_ON_FILE, "Add a photo to this timetable");
  const migration = readFileSync("supabase/migrations/20261125234726_phoenix_crm_append_timetable_pages.sql", "utf8");
  assert.ok(migration.includes("raise exception 'phoenix_crm:timetable_changed'"), "photos are added only to the board on file at that moment");
  assert.ok(migration.includes("coalesce(max(tp.page_number), 1)"), "numbered after the pages already there");
  assert.ok(migration.includes("revoke execute on function public.phoenix_crm_append_timetable_pages(jsonb) from public, anon, authenticated;"), "never callable from the browser");
}
