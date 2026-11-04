"use client";

import { Upload } from "lucide-react";
import * as React from "react";

import { AdminCallout, AdminTableShell } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { phxFieldClassName, phxLabelClassName } from "@/components/ui/form-tokens";
import { formatLeftDay } from "@/lib/employees/left-flag";
import { COMPARISON_STATUS_WORDS, type ComparisonRow, type ComparisonStatus } from "@/lib/medical-insurance/compare";
import { egpWords, MEDICAL_INSURANCE_OPEN_POINTS, type MedicalInsuranceInvoiceRow, type MedicalInsuranceMoneyView } from "@/lib/medical-insurance/view";
import { cn } from "@/lib/utils";

import { cairoDateTime, cellClassName, fileLinkClassName, headerClassName, SaveError, sendForm, sendJson, textLinkClassName, useSave } from "./medical-insurance-parts";

const amountClassName = "break-words text-right text-phx-xs font-bold tabular-nums text-phx-ink";
const rightHeaderClassName = cn(headerClassName, "text-right");
const money = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const signed = (value: number) => `${value > 0 ? "+" : ""}${money(value)}`;

const STATUS_TONE: Record<ComparisonStatus, string> = {
  billed_not_planned: "text-phx-warn",
  differs: "text-phx-warn",
  match: "text-phx-ok",
  planned_not_billed: "text-phx-warn",
};

export function MedicalInsuranceCostTab({ money: view }: { money: MedicalInsuranceMoneyView }) {
  return (
    <div className="space-y-5">
      <PlanPanel view={view} />
      <UploadPanel />
      {view.invoices.map((invoice, index) => <InvoicePanel defaultOpen={index === 0} invoice={invoice} key={invoice.id} />)}
      <AdminCallout>
        <div>
          <h2 className="text-sm font-black">What the insurer has not yet answered</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {MEDICAL_INSURANCE_OPEN_POINTS.map((point) => <li className="break-words text-sm font-semibold" key={point}>{point}</li>)}
          </ul>
        </div>
      </AdminCallout>
    </div>
  );
}

function PlanPanel({ view }: { view: MedicalInsuranceMoneyView }) {
  const { people, prorated, statement, unpriced } = view.plan;
  const [showPeople, setShowPeople] = React.useState(false);

  return (
    <AdminTableShell
      description={`${formatLeftDay(view.period.start)} to ${formatLeftDay(view.period.end)}. The people who belong in this period at the policy's rates. A year at today's people comes to ${egpWords(view.yearEstimate)}.`}
      title="What this period should cost"
    >
      <div className="hidden md:block">
        <table className="w-full table-fixed border-separate border-spacing-0 text-sm">
          <colgroup>
            <col className="w-[28%]" />
            <col className="w-[12%]" />
            <col className="w-[15%]" />
            <col className="w-[15%]" />
            <col className="w-[15%]" />
            <col className="w-[15%]" />
          </colgroup>
          <thead>
            <tr>
              <th className={headerClassName}>Cover</th>
              <th className={rightHeaderClassName}>People</th>
              <th className={rightHeaderClassName}>Premium</th>
              <th className={rightHeaderClassName}>Fees</th>
              <th className={rightHeaderClassName}>Stamp</th>
              <th className={rightHeaderClassName}>Total (EGP)</th>
            </tr>
          </thead>
          <tbody>
            {statement.lines.map((line) => (
              <tr key={line.product}>
                <td className={cellClassName}><span className="break-words text-phx-xs font-bold text-phx-ink">{line.label}</span></td>
                <td className={cn(cellClassName, amountClassName)}>{line.people}</td>
                <td className={cn(cellClassName, amountClassName)}>{money(line.premium)}</td>
                <td className={cn(cellClassName, amountClassName)}>{money(line.fees + line.issueFee)}</td>
                <td className={cn(cellClassName, amountClassName)}>{money(line.stamp)}</td>
                <td className={cn(cellClassName, amountClassName)}>{money(line.total)}</td>
              </tr>
            ))}
            <tr>
              <td className={cellClassName}><span className="text-sm font-black text-phx-ink">Total</span></td>
              <td className={cellClassName} />
              <td className={cn(cellClassName, "text-right text-sm font-black tabular-nums text-phx-ink")}>{money(statement.premiumTotal)}</td>
              <td className={cellClassName} />
              <td className={cellClassName} />
              <td className={cn(cellClassName, "text-right text-sm font-black tabular-nums text-phx-ink")}>{money(statement.total)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="space-y-3 p-4 md:hidden">
        {statement.lines.map((line) => (
          <div className="border border-phx-line bg-white p-3" key={line.product}>
            <p className="break-words text-sm font-black text-phx-ink">{line.label}</p>
            <p className="break-words text-phx-xs font-semibold text-phx-ink-soft">{line.people} people, premium {money(line.premium)}, fees and stamp {money(line.fees + line.issueFee + line.stamp)}</p>
            <p className="break-words text-sm font-black tabular-nums text-phx-ink">{egpWords(line.total)}</p>
          </div>
        ))}
        <p className="text-sm font-black tabular-nums text-phx-ink">Total {egpWords(statement.total)}</p>
      </div>

      <div className="space-y-2 border-t border-phx-line p-4">
        {unpriced > 0 ? <p className="break-words text-phx-xs font-bold text-phx-warn">{unpriced === 1 ? "1 person belongs here with no category, so is not priced." : `${unpriced} people belong here with no category, so are not priced.`}</p> : null}
        {prorated > 0 ? <p className="break-words text-phx-xs font-semibold text-phx-ink-soft">{prorated === 1 ? "1 person is here for part of the period, charged by the day." : `${prorated} people are here for part of the period, charged by the day.`} The policy has no clause for this, so charging by the day is an assumption until the insurer confirms.</p> : null}
        <button className={textLinkClassName} onClick={() => setShowPeople((current) => !current)} type="button">
          {showPeople ? "Hide who makes up this figure" : `Show who makes up this figure (${people.length})`}
        </button>
        {showPeople ? (
          <ul className="border-t border-phx-line">
            {people.map((person) => (
              <li className="flex flex-wrap justify-between gap-2 border-b border-phx-line py-2" key={person.key}>
                <div className="min-w-0">
                  <p className="break-words text-phx-xs font-black text-phx-ink" dir="auto">{person.name}</p>
                  <p className="break-words text-phx-xs font-semibold text-phx-ink-soft">{person.category ? `Category ${person.category}` : "Category not decided"}{person.note ? `. ${person.note}` : ""}</p>
                </div>
                <span className="text-phx-xs font-bold tabular-nums text-phx-ink">{person.cost ? money(person.cost.total) : "Not charged"}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </AdminTableShell>
  );
}

function UploadPanel() {
  const { busy, error, save } = useSave();
  const [file, setFile] = React.useState<File | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  function upload() {
    if (!file) return;
    const form = new FormData();
    form.set("file", file);
    void save(
      () => sendForm("/api/medical-insurance/invoices", form),
      () => {
        setFile(null);
        if (inputRef.current) inputRef.current.value = "";
      },
    );
  }

  return (
    <AdminTableShell description="Reads the insurer's PDF, compares it with the plan for its own dates, and files it. It pays nothing and writes nothing to payroll." title="Upload an invoice">
      <div className="flex flex-wrap items-end gap-3 p-4">
        <label className="block w-full sm:w-96">
          <span className={phxLabelClassName}>The insurer&apos;s PDF</span>
          <input accept="application/pdf,.pdf" className={phxFieldClassName} onChange={(event) => setFile(event.target.files?.[0] ?? null)} ref={inputRef} type="file" />
        </label>
        <Button className="h-10 gap-2" disabled={busy || !file} onClick={upload}>
          <Upload className="h-4 w-4" />
          {busy ? "Reading" : "Read and compare"}
        </Button>
      </div>
      <div className="px-4 pb-4"><SaveError error={error} /></div>
    </AdminTableShell>
  );
}

function InvoicePanel({ defaultOpen, invoice }: { defaultOpen: boolean; invoice: MedicalInsuranceInvoiceRow }) {
  const { busy, error, save } = useSave();
  const [open, setOpen] = React.useState(defaultOpen);
  const [status, setStatus] = React.useState<ComparisonStatus | "all" | "problems">("problems");
  const { comparison } = invoice;
  const base = `/api/medical-insurance/invoices/${invoice.id}`;

  const rows = comparison.rows.filter((row) => (status === "all" ? true : status === "problems" ? row.status !== "match" : row.status === status));
  const statuses: ComparisonStatus[] = ["differs", "billed_not_planned", "planned_not_billed", "match"];

  function renderPerson(row: ComparisonRow) {
    return (
      <>
        <p className="break-words text-phx-xs font-black text-phx-ink" dir="auto">{row.name}</p>
        <p className="break-words text-phx-xs font-semibold text-phx-ink-faint">{row.certificate ? `Certificate ${row.certificate}` : "No certificate yet"}{row.category ? `, category ${row.category}` : ""}</p>
        {row.note ? <p className="break-words text-phx-xs font-semibold text-phx-ink-soft" dir="auto">{row.note}</p> : null}
      </>
    );
  }

  return (
    <AdminTableShell
      action={
        <div className="flex flex-wrap gap-2">
          <a className={fileLinkClassName} download href={`${base}/export`}>Export XLSX</a>
          <a className={fileLinkClassName} href={`${base}/file`} rel="noreferrer" target="_blank">Open PDF</a>
          <Button className="h-10" disabled={busy} onClick={() => void save(() => sendJson(`${base}/compare`, "POST"))} variant="secondary">Compare again</Button>
        </div>
      }
      description={`${formatLeftDay(invoice.periodStart)} to ${formatLeftDay(invoice.periodEnd)}${invoice.issuedOn ? `, issued ${formatLeftDay(invoice.issuedOn)}` : ""}. Uploaded ${cairoDateTime(invoice.uploadedAt)}, compared ${cairoDateTime(invoice.comparedAt)}.`}
      title={`Bill ${invoice.billNumber}`}
    >
      <div className="grid grid-cols-1 gap-px border-b border-phx-line bg-phx-line sm:grid-cols-3">
        {[
          { label: "They billed", value: egpWords(comparison.billedTotal) },
          { label: "The plan says", value: egpWords(comparison.plannedTotal) },
          { label: "Difference", value: `${comparison.difference > 0 ? "+" : ""}${egpWords(comparison.difference)}` },
        ].map(({ label, value }) => (
          <div className="bg-white px-4 py-3" key={label}>
            <span className="block text-phx-2xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">{label}</span>
            <span className="mt-1 block break-words text-xl font-black tabular-nums text-phx-ink">{value}</span>
          </div>
        ))}
      </div>

      {comparison.warnings.length > 0 ? (
        <div className="border-b border-phx-line p-4">
          <AdminCallout tone="warning">
            <ul className="list-disc space-y-1 pl-5">
              {comparison.warnings.map((warning) => <li className="break-words text-sm font-semibold" key={warning}>{warning}</li>)}
            </ul>
          </AdminCallout>
        </div>
      ) : null}

      <div className="p-4"><SaveError error={error} /><button className={textLinkClassName} onClick={() => setOpen((current) => !current)} type="button">{open ? "Hide the comparison" : "Show the comparison"}</button></div>

      {open ? (
        <>
          <div className="hidden md:block">
            <table className="w-full table-fixed border-separate border-spacing-0 text-sm">
              <colgroup>
                <col className="w-[28%]" />
                <col className="w-[14%]" />
                <col className="w-[14%]" />
                <col className="w-[15%]" />
                <col className="w-[15%]" />
                <col className="w-[14%]" />
              </colgroup>
              <thead>
                <tr>
                  <th className={headerClassName}>Cover</th>
                  <th className={rightHeaderClassName}>People, plan</th>
                  <th className={rightHeaderClassName}>People, billed</th>
                  <th className={rightHeaderClassName}>Plan</th>
                  <th className={rightHeaderClassName}>Billed</th>
                  <th className={rightHeaderClassName}>Difference</th>
                </tr>
              </thead>
              <tbody>
                {comparison.products.map((row) => (
                  <tr key={row.product}>
                    <td className={cellClassName}><span className="break-words text-phx-xs font-bold text-phx-ink">{row.label}</span></td>
                    <td className={cn(cellClassName, amountClassName)}>{row.plannedPeople}</td>
                    <td className={cn(cellClassName, amountClassName)}>{row.billedPeople}</td>
                    <td className={cn(cellClassName, amountClassName)}>{money(row.plannedTotal)}</td>
                    <td className={cn(cellClassName, amountClassName)}>{money(row.billedTotal)}</td>
                    <td className={cn(cellClassName, amountClassName)}>{signed(row.difference)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="space-y-3 px-4 md:hidden">
            {comparison.products.map((row) => (
              <div className="border border-phx-line bg-white p-3" key={row.product}>
                <p className="break-words text-sm font-black text-phx-ink">{row.label}</p>
                <p className="break-words text-phx-xs font-semibold text-phx-ink-soft">Plan {row.plannedPeople} people, {money(row.plannedTotal)}. Billed {row.billedPeople} people, {money(row.billedTotal)}.</p>
                <p className="text-phx-xs font-black tabular-nums text-phx-ink">Difference {signed(row.difference)}</p>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap gap-2 border-y border-phx-line p-4 md:mt-0">
            <button
              aria-pressed={status === "problems"}
              className={cn("border border-phx-line bg-white px-3 py-2 text-phx-xs font-bold text-phx-ink hover:border-phx-accent", status === "problems" && "border-phx-accent bg-phx-accent-soft")}
              onClick={() => setStatus("problems")}
              type="button"
            >
              Differences ({comparison.rows.length - comparison.counts.match})
            </button>
            {statuses.map((id) => (
              <button
                aria-pressed={status === id}
                className={cn("border border-phx-line bg-white px-3 py-2 text-phx-xs font-bold text-phx-ink hover:border-phx-accent", status === id && "border-phx-accent bg-phx-accent-soft")}
                key={id}
                onClick={() => setStatus(id)}
                type="button"
              >
                {COMPARISON_STATUS_WORDS[id]} ({comparison.counts[id]})
              </button>
            ))}
          </div>

          {rows.length === 0 ? (
            <p className="p-4 text-sm font-semibold text-phx-ink-soft">Nobody in this group.</p>
          ) : (
            <>
              <div className="hidden md:block">
                <table className="w-full table-fixed border-separate border-spacing-0 text-sm">
                  <colgroup>
                    <col className="w-[40%]" />
                    <col className="w-[21%]" />
                    <col className="w-[13%]" />
                    <col className="w-[13%]" />
                    <col className="w-[13%]" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th className={headerClassName}>Certificate holder</th>
                      <th className={headerClassName}>Standing</th>
                      <th className={rightHeaderClassName}>Plan</th>
                      <th className={rightHeaderClassName}>Billed</th>
                      <th className={rightHeaderClassName}>Difference</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.key}>
                        <td className={cellClassName}>{renderPerson(row)}</td>
                        <td className={cellClassName}><span className={cn("break-words text-phx-xs font-bold", STATUS_TONE[row.status])}>{COMPARISON_STATUS_WORDS[row.status]}</span></td>
                        <td className={cn(cellClassName, amountClassName)}>{money(row.plannedTotal)}</td>
                        <td className={cn(cellClassName, amountClassName)}>{money(row.billedTotal)}</td>
                        <td className={cn(cellClassName, amountClassName)}>{signed(row.difference)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="space-y-3 p-4 md:hidden">
                {rows.map((row) => (
                  <div className="space-y-1 border border-phx-line bg-white p-3" key={row.key}>
                    {renderPerson(row)}
                    <p className={cn("break-words text-phx-xs font-bold", STATUS_TONE[row.status])}>{COMPARISON_STATUS_WORDS[row.status]}</p>
                    <p className="break-words text-phx-xs font-bold tabular-nums text-phx-ink">Plan {money(row.plannedTotal)}, billed {money(row.billedTotal)}, difference {signed(row.difference)}</p>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      ) : null}
    </AdminTableShell>
  );
}
