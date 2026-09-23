"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  cardFirstName,
  formatPlainDateIso,
  milestoneCitation,
  milestoneDate,
  parseMilestoneSpec,
  parsePlainDate,
  type MilestoneSpec,
} from "@/lib/milestones/periods";
import type { MilestoneCandidate, MilestoneDueEntry } from "@/lib/milestones/service";

/**
 * Milestones — the workspace.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * TWO HALVES, IN THE ORDER THE WORK HAPPENS. Who is coming up, then the card for the one you
 * picked. The list is the reason to open the page at all: a first month is easy to miss, and by
 * the time somebody mentions it the day has gone.
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
  candidates: MilestoneCandidate[];
  initialEntries: MilestoneDueEntry[];
  initialFrom: string;
  initialTo: string;
  canExport: boolean;
};

export function MilestonesWorkspace({
  candidates,
  initialEntries,
  initialFrom,
  initialTo,
  canExport,
}: Props) {
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [entries, setEntries] = useState(initialEntries);
  const [loadingList, setLoadingList] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedHrId, setSelectedHrId] = useState(initialEntries[0]?.hrId ?? "");
  const [preset, setPreset] = useState(initialEntries[0]?.spec ?? "1m");
  const [custom, setCustom] = useState("");
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

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<"preview" | "download" | "picture" | null>(null);

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

  // Everything the card needs is in hand. A hire date is not optional: the service dates the
  // milestone from it and refuses without one, so the buttons say so by being unavailable rather
  // than by returning an error after the click.
  const ready = Boolean(selected && hireDate && spec);

  // ── The date and the name arrive worked out ───────────────────────────────────────────────
  // Derived during the render that needs them, never written into state. `?? ` is the whole of
  // "his edit wins": an untouched field shows the arithmetic, a touched one shows what he typed.
  const dateValue = dateEdit ?? (hireDate && spec ? formatPlainDateIso(milestoneDate(hireDate, spec)) : "");
  const nameValue = nameEdit ?? selected?.displayName ?? "";

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
    }),
    [selectedHrId, period, dateValue, nameValue, citationValue, withoutPhoto, variant],
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
    clearPreview();
  }, [clearPreview]);

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
                      selectedHrId === entry.hrId && period === entry.spec ? "bg-sky-50" : ""
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
                    selectedHrId === entry.hrId && period === entry.spec
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

          <div className="grid gap-3">
            <label className="block text-[12px] font-semibold text-slate-600" htmlFor="milestone-person">
              Who it is for
              <SearchableSelect
                className="mt-1 h-auto rounded-none border-slate-300 py-2 text-[13px] text-slate-900"
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

            <label className="block text-[12px] font-semibold text-slate-600">
              Period
              <select
                className="mt-1 block w-full rounded-none border border-slate-300 px-3 py-2 text-[13px] text-slate-900"
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
                  className="mt-1 block w-full rounded-none border border-slate-300 px-3 py-2 text-[13px] text-slate-900"
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
                className="mt-1 block w-full rounded-none border border-slate-300 px-3 py-2 text-[13px] text-slate-900"
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
                className="mt-1 block w-full rounded-none border border-slate-300 px-3 py-2 text-[13px] text-slate-900"
                onChange={(event) => setNameEdit(event.target.value)}
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
                className="mt-1 block w-full rounded-none border border-slate-300 px-3 py-2 text-[13px] text-slate-900"
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
