"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Award, Cake, Check, Download, ImageUp, Loader2, RotateCcw, Sparkles, UserX } from "lucide-react";

import { PortalEmptyState } from "@/components/employee-portal/portal-primitives";
import { ShareCardBar } from "@/components/employee-portal/share-card";
import { SURFACE_CLASS, SectionCard } from "@/components/sales/target-visuals";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";
import { milestoneShareCaption } from "@/lib/share/social-share";
import type { MyMilestoneEntry } from "@/lib/milestones/service";
import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";

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

/** The day + short month of an ISO date, e.g. {day:"12", month:"Aug"} — the badge on each node. */
function dayMonth(iso: string): { day: string; month: string } {
  const day = String(Number(iso.slice(8, 10)));
  // stableEnGbFormatter, never a bare Intl en-GB: CLDR 42 changed the September abbreviation from
  // "Sep" to "Sept", so server and browser can disagree and React throws hydration error #418.
  const month = stableEnGbFormatter({ month: "short", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));
  return { day, month };
}

const OccasionIcon = (kind: MyMilestoneEntry["kind"]) => (kind === "birthday" ? Cake : Sparkles);

/** Anniversary reads Sato-orange; a birthday reads rose — one glance tells the two apart. */
const kindAccent = (kind: MyMilestoneEntry["kind"]) =>
  kind === "birthday"
    ? { rail: "border-l-rose-500", tint: "bg-rose-50", dot: "bg-rose-500", ink: "text-rose-600" }
    : { rail: "border-l-orange-500", tint: "bg-orange-50", dot: "bg-orange-500", ink: "text-orange-600" };

/** "Today" · "In 12 days" · "Reached" — short enough never to force a sideways scroll. */
function whenLabel(daysAway: number): string {
  if (daysAway === 0) return "Today";
  if (daysAway > 0) return `In ${daysAway} ${daysAway === 1 ? "day" : "days"}`;
  return "Reached";
}

/**
 * A square, no-rounded-corner action button in the portal's ink.
 *
 * `w-full` because every one of these now sits in a two-column grid rather than a `flex-wrap` row:
 * wrapping sized each button to its own label, so the panel shipped with ragged right edges and a
 * lone button stranded on the last line. Equal cells read as one deliberate block. The hover lift is
 * the portal's own (`EmployeePortalActionLink`), so these feel like the rest of the shell.
 */
const BTN =
  "inline-flex w-full items-center justify-center gap-1.5 whitespace-nowrap border border-slate-900 " +
  "bg-slate-900 px-3 py-2 text-xs font-bold text-white shadow-[0_1px_2px_rgba(15,23,42,0.18)] " +
  "transition duration-200 hover:-translate-y-px hover:bg-slate-700 hover:shadow-[0_8px_20px_rgba(15,23,42,0.18)] " +
  "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0";
const BTN_LIGHT =
  "inline-flex w-full items-center justify-center gap-1.5 whitespace-nowrap border border-slate-300 " +
  "bg-white px-3 py-2 text-xs font-bold text-slate-800 shadow-[0_1px_2px_rgba(15,23,42,0.05)] " +
  "transition duration-200 hover:-translate-y-px hover:border-slate-400 hover:shadow-[0_6px_16px_rgba(15,23,42,0.10)] " +
  "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0";

/**
 * My Milestones — the rep's own keepsake cards on a tailored timeline (owner, 2026-09-30).
 *
 * NOT a month grid he has to page through — his anniversaries and Sato-Pharma birthdays are laid out
 * on one screen, in order, grouped by year, with the next one up highlighted. Tapping one opens the
 * card, where he frames his photo, hands in a different picture (or drops to the monogram), and
 * downloads a PDF or a picture. Every request builds only HIS card through /api/milestones/my-card;
 * nothing here names anyone else. The framing is the SAME geometry as the admin editor.
 */
export function MyMilestones({ entries, photoUrl }: Props) {
  // The timeline reads in time order (earliest → latest); the service hands them back next-first.
  const ordered = useMemo(() => [...entries].sort((a, b) => a.on.localeCompare(b.on)), [entries]);
  const nextUp = useMemo(
    () => ordered.filter((e) => e.daysAway >= 0).sort((a, b) => a.daysAway - b.daysAway)[0] ?? null,
    [ordered],
  );

  // Open with the next milestone already chosen, so his upcoming card is ready without a click.
  const [selected, setSelected] = useState<MyMilestoneEntry | null>(() => nextUp ?? ordered[0] ?? null);
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

  // The timeline, grouped by calendar year — the "tailored" shape: only his dates, all on one screen.
  const byYear = useMemo(() => {
    const groups = new Map<string, MyMilestoneEntry[]>();
    for (const entry of ordered) {
      const year = entry.on.slice(0, 4);
      const list = groups.get(year) ?? [];
      list.push(entry);
      groups.set(year, list);
    }
    return [...groups.entries()];
  }, [ordered]);

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

  // Zoom keeps whatever framing is already on screen. `focusDefault` is the crop the SERVER resolved
  // for this photo (the face-aware one the card actually prints), so it must be the base when the rep
  // has not dragged yet — falling straight through to CENTRE snapped the picture back to the middle on
  // the first touch of the slider and silently discarded that crop. Identical to the admin editor
  // (milestones-workspace.tsx, `current ?? focusDefault ?? CENTRE`), which never had the bug.
  const setZoom = useCallback(
    (zoom: number) => {
      setFocusEdit((current) => {
        const base = current ?? focusDefault ?? CENTRE;
        return { x: base.x, y: base.y, zoom: Math.min(MAX_ZOOM, Math.max(1, zoom)) };
      });
    },
    [focusDefault],
  );

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

  // Render the card server-side and hand back the file — the ONE place the card bytes are produced,
  // so the download button and every share button frame the photo identically.
  const produceCard = useCallback(
    async (format: "pdf" | "png"): Promise<{ blob: Blob; filename: string }> => {
      if (!selected) throw new Error("No milestone chosen.");
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
      return { blob, filename: match?.[1] ?? `${selected.label.replace(/[^\p{L}\p{N}]+/gu, "-")}.${format}` };
    },
    [selected, withoutPhoto, focusEdit, upload],
  );

  const download = useCallback(
    async (format: "pdf" | "png") => {
      if (!selected) return;
      setBusy(format);
      setError(null);
      try {
        const { blob, filename } = await produceCard(format);
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = filename;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "The card could not be produced.");
      } finally {
        setBusy(null);
      }
    },
    [produceCard, selected],
  );

  // Share the picture. A share always builds a PNG (the card image), never a PDF.
  const shareCard = useCallback(async () => {
    try {
      return await produceCard("png");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The card could not be produced.");
      return null;
    }
  }, [produceCard]);

  // Mint the PUBLIC, expiring link to this card so LinkedIn and Facebook can show it. The link renders
  // the RECORD photo at the framing the rep dragged (his crop travels in the link), so LinkedIn and
  // Facebook match what he saw. A custom UPLOAD cannot fit in a URL, so an uploaded card still shows
  // the record photo — WhatsApp sends the exact uploaded picture instead.
  const shareLink = useCallback(async (): Promise<string | null> => {
    if (!selected) return null;
    try {
      // A GET: minting the link is a read (it renders nothing), so a test account previewing the rep
      // may run it where a POST would be refused as a write.
      const params = new URLSearchParams({ period: selected.spec, on: selected.on });
      if (withoutPhoto) params.set("withoutPhoto", "1");
      // Carry the framing only when the card shows the record photo — a drag on an uploaded picture
      // does not describe the record photo, and a monogram has no photo to frame.
      if (!upload && !withoutPhoto) {
        params.set("fx", focusValue.x.toFixed(3));
        params.set("fy", focusValue.y.toFixed(3));
        params.set("fz", focusValue.zoom.toFixed(3));
      }
      const response = await fetch(`/api/milestones/my-card?${params.toString()}`, { method: "GET" });
      if (!response.ok) return null;
      const data = (await response.json().catch(() => null)) as { shareUrl?: unknown } | null;
      return typeof data?.shareUrl === "string" ? data.shareUrl : null;
    } catch {
      return null;
    }
  }, [selected, withoutPhoto, upload, focusValue]);

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

  const nextKey = nextUp ? rowKey(nextUp) : null;

  return (
    <div className="space-y-4">
      {error ? (
        <p className="border border-red-300 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{error}</p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)]">
        {/* ── The tailored timeline — every milestone on one screen, in order ────────────────────── */}
        <section className="overflow-hidden border border-slate-200 bg-white shadow-[0_18px_46px_rgba(15,23,42,0.07)]">
          {/* A slim strip — the page shell above already carries the "My Milestones" title, so this
              carries only what it does not: the next milestone and the colour legend. No second big
              header (the owner spotted the duplication, 2026-09-30). */}
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-b border-slate-200 bg-slate-50 px-4 py-2.5 sm:px-5">
            <p className="text-xs font-black text-slate-900">
              {nextUp ? (
                <>
                  <span className="text-slate-500">Next:</span> <span className="text-orange-600">{nextUp.label}</span>
                  <span className="font-semibold text-slate-500"> · {whenLabel(nextUp.daysAway).toLowerCase()}</span>
                </>
              ) : (
                `${entries.length} milestone${entries.length === 1 ? "" : "s"}`
              )}
            </p>
            <div className="flex items-center gap-x-4 text-phx-sm font-bold uppercase tracking-[0.12em] text-slate-500">
              <span className="inline-flex items-center gap-1.5"><span className="size-2.5 bg-orange-500" aria-hidden /> Anniversary</span>
              <span className="inline-flex items-center gap-1.5"><span className="size-2.5 bg-rose-500" aria-hidden /> Birthday</span>
            </div>
          </div>

          {/* The timeline, grouped by year. */}
          <div className="p-4 sm:p-5">
            {byYear.map(([year, group]) => (
              <div key={year} className="mb-6 last:mb-0">
                <div className="mb-2.5 flex items-center gap-2">
                  <p className="text-base font-black tracking-tight text-slate-900">{year}</p>
                  <span className="inline-flex items-center justify-center bg-slate-100 px-1.5 py-0.5 text-phx-sm font-black tabular-nums text-slate-500">
                    {group.length}
                  </span>
                  <span aria-hidden className="h-px flex-1 bg-slate-100" />
                </div>
                <ol className="relative ml-2 space-y-2 border-l-2 border-slate-200 pl-5">
                  {group.map((entry) => {
                    const accent = kindAccent(entry.kind);
                    const Icon = OccasionIcon(entry.kind);
                    const isNext = nextKey === rowKey(entry);
                    const isSelected = selected != null && rowKey(selected) === rowKey(entry);
                    const past = entry.daysAway < 0;
                    const badge = dayMonth(entry.on);
                    return (
                      <li key={rowKey(entry)} className="relative">
                        {/* The node on the spine. */}
                        <span
                          aria-hidden
                          className={[
                            "absolute -left-[27px] top-3 flex size-3.5 items-center justify-center border-2 border-white",
                            accent.dot,
                            isNext ? "ring-2 ring-orange-300" : "",
                            past ? "opacity-70" : "",
                          ].join(" ")}
                        >
                          {past ? <Check className="size-2 text-white" aria-hidden /> : null}
                        </span>
                        <button
                          type="button"
                          onClick={() => select(entry)}
                          className={[
                            "flex w-full items-center gap-3 border border-l-[3px] bg-white px-3 py-2.5 text-left transition duration-200",
                            accent.rail,
                            isSelected
                              ? "border-orange-500 shadow-[0_8px_22px_rgba(249,115,22,0.15)] ring-2 ring-inset ring-orange-500"
                              : "border-slate-200 shadow-[0_1px_2px_rgba(15,23,42,0.04)] hover:-translate-y-px hover:border-slate-300 hover:shadow-[0_10px_24px_rgba(15,23,42,0.10)]",
                            isNext && !isSelected ? "bg-orange-50/40" : "",
                            past ? "opacity-90" : "",
                          ].join(" ")}
                        >
                          <span className={`flex size-10 shrink-0 flex-col items-center justify-center border border-black/5 ${accent.tint} ${accent.ink}`}>
                            <span className="text-base font-black leading-none">{badge.day}</span>
                            <span className="text-phx-xs font-bold uppercase leading-none">{badge.month}</span>
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1.5">
                              <Icon className={`size-3.5 shrink-0 ${accent.ink}`} aria-hidden />
                              <span className="break-words text-sm font-black text-slate-900">{entry.label}</span>
                              {isNext ? (
                                <span className="bg-orange-500 px-1.5 py-0.5 text-phx-xs font-black uppercase tracking-wide text-white">Next</span>
                              ) : null}
                            </span>
                            <span className="mt-0.5 block text-phx-xs font-semibold text-slate-500">
                              {entry.onLong} · {whenLabel(entry.daysAway)}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ol>
              </div>
            ))}
          </div>
        </section>

        {/* ── The card for the chosen occasion ──────────────────────────────────────────────────── */}
        {selected ? (
          <SectionCard surface="portal" icon={OccasionIcon(selected.kind)} title={selected.label} subtitle={`${selected.onLong} · ${whenLabel(selected.daysAway)}`}>
            <div className="space-y-3">
              {showFraming ? (
                <>
                  {/* The fixed 4:5 frame; the picture is dragged inside it.

                      THE MAT IS THE POLISH. The frame alone, capped at 220px, sat adrift in the
                      middle of a white card with wide blank gutters either side — it read as a
                      thumbnail that had failed to load rather than as the keepsake it is. Setting it
                      on a slate plinth with a hairline, and letting it grow to 260px, makes the
                      portrait the subject of the panel. The GEOMETRY is untouched: still a fixed 4:5
                      box, still `object-cover` at the same `object-position`, so what is under the
                      cursor is still exactly what the printer cuts. */}
                  <div className={`flex justify-center border border-slate-200 bg-slate-50 p-3 ${adminSoftDepthClassName}`}>
                    <div
                      className="relative w-full max-w-[260px] cursor-grab touch-none select-none overflow-hidden border border-slate-300 bg-slate-100 shadow-[0_10px_28px_rgba(15,23,42,0.12)] active:cursor-grabbing"
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
                  <p className="text-center text-phx-sm font-black uppercase tracking-[0.14em] text-slate-400">
                    Drag the photo to frame it
                  </p>
                  {/* The zoom slider ran edge to edge as a raw browser control with a round blue
                      thumb — the one unstyled thing on the panel. Boxed, micro-labelled and given a
                      readout, it reads as part of the card. The thumb and track are squared and put
                      into the portal's orange by globals.css RULE 1d (the browser draws them from its
                      own shadow tree, so no class on this element can reach them). */}
                  <label className={`flex items-center gap-3 border border-slate-200 bg-white px-3 py-2 ${adminSoftDepthClassName}`}>
                    <span className="text-phx-sm font-black uppercase tracking-[0.14em] text-slate-500">Zoom</span>
                    <input
                      type="range"
                      min={1}
                      max={MAX_ZOOM}
                      step={0.01}
                      value={focusValue.zoom}
                      onChange={(event) => setZoom(Number(event.target.value))}
                      className="flex-1"
                    />
                    <span className="w-9 text-right text-phx-xs font-black tabular-nums text-slate-700">
                      {focusValue.zoom.toFixed(1)}×
                    </span>
                  </label>
                </>
              ) : (
                <div className="mx-auto flex aspect-[4/5] w-full max-w-[260px] items-center justify-center border border-dashed border-slate-300 bg-slate-50 px-4 text-center text-phx-xs text-slate-500">
                  {withoutPhoto ? "The card will print your initials." : "No photo on file — the card prints your initials, or upload one below."}
                </div>
              )}

              <div className="grid grid-cols-2 gap-2">
                <button type="button" className={BTN_LIGHT} onClick={() => uploadInput.current?.click()}>
                  <ImageUp aria-hidden className="size-3.5" /> Upload photo
                </button>
                {upload ? (
                  <button type="button" className={`${BTN_LIGHT} col-span-2 order-last`} onClick={dropUpload}>
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

              <div className="grid grid-cols-2 gap-2 border-t border-slate-100 pt-3">
                <button type="button" className={BTN} disabled={busy !== null} onClick={() => download("pdf")}>
                  {busy === "pdf" ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <Download aria-hidden className="size-3.5" />}
                  {busy === "pdf" ? "Preparing" : "Download PDF"}
                </button>
                <button type="button" className={BTN} disabled={busy !== null} onClick={() => download("png")}>
                  {busy === "png" ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <Download aria-hidden className="size-3.5" />}
                  {busy === "png" ? "Preparing" : "Download picture"}
                </button>
              </div>

              {/* Share the card straight to WhatsApp, his Status, LinkedIn or Facebook. On his tablet
                  the button opens the share sheet with the picture attached; on a desktop it saves the
                  picture and opens the platform's composer. */}
              <div className="border-t border-slate-100 pt-3">
                <ShareCardBar
                  getFile={shareCard}
                  getPageUrl={shareLink}
                  caption={milestoneShareCaption(selected.label)}
                  disabled={busy !== null}
                  heading="Share your card"
                />
              </div>
            </div>
          </SectionCard>
        ) : (
          <div className={`${SURFACE_CLASS} flex items-center justify-center p-6 text-center text-sm text-slate-500`}>
            <span className="inline-flex items-center gap-2">
              <Award className="size-4 text-orange-500" aria-hidden /> Tap a milestone to frame its photo and download the card.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
