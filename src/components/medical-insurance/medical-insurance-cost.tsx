"use client";

import { Download, Save } from "lucide-react";
import * as React from "react";

import { AdminCallout, AdminTableShell } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { phxFieldClassName, phxFieldGridTwoClassName, phxHintClassName, phxLabelClassName, phxSelectClassName } from "@/components/ui/form-tokens";
import { todayInCairo } from "@/lib/date-only";
import { formatLeftDay } from "@/lib/employees/left-flag";
import { INVOICE_KIND_WORDS, invoiceDatesProblem, MEDICAL_INSURANCE_INVOICE_KINDS, type MedicalInsuranceInvoiceKind } from "@/lib/medical-insurance/compare";
import { ageBandWords, MEDICAL_INSURANCE_CATEGORIES, type MedicalInsuranceCategory, type MedicalInsuranceMemberType, type MedicalInsuranceRateCard } from "@/lib/medical-insurance/cost";
import { plannedLinesTotal, type CostLine } from "@/lib/medical-insurance/eligibility";
import { EMPLOYEE_MINIMUM_OWN_SHARE_MONTHLY, LIFE_INSURANCE_PER_PERSON_MONTHLY, MONTHLY_SPLIT_ASSUMPTIONS, quoteMonthlyCost, type MonthlySplit, type MonthlySplitPerson, type MonthlySplitRow } from "@/lib/medical-insurance/monthly-split";
import { egpWords, MEDICAL_INSURANCE_OPEN_POINTS, MEMBER_TYPE_WORDS, type MedicalInsuranceInvoiceRow, type MedicalInsuranceMoneyView } from "@/lib/medical-insurance/view";
import { cn } from "@/lib/utils";

import { cairoDateTime, cellClassName, fileLinkClassName, headerClassName, SaveError, sendForm, sendJson, textLinkClassName, useSave } from "./medical-insurance-parts";

const amountClassName = "break-words text-right text-phx-xs font-bold tabular-nums text-phx-ink";
const totalClassName = "break-words text-right text-sm font-black tabular-nums text-phx-ink";
const rightHeaderClassName = cn(headerClassName, "text-right");
const money = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const signed = (value: number) => `${value > 0 ? "+" : ""}${money(value)}`;
const rateWords = (value: number | null) => (value === null ? "Not quoted" : value.toLocaleString("en-US", { maximumFractionDigits: 2 }));

export function MedicalInsuranceCostTab({
  money: view,
  policy,
}: {
  money: MedicalInsuranceMoneyView;
  policy: { endsOn: string; policyNumber: string | null; startsOn: string };
}) {
  return (
    <div className="space-y-5">
      <YearPanel view={view} />
      <MonthlySplitPanel split={view.monthlySplit} />
      <CostCalculatorPanel card={view.rateCard} policy={policy} />
      <OpeningPanel view={view} />
      <LinesPanel
        description="Joiners charged by the day to the policy's end (a quarter of the year from its last quarter on), and leavers refunded by the day from the day after their last covered day."
        empty="Nobody has joined or left since the policy started."
        lines={view.year.movements}
        title="Joiners and leavers on the register"
      />
      <LinesPanel
        description="What the rule says is still to be done: people to put on the policy, and covers to end. Each one is priced as it would be if done on the day shown."
        empty="Nothing is waiting: the register matches the rule."
        lines={view.year.planned}
        openingAddition={view.year.plannedOpening}
        title="Still to do"
        total={plannedLinesTotal(view.year)}
      />
      <RateCardPanel card={view.rateCard} />
      <PolicyNumberPanel policyNumber={policy.policyNumber} />
      <RecordBillPanel />
      {view.invoices.map((invoice, index) => <InvoicePanel defaultOpen={index === 0} invoice={invoice} key={invoice.id} />)}
      <AdminCallout>
        <div>
          <h2 className="text-sm font-black">What the contract leaves open, and the cost assumes</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {MEDICAL_INSURANCE_OPEN_POINTS.map((point) => <li className="break-words text-sm font-semibold" key={point}>{point}</li>)}
          </ul>
        </div>
      </AdminCallout>
    </div>
  );
}

function Tiles({ tiles }: { tiles: Array<{ label: string; value: string }> }) {
  return (
    <div className="grid grid-cols-1 gap-px bg-phx-line sm:grid-cols-3">
      {tiles.map(({ label, value }) => (
        <div className="bg-white px-4 py-3" key={label}>
          <span className="block text-phx-2xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">{label}</span>
          <span className="mt-1 block break-words text-xl font-black tabular-nums text-phx-ink">{value}</span>
        </div>
      ))}
    </div>
  );
}

function YearPanel({ view }: { view: MedicalInsuranceMoneyView }) {
  const { totals, unpriced } = view.year;
  return (
    <AdminTableShell
      description="The policy year under the signed offer: the opening bill, every joiner's charge and leaver's refund already on the register, and what the rule says is still to be done. Tax, card fees and the issue fee are in every figure."
      title="What the year costs"
    >
      <Tiles
        tiles={[
          { label: "Opening bill", value: egpWords(totals.opening) },
          { label: "Joiners charged", value: egpWords(totals.additions) },
          { label: "Leavers refunded", value: egpWords(totals.deletions) },
          { label: "Recorded so far", value: egpWords(totals.recorded) },
          { label: "Still to do", value: signed(totals.planned) },
          { label: "The year as people stand today", value: egpWords(totals.projected) },
        ]}
      />
      {unpriced > 0 ? (
        <p className="break-words border-t border-phx-line p-4 text-phx-xs font-bold text-phx-warn">
          {unpriced === 1 ? "1 person cannot be priced" : `${unpriced} people cannot be priced`} (no date of birth, no plan, or an age band the offer did not quote), so the figures are short by them. Each one is named below with the reason.
        </p>
      ) : null}
    </AdminTableShell>
  );
}

// ── The cost calculator (owner, 2026-11-27) ────────────────────────────────────────────────────

const CALCULATOR_WHO: ReadonlyArray<{ value: MedicalInsuranceMemberType; words: string }> = [
  { value: "employee", words: "The employee" },
  { value: "spouse", words: "Their spouse" },
  { value: "child", words: "Their child" },
];

function CostCalculatorPanel({ card, policy }: { card: MedicalInsuranceRateCard; policy: { endsOn: string; startsOn: string } }) {
  const today = todayInCairo();
  const defaultStart = today < policy.startsOn ? policy.startsOn : today > policy.endsOn ? policy.endsOn : today;
  const [who, setWho] = React.useState<MedicalInsuranceMemberType>("employee");
  const [birthYear, setBirthYear] = React.useState("");
  const [category, setCategory] = React.useState<MedicalInsuranceCategory>(MEDICAL_INSURANCE_CATEGORIES[0]!);
  const [start, setStart] = React.useState(defaultStart);
  const typedYear = /^\d{4}$/.test(birthYear.trim());
  const coverageStart = start >= policy.startsOn && start <= policy.endsOn ? start : defaultStart;
  const quote = typedYear ? quoteMonthlyCost({ birthYear: Number(birthYear.trim()), category, coverageStart, memberType: who, rateCard: card }) : null;
  const employee = who === "employee";

  return (
    <AdminTableShell
      description="What someone's cover would cost a month, before they are on the policy. Choose who they are, their year of birth and the plan; it is priced exactly as the monthly split above prices a person on the register. Nothing is saved."
      title="Cost calculator"
    >
      <div className="space-y-3 p-4">
        <div className={phxFieldGridTwoClassName}>
          <label className="block">
            <span className={phxLabelClassName}>Who</span>
            <select className={phxSelectClassName} onChange={(event) => setWho(event.target.value as MedicalInsuranceMemberType)} value={who}>
              {CALCULATOR_WHO.map((option) => <option key={option.value} value={option.value}>{option.words}</option>)}
            </select>
          </label>
          <label className="block">
            <span className={phxLabelClassName}>Plan</span>
            <select className={phxSelectClassName} onChange={(event) => setCategory(event.target.value as MedicalInsuranceCategory)} value={category}>
              {MEDICAL_INSURANCE_CATEGORIES.map((plan) => <option key={plan} value={plan}>Plan {plan}</option>)}
            </select>
          </label>
          <label className="block">
            <span className={phxLabelClassName}>Year of birth</span>
            <input className={phxFieldClassName} inputMode="numeric" maxLength={4} onChange={(event) => setBirthYear(event.target.value.replace(/\D/g, ""))} placeholder="1990" value={birthYear} />
          </label>
          <label className="block">
            <span className={phxLabelClassName}>Cover starts</span>
            <input className={phxFieldClassName} max={policy.endsOn} min={policy.startsOn} onChange={(event) => setStart(event.target.value)} type="date" value={start} />
          </label>
        </div>
        <p className={phxHintClassName}>The insurer prices the age as the year cover starts less the year of birth.</p>
      </div>
      {quote === null ? null : !quote.priced ? (
        <p className="break-words border-t border-phx-line p-4 text-sm font-bold text-phx-warn">{quote.reason}</p>
      ) : (
        <>
          <Tiles
            tiles={[
              { label: "Cover a month", value: egpWords(quote.monthly) },
              { label: "The company pays a month", value: egpWords(quote.companyPays) },
              { label: "The employee pays a month", value: egpWords(quote.employeePays) },
            ]}
          />
          <ul className="list-disc space-y-1 border-t border-phx-line p-4 pl-9">
            <li className="break-words text-phx-xs font-semibold tabular-nums text-phx-ink-soft">
              Plan {category}, aged {quote.age} (ages {quote.band}): {egpWords(quote.annual)} a year before tax, {egpWords(quote.monthly)} a month with the tax.
            </li>
            <li className="break-words text-phx-xs font-semibold tabular-nums text-phx-ink-soft">
              {employee
                ? `Of the month, the company carries ${egpWords(quote.companyPays)} and the employee ${egpWords(quote.employeeCover)}${quote.raisedToMinimum ? `, raised to the EGP ${EMPLOYEE_MINIMUM_OWN_SHARE_MONTHLY} minimum` : ""}.`
                : `A spouse or child is the employee's in full: ${egpWords(quote.employeeCover)} a month, and the company carries nothing.`}
            </li>
            <li className="break-words text-phx-xs font-semibold tabular-nums text-phx-ink-soft">
              Life insurance: {egpWords(quote.lifeInsurance)} a month on the employee, so the employee pays {egpWords(quote.employeePays)} in all.
            </li>
            {quote.ageNote ? <li className="break-words text-phx-xs font-bold text-phx-warn">{quote.ageNote}</li> : null}
          </ul>
        </>
      )}
    </AdminTableShell>
  );
}

// ── Who carries the cover each month (owner, 2026-11-17) ──────────────────────────────────────

function splitPersonWords(person: MonthlySplitPerson): string {
  const parts = [person.memberType === "employee" ? `Plan ${person.category}` : `${MEMBER_TYPE_WORDS[person.memberType]}, plan ${person.category}`];
  if (person.band) parts.push(`ages ${person.band}`);
  if (person.startsOn) parts.push(`from ${formatLeftDay(person.startsOn)}`);
  return parts.join(", ");
}

function splitRowName(row: MonthlySplitRow): string {
  return row.employee?.name ?? row.family[0]?.name ?? "";
}

function familyWords(row: MonthlySplitRow): string {
  if (row.family.length === 0) return "None";
  return `${row.family.length === 1 ? "1 person" : `${row.family.length} people`}, ${money(row.familyMonthly)}`;
}

function SplitPeople({ row }: { row: MonthlySplitRow }) {
  return (
    <>
      <p className="break-words text-phx-xs font-black text-phx-ink" dir="auto">{splitRowName(row)}</p>
      {row.employee ? (
        <p className="break-words text-phx-xs font-semibold text-phx-ink-soft">{[row.hrId, splitPersonWords(row.employee)].filter(Boolean).join(", ")}</p>
      ) : (
        <p className="break-words text-phx-xs font-bold text-phx-warn">Their employee is not on the register, so their cover is all on the family</p>
      )}
      {row.employee?.unpricedReason ? <p className="break-words text-phx-xs font-bold text-phx-warn">Cannot be priced: {row.employee.unpricedReason}</p> : null}
      {row.family.map((relative) => (
        <p className="break-words text-phx-xs font-semibold text-phx-ink-faint" dir="auto" key={relative.memberId}>
          {row.employee ? `${relative.name}: ` : ""}
          {splitPersonWords(relative)},{" "}
          {relative.monthly === null ? <span className="font-bold text-phx-warn">cannot be priced: {relative.unpricedReason}</span> : `${money(relative.monthly)} a month`}
        </p>
      ))}
    </>
  );
}

function MonthlySplitPanel({ split }: { split: MonthlySplit }) {
  const { rows, totals, unpriced } = split;
  return (
    <AdminTableShell
      action={
        <a className={cn(fileLinkClassName, "gap-2")} download href="/api/medical-insurance/cost/export">
          <Download className="h-4 w-4" />
          Export
        </a>
      }
      description={`Each month the company carries 70% of the employee's own cover and the employee 30%, never less than EGP ${EMPLOYEE_MINIMUM_OWN_SHARE_MONTHLY} (the company carries the rest). A spouse or child is the employee's in full, and EGP ${LIFE_INSURANCE_PER_PERSON_MONTHLY} of life insurance is added on the employee's share for every person covered. Only you see this.`}
      title="Who pays each month"
    >
      <Tiles
        tiles={[
          { label: "The company pays a month", value: egpWords(totals.companyPays) },
          { label: "Employees pay a month", value: egpWords(totals.employeesPay) },
          { label: "Of which life insurance", value: egpWords(totals.lifeInsurance) },
          { label: "Employees", value: String(totals.employees) },
          { label: "People covered", value: String(totals.people) },
          { label: "Cover and life insurance a month", value: egpWords(totals.total) },
        ]}
      />
      {unpriced > 0 ? (
        <p className="break-words border-t border-phx-line p-4 text-phx-xs font-bold text-phx-warn">
          {unpriced === 1 ? "1 person cannot be priced" : `${unpriced} people cannot be priced`}, so the figures are short by them. Each one is named below with the reason.
        </p>
      ) : null}
      {rows.length === 0 ? (
        <p className="p-4 text-sm font-semibold text-phx-ink-soft">Nobody is on the register.</p>
      ) : (
        <>
          <div className="hidden md:block">
            <table className="w-full table-fixed border-separate border-spacing-0 text-sm">
              <colgroup>
                <col className="w-[28%]" />
                <col className="w-[11%]" />
                <col className="w-[11%]" />
                <col className="w-[11%]" />
                <col className="w-[14%]" />
                <col className="w-[11%]" />
                <col className="w-[14%]" />
              </colgroup>
              <thead>
                <tr>
                  <th className={headerClassName}>Employee and family</th>
                  <th className={rightHeaderClassName}>Own cover a month</th>
                  <th className={rightHeaderClassName}>Company</th>
                  <th className={rightHeaderClassName}>Employee 30%, at least {EMPLOYEE_MINIMUM_OWN_SHARE_MONTHLY}</th>
                  <th className={rightHeaderClassName}>Family, all on the employee</th>
                  <th className={rightHeaderClassName}>Life insurance</th>
                  <th className={rightHeaderClassName}>Employee pays a month</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key}>
                    <td className={cellClassName}><SplitPeople row={row} /></td>
                    <td className={cn(cellClassName, amountClassName)}>{row.employee ? money(row.ownMonthly) : ""}</td>
                    <td className={cn(cellClassName, amountClassName)}>{row.employee ? money(row.companyPays) : ""}</td>
                    <td className={cn(cellClassName, amountClassName)}>
                      {row.employee ? money(row.employeeOwnShare) : ""}
                      {row.raisedToMinimum ? <span className="block text-phx-2xs font-semibold text-phx-ink-soft">raised to the minimum</span> : null}
                    </td>
                    <td className={cn(cellClassName, amountClassName)}>{familyWords(row)}</td>
                    <td className={cn(cellClassName, amountClassName)}>{money(row.lifeInsurance)}</td>
                    <td className={cn(cellClassName, totalClassName)}>{money(row.employeePays)}</td>
                  </tr>
                ))}
                <tr>
                  <th className={cn(cellClassName, "text-left")} colSpan={2} scope="row"><span className="text-sm font-black text-phx-ink">Total a month</span></th>
                  <td className={cn(cellClassName, totalClassName)}>{money(totals.companyPays)}</td>
                  <td className={cellClassName} colSpan={2} />
                  <td className={cn(cellClassName, totalClassName)}>{money(totals.lifeInsurance)}</td>
                  <td className={cn(cellClassName, totalClassName)}>{money(totals.employeesPay)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="space-y-3 p-4 md:hidden">
            {rows.map((row) => (
              <div className="space-y-1 border border-phx-line bg-white p-3" key={row.key}>
                <SplitPeople row={row} />
                {row.employee ? (
                  <p className="break-words text-phx-xs font-semibold tabular-nums text-phx-ink-soft">
                    Own cover {money(row.ownMonthly)}: company {money(row.companyPays)}, employee {money(row.employeeOwnShare)}{row.raisedToMinimum ? " (raised to the minimum)" : ""}
                  </p>
                ) : null}
                <p className="break-words text-phx-xs font-semibold tabular-nums text-phx-ink-soft">Family {familyWords(row)}. Life insurance {money(row.lifeInsurance)}</p>
                <p className="break-words text-phx-xs font-black tabular-nums text-phx-ink">Employee pays {money(row.employeePays)} a month</p>
              </div>
            ))}
            <p className="break-words text-sm font-black tabular-nums text-phx-ink">Company {money(totals.companyPays)}, employees {money(totals.employeesPay)} a month</p>
          </div>
        </>
      )}
      <ul className="list-disc space-y-1 border-t border-phx-line p-4 pl-9">
        {MONTHLY_SPLIT_ASSUMPTIONS.map((point) => <li className="break-words text-phx-xs font-semibold text-phx-ink-soft" key={point}>{point}</li>)}
      </ul>
    </AdminTableShell>
  );
}

function OpeningPanel({ view }: { view: MedicalInsuranceMoneyView }) {
  const { opening, openingPeople } = view.year;
  const [showPeople, setShowPeople] = React.useState(false);
  const plans = opening.plans.filter((plan) => plan.people > 0);
  const unpricedPeople = openingPeople.filter((person) => person.unpricedReason);

  return (
    <AdminTableShell
      description="Everyone on the policy from its first day, laid out as the policy's schedule is: per plan and age band, each band's premium the rate times its people, before the 1.55% tax. Ages are the insurer's: 2026 less the year of birth."
      title="The opening bill"
    >
      <div className="hidden md:block">
        <table className="w-full table-fixed border-separate border-spacing-0 text-sm">
          <colgroup>
            <col className="w-[16%]" />
            <col className="w-[24%]" />
            <col className="w-[16%]" />
            <col className="w-[22%]" />
            <col className="w-[22%]" />
          </colgroup>
          <thead>
            <tr>
              <th className={headerClassName}>Plan</th>
              <th className={headerClassName}>Ages</th>
              <th className={rightHeaderClassName}>People</th>
              <th className={rightHeaderClassName}>Rate per person</th>
              <th className={rightHeaderClassName}>Premium (EGP)</th>
            </tr>
          </thead>
          <tbody>
            {plans.map((plan) => (
              <React.Fragment key={plan.category}>
                {plan.bands.map((band, index) => (
                  <tr key={`${plan.category}:${band.band}`}>
                    <td className={cellClassName}><span className="text-phx-xs font-bold text-phx-ink">{index === 0 ? `Plan ${plan.category}` : ""}</span></td>
                    <td className={cellClassName}><span className="text-phx-xs font-bold text-phx-ink">{band.label}</span></td>
                    <td className={cn(cellClassName, amountClassName)}>{band.people}</td>
                    <td className={cn(cellClassName, amountClassName)}>{band.rate === null ? "Not quoted" : money(band.rate)}</td>
                    <td className={cn(cellClassName, amountClassName)}>{money(band.premium)}</td>
                  </tr>
                ))}
                <tr>
                  <th className={cn(cellClassName, "text-left")} colSpan={2} scope="row"><span className="text-phx-xs font-black text-phx-ink">Plan {plan.category} total</span></th>
                  <td className={cn(cellClassName, totalClassName)}>{plan.people}</td>
                  <td className={cellClassName} />
                  <td className={cn(cellClassName, totalClassName)}>{money(plan.premium)}</td>
                </tr>
              </React.Fragment>
            ))}
            {[
              { label: "Premium", value: opening.premium },
              { label: "Tax and supervision, 1.55%", value: opening.tax },
              { label: `Cards, ${opening.people} at EGP ${view.rateCard.cardFeePerMember}`, value: opening.cards },
              { label: "Issue fee", value: opening.issueFee },
            ].map((row) => (
              <tr key={row.label}>
                <th className={cn(cellClassName, "text-left")} colSpan={4} scope="row"><span className="text-phx-xs font-bold text-phx-ink">{row.label}</span></th>
                <td className={cn(cellClassName, amountClassName)}>{money(row.value)}</td>
              </tr>
            ))}
            <tr>
              <th className={cn(cellClassName, "text-left")} colSpan={4} scope="row"><span className="text-sm font-black text-phx-ink">Opening bill</span></th>
              <td className={cn(cellClassName, totalClassName)}>{money(opening.total)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="space-y-3 p-4 md:hidden">
        {plans.map((plan) => (
          <div className="border border-phx-line bg-white p-3" key={plan.category}>
            <p className="break-words text-sm font-black text-phx-ink">Plan {plan.category}: {plan.people} people, {egpWords(plan.premium)}</p>
            <ul className="mt-1 space-y-1">
              {plan.bands.map((band) => (
                <li className="break-words text-phx-xs font-semibold text-phx-ink-soft" key={band.band}>
                  Ages {band.label}: {band.people} at {band.rate === null ? "no rate" : money(band.rate)}, {money(band.premium)}
                </li>
              ))}
            </ul>
          </div>
        ))}
        <p className="break-words text-phx-xs font-semibold text-phx-ink-soft">
          Premium {money(opening.premium)}, tax {money(opening.tax)}, cards {money(opening.cards)}, issue fee {money(opening.issueFee)}
        </p>
        <p className="text-sm font-black tabular-nums text-phx-ink">Opening bill {egpWords(opening.total)}</p>
      </div>

      <div className="space-y-2 border-t border-phx-line p-4">
        {unpricedPeople.length > 0 ? (
          <ul className="space-y-1">
            {unpricedPeople.map((person) => (
              <li className="break-words text-phx-xs font-bold text-phx-warn" key={person.key} dir="auto">{person.name}: {person.unpricedReason}</li>
            ))}
          </ul>
        ) : null}
        <button className={textLinkClassName} onClick={() => setShowPeople((current) => !current)} type="button">
          {showPeople ? "Hide who is on the opening bill" : `Show who is on the opening bill (${openingPeople.length})`}
        </button>
        {showPeople ? <PeopleList lines={openingPeople} /> : null}
      </div>
    </AdminTableShell>
  );
}

function personDetail(line: CostLine): string {
  const parts = [MEMBER_TYPE_WORDS[line.memberType]];
  if (line.category) parts.push(`plan ${line.category}`);
  if (line.age !== null) parts.push(`aged ${line.age}`);
  if (line.annual !== null) parts.push(`${money(line.annual)} a year`);
  return parts.join(", ");
}

function PeopleList({ lines }: { lines: readonly CostLine[] }) {
  return (
    <ul className="border-t border-phx-line">
      {lines.map((line) => (
        <li className="flex flex-wrap justify-between gap-2 border-b border-phx-line py-2" key={line.key}>
          <div className="min-w-0">
            <p className="break-words text-phx-xs font-black text-phx-ink" dir="auto">{line.name}</p>
            <p className="break-words text-phx-xs font-semibold text-phx-ink-soft">{personDetail(line)}</p>
          </div>
          <span className="text-phx-xs font-bold tabular-nums text-phx-ink">{line.unpricedReason ?? (line.annual === null ? "" : money(line.annual))}</span>
        </li>
      ))}
    </ul>
  );
}

function lineKindWords(line: CostLine): string {
  if (line.kind === "addition" || line.kind === "planned_addition") return `Joins ${formatLeftDay(line.day)}`;
  return `Last covered ${formatLeftDay(line.day)}`;
}

function lineAmountWords(line: CostLine): string {
  if (line.movement) return signed(line.movement.total);
  if (line.unpricedReason) return line.unpricedReason;
  return "On the opening bill";
}

function lineHowWords(line: CostLine): string | null {
  const movement = line.movement;
  if (!movement) return null;
  if (movement.lastQuarter) return `A quarter of the year (last quarter): premium ${money(movement.premium)}, tax ${money(movement.tax)}, card ${money(movement.card)}`;
  const share = `${movement.days} of ${movement.policyDays} days`;
  return movement.kind === "addition"
    ? `${share}: premium ${money(movement.premium)}, tax ${money(movement.tax)}, card ${money(movement.card)}`
    : `${share} refunded: premium ${money(movement.premium)}, tax ${money(movement.tax)}`;
}

const OPENING_ADDITION_HOW = "Laid out as the policy's schedule is: each band's premium the rate times its people, tax 1.55% and EGP 30 a card";

function openingAdditionWords(people: number): string {
  return people === 1 ? "1 person joining from the policy's first day" : `${people} people joining from the policy's first day`;
}

function LinesPanel({
  description,
  empty,
  lines,
  openingAddition,
  title,
  total: givenTotal,
}: {
  description: string;
  empty: string;
  lines: readonly CostLine[];
  /** The day-one joiners' share of the opening bill, shown as its own row and counted in the total. */
  openingAddition?: { people: number; total: number };
  title: string;
  total?: number;
}) {
  const total = givenTotal ?? lines.reduce((sum, line) => sum + Math.round((line.movement?.total ?? 0) * 100), 0) / 100;
  const addition = openingAddition && openingAddition.people > 0 ? openingAddition : null;
  return (
    <AdminTableShell description={description} title={title}>
      {lines.length === 0 ? (
        <p className="p-4 text-sm font-semibold text-phx-ink-soft">{empty}</p>
      ) : (
        <>
          <div className="hidden md:block">
            <table className="w-full table-fixed border-separate border-spacing-0 text-sm">
              <colgroup>
                <col className="w-[34%]" />
                <col className="w-[20%]" />
                <col className="w-[30%]" />
                <col className="w-[16%]" />
              </colgroup>
              <thead>
                <tr>
                  <th className={headerClassName}>Person</th>
                  <th className={headerClassName}>When</th>
                  <th className={headerClassName}>How it is worked out</th>
                  <th className={rightHeaderClassName}>Amount (EGP)</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.key}>
                    <td className={cellClassName}>
                      <p className="break-words text-phx-xs font-black text-phx-ink" dir="auto">{line.name}</p>
                      <p className="break-words text-phx-xs font-semibold text-phx-ink-soft">{personDetail(line)}</p>
                      {line.note ? <p className="break-words text-phx-xs font-semibold text-phx-ink-faint" dir="auto">{line.note}</p> : null}
                    </td>
                    <td className={cellClassName}><span className="break-words text-phx-xs font-bold text-phx-ink">{lineKindWords(line)}</span></td>
                    <td className={cellClassName}><span className="break-words text-phx-xs font-semibold text-phx-ink-soft">{lineHowWords(line) ?? ""}</span></td>
                    <td className={cn(cellClassName, line.movement ? amountClassName : "break-words text-right text-phx-xs font-bold text-phx-warn")}>{lineAmountWords(line)}</td>
                  </tr>
                ))}
                {addition ? (
                  <tr>
                    <th className={cn(cellClassName, "text-left")} scope="row">
                      <p className="break-words text-phx-xs font-black text-phx-ink">Added to the opening bill</p>
                      <p className="break-words text-phx-xs font-semibold text-phx-ink-soft">{openingAdditionWords(addition.people)}</p>
                    </th>
                    <td className={cellClassName}><span className="break-words text-phx-xs font-bold text-phx-ink">From the first day</span></td>
                    <td className={cellClassName}><span className="break-words text-phx-xs font-semibold text-phx-ink-soft">{OPENING_ADDITION_HOW}</span></td>
                    <td className={cn(cellClassName, amountClassName)}>{signed(addition.total)}</td>
                  </tr>
                ) : null}
                <tr>
                  <th className={cn(cellClassName, "text-left")} colSpan={3} scope="row"><span className="text-sm font-black text-phx-ink">Total</span></th>
                  <td className={cn(cellClassName, totalClassName)}>{signed(total)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="space-y-3 p-4 md:hidden">
            {lines.map((line) => (
              <div className="space-y-1 border border-phx-line bg-white p-3" key={line.key}>
                <p className="break-words text-phx-xs font-black text-phx-ink" dir="auto">{line.name}</p>
                <p className="break-words text-phx-xs font-semibold text-phx-ink-soft">{personDetail(line)}. {lineKindWords(line)}</p>
                {line.note ? <p className="break-words text-phx-xs font-semibold text-phx-ink-faint" dir="auto">{line.note}</p> : null}
                {lineHowWords(line) ? <p className="break-words text-phx-xs font-semibold text-phx-ink-soft">{lineHowWords(line)}</p> : null}
                <p className={cn("break-words text-phx-xs font-black tabular-nums", line.movement ? "text-phx-ink" : "text-phx-warn")}>{lineAmountWords(line)}</p>
              </div>
            ))}
            {addition ? (
              <div className="space-y-1 border border-phx-line bg-white p-3">
                <p className="break-words text-phx-xs font-black text-phx-ink">Added to the opening bill</p>
                <p className="break-words text-phx-xs font-semibold text-phx-ink-soft">{openingAdditionWords(addition.people)}</p>
                <p className="break-words text-phx-xs font-semibold text-phx-ink-soft">{OPENING_ADDITION_HOW}</p>
                <p className="break-words text-phx-xs font-black tabular-nums text-phx-ink">{signed(addition.total)}</p>
              </div>
            ) : null}
            <p className="text-sm font-black tabular-nums text-phx-ink">Total {signed(total)}</p>
          </div>
        </>
      )}
    </AdminTableShell>
  );
}

function RateCardPanel({ card }: { card: MedicalInsuranceRateCard }) {
  const { busy, error, save } = useSave();
  const [editing, setEditing] = React.useState(false);
  const toFields = React.useCallback(
    () => Object.fromEntries(MEDICAL_INSURANCE_CATEGORIES.map((category) => [category, card.plans[category].rates.map((rate) => (rate === null ? "" : String(rate)))])) as Record<MedicalInsuranceCategory, string[]>,
    [card],
  );
  const [fields, setFields] = React.useState(toFields);

  function setRate(category: MedicalInsuranceCategory, band: number, value: string) {
    setFields((current) => ({ ...current, [category]: current[category].map((old, index) => (index === band ? value : old)) }));
  }

  function saveCard() {
    const changed = MEDICAL_INSURANCE_CATEGORIES.filter((category) =>
      fields[category].some((value, index) => (value.trim() === "" ? null : Number(value.replace(/,/g, ""))) !== card.plans[category].rates[index]),
    );
    void save(
      async () => {
        for (const category of changed) await sendJson("/api/medical-insurance/policy", "PATCH", { category, rates: fields[category] });
      },
      () => setEditing(false),
    );
  }

  return (
    <AdminTableShell
      action={
        editing ? (
          <div className="flex flex-wrap gap-2">
            <Button className="h-10 gap-2" disabled={busy} onClick={saveCard}><Save className="h-4 w-4" />{busy ? "Saving" : "Save the rates"}</Button>
            <Button className="h-10" disabled={busy} onClick={() => { setFields(toFields()); setEditing(false); }} variant="secondary">Cancel</Button>
          </div>
        ) : (
          <Button className="h-10" onClick={() => { setFields(toFields()); setEditing(true); }} variant="secondary">Change a rate</Button>
        )
      }
      description={`The annual premium per person, from the signed offer. Plan A ${card.plans.A.network}, ${card.plans.A.room.toLowerCase()}, up to EGP ${card.plans.A.annualLimit.toLocaleString("en-US")} a year; plans B and C ${card.plans.B.network}, ${card.plans.B.room.toLowerCase()}, up to EGP ${card.plans.B.annualLimit.toLocaleString("en-US")} and EGP ${card.plans.C.annualLimit.toLocaleString("en-US")}. A blank band is not quoted.`}
      title="The rate card"
    >
      <table className="w-full table-fixed border-separate border-spacing-0 text-sm">
        <colgroup>
          <col className="w-[28%]" />
          <col className="w-[24%]" />
          <col className="w-[24%]" />
          <col className="w-[24%]" />
        </colgroup>
        <thead>
          <tr>
            <th className={headerClassName}>Ages</th>
            {MEDICAL_INSURANCE_CATEGORIES.map((category) => <th className={rightHeaderClassName} key={category}>Plan {category}</th>)}
          </tr>
        </thead>
        <tbody>
          {card.ageBands.map((band, index) => (
            <tr key={band.from}>
              <td className={cellClassName}><span className="break-words text-phx-xs font-bold text-phx-ink">{ageBandWords(band)}</span></td>
              {MEDICAL_INSURANCE_CATEGORIES.map((category) => (
                <td className={cn(cellClassName, amountClassName)} key={category}>
                  {editing ? (
                    <input
                      aria-label={`Plan ${category}, ages ${ageBandWords(band)}`}
                      className={cn(phxFieldClassName, "text-right")}
                      inputMode="decimal"
                      onChange={(event) => setRate(category, index, event.target.value)}
                      value={fields[category][index]}
                    />
                  ) : (
                    <span className={card.plans[category].rates[index] === null ? "text-phx-ink-faint" : undefined}>{rateWords(card.plans[category].rates[index])}</span>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="space-y-1 border-t border-phx-line p-4">
        <p className="break-words text-phx-xs font-semibold text-phx-ink-soft">
          On top of the premium: tax and supervision {card.taxBasisPoints / 100}%, EGP {card.cardFeePerMember} per card, EGP {card.issueFee} issue fee, EGP {card.cardReissueFee} to reissue a card. A joiner in the last quarter pays {card.lastQuarterAdditionBasisPoints / 100}% of the year.
        </p>
        <SaveError error={error} />
      </div>
    </AdminTableShell>
  );
}

function PolicyNumberPanel({ policyNumber }: { policyNumber: string | null }) {
  const { busy, error, save } = useSave();
  const [value, setValue] = React.useState(policyNumber ?? "");
  return (
    <AdminTableShell description="The number printed on the issued policy. Every file carries it; change it only if Libano-Suisse issues a new one." title="Policy number">
      <div className="flex flex-wrap items-end gap-3 p-4">
        <label className="block w-full sm:w-72">
          <span className={phxLabelClassName}>Policy number</span>
          <input className={phxFieldClassName} onChange={(event) => setValue(event.target.value)} value={value} />
        </label>
        <Button className="h-10" disabled={busy || value.trim() === (policyNumber ?? "")} onClick={() => void save(() => sendJson("/api/medical-insurance/policy", "PATCH", { policyNumber: value }))}>Save</Button>
      </div>
      <div className="px-4 pb-4"><SaveError error={error} /></div>
    </AdminTableShell>
  );
}

function RecordBillPanel() {
  const { busy, error, save } = useSave();
  const blank = { coversFrom: "", coversTo: "", invoiceNumber: "", issuedOn: "", kind: "opening" as MedicalInsuranceInvoiceKind, note: "", totalDue: "" };
  const [fields, setFields] = React.useState(blank);
  const [file, setFile] = React.useState<File | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const set = (key: keyof typeof blank) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setFields((current) => ({ ...current, [key]: event.target.value }));
  const datesProblem = invoiceDatesProblem(fields.kind, fields.coversFrom || null, fields.coversTo || null);

  function record() {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    if (file) form.set("file", file);
    void save(
      () => sendForm("/api/medical-insurance/invoices", form),
      () => {
        setFields(blank);
        setFile(null);
        if (inputRef.current) inputRef.current.value = "";
      },
    );
  }

  return (
    <AdminTableShell
      description="Type the bill's figures as Libano-Suisse printed them. It is compared with what the plan says it should be: an opening bill or premium instalment with its share of the opening statement (the year's premium and tax are paid quarterly, the first bill also carrying the cards and the issue fee), additions and deletions with the joiners and leavers inside its dates. It pays nothing and writes nothing to payroll."
      title="Record a bill"
    >
      <div className="space-y-3 p-4">
        <div className={phxFieldGridTwoClassName}>
          <label className="block">
            <span className={phxLabelClassName}>Bill number</span>
            <input className={phxFieldClassName} onChange={set("invoiceNumber")} value={fields.invoiceNumber} />
          </label>
          <label className="block">
            <span className={phxLabelClassName}>What it is for</span>
            <select className={phxSelectClassName} onChange={set("kind")} value={fields.kind}>
              {MEDICAL_INSURANCE_INVOICE_KINDS.map((kind) => <option key={kind} value={kind}>{INVOICE_KIND_WORDS[kind]}</option>)}
            </select>
          </label>
          <label className="block">
            <span className={phxLabelClassName}>Bill date</span>
            <input className={phxFieldClassName} onChange={set("issuedOn")} type="date" value={fields.issuedOn} />
          </label>
          <label className="block">
            <span className={phxLabelClassName}>{fields.kind === "deletions" ? "Total credited (EGP)" : "Total due (EGP)"}</span>
            <input className={phxFieldClassName} inputMode="decimal" onChange={set("totalDue")} value={fields.totalDue} />
          </label>
          {fields.kind !== "other" ? (
            <>
              <label className="block">
                <span className={phxLabelClassName}>
                  {fields.kind === "opening" ? "Cover from (picks the instalment)" : `People who ${fields.kind === "additions" ? "joined" : "left"} from`}
                </span>
                <input className={phxFieldClassName} onChange={set("coversFrom")} type="date" value={fields.coversFrom} />
              </label>
              <label className="block">
                <span className={phxLabelClassName}>{fields.kind === "opening" ? "Cover up to" : "Up to"}</span>
                <input className={phxFieldClassName} onChange={set("coversTo")} type="date" value={fields.coversTo} />
              </label>
            </>
          ) : null}
          <label className="block">
            <span className={phxLabelClassName}>The insurer&apos;s paper, if you have it</span>
            <input className={phxFieldClassName} onChange={(event) => setFile(event.target.files?.[0] ?? null)} ref={inputRef} type="file" />
          </label>
          <label className="block">
            <span className={phxLabelClassName}>Note</span>
            <input className={phxFieldClassName} onChange={set("note")} value={fields.note} />
          </label>
        </div>
        <Button className="h-10" disabled={busy || !fields.invoiceNumber.trim() || !fields.totalDue.trim() || datesProblem !== null} onClick={record}>{busy ? "Recording" : "Record and compare"}</Button>
        {datesProblem && (fields.invoiceNumber.trim() || fields.totalDue.trim()) ? <p className={phxHintClassName}>{datesProblem}</p> : null}
        <SaveError error={error} />
      </div>
    </AdminTableShell>
  );
}

function InvoicePanel({ defaultOpen, invoice }: { defaultOpen: boolean; invoice: MedicalInsuranceInvoiceRow }) {
  const { busy, error, save } = useSave();
  const [open, setOpen] = React.useState(defaultOpen);
  const { comparison } = invoice;
  const base = `/api/medical-insurance/invoices/${invoice.id}`;
  const from = invoice.coversFrom ? formatLeftDay(invoice.coversFrom) : "the start";
  const to = invoice.coversTo ? formatLeftDay(invoice.coversTo) : invoice.kind === "opening" ? "the end of the instalment" : "today";
  const dates = invoice.coversFrom || invoice.coversTo ? (invoice.kind === "opening" ? `Covers ${from} to ${to}. ` : `People from ${from} to ${to}. `) : "";

  return (
    <AdminTableShell
      action={
        <div className="flex flex-wrap gap-2">
          {invoice.fileName ? <a className={fileLinkClassName} href={`${base}/file`} rel="noreferrer" target="_blank">Open the paper</a> : null}
          {comparison.expected !== null ? <Button className="h-10" disabled={busy} onClick={() => void save(() => sendJson(`${base}/compare`, "POST"))} variant="secondary">Compare again</Button> : null}
        </div>
      }
      description={`${INVOICE_KIND_WORDS[invoice.kind]}. ${dates}${invoice.issuedOn ? `Dated ${formatLeftDay(invoice.issuedOn)}. ` : ""}Recorded ${cairoDateTime(invoice.recordedAt)}, compared ${cairoDateTime(invoice.comparedAt)}.${invoice.note ? ` ${invoice.note}` : ""}`}
      title={`Bill ${invoice.invoiceNumber}`}
    >
      <Tiles
        tiles={[
          { label: "They billed", value: egpWords(comparison.billed) },
          {
            label: comparison.instalment ? `The plan says (instalment ${comparison.instalment.number} of ${comparison.instalment.of})` : "The plan says",
            value: comparison.expected === null ? "Not compared" : egpWords(comparison.expected),
          },
          { label: "Difference", value: comparison.difference === null ? "Not compared" : signed(comparison.difference) },
        ]}
      />
      {comparison.unpriced > 0 ? (
        <p className="break-words border-t border-phx-line px-4 pt-3 text-phx-xs font-bold text-phx-warn">
          {comparison.unpriced === 1 ? "1 person on this bill cannot be priced" : `${comparison.unpriced} people on this bill cannot be priced`}, so the plan&apos;s figure is short by them.
        </p>
      ) : null}
      <div className="p-4">
        <SaveError error={error} />
        {comparison.lines.length > 0 ? (
          <button className={textLinkClassName} onClick={() => setOpen((current) => !current)} type="button">{open ? "Hide who the plan expects" : `Show who the plan expects (${comparison.lines.length})`}</button>
        ) : null}
      </div>
      {open && comparison.lines.length > 0 ? (
        <ul className="border-t border-phx-line px-4">
          {comparison.lines.map((line) => (
            <li className="flex flex-wrap justify-between gap-2 border-b border-phx-line py-2" key={`${line.name}:${line.day}`}>
              <div className="min-w-0">
                <p className="break-words text-phx-xs font-black text-phx-ink" dir="auto">{line.name}</p>
                <p className="break-words text-phx-xs font-semibold text-phx-ink-soft">{formatLeftDay(line.day)}{line.planned ? ", not on the register yet" : ""}</p>
              </div>
              <span className={cn("text-phx-xs font-bold tabular-nums", line.amount === null ? "text-phx-warn" : "text-phx-ink")}>{line.amount === null ? line.unpricedReason : signed(line.amount)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </AdminTableShell>
  );
}
