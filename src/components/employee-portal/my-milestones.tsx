"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  Award,
  Cake,
  CalendarHeart,
  ChevronLeft,
  ChevronRight,
  Download,
  ImageUp,
  Loader2,
  RotateCcw,
  Sparkles,
  UserX,
} from "lucide-react";

import { PortalEmptyState } from "@/components/employee-portal/portal-primitives";
import { SURFACE_CLASS, SectionCard } from "@/components/sales/target-visuals";
import type { MyMilestoneEntry } from "@/lib/milestones/service";

type Props = {
  entries: MyMilestoneEntry[];
  /** The rep's own photo, resolved exactly as the portal shows it (uploaded route, else static), or null. */
  photoUrl: string | null;
};

// ── The framing geometry — identical to the admin card editor (milestones-workspace.tsx) ──────────
// The frame is a FIXED 4:5 rectangle on a printed sheet; the picture travels inside it. `object-fit:
// cover` with an `object-position` per-cent is the same geometry the server cuts with, so what is
// under the cursor here is what comes out of the printer. Copied rather than shared to avoid touching
// the admin flow; the two are pinned equal by tests/rep-milestones-portal.test.ts.
const FRAME_RATIO = "4 / 5";
const FRAME_ASPECT = 4 / 5;
const MAX_ZOOM = 4;
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

type Focus = { x: number; y: number; zoom: number };
const CENTRE: Focus = { x: 0.5, y: 0.5, zoom: 1 };

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** How big the picture is drawn, as a MULTIPLE OF THE FRAME in each axis (≥ 1, so the frame is filled). */
function coverFill(natural: { w: number; h: number } | null, zoom: number): { w: number; h: number } {
  if (!natural || natural.w <= 0 || natural.h <= 0) return { w: zoom, h: zoom };
  const ratio = natural.w / natural.h;
  return ratio >= FRAME_ASPECT
    ? { w: (zoom * ratio) / FRAME_ASPECT, h: zoom }
    : { w: zoom, h: (zoom * FRAME_ASPECT) / ratio };
}

/** The picture's offset inside the frame, as a per-cent of ITS OWN size (what a CSS translate per-cent means). */
function fillOffset(fill: number, focus: number): string {
  if (!Number.isFinite(fill) || fill <= 1) return "0%";
  return `${-(1 - 1 / fill) * clamp01(focus) * 100}%`;
}

const rowKey = (entry: MyMilestoneEntry) => `${entry.spec}-${entry.on}`;

// ── Calendar helpers — DATE-ONLY, so they render the same on the server and in every browser. ──────
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "August 2026" from a 1-based month, read at UTC midnight (no zone shift). */
function monthLabel(year: number, month: number): string {
  return new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  );
}

const isoOf = (year: number, month: number, day: number) =>
  `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

function parseIso(iso: string): { year: number; month: number; day: number } {
  const [year, month, day] = iso.split("-").map(Number);
  return { year, month, day };
}

/** `iso` shifted by whole days, through UTC so no DST or zone ever enters it. */
function addDaysIso(iso: string, delta: number): string {
  const { year, month, day } = parseIso(iso);
  const moved = new Date(Date.UTC(year, month - 1, day) + delta * 86_400_000);
  return isoOf(moved.getUTCFullYear(), moved.getUTCMonth() + 1, moved.getUTCDate());
}

/** The cells of a month grid, leading + trailing blanks (null) so every week is 7 wide. */
function monthCells(year: number, month: number): (string | null)[] {
  const startWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cells: (string | null)[] = Array.from({ length: startWeekday }, () => null);
  for (let day = 1; day <= days; day += 1) cells.push(isoOf(year, month, day));
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

const OccasionIcon = (kind: MyMilestoneEntry["kind"]) => (kind === "birthday" ? Cake : Sparkles);

/** Anniversary reads Sato-orange; a birthday reads rose — one glance tells the two apart. */
const kindAccent = (kind: MyMilestoneEntry["kind"]) =>
  kind === "birthday"
    ? { rail: "border-l-rose-500", chip: "border-l-[3px] border-l-rose-500 bg-rose-50 text-rose-900", dot: "bg-rose-500" }
    : { rail: "border-l-orange-500", chip: "border-l-[3px] border-l-orange-500 bg-orange-50 text-orange-900", dot: "bg-orange-500" };

/** "Today" · "In 12 days" · "Reached" — short enough never to force a sideways scroll. */
function whenLabel(daysAway: number): string {
  if (daysAway === 0) return "Today";
  if (daysAway > 0) return `In ${daysAway} ${daysAway === 1 ? "day" : "days"}`;
  return "Reached";
}

/** A square, no-rounded-corner action button in the portal's ink. */
const BTN =
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap border border-slate-900 " +
  "bg-slate-900 px-3 py-1.5 text-xs font-bold text-white transition-colors hover:bg-slate-700 " +
  "disabled:cursor-not-allowed disabled:opacity-50";
const BTN_LIGHT =
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap border border-slate-300 " +
  "bg-white px-3 py-1.5 text-xs font-bold text-slate-800 transition-colors hover:bg-slate-50 " +
  "disabled:cursor-not-allowed disabled:opacity-50";
/** Header navigation buttons, on the navy band. */
const NAV_BTN =
  "inline-flex h-9 min-w-9 items-center justify-center gap-1.5 border border-white/20 bg-white/10 px-2.5 " +
  "text-xs font-bold text-white transition-colors hover:bg-white/20";

/**
 * My Milestones — the rep's own keepsake cards on a premium month calendar (owner, 2026-09-30).
 *
 * His anniversaries and Sato-Pharma birthdays sit on a real calendar; tapping one opens the card,
 * where he frames his photo, hands in a different picture (or drops to the monogram), and downloads a
 * PDF or a picture. Every request builds only HIS card through /api/milestones/my-card; nothing here
 * names anyone else. The framing is the SAME geometry as the admin editor, so what he drags is what
 * the printer cuts.
 */
export function MyMilestones({ entries, photoUrl }: Props) {
  const [selected, setSelected] = useState<MyMilestoneEntry | null>(null);
  const [upload, setUpload] = useState<{ dataUri: string; name: string } | null>(null);
  const [withoutPhoto, setWithoutPhoto] = useState(false);
  const [focusEdit, setFocusEdit] = useState<Focus | null>(null);
  const [focusDefault, setFocusDefault] = useState<Focus | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [busy, setBusy] = useState<"pdf" | "png" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dragFrom = useRef<{ x: number; y: number; focus: Focus } | null>(null);
  const uploadInput = useRef<HTMLInputElement | null>(null);

  const focusValue = focusEdit ?? focusDefault ?? CENTRE;
  const photoSrc = upload ? upload.dataUri : withoutPhoto ? null : photoUrl;
  const showFraming = Boolean(photoSrc) && !withoutPhoto;
  const fill = coverFill(natural, focusValue.zoom);

  // ── The calendar's own state ─────────────────────────────────────────────────────────────────
  // Occasions by day, "today" and the next one up — all derived from the SERVER-computed entries, so
  // nothing reads the client clock and the first paint can never mismatch the server's.
  const entriesByDate = useMemo(() => {
    const map = new Map<string, MyMilestoneEntry[]>();
    for (const entry of entries) {
      const list = map.get(entry.on) ?? [];
      list.push(entry);
      map.set(entry.on, list);
    }
    return map;
  }, [entries]);

  // entries arrive soonest-upcoming first (then the recent past), so the first is the one to open on.
  const anchor = entries[0] ?? null;
  const todayIso = anchor ? addDaysIso(anchor.on, -anchor.daysAway) : null;
  const nextUp = useMemo(() => entries.filter((e) => e.daysAway >= 0).sort((a, b) => a.daysAway - b.daysAway)[0] ?? null, [entries]);

  const [view, setView] = useState<{ year: number; month: number }>(() => {
    const seed = parseIso((nextUp ?? anchor)?.on ?? todayIso ?? isoOf(2026, 1, 1));
    return { year: seed.year, month: seed.month };
  });

  const stepMonth = useCallback((delta: number) => {
    setView((current) => {
      const base = new Date(Date.UTC(current.year, current.month - 1 + delta, 1));
      return { year: base.getUTCFullYear(), month: base.getUTCMonth() + 1 };
    });
  }, []);
  const goToday = useCallback(() => {
    if (!todayIso) return;
    const { year, month } = parseIso(todayIso);
    setView({ year, month });
  }, [todayIso]);

  const cells = useMemo(() => monthCells(view.year, view.month), [view]);

  // A different occasion is a different card; a fresh framing, the record's own photo, no error.
  const select = useCallback((entry: MyMilestoneEntry) => {
    setSelected(entry);
    setUpload(null);
    setWithoutPhoto(false);
    setFocusEdit(null);
    setFocusDefault(null);
    setNatural(null);
    setError(null);
    if (uploadInput.current) uploadInput.current.value = "";
  }, []);

  // Where the card frames this picture right now — only sharp can answer, so the box asks the server
  // once (a read, not a render, so it is unthrottled). A failure is silent: the box opens centred.
  useEffect(() => {
    if (!selected || !showFraming) return;
    let wanted = true;
    void fetch("/api/milestones/my-card", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ period: selected.spec, on: selected.on, format: "focus", photoUpload: upload?.dataUri }),
    })
      .then((r) => (r.ok ? (r.json() as Promise<{ focus?: Focus | null }>) : null))
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
  }, [selected, showFraming, upload?.dataUri]);

  const takeUpload = useCallback((file: File | null | undefined) => {
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
      setWithoutPhoto(false);
      setUpload({ dataUri, name: file.name });
      // A new picture is framed from scratch.
      setFocusEdit(null);
      setFocusDefault(null);
      setNatural(null);
    };
    reader.onerror = () => setError("That picture could not be read.");
    reader.readAsDataURL(file);
  }, []);

  const dropUpload = useCallback(() => {
    setUpload(null);
    if (uploadInput.current) uploadInput.current.value = "";
    setFocusEdit(null);
    setFocusDefault(null);
    setNatural(null);
  }, []);

  // ── DRAGGING THE PHOTOGRAPH — the frame never moves; the picture travels inside it. ──────────────
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
    const picture = event.currentTarget.querySelector("img")?.getBoundingClientRect();
    const travel = {
      x: Math.max(0, (picture?.width ?? 0) - box.width),
      y: Math.max(0, (picture?.height ?? 0) - box.height),
    };
    setFocusEdit({
      x: travel.x > 0 ? clamp01(from.focus.x - (event.clientX - from.x) / travel.x) : from.focus.x,
      y: travel.y > 0 ? clamp01(from.focus.y - (event.clientY - from.y) / travel.y) : from.focus.y,
      zoom: from.focus.zoom,
    });
  }, []);

  const endDrag = useCallback(() => {
    dragFrom.current = null;
  }, []);

  const setZoom = useCallback((zoom: number) => {
    setFocusEdit((current) => {
      const base = current ?? CENTRE;
      return { x: base.x, y: base.y, zoom: Math.min(MAX_ZOOM, Math.max(1, zoom)) };
    });
  }, []);

  // `onLoad` alone misses a cached image (already `complete` before React attaches), so the ref reads
  // the natural size on every commit too, returning the same object when unchanged so it cannot loop.
  const readNatural = useCallback((node: HTMLImageElement | null) => {
    if (!node?.complete || node.naturalWidth <= 0) return;
    setNatural((current) =>
      current && current.w === node.naturalWidth && current.h === node.naturalHeight
        ? current
        : { w: node.naturalWidth, h: node.naturalHeight },
    );
  }, []);

  const download = useCallback(
    async (format: "pdf" | "png") => {
      if (!selected) return;
      setBusy(format);
      setError(null);
      try {
        const response = await fetch("/api/milestones/my-card", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            period: selected.spec,
            on: selected.on,
            format,
            withoutPhoto,
            photoFocus: focusEdit ?? undefined,
            photoUpload: upload?.dataUri,
          }),
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          throw new Error(payload?.error || "The card could not be produced. Please try again.");
        }
        const disposition = response.headers.get("Content-Disposition") ?? "";
        const match = /filename="([^"]+)"/.exec(disposition);
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const anchor2 = document.createElement("a");
        anchor2.href = url;
        anchor2.download = match?.[1] ?? `${selected.label.replace(/[^\p{L}\p{N}]+/gu, "-")}.${format}`;
        document.body.append(anchor2);
        anchor2.click();
        anchor2.remove();
        URL.revokeObjectURL(url);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "The card could not be produced.");
      } finally {
        setBusy(null);
      }
    },
    [selected, withoutPhoto, focusEdit, upload],
  );

  if (entries.length === 0) {
    return (
      <div className={SURFACE_CLASS}>
        <PortalEmptyState
          title="No milestones to show yet."
          message="Your first anniversary and birthday cards appear here once your hire date is on record."
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error ? (
        <p className="border border-red-300 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{error}</p>
      ) : null}

      {/* ── The calendar ──────────────────────────────────────────────────────────────────────── */}
      <section className="overflow-hidden border border-slate-200 bg-white shadow-sm">
        {/* Navy header band — the portal's premium chrome. */}
        <div className="bg-slate-950 px-4 py-4 sm:px-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <span className="inline-flex items-center gap-1.5 bg-white/10 px-2.5 py-1 text-phx-2xs font-black uppercase tracking-[0.16em] text-white/80 ring-1 ring-white/20">
                <CalendarHeart className="size-3.5" aria-hidden /> My Milestones
              </span>
              <h2 className="mt-2 text-2xl font-black tracking-tight text-white sm:text-3xl">{monthLabel(view.year, view.month)}</h2>
              <p className="mt-1 text-xs font-semibold text-slate-300">
                {nextUp
                  ? `Next: ${nextUp.label} — ${whenLabel(nextUp.daysAway).toLowerCase()}`
                  : "Your anniversaries and birthdays at Sato Pharma"}
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <button type="button" className={NAV_BTN} onClick={() => stepMonth(-1)} aria-label="Previous month">
                <ChevronLeft className="size-4" aria-hidden />
              </button>
              <button type="button" className={NAV_BTN} onClick={goToday}>
                Today
              </button>
              <button type="button" className={NAV_BTN} onClick={() => stepMonth(1)} aria-label="Next month">
                <ChevronRight className="size-4" aria-hidden />
              </button>
            </div>
          </div>
          {/* Legend — one glance tells anniversary from birthday. */}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-phx-2xs font-bold uppercase tracking-[0.12em] text-slate-300">
            <span className="inline-flex items-center gap-1.5"><span className="size-2.5 bg-orange-500" aria-hidden /> Anniversary</span>
            <span className="inline-flex items-center gap-1.5"><span className="size-2.5 bg-rose-500" aria-hidden /> Birthday</span>
          </div>
        </div>

        {/* Weekday row. */}
        <div className="grid grid-cols-7 bg-slate-950/95">
          {WEEKDAYS.map((weekday) => (
            <div key={weekday} className="px-1 py-2.5 text-center text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-400">
              <span className="hidden sm:inline">{weekday}</span>
              <span className="sm:hidden">{weekday.slice(0, 1)}</span>
            </div>
          ))}
        </div>

        {/* The month grid. */}
        <div className="grid grid-cols-7 divide-x divide-y divide-slate-100 border-t border-slate-100">
          {cells.map((date, index) => {
            const dayEntries = date ? entriesByDate.get(date) ?? [] : [];
            const isToday = date != null && date === todayIso;
            const holdsSelected = Boolean(selected && dayEntries.some((e) => rowKey(e) === rowKey(selected)));
            return (
              <div
                key={date ?? `blank-${index}`}
                className={[
                  "flex min-h-[64px] flex-col gap-1 p-1 sm:min-h-[112px] sm:p-2",
                  date ? "bg-white" : "bg-slate-50/60",
                  holdsSelected ? "ring-2 ring-inset ring-orange-500" : "",
                ].join(" ")}
              >
                <span className="flex items-center justify-between">
                  <span
                    className={[
                      "flex size-6 items-center justify-center text-xs font-black",
                      isToday ? "bg-orange-500 text-white" : date ? "text-slate-700" : "text-transparent",
                    ].join(" ")}
                  >
                    {date ? Number(date.slice(8, 10)) : ""}
                  </span>
                </span>

                {/* Milestone chips. Desktop: the full label; phone: a coloured dot per occasion. */}
                <div className="hidden flex-col gap-1 sm:flex">
                  {dayEntries.map((entry) => {
                    const accent = kindAccent(entry.kind);
                    const Icon = OccasionIcon(entry.kind);
                    const active = selected && rowKey(selected) === rowKey(entry);
                    return (
                      <button
                        key={rowKey(entry)}
                        type="button"
                        onClick={() => select(entry)}
                        title={`${entry.label} — ${entry.onLong}`}
                        className={[
                          "flex items-center gap-1 px-1.5 py-1 text-left text-phx-2xs font-black leading-tight transition-colors",
                          accent.chip,
                          entry.daysAway < 0 ? "opacity-70" : "",
                          active ? "ring-1 ring-inset ring-orange-500" : "hover:brightness-95",
                        ].join(" ")}
                      >
                        <Icon className="size-3 shrink-0" aria-hidden />
                        <span className="min-w-0 break-words">{entry.label}</span>
                      </button>
                    );
                  })}
                </div>
                {dayEntries.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => {
                      const first = dayEntries[0];
                      if (first) select(first);
                    }}
                    aria-label={dayEntries.map((e) => e.label).join(", ")}
                    className="mt-auto flex flex-wrap gap-0.5 sm:hidden"
                  >
                    {dayEntries.map((entry) => (
                      <span key={rowKey(entry)} className={`size-2 ${kindAccent(entry.kind).dot} ${entry.daysAway < 0 ? "opacity-60" : ""}`} aria-hidden />
                    ))}
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>

      {/* ── The card for the chosen occasion ──────────────────────────────────────────────────── */}
      {selected ? (
        <div className="mx-auto w-full max-w-md">
          <SectionCard surface="portal" icon={OccasionIcon(selected.kind)} title={selected.label} subtitle={`${selected.onLong} · ${whenLabel(selected.daysAway)}`}>
            <div className="space-y-3">
              {showFraming ? (
                <>
                  {/* The fixed 4:5 frame; the picture is dragged inside it. */}
                  <div className="flex justify-center">
                    <div
                      className="relative w-full max-w-[220px] cursor-grab touch-none select-none overflow-hidden border border-slate-300 bg-slate-100 active:cursor-grabbing"
                      onPointerCancel={endDrag}
                      onPointerDown={startDrag}
                      onPointerMove={moveDrag}
                      onPointerUp={endDrag}
                      style={{ aspectRatio: FRAME_RATIO }}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element -- the same private bytes the
                          card uses, or a data URI that never leaves the page; next/image would proxy a
                          private photo and cannot optimise a data URI. */}
                      <img
                        alt=""
                        className="absolute left-0 top-0 object-cover"
                        draggable={false}
                        key={photoSrc}
                        onLoad={(event) => readNatural(event.currentTarget)}
                        ref={readNatural}
                        src={photoSrc ?? ""}
                        style={{
                          width: `${fill.w * 100}%`,
                          height: `${fill.h * 100}%`,
                          maxWidth: "none",
                          transform: `translate(${fillOffset(fill.w, focusValue.x)}, ${fillOffset(fill.h, focusValue.y)})`,
                        }}
                      />
                    </div>
                  </div>
                  <p className="text-center text-phx-xs text-slate-500">Drag the photo to frame it.</p>
                  <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
                    Zoom
                    <input
                      type="range"
                      min={1}
                      max={MAX_ZOOM}
                      step={0.01}
                      value={focusValue.zoom}
                      onChange={(event) => setZoom(Number(event.target.value))}
                      className="flex-1"
                    />
                  </label>
                </>
              ) : (
                <div className="mx-auto flex aspect-[4/5] w-full max-w-[220px] items-center justify-center border border-dashed border-slate-300 bg-slate-50 text-center text-phx-xs text-slate-500">
                  {withoutPhoto ? "The card will print your initials." : "No photo on file — the card prints your initials, or upload one below."}
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                <button type="button" className={BTN_LIGHT} onClick={() => uploadInput.current?.click()}>
                  <ImageUp aria-hidden className="size-3.5" /> Upload photo
                </button>
                {upload ? (
                  <button type="button" className={BTN_LIGHT} onClick={dropUpload}>
                    <RotateCcw aria-hidden className="size-3.5" /> Use my photo
                  </button>
                ) : null}
                <button
                  type="button"
                  className={BTN_LIGHT}
                  onClick={() => {
                    setWithoutPhoto((v) => !v);
                    setFocusEdit(null);
                    setNatural(null);
                  }}
                >
                  <UserX aria-hidden className="size-3.5" /> {withoutPhoto ? "Show photo" : "No photo"}
                </button>
                <input ref={uploadInput} type="file" accept="image/*" className="hidden" onChange={(event) => takeUpload(event.target.files?.[0])} />
              </div>

              <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-3">
                <button type="button" className={BTN} disabled={busy !== null} onClick={() => download("pdf")}>
                  {busy === "pdf" ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <Download aria-hidden className="size-3.5" />}
                  {busy === "pdf" ? "Preparing" : "Download PDF"}
                </button>
                <button type="button" className={BTN} disabled={busy !== null} onClick={() => download("png")}>
                  {busy === "png" ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <Download aria-hidden className="size-3.5" />}
                  {busy === "png" ? "Preparing" : "Download picture"}
                </button>
              </div>
            </div>
          </SectionCard>
        </div>
      ) : (
        <div className={`${SURFACE_CLASS} flex items-center justify-center p-6 text-center text-sm text-slate-500`}>
          <span className="inline-flex items-center gap-2">
            <Award className="size-4 text-orange-500" aria-hidden /> Tap a milestone on the calendar to frame its photo and download the card.
          </span>
        </div>
      )}
    </div>
  );
}
