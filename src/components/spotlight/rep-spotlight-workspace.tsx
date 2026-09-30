"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarRange, Download, FileText, Sparkles } from "lucide-react";

import { SearchableSelect } from "@/components/ui/searchable-select";

/**
 * Spotlight — one person's own sheet.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * 🔒 IT WEARS THE EMPLOYEE PORTAL'S OWN LOOK, AND THE SHELL OWNS THE HEADER.
 *
 * Owner, 2026-09-30: "premium polish the page to follow the portal style." The version before this
 * carried a dark slate banner of its own, directly beneath `EmployeePortalPageShell`'s navy command
 * header — TWO stacked dark blocks, which is what made the page read as broken rather than merely
 * plain. The lesson is worth keeping: this shell ALREADY renders the badge, the title and the
 * description, so a page inside it must never draw a second hero.
 *
 * Everything below is the portal's own vocabulary, taken from `enterprise-shell.tsx`:
 *   · cards are white on `rounded border border-slate-200` with the portal's deep-but-soft shadow
 *   · orange is the single accent — the eyebrow, the active chip, the primary button, the meter
 *   · type is the `text-phx-*` scale with black uppercase micro-labels
 *   · buttons lift on hover exactly as `EmployeePortalActionLink` does
 *
 * 🔒 No horizontal scroll at any width, and no truncation — the owner's standing UI rules. The sheet
 * image is `w-full` so an A4 portrait fits a phone, and every grid collapses to one column.
 */

// ─── Portal primitives ────────────────────────────────────────────────────────────────────────────

const CARD = "rounded border border-slate-200 bg-white shadow-[0_18px_46px_rgba(15,23,42,0.07)]";
const CARD_HEAD = "flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4";
const EYEBROW = "text-phx-2xs font-black uppercase tracking-[0.18em] text-orange-600";
const LABEL = "mb-1.5 block text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500";

const FIELD =
  "h-11 w-full rounded border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-900"
  + " shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition focus:border-orange-400 focus:outline-none"
  + " focus:ring-2 focus:ring-orange-500/15 disabled:cursor-not-allowed disabled:opacity-50";

const BTN_PRIMARY =
  "inline-flex items-center justify-center gap-2 rounded bg-orange-600 px-5 py-2.5 text-sm font-bold text-white"
  + " shadow-[0_8px_20px_rgba(249,115,22,0.18)] transition duration-200 hover:-translate-y-px hover:bg-orange-700"
  + " hover:shadow-[0_12px_26px_rgba(249,115,22,0.24)] disabled:pointer-events-none disabled:opacity-50";
const BTN_QUIET =
  "inline-flex items-center justify-center gap-2 rounded border border-slate-200/80 bg-white px-4 py-2.5 text-sm"
  + " font-bold text-slate-600 shadow-[0_4px_12px_rgba(15,23,42,0.06)] transition duration-200"
  + " hover:-translate-y-px hover:border-orange-300/80 hover:text-orange-700"
  + " hover:shadow-[0_8px_20px_rgba(249,115,22,0.12)] disabled:pointer-events-none disabled:opacity-50";

// ─── Data ─────────────────────────────────────────────────────────────────────────────────────────

type Preview = {
  from: string;
  to: string;
  rangeLabel: string;
  requestedPeriods: string[];
  publishedPeriods: string[];
  pendingPeriods: string[];
  achievement: number | null;
  eligible: boolean;
  threshold: number;
  reason: string | null;
};

type Props = {
  /** Every month the viewer may pick, ascending `YYYY-MM`. */
  months: string[];
  defaultFrom: string;
  defaultTo: string;
  threshold: number;
};

function monthLabel(period: string): string {
  const [year, month] = period.split("-");
  return new Date(Date.UTC(Number(year), Number(month) - 1, 1))
    .toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** Presets over the months actually available, newest-anchored. Each returns [from, to]. */
function presetsFor(months: string[]): { label: string; range: [string, string] }[] {
  if (months.length === 0) return [];
  const last = months[months.length - 1]!;
  const take = (n: number): [string, string] => {
    const slice = months.slice(Math.max(0, months.length - n));
    return [slice[0]!, slice[slice.length - 1]!];
  };
  const out: { label: string; range: [string, string] }[] = [
    { label: "This month", range: [last, last] },
  ];
  if (months.length >= 2) out.push({ label: "Last 2 months", range: take(2) });
  if (months.length >= 3) out.push({ label: "Last quarter", range: take(3) });
  if (months.length >= 6) out.push({ label: "Last semester", range: take(6) });
  return out;
}

/**
 * The meter under the figure.
 *
 * It draws the achievement against the threshold rather than against 100%, because the threshold is
 * the thing the reader is actually asking about: am I past the mark? The scale is capped so a 300%
 * month does not render a bar nine times the card's width, and the tick sits where the mark is.
 */
function AchievementMeter({ value, threshold }: { value: number; threshold: number }) {
  const scale = Math.max(120, Math.min(200, value * 1.1));
  const filled = Math.max(0, Math.min(100, (value / scale) * 100));
  const mark = Math.max(0, Math.min(100, (threshold / scale) * 100));
  const earned = value >= threshold;

  return (
    <div className="mt-4">
      <div className="relative h-2 w-full rounded bg-slate-100">
        <div
          className={`h-2 rounded transition-all duration-500 ${earned ? "bg-orange-500" : "bg-slate-400"}`}
          style={{ width: `${filled.toFixed(2)}%` }}
        />
        <span
          aria-hidden
          className="absolute -top-1 h-4 w-px bg-slate-700"
          style={{ left: `${mark.toFixed(2)}%` }}
        />
      </div>
      <p className="mt-2 text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-400">
        The mark is {threshold}%
      </p>
    </div>
  );
}

export function RepSpotlightWorkspace({ months, defaultFrom, defaultTo, threshold }: Props) {
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<"preview" | "png" | "pdf" | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * The rendered sheet, shown ON SCREEN as soon as the period is chosen (owner, 2026-09-30): he sees
   * the picture first and only then decides to keep it. The blob is HELD so "Download picture" saves
   * exactly the image he is looking at rather than rendering a second one.
   */
  const [sheet, setSheet] = useState<{ url: string; blob: Blob } | null>(null);

  // An object URL is a document-lifetime handle; replacing or leaving without revoking leaks the PNG.
  const replaceSheet = useCallback((next: { url: string; blob: Blob } | null) => {
    setSheet((current) => {
      if (current) URL.revokeObjectURL(current.url);
      return next;
    });
  }, []);
  useEffect(() => () => { if (sheet) URL.revokeObjectURL(sheet.url); }, [sheet]);

  const presets = useMemo(() => presetsFor(months), [months]);
  const rangeValid = from <= to;

  const show = useCallback(async () => {
    if (!rangeValid) {
      setError("The first month cannot come after the last.");
      return;
    }
    setBusy("preview");
    setError(null);
    replaceSheet(null);
    try {
      const response = await fetch("/api/spotlight/me/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, to }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error ?? "Spotlight failed to load.");
      const next = payload as Preview;
      setPreview(next);

      // Earned it? Draw the sheet straight away — he sees the picture before he decides to keep it.
      if (next.eligible) {
        const rendered = await fetch("/api/spotlight/me/sheet", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ from, to, format: "png" }),
        });
        if (!rendered.ok) {
          const failed = await rendered.json().catch(() => null);
          throw new Error(failed?.error ?? "Your spotlight could not be drawn.");
        }
        const blob = await rendered.blob();
        replaceSheet({ url: URL.createObjectURL(blob), blob });
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Spotlight failed to load.");
    } finally {
      setBusy(null);
    }
  }, [from, to, rangeValid, replaceSheet]);

  const save = useCallback((blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }, []);

  const download = useCallback(async (format: "png" | "pdf") => {
    // The picture is already in hand — save the very bytes on screen rather than rendering again.
    if (format === "png" && sheet) {
      save(sheet.blob, `sato-spotlight-${from}${to === from ? "" : `_${to}`}.png`);
      return;
    }
    setBusy(format);
    setError(null);
    try {
      const response = await fetch("/api/spotlight/me/sheet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, to, format }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error ?? "Spotlight sheet failed to render.");
      }
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const named = /filename="([^"]+)"/.exec(disposition)?.[1];
      save(await response.blob(), named ?? `sato-spotlight.${format}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Spotlight sheet failed to render.");
    } finally {
      setBusy(null);
    }
  }, [from, to, sheet, save]);

  const earned = preview !== null && preview.achievement !== null && preview.achievement >= threshold;

  return (
    <>
      {/* ── Period ───────────────────────────────────────────────────────────── */}
      <section className={CARD}>
        <div className={CARD_HEAD}>
          <div className="min-w-0">
            <p className={EYEBROW}>Period</p>
            <h2 className="mt-1 text-base font-black tracking-tight text-slate-900">Choose your months</h2>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded border border-slate-200 bg-slate-50 px-2.5 py-1 text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500">
            <CalendarRange className="h-3.5 w-3.5 text-orange-500" />
            Published months only
          </span>
        </div>

        <div className="space-y-5 p-5">
          {presets.length > 0 && (
            <div>
              <span className={LABEL}>Quick pick</span>
              <div className="flex flex-wrap gap-2">
                {presets.map((preset) => {
                  const active = from === preset.range[0] && to === preset.range[1];
                  return (
                    <button
                      className={[
                        "rounded border px-3 py-1.5 text-phx-xs font-bold tracking-wide transition duration-200",
                        active
                          ? "border-orange-300 bg-orange-50 text-orange-700 shadow-[0_4px_12px_rgba(249,115,22,0.10)]"
                          : "border-slate-200/80 bg-white text-slate-600 hover:-translate-y-px hover:border-orange-300/80 hover:text-orange-700",
                      ].join(" ")}
                      key={preset.label}
                      onClick={() => { setFrom(preset.range[0]); setTo(preset.range[1]); }}
                      type="button"
                    >
                      {preset.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className={LABEL} htmlFor="spotlight-from">From</label>
              <SearchableSelect className={FIELD} id="spotlight-from" onChange={(e) => setFrom(e.target.value)} value={from}>
                {months.map((period) => (
                  <option key={period} value={period}>{monthLabel(period)}</option>
                ))}
              </SearchableSelect>
            </div>
            <div>
              <label className={LABEL} htmlFor="spotlight-to">To</label>
              <SearchableSelect className={FIELD} id="spotlight-to" onChange={(e) => setTo(e.target.value)} value={to}>
                {months.map((period) => (
                  <option key={period} value={period}>{monthLabel(period)}</option>
                ))}
              </SearchableSelect>
            </div>
          </div>

          {!rangeValid && (
            <p className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-800">
              The first month cannot come after the last.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button className={BTN_PRIMARY} disabled={busy !== null || !rangeValid} onClick={show} type="button">
              <Sparkles className="h-4 w-4" />
              {busy === "preview" ? "Drawing your spotlight…" : "Show my spotlight"}
            </button>
            <span className="text-phx-xs font-semibold text-slate-400">
              Your sheet appears here at {threshold}% or more.
            </span>
          </div>

          {error && (
            <p className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-800">
              {error}
            </p>
          )}
        </div>
      </section>

      {/* ── Result ───────────────────────────────────────────────────────────── */}
      {preview && (
        <section className={CARD}>
          <div className={CARD_HEAD}>
            <div className="min-w-0">
              <p className={EYEBROW}>Your achievement</p>
              <h2 className="mt-1 text-base font-black tracking-tight text-slate-900">{preview.rangeLabel}</h2>
            </div>
            {earned && (
              <span className="inline-flex items-center gap-1.5 rounded border border-orange-200 bg-orange-50 px-2.5 py-1 text-phx-2xs font-black uppercase tracking-[0.14em] text-orange-700">
                <Sparkles className="h-3.5 w-3.5" />
                Spotlight earned
              </span>
            )}
          </div>

          <div className="space-y-5 p-5">
            <div>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span
                  className={[
                    "text-5xl font-black tabular-nums leading-none tracking-tight",
                    preview.achievement === null ? "text-slate-300" : earned ? "text-orange-600" : "text-slate-900",
                  ].join(" ")}
                >
                  {preview.achievement === null ? "—" : `${preview.achievement.toFixed(1)}%`}
                </span>
                <span className="text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500">
                  of your published target
                </span>
              </div>
              {preview.achievement !== null && (
                <AchievementMeter threshold={preview.threshold} value={preview.achievement} />
              )}
            </div>

            {preview.pendingPeriods.length > 0 && (
              <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800">
                {preview.pendingPeriods.map(monthLabel).join(", ")}
                {preview.pendingPeriods.length === 1
                  ? " is not published yet and was left out."
                  : " are not published yet and were left out."}
              </p>
            )}

            {preview.eligible ? (
              <>
                {sheet && (
                  <figure className="rounded border border-slate-200 bg-slate-50 p-3 shadow-[inset_0_1px_2px_rgba(15,23,42,0.04)]">
                    <img
                      alt={`Your spotlight for ${preview.rangeLabel}`}
                      className="block w-full rounded-sm border border-slate-200 bg-white shadow-[0_10px_30px_rgba(15,23,42,0.10)]"
                      src={sheet.url}
                    />
                  </figure>
                )}
                <div className="flex flex-wrap gap-3">
                  <button className={BTN_PRIMARY} disabled={busy !== null} onClick={() => download("png")} type="button">
                    <Download className="h-4 w-4" />
                    {busy === "png" ? "Saving…" : "Download picture"}
                  </button>
                  <button className={BTN_QUIET} disabled={busy !== null} onClick={() => download("pdf")} type="button">
                    <FileText className="h-4 w-4" />
                    {busy === "pdf" ? "Building the PDF…" : "Download PDF"}
                  </button>
                </div>
              </>
            ) : (
              <p className="rounded border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-relaxed text-slate-600">
                {preview.reason}
              </p>
            )}
          </div>
        </section>
      )}
    </>
  );
}
