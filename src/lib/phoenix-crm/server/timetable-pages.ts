import { validationError } from "@/lib/http/api-errors";
import type { PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { throwIfError } from "@/lib/phoenix-crm/server/db";
import { photoReachOf } from "@/lib/phoenix-crm/server/photos";
import type { ScheduleBoardReading } from "@/lib/phoenix-crm/server/schedule-check";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Pages 2 to 5 of a polyclinic's timetable (owner, 25 Nov 2026). The rules are in
// `timetable-pages-rules.ts`; this file reads and writes `phoenix_crm_timetable_pages`, keyed on the
// board's FIRST photo — so a board photographed again starts with no pages, and the old pages stay with
// the old photo for whoever reviews it.
//
// The write is `phoenix_crm_add_timetable_pages`, written once per board, after the seating or the
// timetable save has succeeded. It never fails the rep's save: the pages are evidence beside a verdict
// already written, so a failure is logged and the save stands.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export type TimetablePage = { path: string; pageNumber: number; reading: Record<string, unknown> | null };

/** Every extra page per first photo, in page order. A path with no pages is absent from the map. */
export async function timetablePagesOf(firstPaths: ReadonlyArray<string>, isTest?: boolean): Promise<Map<string, TimetablePage[]>> {
  const unique = [...new Set(firstPaths.filter((path) => typeof path === "string" && path.length > 0))];
  const out = new Map<string, TimetablePage[]>();
  if (unique.length === 0) return out;
  for (let start = 0; start < unique.length; start += 100) {
    let query = getSupabaseAdmin()
      .from("phoenix_crm_timetable_pages")
      .select("photo_path, first_photo_path, page_number, reading")
      .in("first_photo_path", unique.slice(start, start + 100))
      .order("page_number", { ascending: true });
    if (isTest !== undefined) query = query.eq("is_test", isTest);
    const { data, error } = await query;
    throwIfError(error);
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const first = String(row.first_photo_path);
      const list = out.get(first) ?? [];
      list.push({
        path: String(row.photo_path),
        pageNumber: Number(row.page_number),
        reading: row.reading && typeof row.reading === "object" ? (row.reading as Record<string, unknown>) : null,
      });
      out.set(first, list);
    }
  }
  return out;
}

/** The extra page paths of one board; an empty list on any failure, so a seating never stops on it. */
export async function timetableExtraPathsOf(firstPath: string | null, isTest: boolean): Promise<string[]> {
  if (!firstPath) return [];
  try {
    return ((await timetablePagesOf([firstPath], isTest)).get(firstPath) ?? []).map((page) => page.path);
  } catch {
    return [];
  }
}

/** The reading a page keeps: only a board the reader saw. An unread page keeps nothing, and is read again. */
export function pageReadingToStore(board: ScheduleBoardReading): Record<string, unknown> | null {
  if (board.kind !== "read") return null;
  const reading: Record<string, unknown> = { ...board };
  delete reading.kind;
  return reading;
}

/** A stored page reading back into the reader's shape, when it saw a board; null otherwise. */
export function storedPageReading(reading: Record<string, unknown> | null): ScheduleBoardReading | null {
  if (!reading) return null;
  const legibility = reading.legibility;
  if (legibility !== "clear" && legibility !== "partial" && legibility !== "unreadable") return null;
  const names = Array.isArray(reading.personNames) ? reading.personNames.filter((name): name is string => typeof name === "string") : [];
  const str = (value: unknown) => (typeof value === "string" && value.trim() ? value : null);
  return {
    kind: "read",
    croppedFraction: typeof reading.croppedFraction === "number" ? reading.croppedFraction : 0,
    hoursRead: str(reading.hoursRead),
    legibility,
    note: str(reading.note),
    personNames: names,
    problem: (str(reading.problem) as Extract<ScheduleBoardReading, { kind: "read" }>["problem"]) ?? null,
    schedulePresent: typeof reading.schedulePresent === "boolean" ? reading.schedulePresent : null,
    scheduleText: str(reading.scheduleText),
    ...(reading.uploaded === true ? { uploaded: true } : {}),
  };
}

/**
 * Write a board's extra pages, once. Void and never throws: it runs after the save succeeded, and a
 * failure here must not turn that save into an error the rep reads.
 */
export async function addTimetablePages(input: {
  seatId: string;
  actorHrId: string;
  isTest: boolean;
  sharedPlaceId: string;
  firstPhotoPath: string;
  pages: ReadonlyArray<{ path: string; board: ScheduleBoardReading | null }>;
  /**
   * The photos are ADDED to a board already on file, after its own pages (owner, 25 Nov 2026: "replace
   * the current timetable or ... add to what exists"), through `phoenix_crm_append_timetable_pages`.
   * Without it they are a fresh board's pages, written once.
   */
  append?: boolean;
}): Promise<void> {
  if (input.pages.length === 0) return;
  try {
    const { error } = await getSupabaseAdmin().rpc(input.append ? "phoenix_crm_append_timetable_pages" : "phoenix_crm_add_timetable_pages", {
      p: {
        seat_id: input.seatId,
        actor_hr_id: input.actorHrId,
        is_test: input.isTest,
        shared_place_id: input.sharedPlaceId,
        first_photo_path: input.firstPhotoPath,
        pages: input.pages.map((page) => ({ photo_path: page.path, reading: page.board ? pageReadingToStore(page.board) : null })),
      },
    });
    throwIfError(error);
  } catch (error) {
    console.error("[phoenix-crm] timetable pages were not saved", {
      append: input.append === true,
      firstPhotoPath: input.firstPhotoPath,
      message: error instanceof Error ? error.message : String(error),
      pages: input.pages.length,
    });
  }
}

/** Timetables asked for at once by a screen; the same ceiling the photo signing door keeps in spirit. */
const PAGES_BATCH_MAX = 200;

/**
 * The other photos of each timetable a screen shows, for this viewer: a first photo outside his reach
 * answers nothing, and so does each page outside it, so a page never reaches a screen that could not
 * sign it (one refused path blanks a whole signing batch).
 */
export async function timetablePagesForViewer(viewer: PhoenixCrmViewer, rawPaths: unknown): Promise<Record<string, string[]>> {
  const paths = [...new Set((Array.isArray(rawPaths) ? rawPaths : []).map((value) => String(value ?? "").trim()).filter(Boolean))];
  if (paths.length === 0) return {};
  if (paths.length > PAGES_BATCH_MAX) throw validationError(`Ask for at most ${PAGES_BATCH_MAX} timetables at a time.`);
  const mayShow = photoReachOf(viewer);
  const reachable = paths.filter((path) => mayShow(path));
  const out: Record<string, string[]> = {};
  for (const [first, pages] of await timetablePagesOf(reachable)) {
    const shown = pages.map((page) => page.path).filter((path) => mayShow(path));
    if (shown.length > 0) out[first] = shown;
  }
  return out;
}
