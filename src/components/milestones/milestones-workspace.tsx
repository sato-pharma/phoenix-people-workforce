"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  milestoneGroupCitation,
  resolveMilestoneGroupOccasion,
  MILESTONE_GROUP_MAX,
  type MilestoneGroupOccasion,
  type MilestoneGroupRow,
} from "@/lib/milestones/group";
import {
  cardFirstName,
  formatPlainDateIso,
  formatPlainDateLong,
  milestoneCitation,
  milestoneDate,
  parseMilestoneSpec,
  parsePlainDate,
  type MilestoneSpec,
  type PlainDate,
} from "@/lib/milestones/periods";
import { employeeProfileImageForHrId } from "@/lib/employees/profile-images";
import { documentScriptNonce, withScriptNonce } from "@/lib/security/csp-nonce";
import type { MilestoneCandidate, MilestoneDueEntry, MilestonePrintHistoryEntry } from "@/lib/milestones/service";
import {
  phxFieldClassName,
  phxSelectClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";

/**
 * Milestones — the workspace.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * TWO HALVES, IN THE ORDER THE WORK HAPPENS. Who is coming up, then the card for the one you
 * picked. The list is the reason to open the page at all: a first month is easy to miss, and by
 * the time somebody mentions it the day has gone.
 *
 * 🔴 THE TICK LIST FEEDS TWO DIFFERENT ACTS, AND THEY ARE NOT SPELLINGS OF EACH OTHER. "Print N
 * cards" is a stack to print and hand out — one card per page, in one PDF. "One picture of all N" is
 * a SINGLE landscape sheet with every face on it, for a group who share one occasion, because a
 * five-page PDF is not something anybody can send ("I want to make a photo that has them all" — the
 * owner, 2026-09-30). The second holds one occasion only, and the rule deciding that is imported
 * from the domain, never restated here, so the button and the route can never disagree.
 *
 * 🔴 THE LIST IS A SHORTCUT, NEVER THE ONLY WAY IN. A name box over the whole active roster sits
 * at the top of the card panel, so a card can be made for anybody at any time — the thirty-day
 * window answers "who is coming up", not "who am I allowed to print". Clicking a row in the list
 * is the same act as typing the name.
 *
 * 🔴 NOTHING IS ASKED FOR THAT THE SYSTEM ALREADY KNOWS. The date, the name and the sentence
 * arrive WORKED OUT — from the hire date, the HR record and the period — and are then editable.
 * The owner's rule, in his own words: "it shows it and I have the option then to edit it, but
 * don't let me [start] from scratch." They are re-worked whenever the person or the period
 * changes; an edit he makes himself survives until one of those two changes underneath it.
 *
 * 🔒 NO HORIZONTAL SCROLL, desktop and mobile. The due list is `table-fixed` over a `<colgroup>`
 * on desktop and stacked cards below `sm`, the preview is an iframe SCALED to whatever width it
 * is given rather than a fixed-width sheet in a sideways-scrolling box, and every corner is square.
 *
 * 🔒 NO ELLIPSIS. A long Egyptian name wraps; it is never cut off with a `…`.
 *
 * THE PREVIEW IS THE REAL ARTWORK, not a mock-up of it — the same HTML the PDF path prints, laid
 * out by the browser showing it. It is still not the deliverable: only the PDF is, because only
 * the PDF has been through Chromium's print path at the page size a printer will use.
 */

const PRESETS: { value: string; label: string }[] = [
  // `0d` is the hire date itself — the first day as a member of the family. It leads the list
  // because it is the first thing that happens to anybody here; `1d` would be their second morning.
  { value: "0d", label: "First day" },
  { value: "1m", label: "First month" },
  { value: "3m", label: "Three months" },
  { value: "6m", label: "Six months" },
  { value: "1y", label: "First year" },
  { value: "2y", label: "Two years" },
  { value: "3y", label: "Three years" },
  { value: "5y", label: "Five years" },
  { value: "10y", label: "Ten years" },
  { value: "custom", label: "A period I type" },
];

const VARIANTS: { value: string; label: string; hint: string }[] = [
  { value: "trim", label: "A4", hint: "The sheet, exactly A4. For a good printer." },
  { value: "safe", label: "Office printer", hint: "The same artwork at 92%, so no margin eats the bands." },
  { value: "bleed", label: "Print shop", hint: "216 × 303 mm with 3 mm bleed and crop marks." },
];

/** The card's own page, in CSS pixels, so the preview can be scaled to any container. */
const SHEET_W = 794;
const SHEET_H = 1123;

/**
 * The GROUP picture's page — the same A4 sheet, turned.
 *
 * Landscape, because a row of faces reads across. The preview pane therefore has to be TOLD which
 * sheet it is showing: it scales the iframe to its own container, and a landscape sheet scaled
 * against the portrait width would be cropped on the right with no scroll bar to reveal it.
 */
const GROUP_SHEET_W = SHEET_H;
const GROUP_SHEET_H = SHEET_W;

/**
 * Where the portrait window sits on the photograph, and how far in — the card's own
 * `PortraitFocus`, with the identical meaning on both sides of the wire.
 */
type Focus = { x: number; y: number; zoom: number };

const CENTRE: Focus = { x: 0.5, y: 0.5, zoom: 1 };

/** The card prints its portrait 4:5, and the box that frames it has to be the same shape. */
const FRAME_RATIO = "4 / 5";
const FRAME_ASPECT = 4 / 5;

/**
 * 🔴 HOW FAR THE PICTURE MAY BE ENLARGED, AND WHY IT MAY BE ENLARGED AT ALL.
 *
 * A picture scaled to exactly cover the frame overhangs it in ONE axis only — the other is
 * already shown edge to edge, with nothing beyond the frame to pull into view. Dragging that axis
 * moves nothing, which looks broken rather than geometric: "I need dragging up, down, left, right,
 * and any place I want" (the owner, 2026-09-23). Making the picture larger than the frame gives
 * BOTH axes something hidden to travel through, and that is the only way free dragging exists.
 *
 * The ceiling is the card route's, so a framing is refused here rather than in flight. Past it a
 * phone photograph is enlarged further than it can carry and the printed card shows mush.
 */
const MAX_ZOOM = 4;

/** The same ceiling the card route enforces, so a picture is refused here rather than in flight. */
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

/** The employee-photo endpoint's own 5 MB ceiling — checked here so saving fails before the upload. */
const MAX_RECORD_PHOTO_BYTES = 5 * 1024 * 1024;

/**
 * Whether the ticked rows may share one picture, and if not, exactly why — in the ROUTE'S OWN WORDS.
 *
 * 🔴 THE RULE IS IMPORTED, NEVER RESTATED HERE. `resolveMilestoneGroupOccasion` is pure — it reaches
 * only `periods.ts`, no I/O — so the button and the route decide from the same function and can never
 * disagree about what is allowed, and the reason shown under the button is the same sentence the
 * route would have returned. A second copy of this rule in the client is how a button ends up enabled
 * for a set the server refuses, or greyed out for a set it would happily print.
 */
type GroupCheck = {
  ok: boolean;
  reason: string;
  /**
   * The one occasion the ticked rows share, carried back so the sentence under the date is worked
   * out from the SAME resolution the button was enabled by — never from a second reading of the
   * rows, which could disagree with it.
   */
  occasion: MilestoneGroupOccasion | null;
  dates: PlainDate[];
};

function groupPictureCheck(rows: readonly MilestoneDueEntry[]): GroupCheck {
  const no = (reason: string): GroupCheck => ({ ok: false, reason, occasion: null, dates: [] });
  if (rows.length === 0) return no("Tick the people who share the occasion.");
  const resolved: MilestoneGroupRow[] = [];
  for (const entry of rows) {
    const on = parsePlainDate(entry.on);
    if (!on) return no(`${entry.displayName} has no usable date on that row.`);
    resolved.push({ periodSpec: entry.spec, on, displayName: entry.displayName });
  }
  try {
    return {
      ok: true,
      reason: "",
      occasion: resolveMilestoneGroupOccasion(resolved),
      dates: resolved.map((row) => row.on),
    };
  } catch (cause) {
    return no(cause instanceof Error ? cause.message : "Those rows cannot share one picture.");
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * How big the picture is rendered, as a MULTIPLE OF THE FRAME in each axis.
 *
 * Both numbers are at least the zoom and never below 1, so the frame is always filled. Expressed
 * as multiples rather than pixels on purpose: the frame's own size never enters the arithmetic, so
 * nothing has to be measured, nothing has to be re-measured when the column reflows, and the same
 * two numbers drive the CSS directly. It is `coverSize` from the portrait module, in the units CSS
 * happens to want.
 */
function coverFill(natural: { w: number; h: number } | null, zoom: number): { w: number; h: number } {
  if (!natural || natural.w <= 0 || natural.h <= 0) return { w: zoom, h: zoom };
  const ratio = natural.w / natural.h;
  return ratio >= FRAME_ASPECT
    ? { w: (zoom * ratio) / FRAME_ASPECT, h: zoom }
    : { w: zoom, h: (zoom * FRAME_ASPECT) / ratio };
}

/**
 * The picture's offset inside the frame, as a per-cent of ITS OWN size — which is what a CSS
 * `translate` per-cent means.
 *
 * The hidden part of an axis is `fill - 1` frames wide, so as a fraction of the picture it is
 * `1 - 1/fill`. A focus of 0 sits flush to that edge and 1 flush to the far one, so the offset is
 * that fraction times the focus, pulled back (negative) to move the picture the other way.
 */
function fillOffset(fill: number, focus: number): string {
  if (!Number.isFinite(fill) || fill <= 1) return "0%";
  return `${-(1 - 1 / fill) * clamp01(focus) * 100}%`;
}

function longDate(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function whenText(daysAway: number): string {
  if (daysAway === 0) return "Today";
  if (daysAway === 1) return "Tomorrow";
  if (daysAway === -1) return "Yesterday";
  if (daysAway > 0) return `In ${daysAway} days`;
  return `${Math.abs(daysAway)} days ago`;
}

/** `b4` → 4, else null. A birthday period is not a `MilestoneSpec`; the server dates it. */
function birthdayOrdinalOf(period: string): number | null {
  const match = /^b(\d+)$/i.exec(period.trim());
  if (!match) return null;
  const ordinal = Number(match[1]);
  return Number.isInteger(ordinal) && ordinal >= 1 ? ordinal : null;
}

/** A stable key for one occurrence, so a tick and a printed mark line up across a refresh. */
function entryKey(entry: MilestoneDueEntry): string {
  return `${entry.hrId}-${entry.spec}-${entry.on}`;
}

/** "1st", "2nd", "23rd" — for the birthday note only; the card itself is worded server-side. */
function ordinalLabel(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

type Props = {
  candidates: MilestoneCandidate[];
  initialEntries: MilestoneDueEntry[];
  initialFrom: string;
  initialTo: string;
  canExport: boolean;
  /** From a calendar deep link — open on this person and period. */
  initialHrId?: string | null;
  initialPeriod?: string | null;
};

export function MilestonesWorkspace({
  candidates,
  initialEntries,
  initialFrom,
  initialTo,
  canExport,
  initialHrId,
  initialPeriod,
}: Props) {
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [entries, setEntries] = useState(initialEntries);
  const [loadingList, setLoadingList] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 🔴 A DEEP LINK SEEDS THE PICKER, AND `custom` MUST BE SEEDED WITH IT. A four-year or a birthday
  // link (`period=4y`, `period=b4`) is not a preset, so it lands in the "A period I type" slot — and
  // if `custom` were left empty the card would silently print a first-month one instead. A birthday
  // row picked from the list is the same case: `b4` is not a preset either.
  const seedPeriod = (initialPeriod ?? "").trim() || initialEntries[0]?.spec || "1m";
  const seedIsPreset = PRESETS.some((option) => option.value === seedPeriod);
  const [selectedHrId, setSelectedHrId] = useState(
    (initialHrId ?? "").trim() || initialEntries[0]?.hrId || "",
  );
  const [preset, setPreset] = useState(seedIsPreset ? seedPeriod : "custom");
  const [custom, setCustom] = useState(seedIsPreset ? "" : seedPeriod);
  const [variant, setVariant] = useState("trim");
  const [withoutPhoto, setWithoutPhoto] = useState(false);

  // ── WHAT HE TYPED, NOT WHAT IS SHOWN ────────────────────────────────────────────────────────
  // `null` means "he has not touched this one", and the field then shows the worked-out value.
  // Holding the OVERRIDE rather than the value is what makes the whole rule one line each: a
  // field follows the arithmetic until it is typed into, and the moment the person or the period
  // changes these go back to null and the arithmetic takes over again.
  //
  // It is deliberately not an effect that writes the computed value into state. That is the
  // shape this was first written in, and `react-hooks/set-state-in-effect` is right to refuse it:
  // it costs a second render every time anything changes, and it needs a separate ref to remember
  // whether he had typed — a second copy of a fact these three already hold.
  const [dateEdit, setDateEdit] = useState<string | null>(null);
  const [nameEdit, setNameEdit] = useState<string | null>(null);
  const [citationEdit, setCitationEdit] = useState<string | null>(null);

  // ── THE NAMES HE HAS CORRECTED, KEPT PER PERSON ──────────────────────────────────────────────
  //
  // 🔴 `nameEdit` ALONE CANNOT REACH A GROUP PICTURE, AND THAT IS WHY THIS EXISTS. It holds ONE
  // correction — the selected person's — and `resetFields` clears it the moment he clicks the next
  // name, which is exactly what he must do to correct five of them. So a group picture built from
  // `nameEdit` would carry at most the last name he touched and print the other four off the record:
  // HR-009's record reads "Yasmeena Khaled Ahmed Hussein Elsafory" where the card he approved says
  // "Yasmeen Khaled Elsafory" (owner, 2026-09-30 — "carry the edited name … into the group picture").
  //
  // Keyed by HR id, so it survives moving between people; a correction he clears goes back to the
  // record rather than printing an empty name. It lives in the page and dies with it — nothing here
  // is written to the employee record, which is HR's act on HR's own screen.
  const [nameOverrides, setNameOverrides] = useState<Record<string, string>>({});

  /** Remember a correction against the person it was typed for, and forget an emptied one. */
  const editName = useCallback((hrId: string, value: string) => {
    setNameEdit(value);
    if (!hrId) return;
    setNameOverrides((current) => {
      const next = { ...current };
      if (value.trim()) next[hrId] = value.trim();
      else delete next[hrId];
      return next;
    });
  }, []);

  // ── THE GROUP PICTURE'S OWN SENTENCE ─────────────────────────────────────────────────────────
  //
  // 🔴 SEPARATE FROM `citationEdit` ON PURPOSE. The single card's sentence names ONE person ("On the
  // thirtieth of September, Yasmeen completes five years…") and would be a lie on a sheet carrying
  // five faces. The group's sentence is about the OCCASION and names nobody, so the two can never be
  // the same string and must never share a box.
  const [groupCitationEdit, setGroupCitationEdit] = useState<string | null>(null);

  // ── WHERE THE PHOTOGRAPH SITS INSIDE ITS FRAME ──────────────────────────────────────────────
  // The same override shape, for the same reason. `focusEdit` is what he dragged; `focusDefault`
  // is where the card is already printing it, read from the server because only sharp knows what
  // its own `attention` crop chose. Until he drags, NOTHING is sent — an untouched card goes down
  // the identical path it always did, rather than a path that merely agrees with it.
  const [focusEdit, setFocusEdit] = useState<Focus | null>(null);
  const [focusDefault, setFocusDefault] = useState<Focus | null>(null);
  const dragFrom = useRef<{ x: number; y: number; focus: Focus } | null>(null);
  // The picture's own pixel dimensions, read off it once it has loaded. Everything about how far
  // it may travel follows from its shape against the frame's, and only the picture knows its shape.
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  // Resizing is opened by hand and starts closed: the picture prints at its own size unless
  // somebody decides otherwise.
  const [resizing, setResizing] = useState(false);

  // ── A PHOTOGRAPH BROUGHT FROM SOMEWHERE ELSE ────────────────────────────────────────────────
  // 🔴 MOST PEOPLE HAVE NEVER PUT A PHOTOGRAPH ON PHOENIX, and a card is exactly the moment that
  // matters — "if someone is not putting the photo, from where I will get his photo" (the owner,
  // 2026-09-23). So a picture can be handed in here, and it also overrides one the record already
  // holds, because a keepsake somebody takes home deserves better than a building-pass snapshot.
  //
  // It lives in this page and dies with it. Nothing is written to the employee record and nothing
  // reaches the photo bucket: changing what the directory holds is HR's act on HR's own screen.
  const [upload, setUpload] = useState<{ dataUri: string; name: string } | null>(null);
  const uploadInput = useRef<HTMLInputElement | null>(null);

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  /** Which sheet the preview pane is currently showing — the single card's, or the group's. */
  const [previewSheet, setPreviewSheet] = useState<{ w: number; h: number }>({ w: SHEET_W, h: SHEET_H });
  const [busy, setBusy] = useState<
    "preview" | "download" | "picture" | "batch" | "group" | "group-pdf" | "group-preview" | null
  >(null);

  // ── WHICH ROWS ARE TICKED FOR A BATCH ────────────────────────────────────────────────────────
  // Keyed by occurrence, so a tick survives a refresh that reorders the list, and so the same
  // person on two occasions ticks independently.
  const [ticked, setTicked] = useState<Set<string>>(new Set());

  // ── THE PRINT HISTORY ──────────────────────────────────────────────────────────────────────────
  // Change (2026-09-23): the record milestone_card_prints, read back. Collapsed and lazy — the log
  // is a look-back, not the reason to open the page, so it costs nothing until it is opened.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<MilestonePrintHistoryEntry[] | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  // The window the table and the export both read. Empty means the server's default (last 90 days
  // through today, Cairo). `applied` is the window the shown rows actually belong to, so the caption
  // and the "Reset" affordance describe what is on screen, not what is typed but not yet applied.
  const [historyFrom, setHistoryFrom] = useState("");
  const [historyTo, setHistoryTo] = useState("");
  const [historyApplied, setHistoryApplied] = useState<{ from: string; to: string } | null>(null);

  /** "from 1 September 2026 to 20 September 2026" — the window the rows on screen actually belong
   *  to, read back from the server's own answer rather than the (possibly half-typed) inputs. Null
   *  when nothing has loaded yet, so callers fall back to naming the default 90-day window instead. */
  const historyRangeCaption = useMemo(() => {
    if (!historyApplied) return null;
    const from = parsePlainDate(historyApplied.from);
    const to = parsePlainDate(historyApplied.to);
    if (!from || !to) return null;
    return `from ${formatPlainDateLong(from)} to ${formatPlainDateLong(to)}`;
  }, [historyApplied]);

  // ── A PHOTOGRAPH SAVED BACK TO THE RECORD ────────────────────────────────────────────────────
  // Change 5: a handed-in picture can be written to the employee's Phoenix record — the ORIGINAL
  // bytes, never the polished crop, because the polish bakes in a grade and vignette that would be a
  // forgery on an HR record. Tracked so the button reads "Saved" without a full remount.
  const [savedPhotoFor, setSavedPhotoFor] = useState<string | null>(null);
  const [savingPhoto, setSavingPhoto] = useState(false);

  const frameBox = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);

  // ── "I HAVE SEEN WHO IS COMING UP" ───────────────────────────────────────────────────────────
  // Change 3: opening the page is the acknowledgement that stops the daily reminder. Fired ONCE per
  // mount, ref-guarded because React StrictMode double-invokes effects in development, with an empty
  // dependency array so it is the act of opening — not a later refresh — that marks the window seen.
  // Fire-and-forget and silent: if it fails, tomorrow reminds him again, which is the safe direction.
  // The route takes no list; it re-derives the window server-side.
  const seenFired = useRef(false);
  useEffect(() => {
    if (seenFired.current) return;
    seenFired.current = true;
    void fetch("/api/milestones/seen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }).catch(() => {
      /* tomorrow reminds him again */
    });
  }, []);

  // The preview scales to its container rather than the container scrolling to the preview. It
  // re-measures when the SHEET changes too, not only when the container does — a landscape group
  // picture and a portrait card are scaled against different widths.
  useEffect(() => {
    const node = frameBox.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setScale(node.clientWidth / previewSheet.w));
    observer.observe(node);
    setScale(node.clientWidth / previewSheet.w);
    return () => observer.disconnect();
  }, [previewSheet.w]);

  // A blob URL outlives the component unless it is revoked by hand.
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  const period = preset === "custom" ? custom.trim() : preset;

  const selected = useMemo(
    () => candidates.find((row) => row.hrId === selectedHrId) ?? null,
    [candidates, selectedHrId],
  );

  // The period as the arithmetic understands it, or null while a typed one is still half-written.
  // A half-written period must not wipe a worked-out date, so every pass below stops at null.
  const spec = useMemo<MilestoneSpec | null>(() => {
    try {
      return parseMilestoneSpec(period);
    } catch {
      return null;
    }
  }, [period]);

  const hireDate = useMemo(() => parsePlainDate(selected?.hireDate), [selected]);

  // A birthday period (`b4`) is not a `MilestoneSpec` — the server dates it from the birth date and
  // the tenure, which this screen does not hold — so it is recognised here and left to the server.
  const birthdayOrdinal = useMemo(() => birthdayOrdinalOf(period), [period]);

  // Everything the card needs is in hand. A hire date is not optional: the service dates the
  // milestone from it and refuses without one, so the buttons say so by being unavailable rather
  // than by returning an error after the click. A birthday is ready on the hire date alone — the
  // day it falls on is worked out server-side.
  const ready = Boolean(selected && hireDate && (spec || birthdayOrdinal !== null));

  // ── The date and the name arrive worked out ───────────────────────────────────────────────
  // Derived during the render that needs them, never written into state. `?? ` is the whole of
  // "his edit wins": an untouched field shows the arithmetic, a touched one shows what he typed.
  const dateValue = dateEdit ?? (hireDate && spec ? formatPlainDateIso(milestoneDate(hireDate, spec)) : "");
  // A correction he has already made for THIS person wins over the record, so clicking back to a name
  // he fixed shows the fix rather than silently reverting — and the single card then prints the same
  // name the group picture does. Without this the two would disagree about one person on one screen.
  const nameValue = nameEdit ?? nameOverrides[selectedHrId] ?? selected?.displayName ?? "";

  // ── And the sentence follows both ─────────────────────────────────────────────────────────
  // The citation names the person and the day, so correcting either has to reach it. HR-009's
  // record reads "Yasmeena"; the card the owner approved says "Yasmeen". Without this the script
  // name would be corrected and the sentence underneath would still say the other one.
  const citationValue = useMemo(() => {
    if (citationEdit !== null) return citationEdit;
    const on = parsePlainDate(dateValue);
    if (!spec || !on) return "";
    const name = nameValue.trim() || selected?.displayName || "";
    return milestoneCitation({ firstName: cardFirstName(name), spec, on });
  }, [citationEdit, dateValue, nameValue, selected, spec]);

  const body = useMemo(
    () => ({
      hrId: selectedHrId,
      period,
      on: dateValue || undefined,
      displayName: nameValue.trim() || undefined,
      citation: citationValue.trim() || undefined,
      withoutPhoto,
      variant,
      photoFocus: focusEdit ?? undefined,
      photoUpload: upload?.dataUri,
    }),
    [
      selectedHrId,
      period,
      dateValue,
      nameValue,
      citationValue,
      withoutPhoto,
      variant,
      focusEdit,
      upload,
    ],
  );

  // What the framing box shows: his drag, else where the card already prints it, else the middle
  // while the answer is still in flight.
  const focusValue = focusEdit ?? focusDefault ?? CENTRE;

  // What the card will actually print, which is not always what the record holds: an uploaded
  // picture comes first; then the uploaded record photo; then the bundled static photo — the same
  // order the card now resolves (loadMilestonePhotoBytes), so the framing box previews whatever the
  // card will cut. Before this the box gated on `hasPhoto` alone and went dark for a static-photo
  // employee, even though the card prints their face — the preview lied about the picture.
  const photoSrc = upload
    ? upload.dataUri
    : selected?.hasPhoto
      ? `/api/employees/${encodeURIComponent(selectedHrId)}/photo`
      : employeeProfileImageForHrId(selectedHrId);
  const showFraming = Boolean(photoSrc) && !withoutPhoto;

  // How big the picture is drawn, in frames. At zoom 1 it exactly covers; above 1 it overhangs in
  // both axes, which is what a drag travels through.
  const fill = coverFill(natural, focusValue.zoom);

  const refreshList = useCallback(async () => {
    setLoadingList(true);
    setError(null);
    try {
      const response = await fetch(`/api/milestones/due?from=${from}&to=${to}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error ?? "The milestone list could not be read.");
      setEntries(payload.entries as MilestoneDueEntry[]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The milestone list could not be read.");
    } finally {
      setLoadingList(false);
    }
  }, [from, to]);

  const clearPreview = useCallback(() => {
    setPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return null;
    });
  }, []);

  /**
   * A different person or a different period is a DIFFERENT CARD, so the three fields go back to
   * what the system works out. This is the one place that happens, and it is an event handler
   * rather than an effect: it is a consequence of the click, not of the render.
   */
  const resetFields = useCallback(() => {
    setDateEdit(null);
    setNameEdit(null);
    setCitationEdit(null);
    setFocusEdit(null);
    setFocusDefault(null);
    setNatural(null);
    setResizing(false);
    // A handed-in photograph belongs to the person it was handed in for. Carrying it to the next
    // name would put one person's face on another person's card, which is the one mistake on this
    // page that cannot be taken back once it is printed and given to somebody.
    setUpload(null);
    if (uploadInput.current) uploadInput.current.value = "";
    clearPreview();
  }, [clearPreview]);

  /**
   * Take a picture off the disk.
   *
   * Read as a data URI rather than posted as a form: the card route already speaks JSON, the URI
   * carries its own type, and the same string is what the framing box shows — so the picture he is
   * dragging is byte-for-byte the picture the server will cut. `sharp` is the judge of whether the
   * bytes are really an image; this only refuses what is obviously too heavy to carry.
   */
  const takeUpload = useCallback(
    (file: File | null | undefined) => {
      if (!file) return;
      if (file.size > MAX_UPLOAD_BYTES) {
        setError("That picture is larger than 12 MB. Send a smaller copy of it.");
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUri = typeof reader.result === "string" ? reader.result : "";
        if (!dataUri.startsWith("data:image/")) {
          setError("That file is not a picture.");
          return;
        }
        setError(null);
        setUpload({ dataUri, name: file.name });
        // A new picture is framed from scratch: the old crop, and the old shape it was worked out
        // against, both belonged to the old photograph.
        setFocusEdit(null);
        setFocusDefault(null);
        setNatural(null);
    setResizing(false);
        clearPreview();
      };
      reader.onerror = () => setError("That picture could not be read.");
      reader.readAsDataURL(file);
    },
    [clearPreview],
  );

  /** Put the record's own photograph back — or the monogram plate, for somebody who has none. */
  const dropUpload = useCallback(() => {
    setUpload(null);
    if (uploadInput.current) uploadInput.current.value = "";
    setFocusEdit(null);
    setFocusDefault(null);
    setNatural(null);
    setResizing(false);
    clearPreview();
  }, [clearPreview]);

  // Where this person's photograph is framed right now.
  //
  // Only sharp can answer — the crop is its `attention` strategy's own choice — so the box cannot
  // open on the right picture without a round trip. It is a read, not a render: nothing is drawn
  // and nothing is rate-limited. A failure is silent on purpose; the box then opens centred, which
  // is a slightly wrong starting point for a drag, not an error worth a red line across a page
  // somebody came to print a card from.
  //
  // 🔴 A LATE ANSWER MUST NOT MOVE SOMEBODY ELSE'S PHOTOGRAPH. Two names picked quickly leave two
  // reads in flight, and they can land in either order. The cleanup drops the one nobody is
  // waiting for any more — otherwise the frame jumps under his hands, seconds after he started
  // dragging, to a position that belongs to the person he moved on from.
  //
  // It runs on the first paint as well as on every later pick: the page opens with somebody
  // already chosen, and a box that only learned where to open after a second click would be worse
  // than one that never knew at all.
  useEffect(() => {
    if (!selectedHrId || !showFraming) return;
    let wanted = true;
    void fetch("/api/milestones/card", {
      body: JSON.stringify({ hrId: selectedHrId, format: "focus", photoUpload: upload?.dataUri }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    })
      .then((response) => (response.ok ? (response.json() as Promise<{ focus?: Focus | null }>) : null))
      .then((payload) => {
        const focus = payload?.focus;
        if (!wanted || !focus || typeof focus.x !== "number" || typeof focus.y !== "number") return;
        setFocusDefault(focus);
      })
      .catch(() => {
        /* the box opens centred */
      });
    return () => {
      wanted = false;
    };
  }, [selectedHrId, showFraming, upload?.dataUri]);

  /** A row in the list carries a period as well as a person, so it sets both. */
  const pick = useCallback(
    (entry: MilestoneDueEntry) => {
      setSelectedHrId(entry.hrId);
      setPreset(PRESETS.some((p) => p.value === entry.spec) ? entry.spec : "custom");
      setCustom(entry.spec);
      resetFields();
    },
    [resetFields],
  );

  /** The name box carries only a person — whatever period is on screen stays. */
  const pickPerson = useCallback(
    (hrId: string) => {
      setSelectedHrId(hrId);
      resetFields();
    },
    [resetFields],
  );

  // ── DRAGGING THE PHOTOGRAPH ──────────────────────────────────────────────────────────────────
  // 🔴 THE FRAME NEVER MOVES. It is a fixed rectangle on a printed sheet, and the picture travels
  // inside it — which is exactly what `object-fit: cover` with an `object-position` percentage
  // does, and exactly what the server does to the real photograph. The two agree because they are
  // the same geometry, not because a conversion keeps them in step.
  //
  // A drag is read against the overflow, not against the box: how far the picture CAN travel is
  // how much of it is hidden, so a photograph barely wider than the frame moves a little for a
  // long drag and a very wide one moves a lot. Anything else feels like the picture is sticking.
  const startDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!showFraming) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      dragFrom.current = { x: event.clientX, y: event.clientY, focus: focusValue };
    },
    [focusValue, showFraming],
  );

  const moveDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const from = dragFrom.current;
    if (!from) return;
    const box = event.currentTarget.getBoundingClientRect();
    // How far it CAN travel, read off the picture as it is actually laid out rather than worked
    // out a second time. A translate does not change an element's width or height, so this is the
    // rendered size however far it has already been dragged.
    const picture = event.currentTarget.querySelector("img")?.getBoundingClientRect();
    const travel = {
      x: Math.max(0, (picture?.width ?? 0) - box.width),
      y: Math.max(0, (picture?.height ?? 0) - box.height),
    };
    // An axis with nothing hidden cannot move, and dividing by that zero would send the focus to
    // infinity. At zoom 1 one axis is always like this - which is exactly why there is a zoom.
    setFocusEdit({
      x: travel.x > 0 ? clamp01(from.focus.x - (event.clientX - from.x) / travel.x) : from.focus.x,
      y: travel.y > 0 ? clamp01(from.focus.y - (event.clientY - from.y) / travel.y) : from.focus.y,
      zoom: from.focus.zoom,
    });
  }, []);

  /**
   * Enlarge or shrink the picture inside the frame.
   *
   * The frame does not change; the picture grows past it, which is what puts something hidden in
   * BOTH axes for a drag to travel through. Back at 1 it exactly covers again and one axis goes
   * still - that is the geometry, not a fault.
   */
  const setZoom = useCallback(
    (zoom: number) => {
      setFocusEdit((current) => {
        const base = current ?? focusDefault ?? CENTRE;
        return { x: base.x, y: base.y, zoom: Math.min(MAX_ZOOM, Math.max(1, zoom)) };
      });
      clearPreview();
    },
    [clearPreview, focusDefault],
  );

  const endDrag = useCallback(() => {
    if (!dragFrom.current) return;
    dragFrom.current = null;
    // The sheet on screen was rendered at the old framing, so it is now a lie. Clearing it is
    // honest; re-rendering it on every drag would put a server round trip inside a gesture.
    clearPreview();
  }, [clearPreview]);

  /**
   * Read the picture's own dimensions off the element.
   *
   * 🔴 `onLoad` ALONE IS NOT ENOUGH, AND ITS FAILURE IS INVISIBLE. A photograph already in
   * the browser cache is `complete` before React attaches the handler, so the load event has
   * already been and gone and nothing ever fires. The dimensions then stay unknown, the picture is
   * drawn at exactly one frame in both axes, and dragging does nothing at all — on a page that
   * looks entirely normal, because `object-cover` is still framing it correctly. Measured here on
   * 2026-09-23: a reload reported `width: 100%` and a dead drag. So the ref reads it too, on every
   * commit, and returns the SAME object when nothing changed so it cannot loop.
   */
  const readNatural = useCallback((node: HTMLImageElement | null) => {
    if (!node?.complete || node.naturalWidth <= 0) return;
    setNatural((current) =>
      current && current.w === node.naturalWidth && current.h === node.naturalHeight
        ? current
        : { w: node.naturalWidth, h: node.naturalHeight },
    );
  }, []);

  /** Put the picture back to its own size, filling the frame and no more. */
  const stopResizing = useCallback(() => {
    setResizing(false);
    setZoom(1);
  }, [setZoom]);

  /** Put the photograph back where the card had it before anybody touched it. */
  const resetFraming = useCallback(() => {
    setFocusEdit(null);
    clearPreview();
  }, [clearPreview]);

  const buildPreview = useCallback(async () => {
    if (!ready) return;
    setBusy("preview");
    setError(null);
    try {
      const response = await fetch("/api/milestones/card", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, format: "html" }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error ?? "The preview could not be built.");
      }
      const html = await response.text();
      // A blob: document inherits the page policy, so the card's layout script runs only with the nonce
      // this page was served with (src/lib/security/csp-nonce.ts). The card is our own escaped render.
      const url = URL.createObjectURL(new Blob([withScriptNonce(html, documentScriptNonce())], { type: "text/html" }));
      // The pane may be showing a landscape group picture; put it back to the card's own sheet.
      setPreviewSheet({ w: SHEET_W, h: SHEET_H });
      setPreviewUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return url;
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The preview could not be built.");
    } finally {
      setBusy(null);
    }
  }, [body, ready]);

  const download = useCallback(async (format: "pdf" | "png") => {
    if (!ready) return;
    setBusy(format === "png" ? "picture" : "download");
    setError(null);
    try {
      const response = await fetch("/api/milestones/card", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, format }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error ?? "The card could not be produced.");
      }
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(disposition);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = match?.[1] ?? `milestone-card.${format}`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The card could not be produced.");
    } finally {
      setBusy(null);
    }
  }, [body, ready]);

  const tickedItems = useMemo(
    () => entries.filter((entry) => ticked.has(entryKey(entry))),
    [entries, ticked],
  );

  /**
   * The ticked rows on the wire — the shape both the batch and the group picture take, plus the name
   * he corrected for that person if he corrected one. The batch takes the same field and ignores it
   * when it is absent, so the two stay one shape.
   */
  const groupItems = useMemo(
    () =>
      tickedItems.map((entry) => ({
        hrId: entry.hrId,
        period: entry.spec,
        on: entry.on,
        displayName: nameOverrides[entry.hrId],
      })),
    [tickedItems, nameOverrides],
  );

  const toggleTick = useCallback((entry: MilestoneDueEntry) => {
    // A different set of people is a different picture, so a sentence typed for the old set goes
    // back to the worked-out one — it counts them ("five colleagues") and would otherwise be wrong
    // the moment the set changes. Same rule as `resetFields`, and an event handler for the same
    // reason: it is a consequence of the click, not of the render.
    setGroupCitationEdit(null);
    setTicked((current) => {
      const next = new Set(current);
      const key = entryKey(entry);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /**
   * Print a set of rows as ONE PDF, one card per page. Shared by "print the ticked ones" and "print
   * everyone due", because both are the same act: one POST, one Chromium launch, one download.
   *
   * 🔴 NO PHOTOGRAPH AND NO FRAMING TRAVEL — the batch prints from each person's record. The batch
   * endpoint carries no upload, and this sends none. After it lands, the list is refreshed so the
   * "already printed" marks appear on the rows that were just made, and the ticks are cleared.
   *
   * 🔴 A WHOLE WINDOW IS ONE REQUEST, NOT PAGED CLIENT-SIDE. The server renders any number of cards
   * from a single launch (it pages the render internally); splitting into several requests here would
   * trip the export rate limit, which bounds launches. The ceiling is `MILESTONE_BATCH_MAX` on the
   * server; over it the route asks to narrow the window, and that message is shown as-is.
   */
  const printItems = useCallback(
    async (items: { hrId: string; period: string; on: string }[]) => {
      if (items.length === 0) return;
      setBusy("batch");
      setError(null);
      try {
        const response = await fetch("/api/milestones/batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items, variant }),
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          throw new Error(payload?.error ?? "The batch could not be produced.");
        }
        const disposition = response.headers.get("Content-Disposition") ?? "";
        const match = /filename="([^"]+)"/.exec(disposition);
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = match?.[1] ?? "milestones.pdf";
        link.click();
        URL.revokeObjectURL(url);
        setTicked(new Set());
        await refreshList();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "The batch could not be produced.");
      } finally {
        setBusy(null);
      }
    },
    [variant, refreshList],
  );

  /** Print every ticked row. */
  const printSelected = useCallback(
    () => printItems(tickedItems.map((entry) => ({ hrId: entry.hrId, period: entry.spec, on: entry.on }))),
    [printItems, tickedItems],
  );

  /**
   * Print EVERYONE in the current window in one go — the "cards ready" shortcut the daily reminder
   * points at. It ignores the ticks and prints the whole due list, so the reminder's "N coming up"
   * becomes one click rather than ticking every row by hand.
   */
  const printAllDue = useCallback(
    () => printItems(entries.map((entry) => ({ hrId: entry.hrId, period: entry.spec, on: entry.on }))),
    [printItems, entries],
  );

  // ── ONE PICTURE WITH EVERYBODY ON IT ─────────────────────────────────────────────────────────
  // "I have five employees that have the same milestone in one day … I want to make a photo that has
  // them all" (the owner, 2026-09-30). The batch above is a thing to PRINT — one card per page, and
  // nothing you can send. This is one landscape sheet with every ticked face on it.

  // Cheap enough to answer on every render (at most twelve rows through a pure function), and
  // deliberately NOT wrapped in useMemo: the try/catch defeats the React Compiler's ability to
  // preserve a manual memo, which is a lint error here.
  const groupCheck = groupPictureCheck(tickedItems);

  /**
   * The sentence the group picture prints, arriving WORKED OUT and then editable — the same contract
   * the single card's three fields have ("it shows it and I have the option then to edit it, but
   * don't let me start from scratch").
   *
   * 🔴 BUILT WITH THE SERVER'S OWN FUNCTION, NOT A COPY OF ITS WORDING. `milestoneGroupCitation` is
   * pure, so the box opens on the exact string the route would have produced; a second phrasing here
   * would drift from the printed one and he would be correcting a sentence the sheet never carried.
   */
  const groupCitationValue =
    groupCitationEdit ??
    (groupCheck.occasion
      ? milestoneGroupCitation({
          occasion: groupCheck.occasion,
          count: tickedItems.length,
          dates: groupCheck.dates,
        })
      : "");

  /**
   * The picture itself — the PNG to send, or the same artwork as a one-page PDF to print.
   *
   * No photograph and no framing travel: the group prints from each person's record, exactly as the
   * batch does. Afterwards the list is refreshed so the "already printed" marks appear on the rows
   * that are on the picture, and the ticks are cleared.
   */
  const groupPicture = useCallback(
    async (format: "png" | "pdf") => {
      if (!groupCheck.ok) return;
      setBusy(format === "pdf" ? "group-pdf" : "group");
      setError(null);
      try {
        const response = await fetch("/api/milestones/group", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items: groupItems, variant, format, citation: groupCitationValue.trim() || undefined }),
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          throw new Error(payload?.error ?? "The picture could not be produced.");
        }
        const disposition = response.headers.get("Content-Disposition") ?? "";
        const match = /filename="([^"]+)"/.exec(disposition);
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = match?.[1] ?? `milestone-group.${format}`;
        link.click();
        URL.revokeObjectURL(url);
        setTicked(new Set());
        // The picture is made; the next one is a different set of people and a different sentence.
        setGroupCitationEdit(null);
        await refreshList();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "The picture could not be produced.");
      } finally {
        setBusy(null);
      }
    },
    [groupCheck.ok, groupCitationValue, groupItems, refreshList, variant],
  );

  /** The same artwork on screen, in the preview pane, before anything is downloaded or sent. */
  const groupPreview = useCallback(async () => {
    if (!groupCheck.ok) return;
    setBusy("group-preview");
    setError(null);
    try {
      const response = await fetch("/api/milestones/group", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: groupItems, variant, format: "html", citation: groupCitationValue.trim() || undefined }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error ?? "The preview could not be built.");
      }
      const html = await response.text();
      // As above: the group picture's layout script needs the page nonce.
      const url = URL.createObjectURL(new Blob([withScriptNonce(html, documentScriptNonce())], { type: "text/html" }));
      setPreviewSheet({ w: GROUP_SHEET_W, h: GROUP_SHEET_H });
      setPreviewUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return url;
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The preview could not be built.");
    } finally {
      setBusy(null);
    }
  }, [groupCheck.ok, groupCitationValue, groupItems, variant]);

  /** The `?from&to` query string for a window; an empty side is left off and the server fills it
   *  with its default 90-day edge. Shared by the table fetch and the XLSX link, so one window
   *  drives both. */
  const historyQueryFor = useCallback((from: string, to: string, extra?: Record<string, string>) => {
    const params = new URLSearchParams(extra);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const qs = params.toString();
    return qs ? `?${qs}` : "";
  }, []);

  /** Read the print log for an explicit window. Silent on failure — a log that will not read shows
   *  nothing rather than breaking the page. Records the window the shown rows belong to. Takes the
   *  window as arguments so a "Reset" can fetch the default without waiting for a state update. */
  const fetchHistory = useCallback(
    async (from: string, to: string) => {
      setHistoryBusy(true);
      try {
        const response = await fetch(`/api/milestones/history${historyQueryFor(from, to)}`);
        if (!response.ok) throw new Error("history unavailable");
        const payload = (await response.json()) as {
          from?: string;
          to?: string;
          entries?: MilestonePrintHistoryEntry[];
        };
        setHistory(Array.isArray(payload?.entries) ? payload.entries : []);
        setHistoryApplied({ from: payload?.from ?? "", to: payload?.to ?? "" });
      } catch {
        setHistory([]);
        setHistoryApplied(null);
      } finally {
        setHistoryBusy(false);
      }
    },
    [historyQueryFor],
  );

  const toggleHistory = useCallback(() => {
    setHistoryOpen((open) => {
      const next = !open;
      if (next && history === null && !historyBusy) void fetchHistory(historyFrom, historyTo);
      return next;
    });
  }, [fetchHistory, history, historyBusy, historyFrom, historyTo]);

  /** Re-read the log for the typed window. */
  const applyHistoryRange = useCallback(() => {
    if (!historyBusy) void fetchHistory(historyFrom, historyTo);
  }, [fetchHistory, historyBusy, historyFrom, historyTo]);

  /** Clear the range back to the default 90 days and re-read at once. */
  const resetHistoryRange = useCallback(() => {
    setHistoryFrom("");
    setHistoryTo("");
    if (!historyBusy) void fetchHistory("", "");
  }, [fetchHistory, historyBusy]);

  /**
   * Write the handed-in picture to the employee's Phoenix record.
   *
   * 🔴 THE ORIGINAL BYTES, NEVER THE POLISHED CROP. The card's polish bakes in a warm grade, a
   * vignette and grain — a keepsake treatment that would be a forgery on an HR record, and every
   * other consumer crops from the original anyway. So this posts the file exactly as it was handed
   * in. It does NOT `router.refresh()`: a remount would throw away the picture, the framing, the
   * edited name and the citation the owner is mid-composing.
   */
  const savePhotoToRecord = useCallback(async () => {
    if (!selectedHrId || !upload) return;
    const mime = /^data:(image\/[a-z+]+);/i.exec(upload.dataUri)?.[1]?.toLowerCase() ?? "";
    if (!["image/jpeg", "image/png", "image/webp"].includes(mime)) {
      setError("A record photo must be a JPG, PNG or WebP. Convert it and upload again.");
      return;
    }
    setSavingPhoto(true);
    setError(null);
    try {
      const source = await fetch(upload.dataUri);
      const blob = await source.blob();
      if (blob.size > MAX_RECORD_PHOTO_BYTES) {
        throw new Error("A record photo must be 5 MB or smaller. Send a smaller copy.");
      }
      const form = new FormData();
      form.append("file", blob, upload.name || "photo");
      const response = await fetch(`/api/employees/${encodeURIComponent(selectedHrId)}/photo`, {
        method: "POST",
        body: form,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.message ?? payload?.error ?? "The photo could not be saved.");
      }
      setSavedPhotoFor(selectedHrId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The photo could not be saved.");
    } finally {
      setSavingPhoto(false);
    }
  }, [selectedHrId, upload]);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6">
      <header className="mb-6">
        <h1 className="text-[22px] font-bold tracking-tight text-slate-900">Milestones</h1>
        <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-slate-600">
          Who reaches a milestone with Sato Pharma, and the printed card to hand them. A first
          month and a first year are the two the company marks; any other period can be typed.
        </p>
      </header>

      {error ? (
        <p className="mb-4 rounded-none border border-red-300 bg-red-50 px-4 py-3 text-[13px] text-red-800">
          {error}
        </p>
      ) : null}

      {/* ── Who is coming up ─────────────────────────────────────────────────────────────── */}
      <section className="rounded-none border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-[13px] font-bold text-slate-900">Coming up</h2>
        <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <label className="block text-[12px] font-semibold text-slate-600">
            From
            <input
              className={`${phxFieldClassName} mt-1 block`}
              onChange={(event) => setFrom(event.target.value)}
              type="date"
              value={from}
            />
          </label>
          <label className="block text-[12px] font-semibold text-slate-600">
            To
            <input
              className={`${phxFieldClassName} mt-1 block`}
              onChange={(event) => setTo(event.target.value)}
              type="date"
              value={to}
            />
          </label>
          <button
            className="rounded-none border border-sky-800 px-5 py-2.5 text-[13px] font-semibold text-sky-800 disabled:opacity-50"
            disabled={loadingList}
            onClick={refreshList}
            type="button"
          >
            {loadingList ? "Reading…" : "Show"}
          </button>
        </div>

        {entries.length === 0 ? (
          <p className="text-[13px] text-slate-600">Nobody reaches a milestone in that window.</p>
        ) : (
          <>
            {/*
              🔴 PRINT A WHOLE WINDOW AT ONCE. Tick the rows and print them as one PDF, one card per
              page. The batch prints from each person's record — no handed-in photograph travels — so
              it is a different act from composing a single card below, where a picture can be
              uploaded one name at a time.
            */}
            {canExport ? (
              <div className="mb-3 flex flex-wrap items-center gap-3 border-b border-slate-200 pb-3">
                <button
                  className="rounded-none bg-sky-800 px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50"
                  disabled={tickedItems.length === 0 || busy !== null}
                  onClick={printSelected}
                  type="button"
                >
                  {busy === "batch"
                    ? "Printing…"
                    : `Print ${tickedItems.length || ""} ${tickedItems.length === 1 ? "card" : "cards"}`.replace("  ", " ").trim()}
                </button>
                {/*
                  🔴 THE "CARDS READY" SHORTCUT the daily reminder points at. It prints EVERYONE in the
                  window — the reminder's "N coming up" in one click, without ticking each row. One PDF,
                  one launch; the server prints the whole window (see MILESTONE_BATCH_MAX).
                */}
                <button
                  className="rounded-none border border-sky-800 px-4 py-2 text-[13px] font-semibold text-sky-800 disabled:opacity-50"
                  disabled={entries.length === 0 || busy !== null}
                  onClick={printAllDue}
                  type="button"
                >
                  {`Print all ${entries.length} due`}
                </button>
                <span className="text-[11px] leading-relaxed text-slate-500">
                  One PDF, one card per page, from each person&apos;s record photograph.
                </span>
              </div>
            ) : null}

            {/*
              🔴 ONE PICTURE WITH EVERYBODY ON IT — a different act from the batch above, not a second
              spelling of it. The batch is a stack of cards to print and hand out; this is a single
              landscape sheet that can be SENT ("I want to make a photo that has them all" — the
              owner, 2026-09-30). It holds one occasion only, and the reason it is off is the route's
              own sentence, from the same function the route decides with.
            */}
            {canExport ? (
              <div className="mb-3 flex flex-wrap items-center gap-3 border-b border-slate-200 pb-3">
                <button
                  className="rounded-none bg-sky-800 px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50"
                  disabled={!groupCheck.ok || busy !== null}
                  onClick={() => groupPicture("png")}
                  type="button"
                >
                  {busy === "group"
                    ? "Drawing…"
                    : tickedItems.length > 1
                      ? `One picture of all ${tickedItems.length}`
                      : "One picture of them all"}
                </button>
                <button
                  className="rounded-none border border-sky-800 px-4 py-2 text-[13px] font-semibold text-sky-800 disabled:opacity-50"
                  disabled={!groupCheck.ok || busy !== null}
                  onClick={groupPreview}
                  type="button"
                >
                  {busy === "group-preview" ? "Building…" : "Preview it"}
                </button>
                <button
                  className="rounded-none border border-sky-800 px-4 py-2 text-[13px] font-semibold text-sky-800 disabled:opacity-50"
                  disabled={!groupCheck.ok || busy !== null}
                  onClick={() => groupPicture("pdf")}
                  type="button"
                >
                  {busy === "group-pdf" ? "Printing…" : "Its PDF"}
                </button>
                {groupCheck.ok || tickedItems.length === 0 ? (
                  <span className="text-[11px] leading-relaxed text-slate-500">
                    One landscape sheet, every ticked face on it, from each person&apos;s record
                    photograph — the one to send. Up to {MILESTONE_GROUP_MAX} faces, all on the same
                    occasion.
                  </span>
                ) : (
                  <span className="text-[11px] leading-relaxed text-amber-800">{groupCheck.reason}</span>
                )}

                {/*
                  The sentence, worked out and then editable — the same contract the single card's
                  fields have. It is the GROUP's sentence and names nobody; the card's names one
                  person and lives in its own box below, so neither can overwrite the other.

                  Shown only once the rows agree on an occasion, because until then there is no
                  sentence to show. `w-full` inside the wrapped row, so it never forces a sideways
                  scroll at 375px.
                */}
                {groupCheck.ok ? (
                  <label className="block w-full text-[12px] font-semibold text-slate-600">
                    What the picture says
                    <textarea
                      className={`${phxTextareaClassName} mt-1 block leading-relaxed`}
                      onChange={(event) => setGroupCitationEdit(event.target.value)}
                      rows={2}
                      value={groupCitationValue}
                    />
                    <span className="mt-1 flex flex-wrap items-center gap-3">
                      <span className="text-[11px] font-normal leading-relaxed text-slate-500">
                        It names the occasion, never the people — their names are under their own
                        faces. The names themselves come from each person&apos;s record, or from the
                        correction you typed for them in the card below.
                      </span>
                      {groupCitationEdit !== null ? (
                        <button
                          className="rounded-none border border-slate-300 px-2 py-1 text-[11px] font-semibold text-slate-600"
                          onClick={() => setGroupCitationEdit(null)}
                          type="button"
                        >
                          Back to the worked-out sentence
                        </button>
                      ) : null}
                    </span>
                  </label>
                ) : null}
              </div>
            ) : null}

            {/* Desktop: a fixed table. Mobile: cards. */}
            <table className="hidden w-full table-fixed border-collapse sm:table">
              <colgroup>
                <col style={{ width: "7%" }} />
                <col style={{ width: "43%" }} />
                <col style={{ width: "22%" }} />
                <col style={{ width: "28%" }} />
              </colgroup>
              <thead>
                <tr className="border-b border-slate-200 text-left text-[11px] font-bold uppercase tracking-wider text-slate-500">
                  <th className="py-2 pr-2" aria-label="Tick to print" />
                  <th className="py-2 pr-3">Name</th>
                  <th className="py-2 pr-3">Milestone</th>
                  <th className="py-2">Date</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr
                    className={`cursor-pointer border-b border-slate-100 align-top text-[13px] ${
                      selectedHrId === entry.hrId && period === entry.spec ? "bg-sky-50" : ""
                    }`}
                    key={entryKey(entry)}
                    onClick={() => pick(entry)}
                  >
                    {/* 🔴 stopPropagation, or ticking fires the row's pick() and throws away the card
                        being composed. */}
                    <td className="py-2 pr-2">
                      {canExport ? (
                        <input
                          aria-label={`Tick ${entry.displayName} for printing`}
                          checked={ticked.has(entryKey(entry))}
                          className="mt-0.5"
                          onChange={() => toggleTick(entry)}
                          onClick={(event) => event.stopPropagation()}
                          type="checkbox"
                        />
                      ) : null}
                    </td>
                    <td className="py-2 pr-3">
                      <span className="block break-words font-semibold text-slate-900">
                        {entry.displayName}
                        {entry.printed ? (
                          <span className="ml-2 align-middle text-[10px] font-bold uppercase tracking-wider text-emerald-700">
                            Printed
                          </span>
                        ) : null}
                      </span>
                      <span className="block break-words text-[11px] text-slate-500">{entry.roleLine}</span>
                    </td>
                    <td className="py-2 pr-3 break-words text-slate-800">{entry.specLabel}</td>
                    <td className="py-2 break-words text-slate-800">
                      {longDate(entry.on)}
                      <span className="block text-[11px] text-slate-500">{whenText(entry.daysAway)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="grid gap-2 sm:hidden">
              {entries.map((entry) => (
                <div
                  className={`flex items-start gap-2 rounded-none border p-3 ${
                    selectedHrId === entry.hrId && period === entry.spec
                      ? "border-sky-800 bg-sky-50"
                      : "border-slate-200"
                  }`}
                  key={entryKey(entry)}
                >
                  {canExport ? (
                    <input
                      aria-label={`Tick ${entry.displayName} for printing`}
                      checked={ticked.has(entryKey(entry))}
                      className="mt-1"
                      onChange={() => toggleTick(entry)}
                      type="checkbox"
                    />
                  ) : null}
                  <button className="min-w-0 flex-1 text-left" onClick={() => pick(entry)} type="button">
                    <span className="block break-words text-[13px] font-semibold text-slate-900">
                      {entry.displayName}
                      {entry.printed ? (
                        <span className="ml-2 align-middle text-[10px] font-bold uppercase tracking-wider text-emerald-700">
                          Printed
                        </span>
                      ) : null}
                    </span>
                    <span className="block break-words text-[11px] text-slate-500">{entry.roleLine}</span>
                    <span className="mt-1 block break-words text-[12px] text-slate-800">
                      {entry.specLabel} · {longDate(entry.on)} · {whenText(entry.daysAway)}
                    </span>
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      {/* ── The card ─────────────────────────────────────────────────────────────────────── */}
      <section className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="rounded-none border border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-[13px] font-bold text-slate-900">The card</h2>

          <div className="grid gap-3">
            <label className="block text-[12px] font-semibold text-slate-600" htmlFor="milestone-person">
              Who it is for
              <SearchableSelect
                className="mt-1 h-auto py-2 text-[13px]"
                id="milestone-person"
                noResultsText="No active employee by that name."
                onValueChange={pickPerson}
                placeholder="Type a name"
                value={selectedHrId}
                wrapValue
              >
                {/*
                  No empty option. An `<option value="">` would paint "Type a name" as a selectable
                  ROW in the list, which reads as a person with no name; the placeholder above says
                  the same thing in the right place. Nothing needs clearing — the screen is only
                  ever used with somebody chosen.
                */}
                {candidates.map((person) => (
                  <option key={person.hrId} value={person.hrId}>
                    {person.roleLine ? `${person.displayName} · ${person.roleLine}` : person.displayName}
                  </option>
                ))}
              </SearchableSelect>
              <span className="mt-1 block text-[11px] font-normal leading-relaxed text-slate-500">
                Anybody on the active roster, whether or not a milestone is due. The list above is a
                shortcut, not the limit.
              </span>
            </label>

            {selected ? (
              <p className="break-words text-[12px] text-slate-500">
                {selected.hireDate
                  ? `Joined ${longDate(selected.hireDate)}`
                  : "No hire date on record, so there is no milestone to date. Fix the employee record first."}
              </p>
            ) : null}

            {/*
              🔴 BIRTHDAY CARDS ARE DATED SERVER-SIDE. A `b<n>` period is their nth birthday at Sato
              Pharma — the date and the sentence are worked out from the BIRTH date when the card is
              built, so the two fields below are left blank on purpose. It is never the person's age.
            */}
            {birthdayOrdinal !== null ? (
              <p className="break-words rounded-none border border-sky-200 bg-sky-50 px-3 py-2 text-[12px] leading-relaxed text-sky-900">
                A birthday card — their {ordinalLabel(birthdayOrdinal)} birthday at Sato Pharma. The
                date and the sentence are worked out from their birth date when it prints; leave the
                two below blank unless you want to word them yourself.
              </p>
            ) : null}

            <label className="block text-[12px] font-semibold text-slate-600">
              Period
              <select
                className={`${phxSelectClassName} mt-1 block`}
                onChange={(event) => {
                  setPreset(event.target.value);
                  resetFields();
                }}
                value={preset}
              >
                {PRESETS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>

            {preset === "custom" ? (
              <label className="block text-[12px] font-semibold text-slate-600">
                How long
                <input
                  className={`${phxFieldClassName} mt-1 block`}
                  onChange={(event) => {
                    setCustom(event.target.value);
                    resetFields();
                  }}
                  placeholder="18 months, 100 days, 7 years"
                  value={custom}
                />
              </label>
            ) : null}

            <label className="block text-[12px] font-semibold text-slate-600">
              The date on the card
              <input
                className={`${phxFieldClassName} mt-1 block`}
                onChange={(event) => setDateEdit(event.target.value)}
                type="date"
                value={dateValue}
              />
              <span className="mt-1 block text-[11px] font-normal leading-relaxed text-slate-500">
                Already worked out from the hire date and the period. Change it only if the day the
                company is marking is a different one.
              </span>
            </label>

            <label className="block text-[12px] font-semibold text-slate-600">
              The name on the card
              <input
                className={`${phxFieldClassName} mt-1 block`}
                onChange={(event) => editName(selectedHrId, event.target.value)}
                value={nameValue}
              />
              <span className="mt-1 block text-[11px] font-normal leading-relaxed text-slate-500">
                Filled from the HR record, which holds a legal name. Change it to whatever the
                person is actually called — the sentence below follows it.
              </span>
            </label>

            <label className="block text-[12px] font-semibold text-slate-600">
              The sentence under the name
              <textarea
                className={`${phxTextareaClassName} mt-1 block`}
                onChange={(event) => setCitationEdit(event.target.value)}
                rows={3}
                value={citationValue}
              />
              <span className="mt-1 block text-[11px] font-normal leading-relaxed text-slate-500">
                Written for you. It keeps following the name and the date until you type in it
                yourself, and then it stays exactly as you left it.
              </span>
            </label>

            <fieldset className="grid gap-2">
              <legend className="text-[12px] font-semibold text-slate-600">The sheet</legend>
              {VARIANTS.map((option) => (
                <label className="flex items-start gap-2 text-[13px] text-slate-800" key={option.value}>
                  <input
                    checked={variant === option.value}
                    className="mt-1"
                    name="milestone-variant"
                    onChange={() => setVariant(option.value)}
                    type="radio"
                  />
                  <span className="min-w-0">
                    {option.label}
                    <span className="block text-[11px] leading-relaxed text-slate-500">{option.hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            <label className="flex items-start gap-2 text-[13px] text-slate-800">
              <input
                checked={withoutPhoto}
                className="mt-1"
                onChange={(event) => setWithoutPhoto(event.target.checked)}
                type="checkbox"
              />
              <span className="min-w-0">
                Print the initials instead of the photograph
                <span className="block text-[11px] leading-relaxed text-slate-500">
                  Use this when the photo on file is not one they would want on a keepsake.
                </span>
              </span>
            </label>

            {/*
              THE PHOTOGRAPH, WHEREVER IT COMES FROM. A card is often wanted for somebody who
              never uploaded one, and the record is then simply the wrong place to look. A picture
              can be handed in here for this one card — it overrides the record's when there is
              one — and, unless the owner presses "Save to their record", it is never written back.

              🔴 THE SAVE WRITES THE ORIGINAL BYTES, NEVER THE POLISHED CARD CROP. See
              `savePhotoToRecord`: a keepsake grade on an HR record would be a forgery.
            */}
            {withoutPhoto ? null : (
              <div className="grid gap-2">
                <span className="text-[12px] font-semibold text-slate-600">The photograph</span>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="cursor-pointer rounded-none border border-slate-400 px-3 py-1.5 text-[12px] font-semibold text-slate-700">
                    {upload
                      ? "Use a different picture"
                      : selected?.hasPhoto
                        ? "Upload a picture instead"
                        : "Upload a picture"}
                    <input
                      accept="image/*"
                      className="hidden"
                      onChange={(event) => takeUpload(event.target.files?.[0])}
                      ref={uploadInput}
                      type="file"
                    />
                  </label>
                  {upload ? (
                    <button
                      className="rounded-none border border-slate-300 px-3 py-1.5 text-[12px] font-semibold text-slate-600"
                      onClick={dropUpload}
                      type="button"
                    >
                      {selected?.hasPhoto ? "Back to the one on file" : "Remove it"}
                    </button>
                  ) : null}
                  {upload && selectedHrId ? (
                    <button
                      className="rounded-none border border-sky-800 px-3 py-1.5 text-[12px] font-semibold text-sky-800 disabled:opacity-50"
                      disabled={savingPhoto || savedPhotoFor === selectedHrId}
                      onClick={savePhotoToRecord}
                      type="button"
                    >
                      {savedPhotoFor === selectedHrId
                        ? "Saved to their record"
                        : savingPhoto
                          ? "Saving…"
                          : "Save to their record"}
                    </button>
                  ) : null}
                </div>
                <p className="min-w-0 break-words text-[11px] leading-relaxed text-slate-500">
                  {upload
                    ? savedPhotoFor === selectedHrId
                      ? `Printing ${upload.name}, and it is now the photograph on their Phoenix record.`
                      : `Printing ${upload.name}. It is used for this card only, unless you save the original to their record.`
                    : selected?.hasPhoto
                      ? "The photograph on their Phoenix record is being used. Upload one to print a better picture instead."
                      : "There is no photograph on their Phoenix record, so the card prints the initials. Upload one to print a face."}
                </p>
              </div>
            )}

            {showFraming ? (
              <div className="grid gap-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-[12px] font-semibold text-slate-600">
                    Where the photograph sits
                  </span>
                  {focusEdit ? (
                    <button
                      className="rounded-none border border-slate-300 px-2 py-1 text-[11px] font-semibold text-slate-600"
                      onClick={resetFraming}
                      type="button"
                    >
                      Put it back
                    </button>
                  ) : null}
                </div>
                {/*
                  The frame is the fixed thing. This box is the card's portrait rectangle at the
                  card's own 4:5, and the picture inside it is dragged — never resized, never
                  reshaped. `object-position` in per-cent is the same geometry the server cuts
                  with, so what is under the cursor here is what comes out of the printer.
                */}
                <div
                  className="relative w-full max-w-[220px] cursor-grab touch-none select-none overflow-hidden border border-slate-300 bg-slate-100 active:cursor-grabbing"
                  onPointerCancel={endDrag}
                  onPointerDown={startDrag}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                  style={{ aspectRatio: FRAME_RATIO }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- the bucket's own bytes
                      behind the same gate as the card, or a data URI that never left this page;
                      next/image would proxy and cache a private photograph through the image
                      optimiser, and cannot optimise a data URI at all. */}
                  <img
                    alt=""
                    className="absolute left-0 top-0 object-cover"
                    draggable={false}
                    key={photoSrc}
                    onLoad={(event) => readNatural(event.currentTarget)}
                    ref={readNatural}
                    src={photoSrc ?? ""}
                    style={{
                      // Sized as a multiple of the frame and pulled back by a per-cent of itself:
                      // the same two numbers the server cuts with, in the units CSS wants.
                      //
                      // 🔴 `object-cover` STAYS ON IT, AND IS NOT BELT AND BRACES. These
                      // multiples already carry the picture's own proportions, so once it has
                      // loaded the cover fit is a no-op. BEFORE it has loaded its shape is not
                      // known yet, the multiples are both 1, and without a cover fit the picture
                      // is drawn at exactly the frame's shape - stretched. The owner saw that
                      // happen (2026-09-23: "the size you made the photo is stretched upon its
                      // normal").
                      width: `${fill.w * 100}%`,
                      height: `${fill.h * 100}%`,
                      // 🔴 THE CEILING HAS TO COME OFF INLINE, AND ONLY HERE. The admin shell
                      // caps every picture at `max-width: 100%`
                      // (`.admin-shell :where(img, svg, video, canvas, iframe)`), which is the
                      // fits-the-screen rule defending itself and must NOT be weakened. Tailwind's
                      // `max-w-none` cannot do it: both selectors score one class, so the shell's
                      // wins on source order, and the picture is silently pinned back to one frame
                      // wide - measured on 2026-09-23, where it read `135.486%` and rendered 218px.
                      // Inline beats both, and it is safe exactly here because this picture is
                      // inside an `overflow: hidden` frame: it can overhang, but it can never put
                      // a scrollbar on the page, which is what that rule exists to prevent.
                      maxWidth: "none",
                      transform: `translate(${fillOffset(fill.w, focusValue.x)}, ${fillOffset(fill.h, focusValue.y)})`,
                    }}
                  />
                </div>
                {/*
                  🔴 THE PICTURE IS LEFT ALONE UNLESS HE ASKS FOR IT TO BE RESIZED. The owner
                  on 2026-09-23: "I want this resize is option but the photo is as it is, I press
                  on an option to make it resize if needed." So the control is behind a press, it
                  starts at the picture's own size - filling the frame and no more - and a card
                  nobody resizes is cut exactly as it always was.
                */}
                {resizing ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      aria-label="How large the picture sits inside the frame"
                      className="h-1 w-full max-w-[150px] accent-sky-800"
                      max={MAX_ZOOM}
                      min={1}
                      onChange={(event) => setZoom(Number(event.target.value))}
                      step={0.02}
                      type="range"
                      value={focusValue.zoom}
                    />
                    <span className="text-[11px] tabular-nums text-slate-500">
                      {focusValue.zoom.toFixed(2)}&#215;
                    </span>
                    <button
                      className="rounded-none border border-slate-300 px-2 py-1 text-[11px] font-semibold text-slate-600"
                      onClick={stopResizing}
                      type="button"
                    >
                      Its own size
                    </button>
                  </div>
                ) : (
                  <button
                    className="w-fit rounded-none border border-slate-300 px-3 py-1.5 text-[11px] font-semibold text-slate-600"
                    onClick={() => setResizing(true)}
                    type="button"
                  >
                    Resize it
                  </button>
                )}
                <p className="text-[11px] leading-relaxed text-slate-500">
                  Drag the picture until the face sits where you want it. The frame itself never
                  moves — it is the card&apos;s, and the picture keeps its own proportions inside it.
                  At its own size it fills the frame exactly, so it slides one way only; resize it
                  and it moves freely up, down, left and right. It opens where the card is already
                  printing it, so leave it alone and nothing changes.
                </p>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-3">
              <button
                className="rounded-none border border-sky-800 px-5 py-2.5 text-[13px] font-semibold text-sky-800 disabled:opacity-50"
                disabled={!ready || busy !== null}
                onClick={buildPreview}
                type="button"
              >
                {busy === "preview" ? "Building…" : "Preview"}
              </button>
              {canExport ? (
                <>
                  <button
                    className="rounded-none bg-sky-800 px-5 py-2.5 text-[13px] font-semibold text-white disabled:opacity-50"
                    disabled={!ready || busy !== null}
                    onClick={() => download("pdf")}
                    type="button"
                  >
                    {busy === "download" ? "Printing…" : "Download the PDF"}
                  </button>
                  <button
                    className="rounded-none border border-sky-800 px-5 py-2.5 text-[13px] font-semibold text-sky-800 disabled:opacity-50"
                    disabled={!ready || busy !== null}
                    onClick={() => download("png")}
                    type="button"
                  >
                    {busy === "picture" ? "Drawing…" : "Download the picture"}
                  </button>
                </>
              ) : null}
            </div>
            {canExport ? (
              <p className="text-[11px] leading-relaxed text-slate-500">
                The PDF is the one to send to a printer. The picture is a PNG at 384 dots per inch —
                good enough to print, and the one to use when it has to go in a message or a slide.
              </p>
            ) : null}
          </div>
        </div>

        <div className="rounded-none border border-slate-200 bg-slate-50 p-4">
          <h2 className="mb-3 text-[13px] font-bold text-slate-900">Preview</h2>
          {/* The sheet comes from state, not a constant: this pane shows the portrait card AND the
              landscape group picture, and the scale is measured against whichever is in it. */}
          <div
            className="w-full"
            ref={frameBox}
            style={{ height: previewUrl ? previewSheet.h * scale : undefined }}
          >
            {previewUrl ? (
              <iframe
                className="border border-slate-300 bg-white"
                height={previewSheet.h}
                src={previewUrl}
                style={{ transform: `scale(${scale})`, transformOrigin: "top left" }}
                title="Milestone card preview"
                width={previewSheet.w}
              />
            ) : (
              <p className="text-[13px] text-slate-600">
                Press Preview to draw the card, or &ldquo;Preview it&rdquo; above to draw one picture
                of everybody ticked. The download is the same artwork, printed.
              </p>
            )}
          </div>
        </div>
      </section>

      {/* ── Recently printed ─────────────────────────────────────────────────────────────────
          The record milestone_card_prints, read back: who was congratulated, when, and by whom.
          Collapsed and lazy — the log is a look-back, not the reason to open the page. No horizontal
          scroll (table-fixed + a colgroup summing 100%, cards below sm); no ellipsis (names wrap). */}
      <section className="mt-4 rounded-none border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <button
            aria-expanded={historyOpen}
            className="text-[13px] font-bold text-slate-900"
            onClick={toggleHistory}
            type="button"
          >
            {historyOpen ? "▾ " : "▸ "}Recently printed
          </button>
          {historyOpen ? (
            <a
              className="rounded-none border border-sky-800 px-3 py-1.5 text-[12px] font-semibold text-sky-800"
              href={`/api/milestones/history${historyQueryFor(historyFrom, historyTo, { format: "xlsx" })}`}
            >
              Export XLSX
            </a>
          ) : null}
        </div>
        {historyOpen ? (
          <div className="mt-3">
            {/* The window the table and the export both read. Empty = the last 90 days through today. */}
            <div className="mb-3 flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                From
                <input
                  className={phxFieldClassName}
                  max={historyTo || undefined}
                  onChange={(event) => setHistoryFrom(event.target.value)}
                  type="date"
                  value={historyFrom}
                />
              </label>
              <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                To
                <input
                  className={phxFieldClassName}
                  min={historyFrom || undefined}
                  onChange={(event) => setHistoryTo(event.target.value)}
                  type="date"
                  value={historyTo}
                />
              </label>
              <button
                className="rounded-none bg-sky-800 px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-50"
                disabled={historyBusy}
                onClick={applyHistoryRange}
                type="button"
              >
                Apply
              </button>
              {historyFrom || historyTo ? (
                <button
                  className="rounded-none border border-slate-300 px-3 py-1.5 text-[12px] font-semibold text-slate-700 disabled:opacity-50"
                  disabled={historyBusy}
                  onClick={resetHistoryRange}
                  type="button"
                >
                  Reset to last 90 days
                </button>
              ) : null}
            </div>
            {historyBusy ? (
              <p className="text-[13px] text-slate-600">Reading the log…</p>
            ) : !history || history.length === 0 ? (
              <p className="text-[13px] text-slate-600">
                No cards were printed{historyRangeCaption ? ` ${historyRangeCaption}` : " in the last 90 days"}.
              </p>
            ) : (
              <>
                <p className="mb-2 text-[11px] text-slate-500">
                  Cards printed {historyRangeCaption || "in the last 90 days"}, newest first. Export for the same window.
                </p>
                <table className="hidden w-full table-fixed border-collapse sm:table">
                  <colgroup>
                    <col style={{ width: "24%" }} />
                    <col style={{ width: "30%" }} />
                    <col style={{ width: "22%" }} />
                    <col style={{ width: "24%" }} />
                  </colgroup>
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-[11px] font-bold uppercase tracking-wider text-slate-500">
                      <th className="py-2 pr-3">Printed</th>
                      <th className="py-2 pr-3">Employee</th>
                      <th className="py-2 pr-3">Occasion</th>
                      <th className="py-2">Milestone date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((row, index) => (
                      <tr
                        className="border-b border-slate-100 align-top text-[13px]"
                        key={`${row.printedAtIso}-${row.subjectHrId}-${index}`}
                      >
                        <td className="py-2 pr-3 break-words text-slate-800">{row.printedAt}</td>
                        <td className="py-2 pr-3 break-words text-slate-900">
                          {row.subjectName}
                          <span className="block text-[11px] text-slate-500">by {row.actorName}</span>
                        </td>
                        <td className="py-2 pr-3 break-words text-slate-800">{row.occasion}</td>
                        <td className="py-2 break-words text-slate-800">{row.milestoneOn}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="grid gap-2 sm:hidden">
                  {history.map((row, index) => (
                    <div
                      className="rounded-none border border-slate-200 p-3"
                      key={`${row.printedAtIso}-${row.subjectHrId}-${index}`}
                    >
                      <span className="block break-words text-[13px] font-semibold text-slate-900">
                        {row.subjectName}
                      </span>
                      <span className="mt-1 block break-words text-[12px] text-slate-800">
                        {row.occasion} · {row.milestoneOn}
                      </span>
                      <span className="mt-1 block break-words text-[11px] text-slate-500">
                        {row.printedAt} · by {row.actorName}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        ) : null}
      </section>
    </div>
  );
}
