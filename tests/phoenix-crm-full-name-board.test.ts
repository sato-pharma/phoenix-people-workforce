import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — every row of "PM full names to check" opens on the customer's signboard and closes again.
 *
 * Owner, 2026-11-08: "to be able to accurate validate i need the collapse and expand on every row carrying a dr
 * name; if expanded the sign board photo with its validation data appear and if collapsed collapsed".
 *
 * What must hold:
 *   * the loader reads each held customer's ACTIVE places, through `selectByIds` (never one long `.in()`), with the
 *     photo, where the rep stood, who validated it and when, and the stored signboard and timetable readings — the
 *     same readers (`signboardOf`, `scheduleOf`) the validated-places list uses, so the words agree;
 *   * a customer seated in a polyclinic shows the venue's timetable photo beside the building's;
 *   * every row starts CLOSED, and the board and its photo are drawn only while that row is open, on the phone
 *     cards and the desktop table alike;
 *   * on the desktop the opened panel is the repo's one joined row-detail (`TableRowDetail`), and its toggle says
 *     which panel it controls.
 */

const ROOT = new URL("../", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, ROOT), "utf8");

export async function runPhoenixCrmFullNameBoardTests(): Promise<void> {
  // ── 1 · THE LOADER ────────────────────────────────────────────────────────────────────────────
  const service = stripComments(read("src/lib/phoenix-crm/server/full-name-reviews.ts"));
  const places = service.indexOf('"phoenix_crm_places"');
  assert.ok(places > -1, "the loader reads the held customers' places");
  const placesCall = service.slice(service.lastIndexOf("selectByIds<Row>(", places), service.indexOf(");", places));
  assert.ok(placesCall.includes('"customer_id"'), "by customer, through selectByIds' chunks");
  assert.ok(placesCall.includes('query.eq("status", "active")'), "🔴 RED only the places in use — a retired place is not the board he is judging");
  for (const column of ["photo_path", "photo_lat", "pin_lat", "created_by_hr_id", "created_at", "signboard_check", "shared_place_id", "schedule_check"]) {
    assert.ok(placesCall.includes(column), `the place read carries ${column}`);
  }
  assert.ok(!/\.in\(\s*"customer_id"/.test(service), "never a bare .in() of the held ids");
  assert.ok(service.includes('"phoenix_crm_shared_places"') && service.includes("schedule_photo_path"), "a seated customer's venue timetable photo is read");
  assert.ok(service.includes("signboard: signboardOf(place.signboard_check)"), "the signboard reading is the validated list's own reader");
  assert.ok(service.includes("schedule: scheduleOf(place.schedule_check)"), "and so is the timetable's");
  assert.ok(service.includes("seated: Boolean(place.shared_place_id)"), "seated is the place's own venue link");
  assert.ok(service.includes("boards: boardsByCustomer.get(String(row.id)) ?? []"), "every held row carries its boards");

  // ── 2 · THE SCREEN ────────────────────────────────────────────────────────────────────────────
  const screen = stripComments(read("src/components/phoenix-crm/full-name-checks.tsx"));
  assert.ok(screen.includes("useState<ReadonlySet<string>>(() => new Set())"), "🔴 RED every row starts closed");
  const phone = screen.slice(screen.indexOf("<CrmCardsOnPhone>"), screen.indexOf("</CrmCardsOnPhone>"));
  const table = screen.slice(screen.indexOf("<CrmTable"), screen.indexOf("</CrmTable>"));
  for (const [where, part] of [
    ["phone cards", phone],
    ["desktop table", table],
  ] as const) {
    assert.ok(part.includes("<BoardToggle"), `the ${where} have the Show / Hide toggle`);
    assert.ok(/open\.has\(row\.customerId\) \? (\(\s*)?<(BoardPanel|TableRowDetail)/.test(part), `🔴 RED the ${where} draw the board only while the row is open`);
  }
  assert.ok(table.includes("<TableRowDetail colSpan={4} id={panelId(row.customerId)}>"), "the desktop panel is the joined row-detail, spanning all four columns");
  assert.ok(!/<tr>\s*<td[^>]*colSpan/.test(table), "never a hand-written panel row");
  assert.ok(table.includes("controls={panelId(row.customerId)}"), "the desktop toggle names the panel it controls");
  assert.ok(screen.includes('{open ? "Hide the board" : "Show the board"}'), "the toggle says what it will do");
  assert.ok(screen.includes("path={board.photoPath}") && screen.includes("path={board.schedulePhotoPath}"), "the signboard photo, and the timetable for a seated customer");
  assert.ok(screen.includes("rotatable"), "turnable, as every Place checks photo is");
  assert.ok(screen.includes("placeSignboardText(board.signboard)") && screen.includes("PLACE_SCHEDULE_TEXT[board.schedule.verdict]"), "the reading in the validated list's own words");

  console.log("phoenix-crm full name board: OK");
}
