"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { MilestoneDueEntry } from "@/lib/milestones/service";

/**
 * Milestones — the workspace.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * TWO HALVES, IN THE ORDER THE WORK HAPPENS. Who is coming up, then the card for the one you
 * picked. The list is the reason to open the page at all: a first month is easy to miss, and by
 * the time somebody mentions it the day has gone.
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

type Props = {
  initialEntries: MilestoneDueEntry[];
  initialFrom: string;
  initialTo: string;
  canExport: boolean;
};

export function MilestonesWorkspace({ initialEntries, initialFrom, initialTo, canExport }: Props) {
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [entries, setEntries] = useState(initialEntries);
  const [loadingList, setLoadingList] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<MilestoneDueEntry | null>(initialEntries[0] ?? null);
  const [preset, setPreset] = useState(initialEntries[0]?.spec ?? "1m");
  const [custom, setCustom] = useState("");
  const [dateOverride, setDateOverride] = useState("");
  const [nameOverride, setNameOverride] = useState("");
  const [citation, setCitation] = useState("");
  const [variant, setVariant] = useState("trim");
  const [withoutPhoto, setWithoutPhoto] = useState(false);

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<"preview" | "download" | null>(null);

  const frameBox = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);

  // The preview scales to its container rather than the container scrolling to the preview.
  useEffect(() => {
    const node = frameBox.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setScale(node.clientWidth / SHEET_W));
    observer.observe(node);
    setScale(node.clientWidth / SHEET_W);
    return () => observer.disconnect();
  }, []);

  // A blob URL outlives the component unless it is revoked by hand.
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  const period = preset === "custom" ? custom.trim() : preset;

  const body = useMemo(
    () => ({
      hrId: selected?.hrId ?? "",
      period,
      on: dateOverride || undefined,
      displayName: nameOverride.trim() || undefined,
      citation: citation.trim() || undefined,
      withoutPhoto,
      variant,
    }),
    [selected, period, dateOverride, nameOverride, citation, withoutPhoto, variant],
  );

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

  const pick = useCallback((entry: MilestoneDueEntry) => {
    setSelected(entry);
    setPreset(PRESETS.some((p) => p.value === entry.spec) ? entry.spec : "custom");
    setCustom(entry.spec);
    setDateOverride(entry.on);
    setNameOverride("");
    setCitation("");
    setPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return null;
    });
  }, []);

  const buildPreview = useCallback(async () => {
    if (!selected) return;
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
      const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
      setPreviewUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return url;
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The preview could not be built.");
    } finally {
      setBusy(null);
    }
  }, [body, selected]);

  const download = useCallback(async () => {
    if (!selected) return;
    setBusy("download");
    setError(null);
    try {
      const response = await fetch("/api/milestones/card", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, format: "pdf" }),
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
      link.download = match?.[1] ?? "milestone-card.pdf";
      link.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The card could not be produced.");
    } finally {
      setBusy(null);
    }
  }, [body, selected]);

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
              className="mt-1 block w-full rounded-none border border-slate-300 px-3 py-2 text-[13px] text-slate-900"
              onChange={(event) => setFrom(event.target.value)}
              type="date"
              value={from}
            />
          </label>
          <label className="block text-[12px] font-semibold text-slate-600">
            To
            <input
              className="mt-1 block w-full rounded-none border border-slate-300 px-3 py-2 text-[13px] text-slate-900"
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
            {/* Desktop: a fixed table. Mobile: cards. */}
            <table className="hidden w-full table-fixed border-collapse sm:table">
              <colgroup>
                <col style={{ width: "40%" }} />
                <col style={{ width: "20%" }} />
                <col style={{ width: "22%" }} />
                <col style={{ width: "18%" }} />
              </colgroup>
              <thead>
                <tr className="border-b border-slate-200 text-left text-[11px] font-bold uppercase tracking-wider text-slate-500">
                  <th className="py-2 pr-3">Name</th>
                  <th className="py-2 pr-3">Milestone</th>
                  <th className="py-2 pr-3">Date</th>
                  <th className="py-2">When</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr
                    className={`cursor-pointer border-b border-slate-100 align-top text-[13px] ${
                      selected?.hrId === entry.hrId && selected?.spec === entry.spec ? "bg-sky-50" : ""
                    }`}
                    key={`${entry.hrId}-${entry.spec}-${entry.on}`}
                    onClick={() => pick(entry)}
                  >
                    <td className="py-2 pr-3">
                      <span className="block break-words font-semibold text-slate-900">{entry.displayName}</span>
                      <span className="block break-words text-[11px] text-slate-500">{entry.roleLine}</span>
                    </td>
                    <td className="py-2 pr-3 break-words text-slate-800">{entry.specLabel}</td>
                    <td className="py-2 pr-3 break-words text-slate-800">{longDate(entry.on)}</td>
                    <td className="py-2 break-words text-slate-600">{whenText(entry.daysAway)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="grid gap-2 sm:hidden">
              {entries.map((entry) => (
                <button
                  className={`rounded-none border p-3 text-left ${
                    selected?.hrId === entry.hrId && selected?.spec === entry.spec
                      ? "border-sky-800 bg-sky-50"
                      : "border-slate-200"
                  }`}
                  key={`${entry.hrId}-${entry.spec}-${entry.on}`}
                  onClick={() => pick(entry)}
                  type="button"
                >
                  <span className="block break-words text-[13px] font-semibold text-slate-900">
                    {entry.displayName}
                  </span>
                  <span className="block break-words text-[11px] text-slate-500">{entry.roleLine}</span>
                  <span className="mt-1 block break-words text-[12px] text-slate-800">
                    {entry.specLabel} · {longDate(entry.on)} · {whenText(entry.daysAway)}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </section>

      {/* ── The card ─────────────────────────────────────────────────────────────────────── */}
      <section className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="rounded-none border border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-[13px] font-bold text-slate-900">The card</h2>
          {selected ? (
            <p className="mb-3 break-words text-[13px] text-slate-700">
              <span className="font-semibold text-slate-900">{selected.displayName}</span>
              <span className="block text-[12px] text-slate-500">
                Joined {longDate(selected.hireDate)}
              </span>
            </p>
          ) : (
            <p className="mb-3 text-[13px] text-slate-600">Pick somebody from the list above.</p>
          )}

          <div className="grid gap-3">
            <label className="block text-[12px] font-semibold text-slate-600">
              Period
              <select
                className="mt-1 block w-full rounded-none border border-slate-300 px-3 py-2 text-[13px] text-slate-900"
                onChange={(event) => setPreset(event.target.value)}
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
                  className="mt-1 block w-full rounded-none border border-slate-300 px-3 py-2 text-[13px] text-slate-900"
                  onChange={(event) => setCustom(event.target.value)}
                  placeholder="18 months, 100 days, 7 years"
                  value={custom}
                />
              </label>
            ) : null}

            <label className="block text-[12px] font-semibold text-slate-600">
              The date on the card
              <input
                className="mt-1 block w-full rounded-none border border-slate-300 px-3 py-2 text-[13px] text-slate-900"
                onChange={(event) => setDateOverride(event.target.value)}
                type="date"
                value={dateOverride}
              />
              <span className="mt-1 block text-[11px] font-normal leading-relaxed text-slate-500">
                Worked out from the hire date. Change it if the day the company is marking is a
                different one.
              </span>
            </label>

            <label className="block text-[12px] font-semibold text-slate-600">
              The name on the card
              <input
                className="mt-1 block w-full rounded-none border border-slate-300 px-3 py-2 text-[13px] text-slate-900"
                onChange={(event) => setNameOverride(event.target.value)}
                placeholder={selected ? selected.displayName : "Leave empty to use the HR record."}
                value={nameOverride}
              />
              <span className="mt-1 block text-[11px] font-normal leading-relaxed text-slate-500">
                Taken from the HR record, which holds a legal name. Change it to whatever the person
                is actually called — the sentence below the name follows it.
              </span>
            </label>

            <label className="block text-[12px] font-semibold text-slate-600">
              The sentence under the name
              <textarea
                className="mt-1 block w-full rounded-none border border-slate-300 px-3 py-2 text-[13px] text-slate-900"
                onChange={(event) => setCitation(event.target.value)}
                placeholder="Leave empty for the standard wording."
                rows={3}
                value={citation}
              />
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

            <div className="flex flex-wrap items-center gap-3">
              <button
                className="rounded-none border border-sky-800 px-5 py-2.5 text-[13px] font-semibold text-sky-800 disabled:opacity-50"
                disabled={!selected || busy !== null}
                onClick={buildPreview}
                type="button"
              >
                {busy === "preview" ? "Building…" : "Preview"}
              </button>
              {canExport ? (
                <button
                  className="rounded-none bg-sky-800 px-5 py-2.5 text-[13px] font-semibold text-white disabled:opacity-50"
                  disabled={!selected || busy !== null}
                  onClick={download}
                  type="button"
                >
                  {busy === "download" ? "Printing…" : "Download the card"}
                </button>
              ) : null}
            </div>
          </div>
        </div>

        <div className="rounded-none border border-slate-200 bg-slate-50 p-4">
          <h2 className="mb-3 text-[13px] font-bold text-slate-900">Preview</h2>
          <div className="w-full" ref={frameBox} style={{ height: previewUrl ? SHEET_H * scale : undefined }}>
            {previewUrl ? (
              <iframe
                className="border border-slate-300 bg-white"
                height={SHEET_H}
                src={previewUrl}
                style={{ transform: `scale(${scale})`, transformOrigin: "top left" }}
                title="Milestone card preview"
                width={SHEET_W}
              />
            ) : (
              <p className="text-[13px] text-slate-600">
                Press Preview to draw the card. The download is the same artwork, printed.
              </p>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
