"use client";

import { useCallback, useMemo, useState } from "react";

/**
 * Spotlight — the medical rep's own picker.
 *
 * ONE PERSON, HIMSELF. There is no subject, no filter, no ranking: the rep chooses a period — a
 * single month, a quarter, a semester, or any run of months in between (owner, 2026-09-30) — and asks
 * how he did. The server answers with his achievement against the PUBLISHED monthly closing, and the
 * picture and the PDF unlock only at 90% and above.
 *
 * 🔒 NO HORIZONTAL SCROLL, square corners, mobile and desktop. Reps read this on a tablet, so the
 * controls stack to one column on a phone and the buttons wrap.
 */

const FIELD =
  "w-full rounded-none border border-slate-300 bg-white px-3 py-2 text-[13px] text-slate-900"
  + " focus:border-sky-700 focus:outline-none";
const LABEL = "block text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500";
const CARD = "rounded-none border border-slate-200 bg-white p-4";

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
  /** Every month the rep may pick, ascending `YYYY-MM`. */
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

/** Presets over the months the rep actually has, newest-anchored. Each returns [from, to]. */
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

export function RepSpotlightWorkspace({ months, defaultFrom, defaultTo, threshold }: Props) {
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<"preview" | "png" | "pdf" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const presets = useMemo(() => presetsFor(months), [months]);
  // A backwards range is the one thing the picker can catch before the server does.
  const rangeValid = from <= to;

  const show = useCallback(async () => {
    if (!rangeValid) {
      setError("The first month cannot come after the last.");
      return;
    }
    setBusy("preview");
    setError(null);
    try {
      const response = await fetch("/api/spotlight/me/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, to }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error ?? "Spotlight failed to load.");
      setPreview(payload as Preview);
    } catch (caught) {
      setPreview(null);
      setError(caught instanceof Error ? caught.message : "Spotlight failed to load.");
    } finally {
      setBusy(null);
    }
  }, [from, to, rangeValid]);

  const download = useCallback(async (format: "png" | "pdf") => {
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
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = named ?? `sato-spotlight.${format}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Spotlight sheet failed to render.");
    } finally {
      setBusy(null);
    }
  }, [from, to]);

  const beat = preview?.achievement !== null && preview !== null && preview.achievement! >= 100;

  return (
    <div className="mx-auto w-full max-w-3xl">
      <p className="mb-4 max-w-2xl text-[13px] leading-relaxed text-slate-600">
        Choose a period — a single month, a quarter, a semester, or any run of months — and see how you
        did against your published targets. When you reach {threshold}% or more, you can download your
        spotlight as a picture or a PDF.
      </p>

      {error ? (
        <p className="mb-4 rounded-none border border-red-300 bg-red-50 px-4 py-3 text-[13px] text-red-800">
          {error}
        </p>
      ) : null}

      <section className={CARD}>
        <h2 className="mb-3 text-[13px] font-bold text-slate-900">Period</h2>
        {presets.length > 0 ? (
          <div className="mb-3 flex flex-wrap gap-2">
            {presets.map((preset) => {
              const active = from === preset.range[0] && to === preset.range[1];
              return (
                <button
                  className={`rounded-none border px-3 py-1.5 text-[12px] font-semibold ${
                    active ? "border-sky-800 bg-sky-800 text-white" : "border-slate-300 text-slate-700"
                  }`}
                  key={preset.label}
                  onClick={() => { setFrom(preset.range[0]); setTo(preset.range[1]); }}
                  type="button"
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className={LABEL} htmlFor="rs-from">From</label>
            <select className={FIELD} id="rs-from" onChange={(event) => setFrom(event.target.value)} value={from}>
              {months.map((period) => (
                <option key={period} value={period}>{monthLabel(period)}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={LABEL} htmlFor="rs-to">To</label>
            <select className={FIELD} id="rs-to" onChange={(event) => setTo(event.target.value)} value={to}>
              {months.map((period) => (
                <option key={period} value={period}>{monthLabel(period)}</option>
              ))}
            </select>
          </div>
        </div>
        {!rangeValid ? (
          <p className="mt-2 text-[12px] text-red-700">The first month cannot come after the last.</p>
        ) : null}

        <div className="mt-4">
          <button
            className="rounded-none bg-sky-800 px-5 py-2.5 text-[13px] font-semibold text-white disabled:opacity-50"
            disabled={busy !== null || !rangeValid}
            onClick={show}
            type="button"
          >
            {busy === "preview" ? "Checking…" : "Show my achievement"}
          </button>
        </div>
      </section>

      {preview ? (
        <section className={`${CARD} mt-4`}>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            {preview.rangeLabel}
          </p>
          <p className="mt-1 flex items-baseline gap-2">
            <span
              className={`text-[34px] font-bold leading-none ${
                preview.achievement === null ? "text-slate-400" : beat ? "text-emerald-700" : "text-slate-900"
              }`}
            >
              {preview.achievement === null ? "—" : `${preview.achievement.toFixed(1)}%`}
            </span>
            <span className="text-[12px] text-slate-500">of your published target</span>
          </p>

          {preview.pendingPeriods.length > 0 ? (
            <p className="mt-3 rounded-none border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
              {preview.pendingPeriods.map(monthLabel).join(", ")}
              {preview.pendingPeriods.length === 1 ? " is not published yet and was left out." : " are not published yet and were left out."}
            </p>
          ) : null}

          {preview.eligible ? (
            <div className="mt-4">
              <p className="mb-2 text-[13px] text-emerald-800">
                Your spotlight is ready. Download it as a picture to share, or as a PDF to print.
              </p>
              <div className="flex flex-wrap gap-3">
                <button
                  className="rounded-none bg-sky-800 px-5 py-2.5 text-[13px] font-semibold text-white disabled:opacity-50"
                  disabled={busy !== null}
                  onClick={() => download("png")}
                  type="button"
                >
                  {busy === "png" ? "Building the picture…" : "Download picture"}
                </button>
                <button
                  className="rounded-none border border-sky-800 px-5 py-2.5 text-[13px] font-semibold text-sky-800 disabled:opacity-50"
                  disabled={busy !== null}
                  onClick={() => download("pdf")}
                  type="button"
                >
                  {busy === "pdf" ? "Building the PDF…" : "Download PDF"}
                </button>
              </div>
            </div>
          ) : (
            <p className="mt-3 text-[13px] leading-relaxed text-slate-600">{preview.reason}</p>
          )}
        </section>
      ) : null}
    </div>
  );
}
