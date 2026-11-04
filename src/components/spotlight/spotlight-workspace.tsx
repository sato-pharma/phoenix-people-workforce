"use client";

import { useCallback, useMemo, useState } from "react";

import { windowKeyInForce, windowsForLines, type SpotlightWindows } from "@/lib/spotlight/line-windows";
import { blockedReason } from "@/lib/spotlight/period";
import type { SpotlightFacets } from "@/lib/spotlight/org";
import type {
  SpotlightLayout,
  SpotlightRankBy,
  SpotlightRankDirection,
  SpotlightResult,
  SpotlightSubjectKind,
  SpotlightWindow,
  SpotlightWindowKind,
} from "@/lib/spotlight/types";
import { phxSelectClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";

/**
 * Spotlight — the picker.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE FILTERS ARE AN INTERSECTION, not a hierarchy, and the layout says so: lines, districts,
 * territories and people sit side by side as independent narrowings. That is what makes the owner's
 * own comparison case — "the Giza district managers for the three lines" — a normal use of the
 * screen rather than a special mode: pick the subject District Manager, tick Giza, leave all three
 * lines on.
 *
 * 🔒 NO HORIZONTAL SCROLL, desktop and mobile. Every grid below collapses to one column at small
 * widths, the preview is a table on desktop and stacked cards on a phone, and the results table is
 * `table-fixed` over a `<colgroup>` so a long Egyptian full name WRAPS rather than pushing the row
 * sideways. Square corners throughout.
 */

const SUBJECTS: { value: SpotlightSubjectKind; label: string }[] = [
  { value: "rep", label: "Medical Representatives" },
  { value: "dm", label: "District Managers" },
  { value: "rsm", label: "Regional Managers" },
  { value: "nsm", label: "National Sales Managers" },
  { value: "area", label: "Territories" },
  { value: "region", label: "Districts" },
  { value: "line", label: "Lines" },
];

const WINDOW_KINDS: { value: SpotlightWindowKind; label: string }[] = [
  { value: "month", label: "Month" },
  { value: "quarter", label: "Quarter" },
  { value: "semester", label: "Half year" },
  { value: "year", label: "Year" },
];

const LAYOUTS: { value: SpotlightLayout; label: string; hint: string }[] = [
  { value: "both", label: "Leaderboard + a page each", hint: "The default. A ranked page, then one sheet per person." },
  { value: "leaderboard", label: "Leaderboard only", hint: "One page, however many you pick." },
  { value: "heroes", label: "A page each only", hint: "One full sheet per person, no summary page." },
];

function windowText(window: SpotlightWindow): string {
  if (window.kind === "year") return window.key;
  if (window.kind === "quarter") return `${window.key.slice(5)} ${window.key.slice(0, 4)}`;
  // Kept in step with windowLabel in src/lib/spotlight/period.ts — "Semester 2 2026", never "H2"
  // (owner, 2026-09-23).
  if (window.kind === "semester") return `Semester ${window.key.slice(6)} ${window.key.slice(0, 4)}`;
  const [year, month] = window.key.split("-");
  return new Date(Date.UTC(Number(year), Number(month) - 1, 1))
    .toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
}

const money = (value: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(value));

type Props = {
  canExport: boolean;
  facets: SpotlightFacets;
  /** The windows on offer for each set of lines, keyed by `lineSetKey`. A month is offered once the ticked lines have published it. */
  windowsByLines: Record<string, SpotlightWindows>;
};

const FIELD = cn(phxSelectClassName, "w-full px-3 py-2 text-[13px]");
const LABEL = "block text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500";
const CARD = "rounded-none border border-slate-200 bg-white p-4";

export function SpotlightWorkspace({ canExport, facets, windowsByLines }: Props) {
  const [windowKind, setWindowKind] = useState<SpotlightWindowKind>("month");
  const [pickedKey, setPickedKey] = useState<string>("");
  const [subject, setSubject] = useState<SpotlightSubjectKind>("rep");
  const [lines, setLines] = useState<string[]>([]);
  const [regions, setRegions] = useState<string[]>([]);
  const [areas, setAreas] = useState<string[]>([]);
  const [hrIds, setHrIds] = useState<string[]>([]);
  // Ticked by default: a sheet with somebody's name on it is the common case, and the first
  // top-ten ever exported put a vacant territory in 8th place with nobody to congratulate.
  const [excludeVacant, setExcludeVacant] = useState(true);
  const [peopleQuery, setPeopleQuery] = useState("");
  const [rankByPicked, setRankBy] = useState<SpotlightRankBy>("achievement");
  // Ticked by default. Unticked prints no EGP figure anywhere on the sheet and ranks by achievement,
  // because a sales figure beside a target gives the percentage away and the other way round.
  const [showValue, setShowValue] = useState(true);
  const rankBy: SpotlightRankBy = showValue ? rankByPicked : "achievement";
  const [direction, setDirection] = useState<SpotlightRankDirection>("top");
  const [limitText, setLimitText] = useState("10");
  const [layout, setLayout] = useState<SpotlightLayout>("both");
  const [headline, setHeadline] = useState("");
  const [subheadline, setSubheadline] = useState("");

  const [result, setResult] = useState<SpotlightResult | null>(null);
  const [busy, setBusy] = useState<"preview" | "export" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // What is on offer follows the lines ticked: each line publishes on its own day, so ticking only
  // the line that has published October offers October. Ticking another line can take it away again,
  // so the period actually in force is the one picked while it is still offered, else the newest.
  const availableWindows = useMemo(
    () => windowsForLines(windowsByLines, lines)[windowKind] ?? [],
    [windowsByLines, lines, windowKind],
  );
  const windowKey = useMemo(() => windowKeyInForce(availableWindows, pickedKey), [availableWindows, pickedKey]);
  // The SAME value disables the buttons and prints the reason, so the two can never disagree —
  // which is the whole defect this replaces: disabled with nothing said.
  const blocked = blockedReason(windowKind, Boolean(windowKey), lines.length > 0);
  // The preview follows the sheet that was BUILT, not the box as it is ticked now.
  const previewShowsValue = result?.selection.showValue !== false;

  const selection = useMemo(() => ({
    window: { kind: windowKind, key: windowKey },
    subject,
    filters: { lines, regions, areas, hrIds, excludeVacant },
    rankBy,
    ...(showValue ? {} : { showValue: false }),
    direction,
    limit: limitText.trim() === "" ? null : Number(limitText),
    layout,
    headline: headline.trim() || null,
    subheadline: subheadline.trim() || null,
  }), [windowKind, windowKey, subject, lines, regions, areas, hrIds, excludeVacant, rankBy, showValue, direction, limitText, layout, headline, subheadline]);

  const toggle = (list: string[], set: (next: string[]) => void, value: string) => {
    set(list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value]);
  };

  const preview = useCallback(async () => {
    setBusy("preview");
    setError(null);
    try {
      const response = await fetch("/api/spotlight/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(selection),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error ?? "Spotlight failed to load.");
      setResult(payload.result as SpotlightResult);
    } catch (caught) {
      setResult(null);
      setError(caught instanceof Error ? caught.message : "Spotlight failed to load.");
    } finally {
      setBusy(null);
    }
  }, [selection]);

  const exportPdf = useCallback(async () => {
    setBusy("export");
    setError(null);
    try {
      const response = await fetch("/api/spotlight/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(selection),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error ?? "Spotlight export failed.");
      }
      // The filename the server chose travels in Content-Disposition; falling back to a fixed name
      // is better than inventing one that disagrees with the sheet's own headline.
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const named = /filename="([^"]+)"/.exec(disposition)?.[1];
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = named ?? "sato-spotlight.pdf";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Spotlight export failed.");
    } finally {
      setBusy(null);
    }
  }, [selection]);

  const visiblePeople = useMemo(() => {
    const query = peopleQuery.trim().toLowerCase();
    const pool = query
      ? facets.people.filter((person) =>
        person.name.toLowerCase().includes(query)
        || person.fullName.toLowerCase().includes(query)
        || person.territory.toLowerCase().includes(query)
        || person.roleLabel.toLowerCase().includes(query))
      : facets.people;
    return pool.slice(0, 60);
  }, [facets.people, peopleQuery]);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6">
      <header className="mb-6">
        <h1 className="text-[22px] font-bold tracking-tight text-slate-900">Spotlight</h1>
        <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-slate-600">
          Choose a window, choose who it is about, and export a sheet. Only finished months, quarters
          and halves can be spotlighted, because a spotlight is a published number.
        </p>
      </header>

      {error ? (
        <p className="mb-4 rounded-none border border-red-300 bg-red-50 px-4 py-3 text-[13px] text-red-800">
          {error}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        {/* ── Window and subject ─────────────────────────────────────────── */}
        <section className={CARD}>
          <h2 className="mb-3 text-[13px] font-bold text-slate-900">Window</h2>
          <div className="grid gap-3">
            <div>
              <label className={LABEL} htmlFor="sl-kind">Period type</label>
              <select
                className={FIELD}
                id="sl-kind"
                onChange={(event) => {
                  const next = event.target.value as SpotlightWindowKind;
                  setWindowKind(next);
                  setPickedKey("");
                }}
                value={windowKind}
              >
                {WINDOW_KINDS.map((entry) => (
                  <option key={entry.value} value={entry.value}>{entry.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={LABEL} htmlFor="sl-window">Period</label>
              <select className={FIELD} id="sl-window" onChange={(event) => setPickedKey(event.target.value)} value={windowKey}>
                {availableWindows.map((window) => (
                  <option key={window.key} value={window.key}>{windowText(window)}</option>
                ))}
              </select>
              {blocked ? (
                <p className="mt-2 text-[12px] leading-relaxed text-slate-500">{blocked}</p>
              ) : null}
            </div>
            <div>
              <label className={LABEL} htmlFor="sl-subject">Spotlight</label>
              <select className={FIELD} id="sl-subject" onChange={(event) => setSubject(event.target.value as SpotlightSubjectKind)} value={subject}>
                {SUBJECTS.map((entry) => (
                  <option key={entry.value} value={entry.value}>{entry.label}</option>
                ))}
              </select>
            </div>
          </div>
        </section>

        {/* ── Ranking ────────────────────────────────────────────────────── */}
        <section className={CARD}>
          <h2 className="mb-3 text-[13px] font-bold text-slate-900">Ranking</h2>
          <div className="grid gap-3">
            <div>
              <label className="flex items-start gap-2 text-[13px] text-slate-800">
                <input
                  checked={showValue}
                  className="mt-1"
                  onChange={(event) => setShowValue(event.target.checked)}
                  type="checkbox"
                />
                <span>
                  <span className="font-semibold">Show the sales value</span>
                  <span className="block text-[12px] text-slate-500">
                    Untick to rank by achievement and print no EGP figure, sales or target, on the sheet.
                  </span>
                </span>
              </label>
            </div>
            <div>
              <label className={LABEL} htmlFor="sl-rank">Rank by</label>
              <select className={FIELD} id="sl-rank" onChange={(event) => setRankBy(event.target.value as SpotlightRankBy)} value={rankBy}>
                <option value="achievement">Achievement against target</option>
                <option disabled={!showValue} value="value">Sales value</option>
              </select>
            </div>
            <div>
              <label className={LABEL} htmlFor="sl-dir">Which end</label>
              <select className={FIELD} id="sl-dir" onChange={(event) => setDirection(event.target.value as SpotlightRankDirection)} value={direction}>
                <option value="top">Top — the best</option>
                <option value="bottom">Bottom — those behind</option>
              </select>
            </div>
            <div>
              <label className="flex items-start gap-2 text-[13px] text-slate-800">
                <input
                  checked={excludeVacant}
                  className="mt-1"
                  onChange={(event) => setExcludeVacant(event.target.checked)}
                  type="checkbox"
                />
                <span className="min-w-0">
                  Only people
                  <span className="block text-[11px] leading-relaxed text-slate-500">
                    Leaves out territories with no one in the seat. Their sales are real, so untick
                    this to see them.
                  </span>
                </span>
              </label>
            </div>
            <div>
              <label className={LABEL} htmlFor="sl-limit">How many (blank for everyone)</label>
              <input
                className={FIELD}
                id="sl-limit"
                inputMode="numeric"
                onChange={(event) => setLimitText(event.target.value.replace(/[^\d]/g, ""))}
                placeholder="10"
                value={limitText}
              />
            </div>
          </div>
        </section>

        {/* ── Export shape ───────────────────────────────────────────────── */}
        <section className={CARD}>
          <h2 className="mb-3 text-[13px] font-bold text-slate-900">The sheet</h2>
          <div className="grid gap-3">
            <div>
              <label className={LABEL} htmlFor="sl-layout">Pages</label>
              <select className={FIELD} id="sl-layout" onChange={(event) => setLayout(event.target.value as SpotlightLayout)} value={layout}>
                {LAYOUTS.map((entry) => (
                  <option key={entry.value} value={entry.value}>{entry.label}</option>
                ))}
              </select>
              <p className="mt-2 text-[12px] leading-relaxed text-slate-500">
                {LAYOUTS.find((entry) => entry.value === layout)?.hint}
              </p>
            </div>
            <div>
              <label className={LABEL} htmlFor="sl-headline">Headline (blank for automatic)</label>
              <input className={FIELD} id="sl-headline" onChange={(event) => setHeadline(event.target.value)} placeholder={result?.headline ?? "Generated from your selection"} value={headline} />
            </div>
            <div>
              <label className={LABEL} htmlFor="sl-sub">Sub-line (blank for automatic)</label>
              <input className={FIELD} id="sl-sub" onChange={(event) => setSubheadline(event.target.value)} placeholder={result?.subheadline ?? "Generated from your selection"} value={subheadline} />
            </div>
          </div>
        </section>
      </div>

      {/* ── Filters ──────────────────────────────────────────────────────── */}
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <section className={CARD}>
          <h2 className="mb-3 text-[13px] font-bold text-slate-900">Lines</h2>
          <p className="mb-2 text-[12px] text-slate-500">
            Leave all unticked for the three tracked lines. A month is offered once every ticked line has published it.
          </p>
          <div className="grid gap-2">
            {facets.lines.map((line) => (
              <label className="flex items-center gap-2 text-[13px] text-slate-800" key={line.code}>
                <input checked={lines.includes(line.code)} onChange={() => toggle(lines, setLines, line.code)} type="checkbox" />
                <span>{line.name}</span>
              </label>
            ))}
          </div>
        </section>

        <section className={CARD}>
          <h2 className="mb-3 text-[13px] font-bold text-slate-900">Districts</h2>
          <p className="mb-2 text-[12px] text-slate-500">Tick one to compare it across lines.</p>
          <div className="grid max-h-56 gap-2 overflow-y-auto">
            {facets.regions.map((region) => (
              <label className="flex items-center gap-2 text-[13px] text-slate-800" key={region.code}>
                <input checked={regions.includes(region.code)} onChange={() => toggle(regions, setRegions, region.code)} type="checkbox" />
                <span className="min-w-0 break-words">{region.name}</span>
              </label>
            ))}
          </div>
        </section>

        <section className={CARD}>
          <h2 className="mb-3 text-[13px] font-bold text-slate-900">Territories</h2>
          <div className="grid max-h-56 gap-2 overflow-y-auto">
            {facets.areas.map((area) => (
              <label className="flex items-center gap-2 text-[13px] text-slate-800" key={area.code}>
                <input checked={areas.includes(area.code)} onChange={() => toggle(areas, setAreas, area.code)} type="checkbox" />
                <span className="min-w-0 break-words">{area.name}</span>
              </label>
            ))}
          </div>
        </section>
      </div>

      <section className={`${CARD} mt-4`}>
        <h2 className="mb-3 text-[13px] font-bold text-slate-900">Specific people</h2>
        <input className={`${FIELD} mb-3`} onChange={(event) => setPeopleQuery(event.target.value)} placeholder="Search a name, a role or a territory" value={peopleQuery} />
        <div className="grid max-h-64 gap-2 overflow-y-auto sm:grid-cols-2">
          {visiblePeople.map((person) => (
            <label className="flex items-start gap-2 text-[13px] text-slate-800" key={person.hrId}>
              <input checked={hrIds.includes(person.hrId)} className="mt-1" onChange={() => toggle(hrIds, setHrIds, person.hrId)} type="checkbox" />
              <span className="min-w-0 break-words">
                {person.name}
                <span className="block text-[11px] text-slate-500">
                  {person.roleLabel}{person.lineName ? ` · ${person.lineName}` : ""} · {person.territory}
                </span>
              </span>
            </label>
          ))}
          {visiblePeople.length === 0 ? <p className="text-[12px] text-slate-500">Nobody matches that search.</p> : null}
        </div>
      </section>

      <div className="mt-5">
        <div className="flex flex-wrap items-center gap-3">
          <button
            className="rounded-none bg-sky-800 px-5 py-2.5 text-[13px] font-semibold text-white disabled:opacity-50"
            disabled={busy !== null || blocked !== null}
            onClick={preview}
            type="button"
          >
            {busy === "preview" ? "Loading…" : "Show me"}
          </button>
          {canExport ? (
            <button
              className="rounded-none border border-sky-800 px-5 py-2.5 text-[13px] font-semibold text-sky-800 disabled:opacity-50"
              disabled={busy !== null || blocked !== null}
              onClick={exportPdf}
              type="button"
            >
              {busy === "export" ? "Building the PDF…" : "Export PDF"}
            </button>
          ) : null}
        </div>
        {/* Beside the button, not only up in the picker — a greyed control with its explanation
            three sections away is indistinguishable from a broken one. */}
        {blocked ? (
          <p className="mt-3 max-w-2xl text-[12px] leading-relaxed text-slate-600">{blocked}</p>
        ) : null}
      </div>

      {/* ── Preview ──────────────────────────────────────────────────────── */}
      {result ? (
        <section className="mt-6">
          <h2 className="text-[18px] font-bold text-slate-900">{result.headline}</h2>
          <p className="mt-1 text-[12px] uppercase tracking-[0.12em] text-slate-500">{result.subheadline}</p>
          <p className="mt-2 text-[13px] text-slate-600">
            {previewShowsValue ? `${money(result.shortlistActualValue)} EGP across ` : "Showing "}{result.rows.length} of {result.totalSubjects}.
            {result.untargetedSubjects > 0
              ? ` ${result.untargetedSubjects} carried no target in this window and cannot be ranked by achievement.`
              : ""}
          </p>

          {/* Desktop: a fixed table. Mobile: the same rows as stacked cards. */}
          <div className="mt-4 hidden md:block">
            <table className="w-full table-fixed border-collapse">
              <colgroup>
                <col style={{ width: "3rem" }} /><col /><col style={{ width: "12rem" }} />
                {previewShowsValue ? <col style={{ width: "8rem" }} /> : null}<col style={{ width: "8rem" }} />
              </colgroup>
              <thead>
                <tr className="border-b border-slate-300 text-left text-[11px] uppercase tracking-[0.14em] text-slate-500">
                  <th className="py-2"></th><th className="py-2">Name</th><th className="py-2">Territory</th>
                  {previewShowsValue ? <th className="py-2 text-right">Sales</th> : null}<th className="py-2 text-right">Achievement</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row, index) => {
                  const beat = row.achievement !== null && row.achievement >= 100;
                  return (
                    <tr className="border-b border-slate-200 align-baseline" key={row.key}>
                      <td className="py-2 text-[12px] font-bold text-sky-700">{String(index + 1).padStart(2, "0")}</td>
                      <td className="py-2 text-[13px] font-semibold text-slate-900">
                        <span className="break-words">{row.title}</span>
                        {row.isVacant ? <span className="ml-2 text-[11px] uppercase text-slate-500">vacant seat</span> : null}
                      </td>
                      <td className="py-2 text-[12px] text-slate-600">
                        <span className="break-words">{row.territory}</span>
                        {row.lineName ? <span className="block text-[11px] uppercase text-sky-700">{row.lineName}</span> : null}
                      </td>
                      {previewShowsValue ? (
                        <td className="py-2 text-right text-[13px] font-semibold text-slate-900">{(row.actualValue / 1_000_000).toFixed(2)}M</td>
                      ) : null}
                      <td className={`py-2 text-right text-[13px] font-bold ${row.achievement === null ? "text-slate-400" : beat ? "text-emerald-700" : "text-red-700"}`}>
                        {row.achievement === null ? "—" : `${beat ? "▲" : "▼"} ${row.achievement.toFixed(1)}%`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-4 grid gap-3 md:hidden">
            {result.rows.map((row, index) => {
              const beat = row.achievement !== null && row.achievement >= 100;
              return (
                <div className="rounded-none border border-slate-200 bg-white p-3" key={row.key}>
                  <p className="text-[13px] font-semibold text-slate-900">
                    <span className="mr-2 text-sky-700">{String(index + 1).padStart(2, "0")}</span>
                    <span className="break-words">{row.title}</span>
                  </p>
                  <p className="mt-1 text-[12px] text-slate-600">
                    {row.territory}{row.lineName ? ` · ${row.lineName}` : ""}
                  </p>
                  <p className="mt-2 flex flex-wrap items-baseline gap-x-4 text-[13px]">
                    {previewShowsValue ? (
                      <span className="font-semibold text-slate-900">{(row.actualValue / 1_000_000).toFixed(2)}M EGP</span>
                    ) : null}
                    <span className={`font-bold ${row.achievement === null ? "text-slate-400" : beat ? "text-emerald-700" : "text-red-700"}`}>
                      {row.achievement === null ? "no target" : `${beat ? "▲" : "▼"} ${row.achievement.toFixed(1)}%`}
                    </span>
                  </p>
                </div>
              );
            })}
          </div>

          {result.rows.length === 0 ? (
            <p className="mt-4 text-[13px] text-slate-600">Nobody matched this selection.</p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
