"use client";

/**
 * Phoenix CRM — four of the five reports the owner picked on 2026-10-02, drawn as sections of the
 * Reports tab with the tab's own pieces (report-list.tsx), so they look and behave exactly like the
 * sections beside them:
 *
 *   - Grade against capacity: what each territory's list asks of a month, against what it can hold;
 *   - What the field heard: the products discussed and the objections customers raised;
 *   - Missing stock: which pharmacies last said they do not have which product;
 *   - Samples by month: what was handed over, by product and territory.
 *
 * Every rule lives in `src/lib/phoenix-crm/` and every gate on the server; these only draw what they
 * are given. AM and PM are two figures everywhere and never one. A pharmacy is counted as a pharmacy.
 * There is no rate of objections, no "no objection" figure, no stock balance, no sales number and no
 * sum of units across different products on any of them.
 *
 * A territory's row names its rep, as every manager board does. On grade against capacity the red and
 * amber pills beside that name judge the LIST — its size against the month's field days — and never the
 * rep: he does not choose who is on his list, and its size is the district manager's and SFE's
 * question. All four boards are manager-only (the server refuses each one to a medical rep), and none
 * of them judges how a rep worked or how honest he is.
 *
 * Objections by doctor (owner, 2026-11-03) is drawn here too: it names the rep to say whose doctors they
 * are, by name and never by a count, and carries no percentage, no rank, no score and no total per rep.
 */

import { useState } from "react";

import type { CrmResource } from "@/components/phoenix-crm/api";
import { cairoStamp, countText, dayLabel, monthLabel, percentText, plural } from "@/components/phoenix-crm/format";
import { listText } from "@/components/phoenix-crm/labels";
import { DayList, DaysToggle, LIST_WORDS, RefreshFailed, ReportList, SectionWaiting, type DayLine } from "@/components/phoenix-crm/report-list";
import {
  CrmBlock,
  CrmButton,
  CrmCard,
  CrmChoice,
  CrmEmpty,
  CrmFacts,
  CrmNote,
  CrmPill,
  CrmStat,
  CrmStatGrid,
  crmTdClassName,
  type CrmChoiceOption,
  type PillTone,
} from "@/components/phoenix-crm/ui";
import { capacityVerdictText, gradeTargetsText, type CapacityRow, type CapacityVerdict, type ListCapacity } from "@/lib/phoenix-crm/capacity-board";
import { HEARD_BASIS_TEXT, heardTallyText, type HeardGrain, type HeardNote, type HeardRow } from "@/lib/phoenix-crm/field-heard";
import type { MissingStockPharmacy, MissingStockProduct, StockChase } from "@/lib/phoenix-crm/missing-stock";
import { objectionDoctorRows, type DoctorObjection, type ObjectionDoctorRow } from "@/lib/phoenix-crm/objections-by-doctor";
import type { SampleItemTotal, SamplesTerritoryRow } from "@/lib/phoenix-crm/samples-report";
import type { CapacityBoardView, FieldHeardView, MissingStockView, ObjectionsByDoctorView, SamplesReportView } from "@/lib/phoenix-crm/view-types";

// ── Words ───────────────────────────────────────────────────────────────────────────────────────

/** "3 AM · 41 PM" — AM and PM side by side, never added together. */
function amPmText(am: number, pm: number): string {
  return `${countText(am)} AM · ${countText(pm)} PM`;
}

/** "13.1", or "13" when it is whole. */
function decimalText(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return Number.isInteger(value) ? countText(value) : value.toFixed(1);
}

function repText(repName: string | null): string {
  return repName ?? "No rep in this territory";
}

function TestNote({ includeTest }: { includeTest: boolean }) {
  if (!includeTest) return null;
  return (
    <div className="px-4 pt-4 sm:px-5">
      <CrmNote title="Your test entries are counted" tone="info">
        Test entries are read beside the real ones on this report.
      </CrmNote>
    </div>
  );
}

// ── Grade against capacity ──────────────────────────────────────────────────────────────────────

const VERDICT_TONE: Record<CapacityVerdict, { tone: PillTone; accent: string }> = {
  over_cap: { tone: "bad", accent: "border-l-rose-500" },
  over_target: { tone: "warn", accent: "border-l-amber-500" },
  fits: { tone: "good", accent: "border-l-emerald-500" },
  no_days: { tone: "neutral", accent: "border-l-slate-300" },
  no_list: { tone: "neutral", accent: "border-l-slate-300" },
};

/** "264 visits a month" and the sentence beside it. */
function capacityText(capacity: ListCapacity, listType: "AM" | "PM"): { main: string; detail: string } {
  if (capacity.verdict === "no_list") return { main: `No ${listType} list`, detail: "Nobody on it yet" };
  const main = `${plural(capacity.required, "visit", "visits")} a month`;
  if (capacity.verdict === "no_days") return { main, detail: `The month holds no ${listType} day` };
  const perDay = `${decimalText(capacity.perDayNeeded)} a day over ${plural(capacity.days, "day", "days")}`;
  if (capacity.verdict === "over_cap") {
    return { main, detail: `${perDay} · even ${countText(capacity.perDayCap)} a day (${countText(capacity.atCap)}) falls ${countText(capacity.beyondCap)} short` };
  }
  if (capacity.verdict === "over_target") {
    return {
      main,
      detail: `${perDay} · ${countText(capacity.beyondTarget)} more than ${countText(capacity.perDayTarget)} a day holds (${countText(capacity.atTarget)}) · within ${countText(capacity.perDayCap)} a day`,
    };
  }
  return { main, detail: `${perDay} · fits ${countText(capacity.perDayTarget)} a day (${countText(capacity.atTarget)})` };
}

/** "A 40 · B 30 · C 2 · 1 with no grade" — the list as its grades stand. */
function gradesText(capacity: ListCapacity): string {
  if (capacity.customers === 0) return "Nobody on the list";
  const parts = [
    `A ${countText(capacity.grades.A)}`,
    `B ${countText(capacity.grades.B)}`,
    `C ${countText(capacity.grades.C)}`,
    capacity.noGrade > 0 ? `${countText(capacity.noGrade)} with no grade` : null,
  ].filter((part): part is string => part !== null);
  return parts.join(" · ");
}

/** "55% grade A · 70 not validated yet" — the list's shape, and how much of it is carried over. */
function listShapeText(capacity: ListCapacity): string | null {
  if (capacity.customers === 0) return null;
  const parts = [
    capacity.gradeAShare === null ? null : `${percentText(capacity.gradeAShare)} grade A`,
    capacity.notValidated > 0 ? `${countText(capacity.notValidated)} not validated yet` : null,
    capacity.noNumber > 0 ? `${countText(capacity.noNumber)} on a grade with no monthly number` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function capacityCell(capacity: ListCapacity, listType: "AM" | "PM") {
  const text = capacityText(capacity, listType);
  return (
    <td className={crmTdClassName}>
      <p className={capacity.customers > 0 ? "font-black text-slate-950" : "text-slate-400"}>{text.main}</p>
      <p className="mt-0.5 text-xs text-slate-500">{text.detail}</p>
    </td>
  );
}

function isOverCapacity(row: CapacityRow): boolean {
  return [row.pm.verdict, row.am.verdict].some((verdict) => verdict === "over_target" || verdict === "over_cap");
}

/**
 * Grade against capacity. LIST SIZE AGAINST THE MONTH — never coverage, and the screen says so above
 * the figures: a customer not validated yet counts with the grade iReports360 carried over, where the
 * plan review's coverage counts validated customers only. The board only shows; a grade changes on the
 * List, by the district manager.
 */
export function CapacitySection({ idPrefix, resource }: { idPrefix: string; resource: CrmResource<CapacityBoardView> }) {
  const report = resource.data;
  if (!report) return <SectionWaiting error={resource.error} label="Weighing the lists against the month" onRetry={resource.reload} />;
  const { fieldDays, perDay, summary } = report;
  const pmLists = report.rows.filter((row) => row.pm.customers > 0).length;
  const amLists = report.rows.filter((row) => row.am.customers > 0).length;

  return (
    <>
      <RefreshFailed error={resource.error} onRetry={resource.reload} />
      <TestNote includeTest={report.includeTest} />
      <CrmBlock>
        <CrmStatGrid>
          <CrmStat
            label="PM over the day's target"
            note={`More than ${countText(perDay.PM.target)} a day over ${plural(fieldDays.PM, "PM day", "PM days")}`}
            tone={summary.pmOverTarget > 0 ? "warn" : "neutral"}
            value={`${countText(summary.pmOverTarget)} of ${countText(pmLists)}`}
          />
          <CrmStat
            label="PM over the cap"
            note={`More than even ${countText(perDay.PM.cap)} a day`}
            tone={summary.pmOverCap > 0 ? "bad" : "neutral"}
            value={`${countText(summary.pmOverCap)} of ${countText(pmLists)}`}
          />
          <CrmStat label="Middle PM need" note="PM visits a month, the middle territory" value={decimalText(summary.pmMedianRequired)} />
          <CrmStat
            label="AM over the day's target"
            note={`More than ${countText(perDay.AM.target)} a day over ${plural(fieldDays.AM, "AM day", "AM days")}`}
            tone={summary.amOverTarget > 0 ? "warn" : "neutral"}
            value={`${countText(summary.amOverTarget)} of ${countText(amLists)}`}
          />
        </CrmStatGrid>
        <div className="mt-3 grid min-w-0 gap-1 text-xs font-semibold leading-5 text-slate-500">
          <p className="break-words">
            {`${monthLabel(report.month.month)} holds ${plural(fieldDays.PM, "PM day", "PM days")} and ${plural(fieldDays.AM, "AM day", "AM days")}: Saturday to Wednesday hold both, Thursday holds AM only, Friday holds nothing.`}
          </p>
          <p className="break-words">
            {fieldDays.holidays.length > 0
              ? `Public holidays taken out: ${fieldDays.holidays.map((holiday) => `${dayLabel(holiday.day)} (${holiday.name})`).join(", ")}.`
              : "No public holiday falls on a field day this month."}
          </p>
          <p className="break-words">
            {`Each grade's visits a month, from Settings: ${gradeTargetsText(report.gradeTargets, "PM")}; ${gradeTargetsText(report.gradeTargets, "AM")}. A day holds ${countText(perDay.PM.target)} PM at the call rate and ${countText(perDay.PM.cap)} at most; ${countText(perDay.AM.target)} AM at the call rate and ${countText(perDay.AM.cap)} at most.`}
          </p>
          {summary.pmGradeAShare ? (
            <p className="break-words">{`Grade A is ${percentText(summary.pmGradeAShare.min)} to ${percentText(summary.pmGradeAShare.max)} of a territory's PM list.`}</p>
          ) : null}
        </div>
        <CrmNote className="mt-3" title="The size of each list, not its coverage" tone="info">
          {`A customer not validated yet is counted here with the grade iReports360 carried over — ${amPmText(summary.notValidated.AM, summary.notValidated.PM)} of them on these lists. Coverage on the plan review counts validated customers only, so the two are different questions. A grade changes only on the List, by the district manager.`}
        </CrmNote>
      </CrmBlock>
      {report.rows.length === 0 ? (
        <div className="border-t border-slate-100">
          <CrmEmpty message="A territory shows here once it is in your scope." title="No territories to weigh" />
        </div>
      ) : (
        <ReportList
          columns={["24%", "25%", "25%", "26%"]}
          explain="The tightest first. A list's monthly need is each customer's grade number added up, against the month's field days at the call rate and at the plan's own cap — AM and PM apart."
          hasData={isOverCapacity}
          headers={["Territory and rep", "PM", "AM", "The list by grade"]}
          idPrefix={`${idPrefix}-capacity`}
          items={report.rows}
          keyOf={(row) => row.seatId}
          renderCard={(row) => (
            <CrmCard
              accent={VERDICT_TONE[row.pm.verdict].accent}
              meta={repText(row.repName)}
              status={
                <>
                  <CrmPill tone={VERDICT_TONE[row.pm.verdict].tone}>{capacityVerdictText(row.pm, "PM")}</CrmPill>
                  <CrmPill tone={VERDICT_TONE[row.am.verdict].tone}>{capacityVerdictText(row.am, "AM")}</CrmPill>
                </>
              }
              title={row.territoryName}
            >
              <CrmFacts
                facts={[
                  { label: "PM", value: `${capacityText(row.pm, "PM").main} · ${capacityText(row.pm, "PM").detail}` },
                  { label: "AM", value: `${capacityText(row.am, "AM").main} · ${capacityText(row.am, "AM").detail}` },
                  { label: "PM by grade", value: [gradesText(row.pm), listShapeText(row.pm)].filter(Boolean).join(" · ") },
                  { label: "AM by grade", value: [gradesText(row.am), listShapeText(row.am)].filter(Boolean).join(" · ") },
                ]}
              />
              {row.listSource === "reference" ? (
                <p className="mt-2 break-words text-xs font-semibold text-slate-500">Read from iReports360: this list has not been opened in Phoenix yet.</p>
              ) : null}
            </CrmCard>
          )}
          renderCells={(row) => (
            <>
              <td className={crmTdClassName}>
                <p className="font-black text-slate-950">{row.territoryName}</p>
                <p className="mt-0.5 text-xs text-slate-500">{repText(row.repName)}</p>
                {row.listSource === "reference" ? (
                  <p className="mt-0.5 text-xs text-slate-500">Read from iReports360: the list is not opened in Phoenix yet</p>
                ) : null}
              </td>
              {capacityCell(row.pm, "PM")}
              {capacityCell(row.am, "AM")}
              <td className={crmTdClassName}>
                <p>{`PM: ${gradesText(row.pm)}`}</p>
                {listShapeText(row.pm) ? <p className="mt-0.5 text-xs text-slate-500">{listShapeText(row.pm)}</p> : null}
                <p className="mt-1">{`AM: ${gradesText(row.am)}`}</p>
                {listShapeText(row.am) ? <p className="mt-0.5 text-xs text-slate-500">{listShapeText(row.am)}</p> : null}
              </td>
            </>
          )}
          searchWords={(row) => [row.territoryName, row.repName, row.lineName]}
          words={{ ...LIST_WORDS, title: "Tightest first", with: "Over the day's target", without: "Within it" }}
        />
      )}
    </>
  );
}

// ── What the field heard ────────────────────────────────────────────────────────────────────────

const GRAIN_OPTIONS: ReadonlyArray<CrmChoiceOption<HeardGrain>> = [
  { value: "product", label: "By product", note: "And what was said" },
  { value: "speciality", label: "By speciality", note: "And what was discussed" },
  { value: "area", label: "By area", note: "A place, never a rep" },
];

function objectionLines(row: HeardRow): string[] {
  return row.byObjection.map((entry) => `${entry.label} — ${heardTallyText(entry)}`);
}

/** The notes as days: each day, then what was said on it — the objection, where, and the words. */
function noteDays(notes: ReadonlyArray<HeardNote>): DayLine[] {
  const byDay = new Map<string, string[]>();
  for (const note of notes) {
    const where = [listText(note.listType), note.speciality, note.area].filter(Boolean).join(" · ");
    const lines = byDay.get(note.visitDate) ?? [];
    lines.push(`${note.objectionLabel} (${where}): “${note.note}”`);
    byDay.set(note.visitDate, lines);
  }
  return [...byDay].map(([date, lines]) => ({ date, lines }));
}

function NotesToggle({ onToggle, open }: { onToggle: () => void; open: boolean }) {
  return (
    <CrmButton aria-expanded={open} onClick={onToggle} size="sm" variant="ghost">
      {open ? "Hide what was said" : "What was said"}
    </CrmButton>
  );
}

function objectionsCell(row: HeardRow) {
  const lines = objectionLines(row);
  return (
    <td className={crmTdClassName}>
      <p className={row.objections.am > 0 || row.objections.pm > 0 ? "font-black text-slate-950" : "text-slate-400"}>{amPmText(row.objections.am, row.objections.pm)}</p>
      {lines.map((line) => (
        <p className="mt-0.5 break-words text-xs text-slate-500" key={line}>
          {line}
        </p>
      ))}
    </td>
  );
}

/**
 * What the field heard. COUNTS ONLY: there is no rate on this screen, no "no objection" figure, and no
 * row for a rep or a territory — the grains are a product, a speciality and an area. The product and
 * marketing managers read their own products, company-wide, and are never offered the area.
 */
export function HeardSection({ idPrefix, resource, today }: { idPrefix: string; resource: CrmResource<FieldHeardView>; today: string }) {
  const [grain, setGrain] = useState<HeardGrain>("product");
  const report = resource.data;
  if (!report) return <SectionWaiting error={resource.error} label="Gathering what the field heard" onRetry={resource.reload} />;

  const grains = report.byArea === null ? GRAIN_OPTIONS.filter((option) => option.value !== "area") : GRAIN_OPTIONS;
  const current: HeardGrain = report.byArea === null && grain === "area" ? "product" : grain;
  const top = report.totals.byObjection[0] ?? null;
  const ownProducts = report.products;

  if (ownProducts && ownProducts.basis === "none") {
    return (
      <>
        <RefreshFailed error={resource.error} onRetry={resource.reload} />
        <div className="border-t border-slate-100">
          <CrmEmpty
            message="This report reads your own products, and none are set for you. Your product list is the one Weekly Sales and Scope & Visibility both keep."
            title="No products to read"
          />
        </div>
      </>
    );
  }

  return (
    <>
      <RefreshFailed error={resource.error} onRetry={resource.reload} />
      <TestNote includeTest={report.includeTest} />
      {ownProducts ? (
        <div className="px-4 pt-4 sm:px-5">
          <CrmNote title="Your products, company-wide" tone="info">
            {ownProducts.basis === "every"
              ? `Every product — your sales scope is the whole company. Never by area and never by rep.`
              : `${ownProducts.names.join(", ")} — ${HEARD_BASIS_TEXT[ownProducts.basis]}. Never by area and never by rep.`}
          </CrmNote>
        </div>
      ) : null}
      <CrmBlock>
        <CrmStatGrid>
          <CrmStat label="Visits" note="Countable visits in these days" value={amPmText(report.totals.visits.am, report.totals.visits.pm)} />
          <CrmStat label="Objections heard" note="Visits where a customer pushed back" value={amPmText(report.totals.objections.am, report.totals.objections.pm)} />
          <CrmStat label="Heard most" note={top ? heardTallyText(top) : "Nothing raised in these days"} value={top ? top.label : "—"} />
          <CrmStat label="Products discussed" note="Each one on its own row below" value={countText(report.byProduct.length)} />
        </CrmStatGrid>
        <p className="mt-3 break-words text-xs font-semibold leading-5 text-slate-500">
          A visit records one objection beside the products discussed on it, so an objection counts against every product discussed on that visit. Counts only — this report holds no rate and nothing per rep.
        </p>
      </CrmBlock>
      <CrmBlock className="border-t border-slate-100" title="Read it">
        <CrmChoice columns={grains.length === 3 ? 3 : 2} label="Read it" onChange={setGrain} options={grains} value={current} />
      </CrmBlock>
      {report.totals.visits.am === 0 && report.totals.visits.pm === 0 ? (
        <div className="border-t border-slate-100">
          <CrmEmpty message="What customers said shows here once visits are saved in these days." title="Nothing heard yet" />
        </div>
      ) : current === "product" ? (
        <ReportList
          columns={["22%", "20%", null, "16%"]}
          explain="Each product, the visits it was discussed on, and what customers objected to on those visits. Open a product for what was said, newest first."
          hasData={(row: HeardRow) => row.objections.am > 0 || row.objections.pm > 0}
          headers={[
            "Product",
            "Discussed",
            "Objections",
            <span className="sr-only" key="said">
              What was said
            </span>,
          ]}
          idPrefix={`${idPrefix}-heard-product`}
          items={report.byProduct}
          key="product"
          keyOf={(row) => row.key}
          renderCard={(row, open, onToggle) => (
            <CrmCard meta={`Discussed on ${amPmText(row.visits.am, row.visits.pm)} visits`} title={row.label}>
              <CrmFacts
                facts={[
                  { label: "Objections", value: amPmText(row.objections.am, row.objections.pm) },
                  { label: "What they objected to", value: objectionLines(row).join(" · ") || "—" },
                ]}
              />
              {row.notes.length > 0 ? (
                <div className="mt-3">
                  <NotesToggle onToggle={onToggle} open={open} />
                </div>
              ) : null}
              {open && row.notes.length > 0 ? (
                <div className="mt-3">
                  <DayList days={noteDays(row.notes)} today={today} />
                </div>
              ) : null}
            </CrmCard>
          )}
          renderCells={(row, open, onToggle) => (
            <>
              <td className={crmTdClassName}>
                <p className="break-words font-black text-slate-950">{row.label}</p>
              </td>
              <td className={crmTdClassName}>{amPmText(row.visits.am, row.visits.pm)}</td>
              {objectionsCell(row)}
              <td className={crmTdClassName}>{row.notes.length > 0 ? <NotesToggle onToggle={onToggle} open={open} /> : null}</td>
            </>
          )}
          renderOpen={(row) => <DayList days={noteDays(row.notes)} today={today} />}
          searchWords={(row) => [row.label]}
          words={{ ...LIST_WORDS, searchLabel: "Find a product", searchPlaceholder: "Product", title: "By product", with: "With objections", without: "None heard" }}
        />
      ) : (
        <ReportList
          columns={["22%", "18%", "30%", null]}
          explain={
            current === "speciality"
              ? "Each speciality: the visits to it, what its customers objected to, and the products discussed."
              : "Each area — a place, never the rep who works it: the visits there, what customers objected to, and the products discussed."
          }
          hasData={(row: HeardRow) => row.objections.am > 0 || row.objections.pm > 0}
          headers={[current === "speciality" ? "Speciality" : "Area", "Visits", "Objections", "Products discussed"]}
          idPrefix={`${idPrefix}-heard-${current}`}
          items={current === "speciality" ? report.bySpeciality : (report.byArea ?? [])}
          key={current}
          keyOf={(row) => row.key}
          renderCard={(row) => (
            <CrmCard meta={`${amPmText(row.visits.am, row.visits.pm)} visits`} title={row.label}>
              <CrmFacts
                facts={[
                  { label: "Objections", value: [amPmText(row.objections.am, row.objections.pm), ...objectionLines(row)].join(" · ") },
                  { label: "Products discussed", value: row.products.map((product) => `${product.name} ${heardTallyText(product)}`).join(" · ") || "—" },
                ]}
              />
            </CrmCard>
          )}
          renderCells={(row) => (
            <>
              <td className={crmTdClassName}>
                <p className="break-words font-black text-slate-950">{row.label}</p>
              </td>
              <td className={crmTdClassName}>{amPmText(row.visits.am, row.visits.pm)}</td>
              {objectionsCell(row)}
              <td className={crmTdClassName}>
                {row.products.map((product) => (
                  <p className="break-words" key={product.name}>
                    {`${product.name} — ${heardTallyText(product)}`}
                  </p>
                ))}
              </td>
            </>
          )}
          searchWords={(row) => [row.label, ...row.products.map((product) => product.name)]}
          words={{
            ...LIST_WORDS,
            searchLabel: current === "speciality" ? "Find a speciality" : "Find an area",
            searchPlaceholder: current === "speciality" ? "Speciality or product" : "Area or product",
            title: current === "speciality" ? "By speciality" : "By area",
            with: "With objections",
            without: "None heard",
          }}
        />
      )}
    </>
  );
}

// ── Missing stock ───────────────────────────────────────────────────────────────────────────────

function pharmacyLine(entry: MissingStockPharmacy): string {
  const said = `last said ${cairoStamp(entry.lastReportedAt)}`;
  const reports = entry.reports > 1 ? ` · ${plural(entry.reports, "visit", "visits")} asked` : "";
  return `${entry.pharmacy} · ${entry.territoryName} · ${said}${reports}${entry.chasePromised ? " · a chase is promised" : ""}`;
}

function PharmacyLines({ entries }: { entries: ReadonlyArray<MissingStockPharmacy> }) {
  return (
    <ul className="divide-y divide-slate-100 border border-slate-200">
      {entries.map((entry) => (
        <li className="break-words px-3 py-2 text-sm font-semibold leading-6 text-slate-700" dir="auto" key={`${entry.seatId}|${entry.pharmacy}`}>
          {pharmacyLine(entry)}
        </li>
      ))}
    </ul>
  );
}

function PharmaciesToggle({ onToggle, open }: { onToggle: () => void; open: boolean }) {
  return (
    <CrmButton aria-expanded={open} onClick={onToggle} size="sm" variant="ghost">
      {open ? "Hide the pharmacies" : "Show the pharmacies"}
    </CrmButton>
  );
}

function chaseWhen(chase: StockChase): string {
  return chase.dueOn ? `By ${dayLabel(chase.dueOn)}` : "No day given";
}

/**
 * Missing stock: which pharmacies last said they do not have which product, from the same grouping the
 * customer's own card reads. A pharmacy is counted as a pharmacy, and no sales figure is read.
 */
export function StockSection({ idPrefix, resource }: { idPrefix: string; resource: CrmResource<MissingStockView> }) {
  const report = resource.data;
  if (!report) return <SectionWaiting error={resource.error} label="Reading the pharmacies' shelves" onRetry={resource.reload} />;
  const { summary } = report;
  const short = report.products.filter((product) => product.missing.length > 0);

  return (
    <>
      <RefreshFailed error={resource.error} onRetry={resource.reload} />
      <TestNote includeTest={report.includeTest} />
      <CrmBlock>
        <CrmStatGrid>
          <CrmStat label="Pharmacies that answered" note="Each one once per territory" value={countText(summary.pharmacies)} />
          <CrmStat label="Products short somewhere" note="At least one pharmacy said no" tone={summary.productsShort > 0 ? "warn" : "neutral"} value={countText(summary.productsShort)} />
          <CrmStat label="Pharmacy and product gaps" note="Each pharmacy's last answer was no" value={countText(summary.gaps)} />
          <CrmStat label="Chase the pharmacy stock" note="Visits that promised to" value={countText(summary.chases)} />
        </CrmStatGrid>
        <p className="mt-3 break-words text-xs font-semibold leading-5 text-slate-500">
          Each pharmacy&apos;s last answer for each product in these days — the same answer the customer&apos;s own card shows. What was on the shelf, never a sales figure.
        </p>
      </CrmBlock>
      {summary.pharmacies === 0 ? (
        <div className="border-t border-slate-100">
          <CrmEmpty message="A pharmacy shows here once a visit records its stock answers in these days." title="No pharmacy answered yet" />
        </div>
      ) : short.length === 0 ? (
        <div className="border-t border-slate-100">
          <CrmEmpty message="Every pharmacy that answered in these days said it had what it was asked about." title="Nothing reported missing" />
        </div>
      ) : (
        <ReportList
          columns={["28%", "20%", null, "16%"]}
          explain="The most pharmacies short first. Open a product for the other pharmacies, the territory, and when each last said so."
          hasData={(product: MissingStockProduct) => product.missing.some((entry) => entry.chasePromised)}
          headers={[
            "Product",
            "Short",
            "Where",
            <span className="sr-only" key="pharmacies">
              Pharmacies
            </span>,
          ]}
          idPrefix={`${idPrefix}-stock`}
          items={short}
          keyOf={(product) => product.product}
          renderCard={(product, open, onToggle) => (
            <CrmCard meta={`${plural(product.inStock, "pharmacy has", "pharmacies have")} it`} title={product.product}>
              <CrmFacts
                facts={[
                  { label: "Short", value: plural(product.missing.length, "pharmacy", "pharmacies") },
                  { label: "Latest", value: product.missing[0] ? pharmacyLine(product.missing[0]) : "—" },
                ]}
              />
              {product.missing.length > 1 ? (
                <div className="mt-3">
                  <PharmaciesToggle onToggle={onToggle} open={open} />
                </div>
              ) : null}
              {open && product.missing.length > 1 ? (
                <div className="mt-3">
                  <PharmacyLines entries={product.missing.slice(1)} />
                </div>
              ) : null}
            </CrmCard>
          )}
          renderCells={(product, open, onToggle) => (
            <>
              <td className={crmTdClassName}>
                <p className="break-words font-black text-slate-950">{product.product}</p>
                <p className="mt-0.5 text-xs text-slate-500">{`${plural(product.inStock, "pharmacy has", "pharmacies have")} it`}</p>
              </td>
              <td className={crmTdClassName}>{plural(product.missing.length, "pharmacy", "pharmacies")}</td>
              <td className={crmTdClassName}>
                <p className="break-words" dir="auto">
                  {product.missing[0] ? pharmacyLine(product.missing[0]) : "—"}
                </p>
                {product.missing.length > 1 ? <p className="mt-0.5 text-xs text-slate-500">{`and ${plural(product.missing.length - 1, "more", "more")}`}</p> : null}
              </td>
              <td className={crmTdClassName}>{product.missing.length > 1 ? <PharmaciesToggle onToggle={onToggle} open={open} /> : null}</td>
            </>
          )}
          // The first pharmacy is already in the row ("Where"); the panel carries the rest.
          renderOpen={(product) => <PharmacyLines entries={product.missing.slice(1)} />}
          searchWords={(product) => [product.product, ...product.missing.flatMap((entry) => [entry.pharmacy, entry.territoryName])]}
          words={{
            ...LIST_WORDS,
            searchLabel: "Find a product or pharmacy",
            searchPlaceholder: "Product, pharmacy or territory",
            title: "Short of a product",
            with: "A chase is promised",
            without: "No chase yet",
          }}
        />
      )}
      {report.chases.length > 0 ? (
        <ReportList
          columns={["20%", "34%", null]}
          explain="Every visit whose next step was to chase the pharmacy stock, the soonest first."
          hasData={(chase) => chase.dueOn !== null}
          headers={["When", "Customer", "Pharmacy"]}
          idPrefix={`${idPrefix}-chases`}
          items={report.chases}
          keyOf={(chase) => chase.visitId}
          renderCard={(chase) => (
            <CrmCard meta={`${listText(chase.listType)} · ${chase.territoryName} · visit on ${dayLabel(chase.visitDate)}`} title={<span dir="auto">{chase.customerName}</span>}>
              <CrmFacts
                facts={[
                  { label: "When", value: chaseWhen(chase) },
                  { label: "Pharmacy", value: chase.pharmacy ?? "Not named on the visit" },
                ]}
              />
            </CrmCard>
          )}
          renderCells={(chase) => (
            <>
              <td className={crmTdClassName}>
                <p className="font-black text-slate-950">{chaseWhen(chase)}</p>
                <p className="mt-0.5 text-xs text-slate-500">{`Visit on ${dayLabel(chase.visitDate)}`}</p>
              </td>
              <td className={crmTdClassName}>
                <p className="break-words" dir="auto">
                  {chase.customerName}
                </p>
                <p className="mt-0.5 text-xs text-slate-500">{`${listText(chase.listType)} · ${chase.territoryName}`}</p>
              </td>
              <td className={crmTdClassName}>
                <p className="break-words" dir="auto">
                  {chase.pharmacy ?? "Not named on the visit"}
                </p>
              </td>
            </>
          )}
          searchWords={(chase) => [chase.customerName, chase.pharmacy, chase.territoryName]}
          words={{
            ...LIST_WORDS,
            searchLabel: "Find a chase",
            searchPlaceholder: "Customer, pharmacy or territory",
            title: "Chase the pharmacy stock",
            with: "With a day",
            without: "No day given",
          }}
        />
      ) : null}
    </>
  );
}

// ── Samples by month ────────────────────────────────────────────────────────────────────────────

function itemLines(items: ReadonlyArray<SampleItemTotal>): string[] {
  return items.map((item) => `${item.label} — ${heardTallyText(item)}`);
}

/**
 * Samples by month. A RECORD of what was handed over: there is no balance on this screen, nothing is
 * subtracted, and nothing a rep was issued is set beside what he recorded (samples.ts).
 */
export function SamplesSection({ idPrefix, resource }: { idPrefix: string; resource: CrmResource<SamplesReportView> }) {
  const report = resource.data;
  if (!report) return <SectionWaiting error={resource.error} label="Adding up what was left" onRetry={resource.reload} />;
  const leftSomething = report.territories.filter((row) => row.items.length > 0).length;

  return (
    <>
      <RefreshFailed error={resource.error} onRetry={resource.reload} />
      <TestNote includeTest={report.includeTest} />
      {report.month.inProgress ? (
        <div className="px-4 pt-4 sm:px-5">
          <CrmNote title={`${monthLabel(report.month.month)} is still running`} tone="info">
            The totals grow as visits are saved.
          </CrmNote>
        </div>
      ) : null}
      <CrmBlock>
        <CrmStatGrid>
          <CrmStat label="Visits that left something" note="Samples or materials" value={amPmText(report.visits.am, report.visits.pm)} />
          {/* VISITS, never units: three packs of one product and two of another are not "five samples". */}
          <CrmStat label="Visits that left samples" note="Free samples of the line's products" value={amPmText(report.visitsWithSamples.am, report.visitsWithSamples.pm)} />
          <CrmStat label="Visits that left materials" note="Pens, block notes and giveaways" value={amPmText(report.visitsWithMaterials.am, report.visitsWithMaterials.pm)} />
          <CrmStat label="Territories" note="That left anything this month" value={`${countText(leftSomething)} of ${countText(report.territories.length)}`} />
        </CrmStatGrid>
        <p className="mt-3 break-words text-xs font-semibold leading-5 text-slate-500">
          A record of what was handed over, as each visit saved it. Quantities are added within one product only — units of different products are never added together. Nothing here is a stock: no balance, nothing subtracted, and nothing set against what was issued.
        </p>
      </CrmBlock>
      {report.items.length === 0 ? (
        <div className="border-t border-slate-100">
          <CrmEmpty message="Samples and materials show here once a visit records them this month." title={`Nothing recorded as left in ${monthLabel(report.month.month)}`} />
        </div>
      ) : (
        <>
          <ReportList
            columns={["40%", null, null]}
            explain="Each product sampled, then the three materials, the quantities left on PM visits and on AM visits."
            hasData={(item: SampleItemTotal) => item.kind === "sample"}
            headers={["Item", "PM", "AM"]}
            idPrefix={`${idPrefix}-samples-items`}
            items={report.items}
            keyOf={(item) => item.key}
            renderCard={(item) => (
              <CrmCard meta={item.kind === "sample" ? "Free sample" : "Material"} title={item.label}>
                <CrmFacts
                  facts={[
                    { label: "PM", value: countText(item.pm) },
                    { label: "AM", value: countText(item.am) },
                  ]}
                />
              </CrmCard>
            )}
            renderCells={(item) => (
              <>
                <td className={crmTdClassName}>
                  <p className="break-words font-black text-slate-950">{item.label}</p>
                  <p className="mt-0.5 text-xs text-slate-500">{item.kind === "sample" ? "Free sample" : "Material"}</p>
                </td>
                <td className={crmTdClassName}>{countText(item.pm)}</td>
                <td className={crmTdClassName}>{countText(item.am)}</td>
              </>
            )}
            searchWords={(item) => [item.label]}
            words={{ ...LIST_WORDS, searchLabel: "Find an item", searchPlaceholder: "Product or material", title: "By item", with: "Samples", without: "Materials" }}
          />
          <ReportList
            columns={["30%", "22%", null]}
            explain="Every territory chosen, including the ones that left nothing this month."
            hasData={(row: SamplesTerritoryRow) => row.items.length > 0}
            headers={["Territory and rep", "Visits that left something", "What was left"]}
            idPrefix={`${idPrefix}-samples-territories`}
            items={report.territories}
            keyOf={(row) => row.seatId}
            renderCard={(row) => (
              <CrmCard meta={repText(row.repName)} title={row.territoryName}>
                <CrmFacts
                  facts={[
                    { label: "Visits", value: amPmText(row.visits.am, row.visits.pm) },
                    { label: "What was left", value: itemLines(row.items).join(" · ") || "Nothing this month" },
                  ]}
                />
              </CrmCard>
            )}
            renderCells={(row) => (
              <>
                <td className={crmTdClassName}>
                  <p className="font-black text-slate-950">{row.territoryName}</p>
                  <p className="mt-0.5 text-xs text-slate-500">{repText(row.repName)}</p>
                </td>
                <td className={crmTdClassName}>{amPmText(row.visits.am, row.visits.pm)}</td>
                <td className={crmTdClassName}>
                  {row.items.length === 0 ? (
                    <span className="text-slate-400">Nothing this month</span>
                  ) : (
                    itemLines(row.items).map((line) => (
                      <p className="break-words" key={line}>
                        {line}
                      </p>
                    ))
                  )}
                </td>
              </>
            )}
            searchWords={(row) => [row.territoryName, row.repName, row.lineName]}
            words={{ ...LIST_WORDS, title: "By territory", with: "Left something", without: "Nothing left" }}
          />
        </>
      )}
    </>
  );
}

// ── Objections by doctor ────────────────────────────────────────────────────────────────────────

/** "Price — 2 PM", one line per objection, in the visit form's own order. */
function doctorObjectionLines(objections: ReadonlyArray<DoctorObjection>): string[] {
  return objections.map((objection) => `${objection.label} — ${heardTallyText(objection)}`);
}

/** The visits behind a doctor's counts, as days: the objection, the list, the products and the rep's note. */
function objectionVisitDays(row: ObjectionDoctorRow): DayLine[] {
  const byDay = new Map<string, string[]>();
  for (const objection of row.objections) {
    for (const visit of objection.visits) {
      const products = visit.products.join(", ") || "No product recorded";
      const lines = byDay.get(visit.visitDate) ?? [];
      lines.push(`${objection.label} (${listText(visit.listType)}): ${products}${visit.note ? ` — “${visit.note}”` : ""}`);
      byDay.set(visit.visitDate, lines);
    }
  }
  return [...byDay].sort(([left], [right]) => right.localeCompare(left)).map(([date, lines]) => ({ date, lines }));
}

/**
 * Objections by doctor. Sorted by the rep's name, then the doctor's, and never by a count; the only
 * figures are how many times each objection was raised, AM and PM apart.
 */
export function ObjectionsByDoctorSection({ idPrefix, resource, today }: { idPrefix: string; resource: CrmResource<ObjectionsByDoctorView>; today: string }) {
  const report = resource.data;
  if (!report) return <SectionWaiting error={resource.error} label="Gathering what the doctors objected to" onRetry={resource.reload} />;
  const rows = objectionDoctorRows(report);

  return (
    <>
      <RefreshFailed error={resource.error} onRetry={resource.reload} />
      <TestNote includeTest={report.includeTest} />
      <CrmBlock>
        <CrmStatGrid>
          <CrmStat label="Objections heard" note="Visits where a doctor pushed back" value={amPmText(report.totals.objections.am, report.totals.objections.pm)} />
          <CrmStat label="Doctors" note="Who raised at least one" value={countText(report.totals.doctors)} />
          <CrmStat label="Reps" note="Whose doctors these are" value={countText(report.totals.reps)} />
        </CrmStatGrid>
        <CrmNote className="mt-3" title="What the doctor said, never a mark against the rep" tone="info">
          Counts only, sorted by name. There is no percentage, no rank and no score here, and a visit where the doctor raised nothing is never listed. A manager&apos;s report: reps never see it.
        </CrmNote>
      </CrmBlock>
      {rows.length === 0 ? (
        <div className="border-t border-slate-100">
          <CrmEmpty message="A doctor's objection shows here once a rep records one on a visit in these days." title="Nothing objected to yet" />
        </div>
      ) : (
        <ReportList
          columns={["24%", "24%", null, "16%"]}
          explain="Each rep by name, then each of the rep's doctors by name, and what the doctor objected to. Open a row for the day, the products and the rep's note."
          hasData={() => true}
          headers={[
            "Rep",
            "Doctor",
            "What they objected to",
            <span className="sr-only" key="visits">
              The visits
            </span>,
          ]}
          idPrefix={`${idPrefix}-objections`}
          items={rows}
          keyOf={(row) => row.key}
          renderCard={(row, open, onToggle) => (
            <CrmCard meta={[row.repName, ...row.territories].join(" · ")} title={row.doctorName}>
              <CrmFacts
                facts={[
                  { label: "Speciality", value: row.speciality ?? "—" },
                  { label: "What they objected to", value: doctorObjectionLines(row.objections).join(" · ") },
                ]}
              />
              <div className="mt-3">
                <DaysToggle onToggle={onToggle} open={open} />
              </div>
              {open ? (
                <div className="mt-3">
                  <DayList days={objectionVisitDays(row)} today={today} />
                </div>
              ) : null}
            </CrmCard>
          )}
          renderCells={(row, open, onToggle) => (
            <>
              <td className={crmTdClassName}>
                <p className="break-words font-black text-slate-950">{row.repName}</p>
                {row.territories.length > 0 ? <p className="mt-0.5 break-words text-xs text-slate-500">{row.territories.join(", ")}</p> : null}
              </td>
              <td className={crmTdClassName}>
                <p className="break-words font-black text-slate-950">{row.doctorName}</p>
                {row.speciality ? <p className="mt-0.5 break-words text-xs text-slate-500">{row.speciality}</p> : null}
              </td>
              <td className={crmTdClassName}>
                {doctorObjectionLines(row.objections).map((line) => (
                  <p className="break-words" key={line}>
                    {line}
                  </p>
                ))}
              </td>
              <td className={crmTdClassName}>
                <DaysToggle onToggle={onToggle} open={open} />
              </td>
            </>
          )}
          renderOpen={(row) => <DayList days={objectionVisitDays(row)} today={today} />}
          searchWords={(row) => [row.repName, row.doctorName, row.speciality, ...row.territories, ...row.objections.flatMap((objection) => [objection.label, ...objection.visits.flatMap((visit) => visit.products)])]}
          words={{ ...LIST_WORDS, searchLabel: "Find a rep or doctor", searchPlaceholder: "Rep, doctor, territory or product", title: "By rep, then doctor", with: "With objections", without: "None" }}
        />
      )}
    </>
  );
}
