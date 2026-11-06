/**
 * Phoenix CRM — the comments and the recommendations written on a place check.
 *
 * Owner, 13 October 2026: "In every district manager account, build a tab in his sidebar that shows
 * the check places only for his team and make him able to comment. And when he comes to comment, he
 * can choose the rep see the comment or the rep doesn't see the comment. He can recommend to validate,
 * or he can recommend to not validate. But the final is for the system administrator only. But don't
 * show this on the screen."
 *
 * So:
 *   · TWO writers — the Super Admin (`system_admin`) and the district manager above that rep
 *     (`manager`), and the manager only on his own team's seats (`teamPlaceChecksSeats`);
 *   · TWO things written — a comment, many per subject, each carrying whether the rep may read it;
 *     and ONE recommendation per subject per manager, replaced when he changes his mind;
 *   · NOTHING decided. The decision is `canDecideValidationReviews` — the Super Admin alone (owner,
 *     2026-10-03) — and no screen a manager opens says who decides or that anything waits on anybody.
 *
 * 🔴 THE REP'S SIDE IS THE ONE DOOR IN GOLDEN RULE #1, AND IT IS EXACTLY THIS WIDE. Until today nothing
 * a rep received named a person (owner, 2026-10-03: "do not show the rep that a person is accepting or
 * rejecting"). A note marked visible now reaches him — attributed by ROLE and never by name
 * (`placeNoteRepAuthorText`), SILENTLY on the customer: no in-app bell, no Telegram, no email, no
 * badge (his own choice, 2026-10-13). Nothing else about a check moved into his sight, and a note he
 * may not read never leaves the server: `loadRepVisiblePlaceNotes` filters on `rep_visible` in the
 * query, because a field a browser receives counts as shown.
 *
 * 🔴 AND A COMMENT WRITTEN WITH A DECISION COMES THROUGH THIS SAME DOOR, ALWAYS VISIBLE (owner,
 * 2026-11-01: "when sfe or admin reject or approve validation and write the comment this comment appear
 * to the rep and his manager"). `tellDecisionComment` below, on every approve, reject and take-back.
 */

import { forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { formatPhoenixDateTime } from "@/lib/i18n/format";
import { logError } from "@/lib/observability/log";
import { cleanText } from "@/lib/phoenix-crm/entry-rules";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import {
  parsePlaceNoteAdvice,
  parsePlaceNoteSource,
  type PlaceCheckIntegrityIndex,
  parsePlaceNoteSubjectKind,
  parsePlaceRecommendation,
  placeNoteAuthorLabel,
  placeNoteReachesManager,
  placeNoteRepAuthorText,
  placeNoteSubjectKey,
  PLACE_NOTE_MAX_LENGTH,
  PLACE_NOTE_REQUIRED,
  PLACE_NOTE_VISIBILITY_REQUIRED,
  PLACE_RECOMMENDATION_REQUIRED,
  type PlaceNoteAdvice,
  type PlaceNoteSource,
  type PlaceNoteSubjectKind,
  type PlaceRecommendation,
} from "@/lib/phoenix-crm/place-note-rules";
import {
  canDecideValidationReviews,
  readsTeamPlaceChecks,
  teamPlaceChecksSeats,
  type PhoenixCrmViewer,
} from "@/lib/phoenix-crm/server/access";
import { selectByIds, throwIfError } from "@/lib/phoenix-crm/server/db";
import { readEveryPage } from "@/lib/phoenix-crm/server/paged-read";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

function text(value: unknown): string | null {
  const cleaned = typeof value === "string" ? value.trim() : "";
  return cleaned ? cleaned : null;
}

// ── What either board reads ─────────────────────────────────────────────────────────────────────

/** One comment, as the Super Admin's board and a manager's board both draw it. */
export type PlaceNoteView = {
  noteId: string;
  source: PlaceNoteSource;
  /** "Fatma Saeed · District Manager" — the writer, for a reader who may see every note. */
  authorLabel: string;
  body: string;
  /** Whether the rep may read this one. Both boards say which it is, on every row. */
  repVisible: boolean;
  writtenAtText: string;
  /** The verdict a System Administrator's by-eye note closes on; null on every other note. */
  advice: PlaceNoteAdvice | null;
};

/** One manager's recommendation on a subject. It decides nothing — see the module header. */
export type PlaceRecommendationView = {
  managerName: string;
  recommendation: PlaceRecommendation;
  decidedAtText: string;
};

/**
 * Every comment and every recommendation on this page's subjects, keyed by `placeNoteSubjectKey`.
 *
 * 🔴 ONE READ FOR THE WHOLE PAGE, NOT A FIELD ON FOUR ROW TYPES. The Place checks page already makes
 * four section reads, each with its own paging, caps and `capped` flag; threading notes through all
 * four would have made every one of them carry a join it does not need, and the venue section's rows
 * come from a different table again. A flat record the board hands down costs two queries and changed
 * no loader's shape.
 */
export type PlaceNoteIndex = {
  notes: Record<string, PlaceNoteView[]>;
  recommendations: Record<string, PlaceRecommendationView[]>;
  /**
   * The device evidence on each subject — the integrity cases the system holds on that place.
   *
   * 🔴 IT IS LOADED BY `loadPlaceCheckIntegrity` IN `server/integrity-board.ts`, NEVER HERE, and the
   * page merges the two. That file is where a read of the evidence belongs (its own header draws the
   * line), so this index carries the result and names the table nowhere. The district manager reads it
   * by the owner's own word, 2026-10-13: "system and device evidence the dm can see".
   */
  integrity: PlaceCheckIntegrityIndex;
};

export const EMPTY_PLACE_NOTE_INDEX: PlaceNoteIndex = { integrity: {}, notes: {}, recommendations: {} };

/**
 * The comments and recommendations on a set of places and venues, newest comment first and the
 * recommendations newest first with them.
 *
 * It reads by id through `selectByIds`, never a bare `.in()`: the validated-in-use section alone goes
 * past 600 rows on production, and a 400-id `.in()` has already overflowed the response headers on
 * this very page (`UND_ERR_HEADERS_OVERFLOW`, 2026-10-07).
 *
 * 🔴 ON A MANAGER'S BOARD THE ADMINISTRATOR'S PRIVATE NOTES ARE DROPPED HERE, ON THE SERVER, BECAUSE A
 * FIELD A BROWSER RECEIVES COUNTS AS SHOWN (`placeNoteReachesManager`), and the `advice` verdict is not
 * even read for that board. Only the two Place checks pages call this, and a test pins which is which.
 */
export async function loadPlaceNoteIndex(
  input: {
    placeIds: ReadonlyArray<string>;
    sharedPlaceIds: ReadonlyArray<string>;
  },
  // 🔴 A district manager's board names nobody above him (owner, 2026-10-13), so it gets the writer's
  // ROLE alone on a System Administrator's comment — and the name never leaves the server for him.
  options: { managerBoard?: boolean } = {},
): Promise<PlaceNoteIndex> {
  const placeIds = [...new Set(input.placeIds.filter((id) => isUuid(id)))];
  const sharedPlaceIds = [...new Set(input.sharedPlaceIds.filter((id) => isUuid(id)))];
  if (placeIds.length === 0 && sharedPlaceIds.length === 0) return EMPTY_PLACE_NOTE_INDEX;

  const noteColumns = "id, place_id, shared_place_id, author_hr_id, author_source, body, rep_visible, created_at, advice";
  const columnsToRead = options.managerBoard ? noteColumns.replace(", advice", "") : noteColumns;
  const recColumns = "id, place_id, shared_place_id, manager_hr_id, recommendation, updated_at";
  const [placeNotes, venueNotes, placeRecs, venueRecs] = await Promise.all([
    selectByIds<Row>("phoenix_crm_place_notes", columnsToRead, "place_id", placeIds),
    selectByIds<Row>("phoenix_crm_place_notes", columnsToRead, "shared_place_id", sharedPlaceIds),
    selectByIds<Row>("phoenix_crm_place_recommendations", recColumns, "place_id", placeIds),
    selectByIds<Row>("phoenix_crm_place_recommendations", recColumns, "shared_place_id", sharedPlaceIds),
  ]);

  const noteRows = [...placeNotes, ...venueNotes].filter((row) => !options.managerBoard || placeNoteReachesManager(row.author_source, row.rep_visible));
  const recRows = [...placeRecs, ...venueRecs];
  const names = await loadPeopleNames([
    ...noteRows.map((row) => text(row.author_hr_id)),
    ...recRows.map((row) => text(row.manager_hr_id)),
  ]);

  const notes: Record<string, PlaceNoteView[]> = {};
  for (const row of noteRows.sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))) {
    const key = subjectKeyOf(row);
    if (!key) continue;
    const source = parsePlaceNoteSource(row.author_source);
    // A source the code does not know is a row written by something newer than this build. It is
    // skipped rather than guessed at: the label it would carry is the one thing a rep may be told.
    if (!source) continue;
    (notes[key] ??= []).push({
      advice: source === "system_admin" ? parsePlaceNoteAdvice(row.advice) : null,
      authorLabel: placeNoteAuthorLabel(
        source,
        text(row.author_hr_id) && !(options.managerBoard && source === "system_admin") ? nameOf(names, text(row.author_hr_id), "") || null : null,
      ),
      body: String(row.body ?? ""),
      noteId: String(row.id),
      repVisible: row.rep_visible === true,
      source,
      writtenAtText: formatPhoenixDateTime(String(row.created_at)),
    });
  }

  const recommendations: Record<string, PlaceRecommendationView[]> = {};
  for (const row of recRows.sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))) {
    const key = subjectKeyOf(row);
    const recommendation = parsePlaceRecommendation(row.recommendation);
    if (!key || !recommendation) continue;
    (recommendations[key] ??= []).push({
      decidedAtText: formatPhoenixDateTime(String(row.updated_at)),
      managerName: nameOf(names, text(row.manager_hr_id), "A manager"),
      recommendation,
    });
  }

  return { integrity: {}, notes, recommendations };
}

function subjectKeyOf(row: Row): string | null {
  const placeId = text(row.place_id);
  if (placeId) return placeNoteSubjectKey("place", placeId);
  const venueId = text(row.shared_place_id);
  return venueId ? placeNoteSubjectKey("shared_place", venueId) : null;
}

// ── What the rep reads on his own customer ──────────────────────────────────────────────────────

/**
 * One comment the rep may read, on his own customer. A ROLE and the words — nothing else. `aboutBuilding`
 * is the polyclinic or centre it was written about, when it was written about the building.
 */
export type RepPlaceNote = { noteId: string; authorText: string; body: string; writtenAtText: string; aboutBuilding: string | null };

/**
 * The visible comments on one territory's customers, newest first — the rep's own read.
 *
 * 🔴 `rep_visible` IS IN THE QUERY, NOT IN A `.filter()` AFTER IT, AND NOT IN THE COMPONENT. A field a
 * browser receives counts as shown even when React draws nothing from it (audit, 2026-10-02), so a
 * note he may not read must never be in the payload at all. The partial index
 * `phoenix_crm_place_notes_rep_idx` serves exactly this predicate.
 *
 * It carries no author name, no hr id, no recommendation and no decision — a recommendation is a
 * judgement about his work and is never his (golden rule #1, the boundary being whose work it is).
 */
export async function loadRepVisiblePlaceNotes(seatId: string, isTest: boolean): Promise<Map<string, RepPlaceNote[]>> {
  const { rows, error } = await readEveryPage<Row>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_place_notes")
        .select("id, customer_id, author_source, body, created_at")
        .eq("seat_id", seatId)
        .eq("is_test", isTest)
        .eq("rep_visible", true)
        .not("customer_id", "is", null)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false }),
    {
      maxRows: 5_000,
      // It PRESENTS, it does not judge — and newest first means a ceiling loses only the oldest
      // comments, the ones he has already read.
      whenFull: "stop",
      what: "The comments written to this territory's rep",
      uniqueBy: (row) => String(row.id),
    },
  );
  throwIfError(error);
  const byCustomer = new Map<string, RepPlaceNote[]>();
  for (const row of rows) {
    const customerId = text(row.customer_id);
    const source = parsePlaceNoteSource(row.author_source);
    if (!customerId || !source) continue;
    const list = byCustomer.get(customerId) ?? [];
    list.push({
      aboutBuilding: null,
      authorText: placeNoteRepAuthorText(source),
      body: String(row.body ?? ""),
      noteId: String(row.id),
      writtenAtText: formatPhoenixDateTime(String(row.created_at)),
    });
    byCustomer.set(customerId, list);
  }
  return byCustomer;
}

/** How long a comment on a building nobody is seated in stays in To validate — it has no customer to sit on. */
const EMPTY_BUILDING_NOTE_DAYS = 30;

/**
 * The visible comments on one territory's polyclinics and centres.
 *
 * A building comment has no customer of its own, so it reaches the rep two ways, each comment once per
 * screen: on the card of every customer ever seated there — a rejected building's places are retired,
 * not deleted, so its customers still carry it — and, for a building with nobody seated, in To validate
 * for 30 days. 62 of the 96 buildings rejected by 2026-11-01 had no customer at all, so reading only the
 * first way would tell most of them nothing.
 */
export async function loadRepVisibleBuildingNotes(
  seatId: string,
  isTest: boolean,
): Promise<{ byCustomer: Map<string, RepPlaceNote[]>; withNoCustomer: RepPlaceNote[] }> {
  const { rows, error } = await readEveryPage<Row>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_place_notes")
        .select("id, shared_place_id, author_source, body, created_at")
        .eq("seat_id", seatId)
        .eq("is_test", isTest)
        .eq("rep_visible", true)
        .not("shared_place_id", "is", null)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false }),
    { maxRows: 5_000, whenFull: "stop", what: "The comments written about this territory's buildings", uniqueBy: (row) => String(row.id) },
  );
  throwIfError(error);
  const byCustomer = new Map<string, RepPlaceNote[]>();
  const withNoCustomer: RepPlaceNote[] = [];
  if (rows.length === 0) return { byCustomer, withNoCustomer };

  const buildingIds = [...new Set(rows.map((row) => String(row.shared_place_id)))];
  const [buildings, seated] = await Promise.all([
    selectByIds<Row>("phoenix_crm_shared_places", "id, name", "id", buildingIds),
    selectByIds<Row>("phoenix_crm_places", "customer_id, shared_place_id, seat_id", "shared_place_id", buildingIds),
  ]);
  const nameOfBuilding = new Map(buildings.map((row) => [String(row.id), String(row.name ?? "")]));
  const customersOf = new Map<string, Set<string>>();
  for (const row of seated) {
    const customerId = text(row.customer_id);
    if (!customerId || row.seat_id !== seatId) continue;
    const buildingId = String(row.shared_place_id);
    customersOf.set(buildingId, (customersOf.get(buildingId) ?? new Set<string>()).add(customerId));
  }

  const oldest = Date.now() - EMPTY_BUILDING_NOTE_DAYS * 24 * 60 * 60 * 1_000;
  for (const row of rows) {
    const source = parsePlaceNoteSource(row.author_source);
    if (!source) continue;
    const buildingId = String(row.shared_place_id);
    const note: RepPlaceNote = {
      aboutBuilding: nameOfBuilding.get(buildingId) || null,
      authorText: placeNoteRepAuthorText(source),
      body: String(row.body ?? ""),
      noteId: String(row.id),
      writtenAtText: formatPhoenixDateTime(String(row.created_at)),
    };
    const customers = customersOf.get(buildingId);
    if (!customers) {
      if (new Date(String(row.created_at)).getTime() >= oldest) withNoCustomer.push(note);
      continue;
    }
    for (const customerId of customers) byCustomer.set(customerId, [...(byCustomer.get(customerId) ?? []), note]);
  }
  return { byCustomer, withNoCustomer };
}

// ── Writing one ─────────────────────────────────────────────────────────────────────────────────

/** The subject a write is about, once it has been read back from its own table and allowed. */
type Subject = {
  kind: PlaceNoteSubjectKind;
  id: string;
  seatId: string;
  isTest: boolean;
  /** Null for a venue: it is a building, on nobody's list. */
  customerId: string | null;
};

/**
 * Who this writer is on this subject, or a refusal.
 *
 * 🔴 THE SEAT IS RE-READ FROM THE SUBJECT'S OWN ROW, NEVER TAKEN FROM THE REQUEST. The screen knows
 * which seat a row belongs to, and a screen is not an authority: the whole point of the manager's
 * board is that it shows his team only, so the server asks the place which team it is in and compares
 * that against his own seats.
 */
async function subjectFor(viewer: PhoenixCrmViewer, kind: PlaceNoteSubjectKind, id: string): Promise<{ subject: Subject; source: PlaceNoteSource }> {
  const table = kind === "place" ? "phoenix_crm_places" : "phoenix_crm_shared_places";
  const columns = kind === "place" ? "id, seat_id, is_test, customer_id" : "id, seat_id, is_test";
  const { data, error } = await getSupabaseAdmin().from(table).select(columns).eq("id", id).maybeSingle();
  throwIfError(error);
  const row = data as Row | null;
  if (!row) throw notFoundError("This place is no longer there. Reload the page.");
  const subject: Subject = {
    customerId: kind === "place" ? text(row.customer_id) : null,
    id,
    isTest: row.is_test === true,
    kind,
    seatId: String(row.seat_id ?? ""),
  };

  if (canDecideValidationReviews(viewer)) return { source: "system_admin", subject };
  if (!readsTeamPlaceChecks(viewer)) throw forbiddenError("These place checks are not yours to comment on.");
  const mine = new Set(teamPlaceChecksSeats(viewer).map((seat) => seat.seatId));
  if (!mine.has(subject.seatId)) throw forbiddenError("This place belongs to another district.");
  return { source: "manager", subject };
}

/**
 * Write one comment on a place check, with the writer's own choice of whether the rep may read it.
 *
 * `repVisible` is REQUIRED and has no default on either side of the wire — the screen asks it as two
 * buttons the writer presses, and the column is NOT NULL with no default, so a comment typed in a
 * hurry can never reach the field because nobody chose.
 */
export async function savePlaceNote(viewer: PhoenixCrmViewer, raw: unknown): Promise<{ noteId: string }> {
  const body = (raw && typeof raw === "object" ? raw : {}) as Row;
  const kind = parsePlaceNoteSubjectKind(body.subjectKind);
  if (!kind || !isUuid(body.subjectId)) throw validationError("Choose the place to comment on.");
  const comment = cleanText(body.body, PLACE_NOTE_MAX_LENGTH);
  if (!comment) throw validationError(PLACE_NOTE_REQUIRED);
  if (typeof body.repVisible !== "boolean") throw validationError(PLACE_NOTE_VISIBILITY_REQUIRED);
  const subjectId = String(body.subjectId).toLowerCase();

  const { source, subject } = await subjectFor(viewer, kind, subjectId);
  const inserted = await getSupabaseAdmin()
    .from("phoenix_crm_place_notes")
    .insert({
      author_hr_id: viewer.hrId,
      author_source: source,
      body: comment,
      customer_id: subject.customerId,
      is_test: subject.isTest,
      place_id: kind === "place" ? subject.id : null,
      rep_visible: body.repVisible,
      seat_id: subject.seatId,
      shared_place_id: kind === "shared_place" ? subject.id : null,
    })
    .select("id")
    .single();
  throwIfError(inserted.error);
  // 🔴 NOTHING IS SENT. A visible comment waits on the customer in his app and no channel carries it
  // (owner, 2026-10-13, asked directly: "silent, on the place"). A bell about a place being checked is
  // the exact thing golden rule #1 keeps off his phone, and `notifyPhoenixCrm` is deliberately not
  // imported here so a later edit cannot add one without noticing this comment.
  return { noteId: String((inserted.data as Row).id) };
}

/**
 * The comment written WITH an approval, a refusal or a take-back, as a comment the rep and the district
 * manager above him read (owner, 2026-11-01). The one write above, never a second path: same role
 * wording, same silence, the seat re-read from the subject's own row. An empty comment writes nothing.
 *
 * Never throws: the decision is already committed, and the words stay in its own `decision_note`.
 */
export async function tellDecisionComment(viewer: PhoenixCrmViewer, subjectKind: PlaceNoteSubjectKind, subjectId: string, comment: unknown): Promise<void> {
  if (!cleanText(comment, PLACE_NOTE_MAX_LENGTH)) return;
  try {
    await savePlaceNote(viewer, { body: comment, repVisible: true, subjectId, subjectKind });
  } catch (error) {
    logError("Phoenix CRM decision comment could not reach the rep", { error, labels: { event: "phoenix_crm_decision_comment_failed" } });
  }
}

/**
 * Record, or change, one manager's recommendation on a place check.
 *
 * 🔴 IT WRITES A RECOMMENDATION AND NOTHING ELSE — no status moves, no place is retired, no customer
 * is reopened, nothing is notified, and `phoenix_crm_validation_reviews` is not touched. The decision
 * is the Super Admin's alone, and this row is only what the manager thinks about it.
 */
export async function savePlaceRecommendation(
  viewer: PhoenixCrmViewer,
  raw: unknown,
): Promise<{ recommendation: PlaceRecommendation }> {
  const body = (raw && typeof raw === "object" ? raw : {}) as Row;
  const kind = parsePlaceNoteSubjectKind(body.subjectKind);
  if (!kind || !isUuid(body.subjectId)) throw validationError("Choose the place to recommend on.");
  const recommendation = parsePlaceRecommendation(body.recommendation);
  if (!recommendation) throw validationError(PLACE_RECOMMENDATION_REQUIRED);
  const subjectId = String(body.subjectId).toLowerCase();

  const { subject } = await subjectFor(viewer, kind, subjectId);
  const upserted = await getSupabaseAdmin()
    .from("phoenix_crm_place_recommendations")
    .upsert(
      {
        customer_id: subject.customerId,
        is_test: subject.isTest,
        manager_hr_id: viewer.hrId,
        place_id: kind === "place" ? subject.id : null,
        recommendation,
        seat_id: subject.seatId,
        shared_place_id: kind === "shared_place" ? subject.id : null,
        updated_at: new Date().toISOString(),
      },
      // One unique index per subject kind, so the conflict target names the columns of the kind being
      // written: a venue save conflicts on (shared_place_id, manager_hr_id) and would not match the
      // place index at all. 🔴 NEITHER INDEX IS PARTIAL, deliberately — PostgREST's `on_conflict=`
      // emits bare column names, and Postgres can infer a PARTIAL index only when the inference
      // specification repeats its predicate, so `where place_id is not null` would fail every save
      // here. The migration carries the whole reasoning.
      { onConflict: kind === "place" ? "place_id,manager_hr_id" : "shared_place_id,manager_hr_id" },
    )
    .select("id")
    .single();
  throwIfError(upserted.error);
  return { recommendation };
}
