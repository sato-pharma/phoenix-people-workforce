"use client";

import { Minus, Plus } from "lucide-react";
import { useState } from "react";

import { crmPost, crmUrl, messageOf, useCrmGet } from "@/components/phoenix-crm/api";
import { cairoClock, countText, dayLabelLong, monthLabel, percentText, plural } from "@/components/phoenix-crm/format";
import {
  CrmBlock,
  CrmButton,
  CrmCard,
  CrmCardsOnPhone,
  CrmChoice,
  CrmEmpty,
  CrmFacts,
  CrmField,
  CrmLoadError,
  CrmLoading,
  CrmNote,
  CrmPanel,
  CrmPill,
  CrmSelect,
  CrmStat,
  CrmStatGrid,
  CrmTable,
  crmInputClassName,
  crmTdClassName,
  crmThClassName,
  type CrmChoiceOption,
  type PillTone,
} from "@/components/phoenix-crm/ui";
import { FORECAST_MAX_UNITS, type AccuracyReading } from "@/lib/phoenix-crm/daily-forecast";
import type {
  ForecastAccuracyView,
  ForecastBoardView,
  ForecastFormView,
  ForecastProductLine,
  TerritorySummary,
} from "@/lib/phoenix-crm/view-types";
import { cn } from "@/lib/utils";

/**
 * Phoenix CRM — the CNS daily forecast (owner, 2026-10-01).
 *
 * Two halves, for two readers:
 *   - THE FORM, the territory's own rep's. Every product he has a target for, pre-filled with his daily
 *     share of it; he changes only what he disagrees with and sends. It replaces the seven lines the
 *     CNS reps typed into the line's WhatsApp group each morning.
 *   - THE BOARD, the managers'. Who has sent today and who has not (the not-sent first), and — for a
 *     month whose closing is published — how each territory's delivery compared with its forecast.
 *
 * 🔴 GOLDEN RULE #1: the form shows the rep his own targets and his own last month, and NOTHING that
 * judges his forecasting. The verdict words live in the board alone.
 *
 * 🔴 NO TOTAL OF BOXES. A box of Tebofortine 40 and a box of Dolabactin are different quantities; the
 * form never adds them, and the board compares by value.
 *
 * Square corners, no sideways scroll, no ellipsis: the product rows WRAP on a phone, and the board is a
 * fixed table from `md` and cards below it.
 */

const FORM_PATH = "/api/phoenix-crm/forecast";
const BOARD_PATH = "/api/phoenix-crm/forecast/board";

type BoardAnswer = { kind: "day"; day: ForecastBoardView } | { kind: "month"; accuracy: ForecastAccuracyView };

type BoardView = "day" | "month";

const BOARD_CHOICES: ReadonlyArray<CrmChoiceOption<BoardView>> = [
  { value: "day", label: "Today", note: "Who has sent, and against the day's share" },
  { value: "month", label: "Closed month", note: "Forecast against the published closing" },
];

const READING_TONE: Record<AccuracyReading, PillTone> = {
  "on the mark": "good",
  "over-promised": "bad",
  "under-promised": "info",
};

/** "65%" from a ratio, or the dash for no figure — never a made-up 0%. */
function ratioText(ratio: number | null | undefined): string {
  return typeof ratio === "number" && Number.isFinite(ratio) ? percentText(Math.round(ratio * 100)) : "—";
}

function egpText(value: number): string {
  return `${countText(Math.round(value))} EGP`;
}

// ── The rep's form ──────────────────────────────────────────────────────────────────────────────

function startingUnits(line: ForecastProductLine): number {
  return line.sentUnits ?? line.suggestedUnits ?? 0;
}

function clampUnits(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(FORECAST_MAX_UNITS, Math.max(0, Math.round(value)));
}

function ProductRow({
  line,
  onChange,
  units,
  disabled,
}: {
  line: ForecastProductLine;
  onChange: (units: number) => void;
  units: number;
  disabled: boolean;
}) {
  const inputId = `forecast-${line.productCode}`;
  const changed = line.suggestedUnits !== null && units !== line.suggestedUnits;
  return (
    <li className="flex min-w-0 flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
      <div className="min-w-0 flex-1 basis-56">
        <label className="block break-words text-sm font-black text-slate-950" htmlFor={inputId}>
          {line.productName}
        </label>
        <p className="mt-1 break-words text-xs font-semibold leading-5 text-slate-500">
          Your share of target: {countText(line.suggestedUnits)} a day
          {line.monthTargetUnits !== null ? ` · ${countText(line.monthTargetUnits)} this month` : ""}
          {" · "}
          Last month {ratioText(line.lastMonthRatio)}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <CrmButton aria-label={`One box less of ${line.productName}`} disabled={disabled || units <= 0} onClick={() => onChange(units - 1)} size="sm">
          <Minus aria-hidden className="h-4 w-4" />
        </CrmButton>
        <input
          className={cn(crmInputClassName, "w-20 text-center text-base font-black", changed && "border-orange-400 bg-orange-50")}
          disabled={disabled}
          id={inputId}
          inputMode="numeric"
          max={FORECAST_MAX_UNITS}
          min={0}
          onChange={(event) => onChange(clampUnits(Number(event.target.value)))}
          type="number"
          value={units}
        />
        <CrmButton aria-label={`One box more of ${line.productName}`} disabled={disabled || units >= FORECAST_MAX_UNITS} onClick={() => onChange(units + 1)} size="sm">
          <Plus aria-hidden className="h-4 w-4" />
        </CrmButton>
      </div>
    </li>
  );
}

function ForecastForm({ territories, test }: { territories: TerritorySummary[]; test: boolean }) {
  const [seatId, setSeatId] = useState<string>(territories[0]?.seatId ?? "");
  const resource = useCrmGet<ForecastFormView>(seatId ? crmUrl(FORM_PATH, { seatId, test }) : null, "form");
  const form = resource.data;
  // What he typed belongs to ONE form — this territory, this day, this send. A different form (another
  // territory, tomorrow, the answer to his first send) starts again from its own boxes, derived rather
  // than copied in an effect, so no stale figure from the last form can ever be sent.
  const formKey = form ? `${form.seatId}|${form.day}|${form.sentAt ?? ""}` : "";
  const [edits, setEdits] = useState<{ key: string; units: Record<string, number> }>({ key: "", units: {} });
  const unitsOf = (line: ForecastProductLine): number =>
    edits.key === formKey && line.productCode in edits.units ? (edits.units[line.productCode] ?? startingUnits(line)) : startingUnits(line);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentNow, setSentNow] = useState(false);

  async function send() {
    if (!form) return;
    setSending(true);
    setError(null);
    try {
      const saved = await crmPost<ForecastFormView>(
        FORM_PATH,
        {
          lines: form.lines.map((line) => ({ productCode: line.productCode, units: unitsOf(line) })),
          seatId: form.seatId,
          test,
        },
        "form",
      );
      resource.replace(saved);
      setSentNow(true);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setSending(false);
    }
  }

  const picker =
    territories.length > 1 ? (
      <CrmField htmlFor="forecast-territory" label="Territory">
        <CrmSelect
          id="forecast-territory"
          onChange={(event) => {
            setSentNow(false);
            setSeatId(event.target.value);
          }}
          value={seatId}
        >
          {territories.map((territory) => (
            <option key={territory.seatId} value={territory.seatId}>
              {territory.name}
            </option>
          ))}
        </CrmSelect>
      </CrmField>
    ) : null;

  return (
    <CrmPanel
      description="Every product is filled in with your daily share of this month's target. Change only the ones you disagree with, then send."
      eyebrow={test ? "Forecast · test mode" : "Forecast"}
      title={form ? `Today's forecast · ${dayLabelLong(form.day)}` : "Today's forecast"}
    >
      {picker ? <CrmBlock>{picker}</CrmBlock> : null}
      {resource.error && !form ? (
        <CrmBlock>
          <CrmLoadError message={resource.error} onRetry={resource.reload} />
        </CrmBlock>
      ) : !form ? (
        <CrmBlock>
          <CrmLoading label="Loading today's forecast" />
        </CrmBlock>
      ) : form.lines.length === 0 ? (
        <CrmBlock>
          <CrmEmpty
            message={`${monthLabel(form.period)}'s targets are not loaded for this territory yet. The forecast opens once they are.`}
            title="No target to forecast against"
          />
        </CrmBlock>
      ) : (
        <>
          <CrmBlock>
            <div className="grid min-w-0 gap-2">
              {form.sentAt ? (
                <CrmNote tone="good" title={sentNow ? "Sent" : `Sent at ${cairoClock(form.sentAt)}`}>
                  Your forecast for today is in. You can change a figure and send again; it replaces today&apos;s boxes.
                </CrmNote>
              ) : null}
              <p className="break-words text-xs font-semibold leading-5 text-slate-500">
                {monthLabel(form.period)} has {plural(form.workingDays, "working day", "working days")}, Saturday to Wednesday.
                {form.lastMonthPeriod ? ` "Last month" is ${monthLabel(form.lastMonthPeriod)}, the latest published closing.` : " No month has been published yet, so there is no last month to show."}
                {form.holidaysComplete ? "" : " The holiday calendar could not be read, so a national holiday may be counted as a working day."}
              </p>
            </div>
          </CrmBlock>
          <ul className="divide-y divide-slate-100 border-t border-slate-100">
            {form.lines.map((line) => (
              <ProductRow
                disabled={sending}
                key={line.productCode}
                line={line}
                onChange={(next) => {
                  setSentNow(false);
                  setEdits((current) => ({
                    key: formKey,
                    units: { ...(current.key === formKey ? current.units : {}), [line.productCode]: clampUnits(next) },
                  }));
                }}
                units={unitsOf(line)}
              />
            ))}
          </ul>
          <CrmBlock className="border-t border-slate-100">
            <div className="grid min-w-0 gap-2">
              {error ? <CrmNote tone="bad">{error}</CrmNote> : null}
              <CrmButton busy={sending} className="w-full sm:w-auto" onClick={() => void send()} variant="primary">
                {form.sentAt ? "Send again" : "Send forecast"}
              </CrmButton>
            </div>
          </CrmBlock>
        </>
      )}
    </CrmPanel>
  );
}

// ── The managers' board ─────────────────────────────────────────────────────────────────────────

function DayBoard({ view }: { view: ForecastBoardView }) {
  const sent = view.rows.filter((row) => row.sent).length;
  return (
    <>
      <CrmBlock>
        <CrmStatGrid>
          <CrmStat label="Territories" value={countText(view.rows.length)} />
          <CrmStat label="Sent" tone={sent === view.rows.length && sent > 0 ? "good" : "neutral"} value={countText(sent)} />
          <CrmStat label="Not sent" tone={view.rows.length - sent > 0 ? "warn" : "neutral"} value={countText(view.rows.length - sent)} />
          <CrmStat label="Working days" note={monthLabel(view.period)} value={countText(view.workingDays)} />
        </CrmStatGrid>
      </CrmBlock>
      {view.regions.length > 0 ? (
        <CrmBlock title="By region">
          <ul className="grid min-w-0 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {view.regions.map((region) => (
              <li className="min-w-0 border border-slate-200 bg-white px-3 py-2.5" key={region.regionName}>
                <p className="break-words text-sm font-black text-slate-950">{region.regionName}</p>
                <p className="mt-1 break-words text-xs font-semibold leading-5 text-slate-500">
                  {region.sent} of {plural(region.territories, "territory", "territories")} sent · forecast {ratioText(region.shareOfDay)} of the day&apos;s share
                </p>
              </li>
            ))}
          </ul>
        </CrmBlock>
      ) : null}
      {view.rows.length === 0 ? (
        <CrmBlock>
          <CrmEmpty message="No CNS territory sits beneath you." title="Nothing to show" />
        </CrmBlock>
      ) : (
        <>
          <CrmTable columns={["30%", "22%", "18%", "13%", "17%"]}>
            <thead>
              <tr>
                <th className={crmThClassName}>Rep</th>
                <th className={crmThClassName}>Area</th>
                <th className={crmThClassName}>Region</th>
                <th className={crmThClassName}>Sent</th>
                <th className={crmThClassName}>Against the day&apos;s share</th>
              </tr>
            </thead>
            <tbody>
              {view.rows.map((row) => (
                <tr key={row.seatId}>
                  <td className={crmTdClassName}>{row.repName ?? "Vacant"}</td>
                  <td className={crmTdClassName}>{row.areaName ?? row.name}</td>
                  <td className={crmTdClassName}>{row.regionName ?? "—"}</td>
                  <td className={crmTdClassName}>
                    {row.sent ? cairoClock(row.sentAt) : <CrmPill tone="warn">Not sent</CrmPill>}
                  </td>
                  <td className={crmTdClassName}>{ratioText(row.shareOfDay)}</td>
                </tr>
              ))}
            </tbody>
          </CrmTable>
          <CrmCardsOnPhone>
            {view.rows.map((row) => (
              <CrmCard
                accent={row.sent ? "border-l-emerald-500" : "border-l-amber-500"}
                key={row.seatId}
                meta={`${row.areaName ?? row.name} · ${row.regionName ?? "—"}`}
                status={row.sent ? <CrmPill tone="good">Sent {cairoClock(row.sentAt)}</CrmPill> : <CrmPill tone="warn">Not sent</CrmPill>}
                title={row.repName ?? "Vacant"}
              >
                {row.sent ? <CrmFacts facts={[{ label: "Against the day's share", value: ratioText(row.shareOfDay) }]} /> : null}
              </CrmCard>
            ))}
          </CrmCardsOnPhone>
        </>
      )}
    </>
  );
}

function MonthBoard({ view, onPeriod }: { view: ForecastAccuracyView; onPeriod: (period: string) => void }) {
  return (
    <>
      <CrmBlock>
        <div className="grid min-w-0 gap-2">
          {view.publishedPeriods.length > 0 ? (
            <CrmField htmlFor="forecast-month" label="Month">
              <CrmSelect id="forecast-month" onChange={(event) => onPeriod(event.target.value)} value={view.period}>
                {view.publishedPeriods.map((period) => (
                  <option key={period} value={period}>
                    {monthLabel(period)}
                  </option>
                ))}
              </CrmSelect>
            </CrmField>
          ) : null}
          <p className="break-words text-xs font-semibold leading-5 text-slate-500">
            A territory&apos;s forecast is its average day carried across the month&apos;s working days, valued product by product, and set
            against what the published closing credits it with on the same products. Within 15% either way is on the mark.
          </p>
        </div>
      </CrmBlock>
      {!view.published ? (
        <CrmBlock>
          <CrmEmpty
            message="A month is scored once its CNS closing is published, so the figures behind it are final."
            title={`${monthLabel(view.period)} is not published yet`}
          />
        </CrmBlock>
      ) : view.rows.length === 0 ? (
        <CrmBlock>
          <CrmEmpty message="No CNS territory sits beneath you." title="Nothing to show" />
        </CrmBlock>
      ) : (
        <>
          <CrmTable columns={["24%", "18%", "10%", "15%", "15%", "18%"]}>
            <thead>
              <tr>
                <th className={crmThClassName}>Rep</th>
                <th className={crmThClassName}>Area</th>
                <th className={crmThClassName}>Days sent</th>
                <th className={crmThClassName}>Forecast</th>
                <th className={crmThClassName}>Closing</th>
                <th className={crmThClassName}>Delivered</th>
              </tr>
            </thead>
            <tbody>
              {view.rows.map((row) => (
                <tr key={row.seatId}>
                  <td className={crmTdClassName}>{row.repName ?? "Vacant"}</td>
                  <td className={crmTdClassName}>{row.areaName ?? row.name}</td>
                  <td className={crmTdClassName}>
                    {row.daysSent} of {view.workingDays}
                  </td>
                  <td className={crmTdClassName}>{row.daysSent > 0 ? egpText(row.projectedValue) : "—"}</td>
                  <td className={crmTdClassName}>{row.daysSent > 0 ? egpText(row.actualValue) : "—"}</td>
                  <td className={crmTdClassName}>
                    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                      {ratioText(row.delivered)}
                      {row.reading ? <CrmPill tone={READING_TONE[row.reading]}>{row.reading}</CrmPill> : null}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </CrmTable>
          <CrmCardsOnPhone>
            {view.rows.map((row) => (
              <CrmCard
                key={row.seatId}
                meta={`${row.areaName ?? row.name} · ${row.daysSent} of ${view.workingDays} days sent`}
                status={row.reading ? <CrmPill tone={READING_TONE[row.reading]}>{row.reading}</CrmPill> : null}
                title={row.repName ?? "Vacant"}
              >
                {row.daysSent > 0 ? (
                  <CrmFacts
                    facts={[
                      { label: "Forecast", value: egpText(row.projectedValue) },
                      { label: "Closing", value: egpText(row.actualValue) },
                      { label: "Delivered", value: ratioText(row.delivered) },
                    ]}
                  />
                ) : null}
              </CrmCard>
            ))}
          </CrmCardsOnPhone>
        </>
      )}
    </>
  );
}

function ForecastBoard({ test }: { test: boolean }) {
  const [view, setView] = useState<BoardView>("day");
  const [period, setPeriod] = useState<string | null>(null);
  const url = view === "day" ? crmUrl(BOARD_PATH, { test, view: "day" }) : crmUrl(BOARD_PATH, { period, test, view: "month" });
  const resource = useCrmGet<BoardAnswer>(url, "board");
  const answer = resource.data;

  return (
    <CrmPanel
      description="The CNS territories beneath you. The ones that have not sent today come first."
      eyebrow={test ? "Forecast board · test mode" : "Forecast board"}
      title="Your team's forecasts"
    >
      <CrmBlock>
        <CrmChoice columns={2} label="What to show" onChange={setView} options={BOARD_CHOICES} value={view} />
      </CrmBlock>
      {resource.error && !answer ? (
        <CrmBlock>
          <CrmLoadError message={resource.error} onRetry={resource.reload} />
        </CrmBlock>
      ) : !answer ? (
        <CrmBlock>
          <CrmLoading label="Loading the board" />
        </CrmBlock>
      ) : answer.kind === "day" ? (
        <DayBoard view={answer.day} />
      ) : (
        <MonthBoard onPeriod={setPeriod} view={answer.accuracy} />
      )}
    </CrmPanel>
  );
}

// ── The tab ─────────────────────────────────────────────────────────────────────────────────────

export function ForecastTab({
  formTerritories,
  showBoard,
  test,
}: {
  /** The CNS territories whose form this viewer fills: his own, or any in the Super Admin's test mode. */
  formTerritories: TerritorySummary[];
  /** Whether this viewer reads the managers' board — the same readers the Team tab has. */
  showBoard: boolean;
  test: boolean;
}) {
  if (formTerritories.length === 0 && !showBoard) {
    return (
      <CrmPanel eyebrow="Forecast" title="Forecast">
        <CrmEmpty message="The daily forecast is for the CNS line: a CNS territory's rep fills it, and its managers read it." title="Nothing to forecast here" />
      </CrmPanel>
    );
  }
  return (
    <div className="grid min-w-0 gap-3">
      {formTerritories.length > 0 ? <ForecastForm territories={formTerritories} test={test} /> : null}
      {showBoard ? <ForecastBoard test={test} /> : null}
    </div>
  );
}
