"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, CalendarDays, Download, Eye, FileArchive, IdCard, Loader2, RotateCcw, Users, X } from "lucide-react";

import { AdminCallout, AdminInsightChip, AdminPageHero } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { GroupedComboBox } from "@/components/ui/grouped-combobox";
import type { ComboItem } from "@/components/ui/grouped-combobox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { CARD_FIELD_MAX_LENGTH, EDITABLE_CARD_FIELDS, withDoctorTitle } from "@/lib/business-cards/card-content";
import type { EditableCardField } from "@/lib/business-cards/card-content";
import { cairoDate } from "@/lib/format/cairo-datetime";
import { formatHireDate, hireMonthKey, hireMonthLabel, hireMonthOptions, NO_HIRE_MONTH } from "@/lib/business-cards/hire-month";
import type { BusinessCardEmployee } from "@/lib/business-cards/service";
import { cn } from "@/lib/utils";
import {
  phxLabelClassName,
  phxSelectClassName,
} from "@/components/ui/form-tokens";

// Choose people, correct anything the record has wrong, and download print-ready cards — every card
// in one PDF, or a PDF per person. What each box shows is exactly what the card prints: the values
// come from the same `cardFieldsFor` the server renders with, with the name and mobile the employee
// set on their own page already laid over them, and only corrections travel back.

type Mode = "combined" | "separate";
type Edits = Record<string, Partial<Record<EditableCardField, string>>>;
/** The people whose card prints "Dr." before the name — the toggle on each card. */
type Doctors = Record<string, boolean>;

const FIELD_LABELS: Record<EditableCardField, string> = {
  email: "Email",
  lineArea: "Line · Area",
  mobile: "Mobile",
  name: "Name",
  title: "Job title",
};

// Square edges everywhere — the golden rule — so every control here states `rounded-none`.
const inputClassName = "";
const labelClassName = phxLabelClassName;

function cardsBody(mode: Mode, hrIds: string[], edits: Edits, doctors: Doctors) {
  return { cards: hrIds.map((hrId) => ({ doctor: doctors[hrId] === true, edits: edits[hrId], hrId })), mode };
}

async function postCards(body: object): Promise<Response> {
  const response = await fetch("/api/business-cards", {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(payload?.message ?? "The cards could not be generated. Try again.");
  }
  return response;
}

const DOWNLOAD_FRAME = "business-cards-download";

// A ZIP of separate PDFs is about 2.7 MB per person, so it is never loaded into the page — fetch()
// would hold the whole file in memory before saving it. The server checks the request first, so a
// refusal can still be shown here; then a hidden form posts it into a hidden frame, and the browser
// saves the stream straight to disk as it arrives.
async function streamZip(hrIds: string[], edits: Edits, doctors: Doctors) {
  const body = cardsBody("separate", hrIds, edits, doctors);
  await postCards({ ...body, check: true });

  let frame = document.querySelector<HTMLIFrameElement>(`iframe[name="${DOWNLOAD_FRAME}"]`);
  if (!frame) {
    frame = document.createElement("iframe");
    frame.name = DOWNLOAD_FRAME;
    frame.hidden = true;
    document.body.appendChild(frame);
  }
  const form = document.createElement("form");
  form.method = "POST";
  form.action = "/api/business-cards";
  form.target = DOWNLOAD_FRAME;
  form.hidden = true;
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = "payload";
  input.value = JSON.stringify(body);
  form.appendChild(input);
  document.body.appendChild(form);
  form.submit();
  form.remove();
}

async function requestCards(mode: Mode, hrIds: string[], edits: Edits, doctors: Doctors): Promise<{ blob: Blob; fileName: string }> {
  const response = await postCards(cardsBody(mode, hrIds, edits, doctors));
  const fileName = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "")?.[1] ?? "business-cards.pdf";
  return { blob: await response.blob(), fileName };
}

function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function BusinessCardsManager({
  employees,
  initialError,
  requestsUnread = false,
}: {
  employees: BusinessCardEmployee[];
  initialError: string | null;
  requestsUnread?: boolean;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [edits, setEdits] = useState<Edits>({});
  const [doctors, setDoctors] = useState<Doctors>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(initialError);
  const [notice, setNotice] = useState<string | null>(null);
  const [hireMonth, setHireMonth] = useState("");

  const byId = useMemo(() => new Map(employees.map((employee) => [employee.hrId, employee])), [employees]);
  const monthOptions = useMemo(() => hireMonthOptions(employees), [employees]);

  // Grouped by line, then job title, so a whole district reads as one block in the list. A hiring
  // month narrows the list to the people who joined in it; anyone already chosen stays listed, so
  // the picker's summary still counts them and they can still be taken off.
  const items: ComboItem[] = useMemo(
    () =>
      [...employees]
        .filter((employee) => !hireMonth || hireMonthKey(employee.hireDate) === hireMonth || selected.includes(employee.hrId))
        .sort((a, b) => (a.lineName ?? "~").localeCompare(b.lineName ?? "~") || a.name.localeCompare(b.name))
        .map((employee) => {
          const hired = formatHireDate(employee.hireDate);
          return {
            group: employee.lineName ?? "No line",
            id: employee.hrId,
            name: employee.name,
            search: [employee.hrId, employee.regionName, employee.fields.mobile, employee.fields.email].filter(Boolean).join(" "),
            secondary: [employee.areaName, hired && `Hired ${hired}`].filter(Boolean).join(" · ") || null,
            subgroup: employee.jobTitle,
          };
        }),
    [employees, hireMonth, selected],
  );

  const monthPeople = hireMonth ? employees.filter((employee) => hireMonthKey(employee.hireDate) === hireMonth) : employees;

  const chosen = selected.map((hrId) => byId.get(hrId)).filter((employee): employee is BusinessCardEmployee => Boolean(employee));
  const missingName = chosen.filter((employee) => !(edits[employee.hrId]?.name ?? employee.fields.name));

  function valueOf(employee: BusinessCardEmployee, field: EditableCardField): string {
    return edits[employee.hrId]?.[field] ?? employee.fields[field];
  }

  function setField(employee: BusinessCardEmployee, field: EditableCardField, value: string) {
    setEdits((current) => {
      const person = { ...current[employee.hrId] };
      if (value === employee.fields[field]) delete person[field];
      else person[field] = value;
      const next = { ...current };
      if (Object.keys(person).length) next[employee.hrId] = person;
      else delete next[employee.hrId];
      return next;
    });
  }

  function resetPerson(hrId: string) {
    setEdits((current) => {
      const next = { ...current };
      delete next[hrId];
      return next;
    });
  }

  async function download(mode: Mode, hrIds: string[], key: string) {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      if (mode === "separate" && hrIds.length > 1) {
        await streamZip(hrIds, edits, doctors);
        setNotice(
          `Your browser is saving the ZIP of ${hrIds.length} PDFs as it is built (about ${Math.ceil(hrIds.length * 2.7)} MB) — check your downloads.`,
        );
      } else {
        const { blob, fileName } = await requestCards(mode, hrIds, edits, doctors);
        saveBlob(blob, fileName);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The cards could not be generated. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function preview(hrId: string) {
    // Opened before the request so the browser treats it as the click's own window, not a pop-up.
    const tab = window.open("about:blank", "_blank");
    setBusy(`preview-${hrId}`);
    setError(null);
    try {
      const { blob } = await requestCards("separate", [hrId], edits, doctors);
      const url = URL.createObjectURL(blob);
      if (tab) tab.location.href = url;
      else window.location.assign(url);
      window.setTimeout(() => URL.revokeObjectURL(url), 300_000);
    } catch (caught) {
      tab?.close();
      setError(caught instanceof Error ? caught.message : "The card could not be generated. Try again.");
    } finally {
      setBusy(null);
    }
  }

  const count = chosen.length;
  const blocked = Boolean(busy) || count === 0 || missingName.length > 0;

  return (
    <div className="border border-phx-line bg-phx-paper p-4 sm:p-6">
      <div className="flex flex-col gap-5">
        <AdminPageHero
          badges={
            <>
              <AdminInsightChip tone="orange">{employees.length} on staff</AdminInsightChip>
              <AdminInsightChip>90 × 50 mm · 3 mm bleed · CMYK vector</AdminInsightChip>
            </>
          }
          description="Choose employees, check each card's details, and download print-ready cards: all in one PDF, or a separate PDF for each person."
          eyebrow="Employee documents"
          icon={<IdCard className="h-5 w-5" />}
          title="Business Cards"
        />

        {requestsUnread ? (
          <AdminCallout tone="warning">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              The names and numbers employees set on their own cards could not be read just now, so these cards show the
              record alone. Refresh the page before printing.
            </span>
          </AdminCallout>
        ) : null}

        {error ? (
          <AdminCallout tone="danger">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </AdminCallout>
        ) : null}

        <div className="border border-slate-200/90 bg-white/95 px-4 py-3 shadow-[0_12px_32px_rgba(15,23,42,0.10)] sm:px-5">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <span className="flex items-center gap-2 text-phx-xs font-black uppercase tracking-[0.12em] text-phx-ink-soft">
              <Users className="h-4 w-4 text-phx-accent-press" />
              Employees
            </span>
            {/* On desktop the select takes its widest option's width, so no month label is ever cut off. */}
            <label className="flex min-w-0 items-center gap-2 lg:shrink-0">
              <span className="sr-only">Hiring month</span>
              <CalendarDays aria-hidden className="h-4 w-4 shrink-0 text-phx-accent-press" />
              <select
                aria-label="Filter by hiring month"
                className={cn(phxSelectClassName, "min-w-0 lg:w-auto")}
                onChange={(event) => setHireMonth(event.target.value)}
                value={hireMonth}
              >
                <option value="">Hired in any month</option>
                {monthOptions.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.key === NO_HIRE_MONTH ? option.label : `Hired in ${option.label}`} ({option.count})
                  </option>
                ))}
              </select>
            </label>
            <div className="min-w-0 flex-1">
              <GroupedComboBox
                ariaLabel="Choose employees for business cards"
                emptyLabel="Nobody matches"
                hint="line · job title · area"
                items={items}
                multiple
                onChange={setSelected}
                panelId="business-cards-picker-panel"
                placeholder="Type a name, line, area, title or mobile"
                summaryNoun="employees"
                value={selected}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                className="h-10 rounded-none"
                disabled={monthPeople.length === 0}
                onClick={() => setSelected((current) => [...new Set([...current, ...monthPeople.map((employee) => employee.hrId)])])}
                type="button"
                variant="outline"
              >
                {hireMonth ? `Everyone hired in ${hireMonthLabel(hireMonth)} (${monthPeople.length})` : "Everyone"}
              </Button>
              <Button className="h-10 rounded-none" disabled={count === 0} onClick={() => setSelected([])} type="button" variant="ghost">
                Clear
              </Button>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3 border border-slate-200/90 bg-white/95 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-phx-ink-soft">
              {count === 0 ? "No employees chosen yet." : `${count} ${count === 1 ? "card" : "cards"} · front and back each`}
            </p>
            {notice ? (
              <p className="mt-1 text-xs font-semibold text-phx-accent-press" role="status">
                {notice}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button className="h-10 rounded-none" disabled={blocked} onClick={() => void download("combined", selected, "combined")} type="button">
              {busy === "combined" ? <Loader2 className="animate-spin" /> : <Download />}
              All in one PDF
            </Button>
            <Button
              className="h-10 rounded-none"
              disabled={blocked}
              onClick={() => void download("separate", selected, "separate")}
              type="button"
              variant="outline"
            >
              {busy === "separate" ? <Loader2 className="animate-spin" /> : <FileArchive />}
              {count > 1 ? "Separate PDFs (ZIP)" : "Separate PDF"}
            </Button>
          </div>
        </div>

        {missingName.length ? (
          <AdminCallout tone="warning">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Every card needs a name. Fill in the name for {missingName.map((employee) => employee.name).join(", ")}.</span>
          </AdminCallout>
        ) : null}

        {count === 0 ? (
          <div className="border border-dashed border-phx-line bg-white/70 px-5 py-10 text-center text-sm font-semibold text-phx-ink-soft">
            Choose one or more employees above. Each card appears here with the details it will print, and you can
            correct any line before downloading.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {chosen.map((employee) => {
              const edited = Boolean(edits[employee.hrId]);
              const mobile = valueOf(employee, "mobile");
              // A blanked email box never blanks the card — the server keeps the card's own address.
              const email = valueOf(employee, "email") || employee.fields.email;
              return (
                <section className="border border-slate-200/90 bg-white p-4 shadow-[0_12px_32px_rgba(15,23,42,0.06)] sm:p-5" key={employee.hrId}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="text-sm font-black text-phx-ink">{employee.name}</h2>
                      <p className="mt-0.5 text-xs font-semibold text-phx-ink-soft">
                        {[
                          employee.jobTitle,
                          employee.lineName,
                          employee.areaName,
                          employee.hireDate ? `Hired ${formatHireDate(employee.hireDate)}` : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                      {employee.requested ? (
                        <p className="mt-0.5 text-xs font-semibold text-phx-accent-press">
                          Name and mobile as {employee.name} set them on their own card, {cairoDate(employee.requested.createdAt)} ·{" "}
                          {employee.requested.status}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="flex items-center gap-2 text-xs font-bold text-phx-ink-soft">
                        <Switch
                          checked={doctors[employee.hrId] === true}
                          label={`Print Dr. before ${employee.name}'s name`}
                          onChange={(on) => setDoctors((current) => ({ ...current, [employee.hrId]: on }))}
                        />
                        Dr.
                      </label>
                      {edited ? (
                        <Button className="rounded-none" onClick={() => resetPerson(employee.hrId)} size="sm" type="button" variant="ghost">
                          <RotateCcw />
                          {employee.requested ? "Use their card" : "Use the record"}
                        </Button>
                      ) : null}
                      <Button
                        className="rounded-none"
                        disabled={Boolean(busy) || !valueOf(employee, "name")}
                        onClick={() => void preview(employee.hrId)}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        {busy === `preview-${employee.hrId}` ? <Loader2 className="animate-spin" /> : <Eye />}
                        Preview
                      </Button>
                      <Button
                        className="rounded-none"
                        disabled={Boolean(busy) || !valueOf(employee, "name")}
                        onClick={() => void download("separate", [employee.hrId], `one-${employee.hrId}`)}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        {busy === `one-${employee.hrId}` ? <Loader2 className="animate-spin" /> : <Download />}
                        PDF
                      </Button>
                      <Button
                        aria-label={`Remove ${employee.name}`}
                        className="rounded-none"
                        onClick={() => setSelected((current) => current.filter((hrId) => hrId !== employee.hrId))}
                        size="icon-sm"
                        type="button"
                        variant="ghost"
                      >
                        <X />
                      </Button>
                    </div>
                  </div>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                    {EDITABLE_CARD_FIELDS.map((field) => {
                      const id = `business-card-${employee.hrId}-${field}`;
                      return (
                        <div className={cn("min-w-0", field === "email" && "sm:col-span-2 xl:col-span-1")} key={field}>
                          <label className={labelClassName} htmlFor={id}>
                            {FIELD_LABELS[field]}
                          </label>
                          <Input
                            className={inputClassName}
                            id={id}
                            maxLength={CARD_FIELD_MAX_LENGTH}
                            onChange={(event) => setField(employee, field, event.target.value)}
                            placeholder={field === "name" ? "Required" : field === "email" ? "Always printed" : "Left off the card"}
                            value={valueOf(employee, field)}
                          />
                        </div>
                      );
                    })}
                  </div>
                  {doctors[employee.hrId] && valueOf(employee, "name") ? (
                    <p className="mt-2 text-xs font-semibold text-phx-accent-press">
                      The card prints: {withDoctorTitle(valueOf(employee, "name"))}
                    </p>
                  ) : null}
                  {!mobile || !email ? (
                    <p className="mt-2 text-xs font-semibold text-amber-800">
                      {!mobile && !email ? "No mobile and no email" : !mobile ? "No mobile" : "No email"} — that line and its icon
                      are left off, and the lines below move up.
                    </p>
                  ) : null}
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
