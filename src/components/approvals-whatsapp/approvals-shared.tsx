"use client";

// Approvals WhatsApp — the parts the Bulk send and Lists tabs share: the employee picker with its filters, the pasted
// numbers box, and the small flat pieces every tab draws with.
//
// Recipients come from the employee master or are pasted (owner, 19 Nov 2026: "Phoenix people + pasted"). The picker
// reads the master once and filters on the screen — department, manager, area or region, job title and whether the
// person is still employed — so changing a filter never waits on the server.

import { useMemo, useState } from "react";

import { Action } from "@/components/recruitment/workstation/workstation-look";
import { phxCheckInputClassName, phxFieldClassName, phxLabelClassName, phxSelectClassName, phxTextareaClassName } from "@/components/ui/form-tokens";
import { parsePastedNumbers, formatApprovalsPhone } from "@/lib/approvals-whatsapp/rules";
import { cn } from "@/lib/utils";

export const APPROVALS_API = "/api/admin/approvals-whatsapp";

export type ApprovalsEmployeeOption = {
  active: boolean;
  area: string | null;
  department: string | null;
  hrId: string;
  jobTitle: string | null;
  managerHrId: string | null;
  managerName: string | null;
  name: string;
  phone: string | null;
  region: string | null;
  waId: string | null;
};

export type RecipientChoice = { employeeHrIds: string[]; pasted: string };

/** A flat section on the page: a hairline box, a title line and its body. No shadow, no gradient, square. */
export function Panel({ children, className, title, aside }: { children: React.ReactNode; className?: string; title?: string; aside?: React.ReactNode }) {
  return (
    <section className={cn("border border-phx-line bg-white", className)}>
      {title ? (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-phx-line px-3 py-2 sm:px-4">
          <h2 className="text-[11px] font-black uppercase tracking-[0.14em] text-phx-ink-2">{title}</h2>
          {aside}
        </header>
      ) : null}
      <div className="p-3 sm:p-4">{children}</div>
    </section>
  );
}

/** One number with its label, flat. A count that could not be read says so; it is never a zero nobody read. */
export function Figure({ label, value, tone = "plain" }: { label: string; value: number | string | null; tone?: "plain" | "good" | "bad" | "warn" }) {
  return (
    <div className="flex min-w-[6.5rem] flex-col gap-1 border border-phx-line bg-white px-3 py-2">
      <span className="text-[10px] font-black uppercase leading-tight tracking-[0.14em] text-phx-ink-faint">{label}</span>
      {value === null ? (
        <span className="text-[12px] font-bold text-phx-ink-soft">Not available</span>
      ) : (
        <span
          className={cn(
            "text-[18px] font-black leading-none tabular-nums",
            tone === "good" ? "text-phx-ok" : tone === "bad" ? "text-phx-danger" : tone === "warn" ? "text-phx-warn" : "text-phx-ink",
          )}
        >
          {value}
        </span>
      )}
    </div>
  );
}

export function Notice({ children, tone = "quiet" }: { children: React.ReactNode; tone?: "quiet" | "warn" | "good" }) {
  return (
    <p
      className={cn(
        "border-l-[3px] px-3 py-2 text-[12px] leading-snug",
        tone === "warn" ? "border-l-phx-warn bg-phx-warn-bg text-phx-ink" : tone === "good" ? "border-l-phx-ok bg-phx-ok-bg text-phx-ink" : "border-l-phx-line-strong bg-phx-surface-2 text-phx-ink-2",
      )}
    >
      {children}
    </p>
  );
}

/** "+20 10 1234 5678" for a waId, or the waId itself. */
export function phoneText(waId: string | null | undefined): string {
  return formatApprovalsPhone(waId) ?? (waId ? `+${waId}` : "");
}

const ALL = "";

function uniqueSorted(values: Array<string | null>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value && value.trim())))).sort((a, b) => a.localeCompare(b));
}

/**
 * Pick employees by filter, tick or untick them one by one, and paste numbers. The parent owns the choice; this only
 * draws it. Pasted numbers are checked here as they are typed — invalid and duplicate ones are named — and the server
 * checks them again before anything is sent.
 */
export function RecipientPicker({
  choice,
  employees,
  onChange,
}: {
  choice: RecipientChoice;
  employees: ApprovalsEmployeeOption[];
  onChange: (next: RecipientChoice) => void;
}) {
  const [department, setDepartment] = useState(ALL);
  const [manager, setManager] = useState(ALL);
  const [place, setPlace] = useState(ALL);
  const [jobTitle, setJobTitle] = useState(ALL);
  const [status, setStatus] = useState<"active" | "all" | "left">("active");
  const [search, setSearch] = useState("");

  const departments = useMemo(() => uniqueSorted(employees.map((employee) => employee.department)), [employees]);
  const managers = useMemo(
    () =>
      Array.from(new Map(employees.filter((employee) => employee.managerHrId && employee.managerName).map((employee) => [employee.managerHrId!, employee.managerName!])).entries()).sort((a, b) =>
        a[1].localeCompare(b[1]),
      ),
    [employees],
  );
  const places = useMemo(() => uniqueSorted(employees.flatMap((employee) => [employee.region, employee.area])), [employees]);
  const jobTitles = useMemo(() => uniqueSorted(employees.map((employee) => employee.jobTitle)), [employees]);

  const term = search.trim().toLowerCase();
  const termDigits = term.replace(/\D+/g, "");
  const matching = useMemo(
    () =>
      employees.filter((employee) => {
        if (status === "active" && !employee.active) return false;
        if (status === "left" && employee.active) return false;
        if (department && employee.department !== department) return false;
        if (manager && employee.managerHrId !== manager) return false;
        if (place && employee.area !== place && employee.region !== place) return false;
        if (jobTitle && employee.jobTitle !== jobTitle) return false;
        if (term) {
          const byName = employee.name.toLowerCase().includes(term);
          const byNumber = termDigits.length >= 3 && (employee.waId ?? "").includes(termDigits.replace(/^0/, ""));
          if (!byName && !byNumber) return false;
        }
        return true;
      }),
    [department, employees, jobTitle, manager, place, status, term, termDigits],
  );

  const chosen = useMemo(() => new Set(choice.employeeHrIds), [choice.employeeHrIds]);
  const chosenWaIds = useMemo(() => employees.filter((employee) => chosen.has(employee.hrId) && employee.waId).map((employee) => employee.waId!), [chosen, employees]);
  const pasted = useMemo(() => parsePastedNumbers(choice.pasted, chosenWaIds), [choice.pasted, chosenWaIds]);
  const chosenWithoutNumber = employees.filter((employee) => chosen.has(employee.hrId) && !employee.waId).length;
  const matchingWithNumber = matching.filter((employee) => employee.waId);

  function setChosen(next: Set<string>) {
    onChange({ ...choice, employeeHrIds: Array.from(next) });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <label className="flex flex-col">
          <span className={phxLabelClassName}>Department</span>
          <select className={phxSelectClassName} onChange={(event) => setDepartment(event.target.value)} value={department}>
            <option value={ALL}>Every department</option>
            {departments.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col">
          <span className={phxLabelClassName}>Manager</span>
          <select className={phxSelectClassName} onChange={(event) => setManager(event.target.value)} value={manager}>
            <option value={ALL}>Every manager</option>
            {managers.map(([hrId, name]) => (
              <option key={hrId} value={hrId}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col">
          <span className={phxLabelClassName}>Region or area</span>
          <select className={phxSelectClassName} onChange={(event) => setPlace(event.target.value)} value={place}>
            <option value={ALL}>Everywhere</option>
            {places.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col">
          <span className={phxLabelClassName}>Job title</span>
          <select className={phxSelectClassName} onChange={(event) => setJobTitle(event.target.value)} value={jobTitle}>
            <option value={ALL}>Every job title</option>
            {jobTitles.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col">
          <span className={phxLabelClassName}>Employment</span>
          <select className={phxSelectClassName} onChange={(event) => setStatus(event.target.value as typeof status)} value={status}>
            <option value="active">Still employed</option>
            <option value="left">Left the company</option>
            <option value="all">Everyone</option>
          </select>
        </label>
        <label className="flex flex-col">
          <span className={phxLabelClassName}>Name or number</span>
          <input className={phxFieldClassName} dir="auto" onChange={(event) => setSearch(event.target.value)} placeholder="Type to narrow the list" value={search} />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[12px] text-phx-ink-2">
        <span>
          <strong className="tabular-nums">{matching.length}</strong> match, <strong className="tabular-nums">{matchingWithNumber.length}</strong> with a WhatsApp number on file.
        </span>
        <Action
          disabled={matchingWithNumber.length === 0}
          onClick={() => setChosen(new Set([...chosen, ...matchingWithNumber.map((employee) => employee.hrId)]))}
          tone="quiet"
        >
          Add all that match
        </Action>
        <Action disabled={matching.length === 0} onClick={() => setChosen(new Set([...chosen].filter((hrId) => !matching.some((employee) => employee.hrId === hrId))))} tone="ghost">
          Remove all that match
        </Action>
        <Action disabled={chosen.size === 0} onClick={() => setChosen(new Set())} tone="ghost">
          Clear the choice
        </Action>
      </div>

      <ul className="max-h-80 overflow-y-auto overflow-x-hidden border border-phx-line">
        {matching.length === 0 ? <li className="px-3 py-3 text-[12px] text-phx-ink-soft">Nobody matches these filters.</li> : null}
        {matching.map((employee) => (
          <li className="border-b border-phx-line last:border-b-0" key={employee.hrId}>
            <label className={cn("flex cursor-pointer items-start gap-3 px-3 py-2", !employee.waId && "cursor-not-allowed opacity-60")}>
              <input
                checked={chosen.has(employee.hrId)}
                className={cn(phxCheckInputClassName, "mt-0.5")}
                disabled={!employee.waId && !chosen.has(employee.hrId)}
                onChange={(event) => {
                  const next = new Set(chosen);
                  if (event.target.checked) next.add(employee.hrId);
                  else next.delete(employee.hrId);
                  setChosen(next);
                }}
                type="checkbox"
              />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="break-words text-[13px] font-bold text-phx-ink" dir="auto">
                  {employee.name}
                  {!employee.active ? <span className="ml-2 text-[11px] font-semibold text-phx-ink-soft">Left the company</span> : null}
                </span>
                <span className="break-words text-[11px] text-phx-ink-soft">
                  {[employee.jobTitle, employee.department, employee.area ?? employee.region].filter(Boolean).join(" · ")}
                </span>
              </span>
              <span className="shrink-0 text-[11px] tabular-nums text-phx-ink-2" dir="ltr">
                {employee.phone ?? "No number on file"}
              </span>
            </label>
          </li>
        ))}
      </ul>

      <label className="flex flex-col">
        <span className={phxLabelClassName}>Pasted numbers — one per line, or separated by commas</span>
        <textarea
          className={phxTextareaClassName}
          dir="ltr"
          onChange={(event) => onChange({ ...choice, pasted: event.target.value })}
          placeholder={"01012345678\n+20 11 2345 6789"}
          rows={4}
          value={choice.pasted}
        />
      </label>

      <div className="flex flex-col gap-1.5 text-[12px] text-phx-ink-2">
        <span>
          Chosen: <strong className="tabular-nums">{chosen.size}</strong> from the employee list, <strong className="tabular-nums">{pasted.valid.length}</strong> pasted.
        </span>
        {chosenWithoutNumber > 0 ? <Notice tone="warn">{chosenWithoutNumber} chosen people have no WhatsApp number on file and will be skipped.</Notice> : null}
        {pasted.invalid.length > 0 ? (
          <Notice tone="warn">
            Skipped, not a usable number: {pasted.invalid.map((item) => item.text).join(", ")}
          </Notice>
        ) : null}
        {pasted.duplicates.length > 0 ? (
          <Notice>Skipped, already in the choice: {pasted.duplicates.map((waId) => phoneText(waId)).join(", ")}</Notice>
        ) : null}
      </div>
    </div>
  );
}
