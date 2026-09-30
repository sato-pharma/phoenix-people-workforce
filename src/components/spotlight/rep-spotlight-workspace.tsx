"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronLeft, Download, FileText, ShieldCheck } from "lucide-react";

import { ShareCardBar } from "@/components/employee-portal/share-card";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { spotlightShareCaption } from "@/lib/share/social-share";

/**
 * Spotlight — one person's own sheet.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * 🔒 THIS PAGE WEARS REPORT IT'S DESIGN, DELIBERATELY. Owner, 2026-09-30: "mimic the style of the
 * report it tab … the same /employee-portals/report-it as design." Every device here is lifted from
 * `src/components/report-it/report-it-form.tsx` and must stay in step with it: the step progress
 * strip, the 244px vertical stepper rail on desktop with its ShieldCheck footnote, the compact
 * mobile stepper, the step heading with its ghost numeral, and the field / label / button primitives
 * below. The ENTRIES are ours — a period and a sheet, not a patient and a medicine — but nothing
 * about the LOOK is invented here.
 *
 * If Report It's look changes, this changes with it rather than drifting into a second house style.
 *
 * 🔴 WITH ONE DEPARTURE, AND IT IS THE POINT: REPORT IT'S DARK SLATE HERO IS NOT COPIED HERE.
 * Owner, 2026-09-30, looking at the live page: "the header is duplicated." Report It draws that hero
 * because it stands on its own; this page lives inside `EmployeePortalPageShell`, which already
 * paints the navy command header with the badge, the title and the description — so a hero here
 * repeated all three and shipped two stacked dark blocks. What replaced it carries only what the
 * shell does NOT say: which step you are on, and that the figures are published. Pinned by
 * `tests/spotlight-portal-look.test.ts`, which bans the dark background tokens outright.
 *
 * 🔒 Square corners throughout, no horizontal scroll at any width, and no truncation — the owner's
 * standing UI rules. The sheet image scales with `w-full` so an A4 portrait fits a phone.
 */

// ─── Primitives, copied from the Report It form so the two cannot drift ───────────────────────────

const fieldClass =
  "h-10 w-full rounded border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-900 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition placeholder:text-slate-400 focus:border-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-500/15 disabled:cursor-not-allowed disabled:opacity-50";
const selectClass = `${fieldClass} cursor-pointer`;

// Orange is the portal's single accent, and its controls lift on hover exactly as
// `EmployeePortalActionLink` does. The dark slate primary this page used to carry was the last
// remnant of the admin form it was copied from — on a portal page it read as a third dark block.
const btnGhost =
  "inline-flex items-center gap-1.5 rounded border border-slate-200/80 bg-white px-4 py-2 text-sm font-bold text-slate-600 shadow-[0_4px_12px_rgba(15,23,42,0.06)] transition duration-200 hover:-translate-y-px hover:border-orange-300/80 hover:text-orange-700 hover:shadow-[0_8px_20px_rgba(249,115,22,0.12)] disabled:pointer-events-none disabled:opacity-40";
const btnOrange =
  "inline-flex items-center gap-1.5 rounded bg-orange-600 px-5 py-2 text-sm font-bold text-white shadow-[0_8px_20px_rgba(249,115,22,0.18)] transition duration-200 hover:-translate-y-px hover:bg-orange-700 hover:shadow-[0_12px_26px_rgba(249,115,22,0.24)] disabled:pointer-events-none disabled:opacity-50";

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="mb-1.5 block text-phx-xs font-black uppercase tracking-wide text-slate-500">
      {children}
    </label>
  );
}

// ─── The two steps ────────────────────────────────────────────────────────────────────────────────

const STEPS = ["Period", "Your sheet"];
const STEP_TITLES = ["Choose your period", "Your spotlight"];
const STEP_DESCRIPTIONS = ["The months to measure", "Picture and PDF"];

function VerticalStepper({ step, onJump }: { step: number; onJump: (n: number) => void }) {
  return (
    <ol className="relative">
      {STEPS.map((label, i) => {
        const num = i + 1;
        const active = num === step;
        const done = num < step;
        const clickable = num < step;
        const last = i === STEPS.length - 1;
        return (
          <li className="relative" key={label}>
            {!last && (
              <span
                aria-hidden
                className={["absolute left-[15px] top-8 h-[calc(100%-1rem)] w-px", done ? "bg-orange-400" : "bg-slate-200"].join(" ")}
              />
            )}
            <button
              className={[
                "group relative flex w-full items-start gap-3 px-3 py-3 text-left transition",
                active ? "bg-orange-50" : "bg-transparent",
                clickable ? "cursor-pointer hover:bg-slate-50" : "cursor-default",
              ].join(" ")}
              disabled={!clickable}
              onClick={() => clickable && onJump(num)}
              type="button"
            >
              {active && <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-orange-500" />}
              <span
                className={[
                  "z-10 flex h-8 w-8 shrink-0 items-center justify-center text-xs font-black",
                  active
                    ? "bg-orange-600 text-white"
                    : done
                      ? "bg-orange-100 text-orange-700"
                      : "border border-slate-300 bg-white text-slate-400",
                ].join(" ")}
              >
                {done ? <Check className="h-4 w-4" /> : num}
              </span>
              <span className="min-w-0">
                <span
                  className={[
                    "block text-phx-xs font-black uppercase tracking-wide",
                    active ? "text-slate-900" : done ? "text-slate-700" : "text-slate-400",
                  ].join(" ")}
                >
                  {label}
                </span>
                <span className="mt-0.5 block text-xs text-slate-400">{STEP_DESCRIPTIONS[i]}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function MobileStepper({ step }: { step: number }) {
  return (
    <div className="flex items-center lg:hidden">
      {STEPS.map((label, i) => {
        const num = i + 1;
        const active = num === step;
        const done = num < step;
        return (
          <div className={["flex items-center", i < STEPS.length - 1 ? "flex-1" : ""].join(" ")} key={label}>
            <span
              className={[
                "flex h-7 w-7 shrink-0 items-center justify-center text-phx-xs font-black",
                active ? "bg-orange-600 text-white" : done ? "bg-orange-100 text-orange-700" : "border border-slate-300 bg-white text-slate-400",
              ].join(" ")}
            >
              {done ? <Check className="h-3.5 w-3.5" /> : num}
            </span>
            {i < STEPS.length - 1 && (
              <span className={["mx-1.5 h-px flex-1", done ? "bg-orange-400" : "bg-slate-200"].join(" ")} />
            )}
          </div>
        );
      })}
    </div>
  );
}

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

export function RepSpotlightWorkspace({ months, defaultFrom, defaultTo, threshold }: Props) {
  const [step, setStep] = useState(1);
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
  const pct = Math.round((step / STEPS.length) * 100);

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
      setStep(2);
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

  const beat = preview !== null && preview.achievement !== null && preview.achievement >= 100;

  return (
    <div className="rounded border border-slate-200 bg-white shadow-[0_18px_46px_rgba(15,23,42,0.07)]">
      {/* ── Progress strip ───────────────────────────────────────────────────────────────────────
          🔴 THIS IS WHERE A SECOND DARK HERO USED TO BE, AND IT MUST NOT COME BACK.
          `EmployeePortalPageShell` already paints the navy command header — the badge, the title and
          the description — so a banner here repeated all three and the page shipped with TWO stacked
          dark blocks (owner, 2026-09-30: "the header is duplicated"). Only the parts the shell does
          NOT provide survive: which step you are on, and that the figures are published ones. Light,
          so it reads as the top edge of this card rather than as a header of its own. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-slate-100 px-5 py-3.5">
        <div className="flex items-center gap-2 text-phx-2xs font-black uppercase tracking-[0.18em] text-slate-500">
          <span>Step {step} of {STEPS.length}</span>
          <span className="text-orange-600">{pct}%</span>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded border border-slate-200 bg-slate-50 px-2.5 py-1 text-phx-2xs font-black uppercase tracking-[0.18em] text-slate-500">
          <ShieldCheck className="h-3.5 w-3.5 text-orange-500" />
          Published figures
        </span>
        <div className="h-1.5 w-full rounded bg-slate-100">
          <div
            className="h-1.5 rounded bg-orange-500 transition-all duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[244px_minmax(0,1fr)]">
        {/* ── Left rail ──────────────────────────────────────────────────────── */}
        <aside className="hidden border-r border-slate-200 bg-slate-50/60 lg:flex lg:flex-col">
          <nav className="p-3">
            <VerticalStepper onJump={(n) => { setError(null); setStep(n); }} step={step} />
          </nav>
          <div className="mt-auto border-t border-slate-200 p-4">
            <div className="flex items-start gap-2.5">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-orange-500" />
              <p className="text-xs leading-relaxed text-slate-500">
                Measured against your published monthly closing — only months that are closed and
                published are counted.
              </p>
            </div>
          </div>
        </aside>

        {/* ── Step content ───────────────────────────────────────────────────── */}
        <div className="p-4 sm:p-6">
          <div className="mb-5 lg:hidden">
            <MobileStepper step={step} />
          </div>

          <div className="mb-5 flex items-center justify-between border-b border-slate-200 pb-4">
            <div>
              <p className="text-phx-2xs font-black uppercase tracking-[0.18em] text-orange-600">
                Step {step} of {STEPS.length}
              </p>
              <h2 className="mt-0.5 text-lg font-black text-slate-900">{STEP_TITLES[step - 1]}</h2>
            </div>
            <span aria-hidden className="select-none text-4xl font-black tabular-nums text-slate-200">
              {String(step).padStart(2, "0")}
            </span>
          </div>

          {step === 1 && (
            <div className="space-y-5">
              {presets.length > 0 && (
                <div>
                  <FieldLabel>Quick pick</FieldLabel>
                  <div className="flex flex-wrap gap-2">
                    {presets.map((preset) => {
                      const active = from === preset.range[0] && to === preset.range[1];
                      return (
                        <button
                          className={[
                            "border px-3 py-2 text-sm font-semibold transition",
                            active
                              ? "border-orange-500 bg-orange-50 text-slate-900"
                              : "border-slate-200 bg-white text-slate-600 hover:border-slate-400",
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
                  <FieldLabel>From</FieldLabel>
                  <SearchableSelect className={selectClass} onChange={(e) => setFrom(e.target.value)} value={from}>
                    {months.map((period) => (
                      <option key={period} value={period}>{monthLabel(period)}</option>
                    ))}
                  </SearchableSelect>
                </div>
                <div>
                  <FieldLabel>To</FieldLabel>
                  <SearchableSelect className={selectClass} onChange={(e) => setTo(e.target.value)} value={to}>
                    {months.map((period) => (
                      <option key={period} value={period}>{monthLabel(period)}</option>
                    ))}
                  </SearchableSelect>
                </div>
              </div>

              {!rangeValid && (
                <p className="border border-rose-300 bg-rose-50 px-3 py-2 text-sm font-bold text-rose-800">
                  The first month cannot come after the last.
                </p>
              )}
            </div>
          )}

          {step === 2 && preview && (
            <div className="space-y-5">
              <div className="border border-slate-200">
                <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-2.5">
                  <span className="flex items-center gap-2 text-phx-xs font-black uppercase tracking-wide text-slate-700">
                    <span aria-hidden className="h-3.5 w-1 bg-orange-500" />
                    {preview.rangeLabel}
                  </span>
                </div>
                <div className="p-4">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span
                      className={[
                        "text-5xl font-black tabular-nums leading-none",
                        preview.achievement === null ? "text-slate-300" : beat ? "text-emerald-600" : "text-slate-900",
                      ].join(" ")}
                    >
                      {preview.achievement === null ? "—" : `${preview.achievement.toFixed(1)}%`}
                    </span>
                    <span className="text-phx-xs font-black uppercase tracking-wide text-slate-500">
                      of your published target
                    </span>
                  </div>
                  {/* A meter to the 100% mark — the same figure, read at a glance. Filled orange until
                      the mark, emerald once it is beaten; the tick marks 100%. */}
                  {preview.achievement !== null && (
                    <div className="mt-3">
                      <div className="relative h-2 w-full bg-slate-100">
                        <div
                          className={["h-2 transition-all duration-500", beat ? "bg-emerald-500" : "bg-orange-500"].join(" ")}
                          style={{ width: `${Math.max(0, Math.min(100, preview.achievement))}%` }}
                        />
                        <span aria-hidden className="absolute inset-y-0 right-0 w-px bg-slate-400" />
                      </div>
                      <p className="mt-1 text-right text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-400">
                        100% target
                      </p>
                    </div>
                  )}
                </div>
              </div>

              {preview.pendingPeriods.length > 0 && (
                <p className="border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800">
                  {preview.pendingPeriods.map(monthLabel).join(", ")}
                  {preview.pendingPeriods.length === 1
                    ? " is not published yet and was left out."
                    : " are not published yet and were left out."}
                </p>
              )}

              {preview.eligible ? (
                <>
                  {sheet && (
                    <figure className="border border-slate-200 bg-slate-50 p-3">
                      <img
                        alt={`Your spotlight for ${preview.rangeLabel}`}
                        className="block w-full border border-slate-200 bg-white"
                        src={sheet.url}
                      />
                    </figure>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <button className={btnOrange} disabled={busy !== null} onClick={() => download("png")} type="button">
                      <Download className="h-4 w-4" />
                      {busy === "png" ? "Saving…" : "Download picture"}
                    </button>
                    <button className={btnGhost} disabled={busy !== null} onClick={() => download("pdf")} type="button">
                      <FileText className="h-4 w-4" />
                      {busy === "pdf" ? "Building the PDF…" : "Download PDF"}
                    </button>
                  </div>

                  {/* Share the spotlight straight to WhatsApp, his Status, LinkedIn or Facebook. The
                      picture on screen is the one shared — no second render. */}
                  {sheet && (
                    <div className="border-t border-slate-100 pt-4">
                      <ShareCardBar
                        getFile={async () => ({
                          blob: sheet.blob,
                          filename: `sato-spotlight-${from}${to === from ? "" : `_${to}`}.png`,
                        })}
                        getPageUrl={async () => {
                          // A GET: minting the link is a read, so a test account previewing the rep
                          // may run it where the POST render is refused as a write.
                          try {
                            const qs = new URLSearchParams({ from, to }).toString();
                            const response = await fetch(`/api/spotlight/me/sheet?${qs}`, { method: "GET" });
                            if (!response.ok) return null;
                            const data = (await response.json().catch(() => null)) as { shareUrl?: unknown } | null;
                            return typeof data?.shareUrl === "string" ? data.shareUrl : null;
                          } catch {
                            return null;
                          }
                        }}
                        caption={spotlightShareCaption(preview.rangeLabel)}
                        disabled={busy !== null}
                        heading="Share your spotlight"
                      />
                    </div>
                  )}
                </>
              ) : (
                <p className="border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-relaxed text-slate-600">
                  {preview.reason}
                </p>
              )}
            </div>
          )}

          {error && (
            <p className="mt-5 border border-rose-300 bg-rose-50 px-3 py-2 text-sm font-bold text-rose-800">
              {error}
            </p>
          )}

          <div className="mt-6 flex items-center justify-between border-t border-slate-200 pt-5">
            <button
              className={btnGhost}
              disabled={step === 1 || busy !== null}
              onClick={() => { setError(null); setStep(1); }}
              type="button"
            >
              <ChevronLeft className="h-4 w-4" />
              Back
            </button>
            {step === 1 && (
              <button className={btnOrange} disabled={busy !== null || !rangeValid} onClick={show} type="button">
                {busy === "preview" ? "Drawing your spotlight…" : "Show my spotlight"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
