"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Award, Cake, Download, ImageUp, Loader2, RotateCcw, Sparkles, UserX } from "lucide-react";

import { PortalEmptyState } from "@/components/employee-portal/portal-primitives";
import {
  SURFACE_CLASS,
  SectionCard,
  TABLE_HEAD_CLASS,
  TABLE_ROW_CLASS,
} from "@/components/sales/target-visuals";
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

/** "Today" · "In 12 days" · "Reached" — short enough never to force a sideways scroll. */
function whenLabel(daysAway: number): string {
  if (daysAway === 0) return "Today";
  if (daysAway > 0) return `In ${daysAway} ${daysAway === 1 ? "day" : "days"}`;
  return "Reached";
}

const OccasionIcon = (kind: MyMilestoneEntry["kind"]) => (kind === "birthday" ? Cake : Sparkles);

/** A square, no-rounded-corner action button in the portal's ink. */
const BTN =
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap border border-slate-900 " +
  "bg-slate-900 px-3 py-1.5 text-xs font-bold text-white transition-colors hover:bg-slate-700 " +
  "disabled:cursor-not-allowed disabled:opacity-50";
const BTN_LIGHT =
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap border border-slate-300 " +
  "bg-white px-3 py-1.5 text-xs font-bold text-slate-800 transition-colors hover:bg-slate-50 " +
  "disabled:cursor-not-allowed disabled:opacity-50";

/**
 * My Milestones — the rep's own keepsake cards, self-scoped (owner, 2026-09-30).
 *
 * He sees his photo, drags it to frame the card, can hand in a different picture (or drop to the
 * monogram), and downloads the card as a PDF or a picture. Every request builds only HIS card
 * through /api/milestones/my-card; nothing here names anyone else. The framing is the SAME geometry
 * as the admin editor, so what he drags is what the printer cuts.
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
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = match?.[1] ?? `${selected.label.replace(/[^\p{L}\p{N}]+/gu, "-")}.${format}`;
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

  const upcoming = entries.filter((entry) => entry.daysAway >= 0).length;

  return (
    <div className="space-y-3">
      {error ? (
        <p className="border border-red-300 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{error}</p>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,340px)]">
        {/* ── The occasions ──────────────────────────────────────────────────────────────────── */}
        <SectionCard
          surface="portal"
          icon={Award}
          title="Keepsake cards"
          subtitle={`${entries.length} milestone${entries.length === 1 ? "" : "s"}${upcoming > 0 ? ` · ${upcoming} coming up` : ""}`}
        >
          {/* Tablet and desktop: table-fixed + colgroup, so it always fits — never a sideways scroll. */}
          <div className="hidden md:block">
            <table className="w-full table-fixed text-left text-sm">
              <colgroup>
                <col style={{ width: "42%" }} />
                <col style={{ width: "28%" }} />
                <col style={{ width: "30%" }} />
              </colgroup>
              <thead>
                <tr className={TABLE_HEAD_CLASS}>
                  <th className="px-3 py-2.5">Occasion</th>
                  <th className="px-3 py-2.5">Date</th>
                  <th className="px-3 py-2.5 text-right">Card</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => {
                  const Icon = OccasionIcon(entry.kind);
                  const active = selected && rowKey(selected) === rowKey(entry);
                  return (
                    <tr key={rowKey(entry)} className={`${TABLE_ROW_CLASS} align-middle ${active ? "bg-orange-50/60" : ""}`}>
                      <td className="px-3 py-2.5">
                        <span className="flex items-center gap-2 font-bold text-slate-900">
                          <Icon aria-hidden className="size-4 shrink-0 text-orange-500" />
                          <span className="break-words">{entry.label}</span>
                        </span>
                      </td>
                      <td className="break-words px-3 py-2.5 text-slate-700">
                        {entry.onLong}
                        <span className="block text-phx-xs text-slate-500">{whenLabel(entry.daysAway)}</span>
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <button type="button" className={BTN} onClick={() => select(entry)}>
                          {active ? "Editing" : "Customize"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Phone: cards, never a table (owner's rule). */}
          <div className="space-y-2 md:hidden">
            {entries.map((entry) => {
              const Icon = OccasionIcon(entry.kind);
              const active = selected && rowKey(selected) === rowKey(entry);
              return (
                <article key={rowKey(entry)} className={`border border-slate-200 bg-white p-3 ${active ? "ring-1 ring-orange-300" : ""}`}>
                  <p className="flex items-center gap-2 text-sm font-black text-slate-900">
                    <Icon aria-hidden className="size-4 shrink-0 text-orange-500" />
                    <span className="break-words">{entry.label}</span>
                  </p>
                  <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-t border-slate-100 pt-2 text-xs">
                    <span className="break-words text-slate-700">{entry.onLong}</span>
                    <span className="text-slate-500">{whenLabel(entry.daysAway)}</span>
                  </div>
                  <button type="button" className={`${BTN} mt-3 w-full`} onClick={() => select(entry)}>
                    {active ? "Editing below" : "Customize & download"}
                  </button>
                </article>
              );
            })}
          </div>
        </SectionCard>

        {/* ── The editor for the chosen occasion ─────────────────────────────────────────────── */}
        {selected ? (
          <SectionCard surface="portal" icon={OccasionIcon(selected.kind)} title={selected.label} subtitle={selected.onLong}>
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
                <div className="flex aspect-[4/5] w-full max-w-[220px] items-center justify-center border border-dashed border-slate-300 bg-slate-50 text-center text-phx-xs text-slate-500 mx-auto">
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
                <input
                  ref={uploadInput}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(event) => takeUpload(event.target.files?.[0])}
                />
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
        ) : (
          <div className={`${SURFACE_CLASS} flex items-center justify-center p-6 text-center text-sm text-slate-500`}>
            Pick an occasion to frame its photo and download the card.
          </div>
        )}
      </div>
    </div>
  );
}
