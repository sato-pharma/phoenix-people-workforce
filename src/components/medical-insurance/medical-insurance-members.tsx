"use client";

import { Download, Search } from "lucide-react";
import * as React from "react";

import { AdminTableShell } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { phxFieldClassName, phxFieldGridTwoClassName, phxLabelClassName, phxSelectClassName } from "@/components/ui/form-tokens";
import { rowDetailToggleProps, TableRowDetail } from "@/components/ui/table-row-detail";
import { formatLeftDay } from "@/lib/employees/left-flag";
import { MEDICAL_INSURANCE_CATEGORIES } from "@/lib/medical-insurance/cost";
import { coveragePeriodWords, MEMBER_TYPE_WORDS, type MedicalInsuranceMemberRow, type MedicalInsuranceView } from "@/lib/medical-insurance/view";
import { cn } from "@/lib/utils";

import { cellClassName, fileLinkClassName, headerClassName, SaveError, sendJson, textLinkClassName, useSave } from "./medical-insurance-parts";

type Props = { canCreate: boolean; canEdit: boolean; canExport: boolean; view: MedicalInsuranceView };
type Standing = "all" | "ended" | "open";
type Mode = "edit" | "end";

const STANDINGS: Array<{ id: Standing; label: string }> = [
  { id: "open", label: "On cover" },
  { id: "ended", label: "Cover ended" },
  { id: "all", label: "Everyone" },
];

function matches(member: MedicalInsuranceMemberRow, query: string): boolean {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return true;
  return [member.name, member.certificateNumber, member.jobTitle, member.principalName].some((value) => String(value ?? "").toLowerCase().includes(wanted));
}

export function MedicalInsuranceMembersTab({ canCreate, canEdit, canExport, view }: Props) {
  const [standing, setStanding] = React.useState<Standing>("open");
  const [query, setQuery] = React.useState("");
  const [open, setOpen] = React.useState<{ id: string; mode: Mode } | null>(null);
  const reinstate = useSave();

  const visible = view.members
    .filter((member) => (standing === "all" || (standing === "open") === member.open) && matches(member, query))
    .sort((a, b) => a.name.localeCompare(b.name));

  function toggle(id: string, mode: Mode) {
    setOpen((current) => (current?.id === id && current.mode === mode ? null : { id, mode }));
  }

  function renderPerson(member: MedicalInsuranceMemberRow) {
    return (
      <>
        <p className="break-words text-sm font-black text-phx-ink" dir="auto">{member.name}</p>
        {member.jobTitle ? <p className="mt-0.5 break-words text-phx-xs font-semibold text-phx-ink-soft">{member.jobTitle}</p> : null}
        {member.memberType === "employee" ? null : (
          <p className="break-words text-phx-xs font-semibold text-phx-ink-soft" dir="auto">{MEMBER_TYPE_WORDS[member.memberType]} of {member.principalName ?? "name not on record"}</p>
        )}
        {member.memberType === "employee" && !member.hrId ? <p className="break-words text-phx-xs font-semibold text-phx-warn">No Phoenix employee record</p> : null}
      </>
    );
  }

  function renderCover(member: MedicalInsuranceMemberRow) {
    return (
      <>
        <p className="break-words text-phx-xs font-bold text-phx-ink">{coveragePeriodWords(member.coverageStart, member.coverageEnd, formatLeftDay)}</p>
        {member.endReason ? <p className="break-words text-phx-xs font-semibold text-phx-ink-soft" dir="auto">{member.endReason}</p> : null}
        {member.notes ? <p className="break-words text-phx-xs font-semibold text-phx-ink-faint" dir="auto">{member.notes}</p> : null}
      </>
    );
  }

  function renderActions(member: MedicalInsuranceMemberRow) {
    if (!canEdit) return null;
    return (
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        <button className={textLinkClassName} onClick={() => toggle(member.id, "edit")} type="button">Edit</button>
        {member.coverageEnd ? (
          <button
            className={textLinkClassName}
            disabled={reinstate.busy}
            onClick={() => void reinstate.save(() => sendJson(`/api/medical-insurance/members/${member.id}`, "PATCH", { action: "reinstate" }))}
            type="button"
          >
            Put back
          </button>
        ) : (
          <button className={textLinkClassName} onClick={() => toggle(member.id, "end")} type="button">End cover</button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <AdminTableShell
        action={
          <div className="flex w-full flex-wrap items-end gap-2 sm:w-auto">
            <div className="w-full sm:w-64">
              <label className={phxLabelClassName} htmlFor="medical-insurance-search">Search</label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-phx-ink-soft" />
                <input className={cn(phxFieldClassName, "pl-9")} id="medical-insurance-search" onChange={(event) => setQuery(event.target.value)} placeholder="Name, certificate or job" type="search" value={query} />
              </div>
            </div>
            {canExport ? (
              <a className={cn(fileLinkClassName, "gap-2")} download href="/api/medical-insurance/members/export">
                <Download className="h-4 w-4" />
                Export
              </a>
            ) : null}
          </div>
        }
        description="Everyone on the register. A row is never deleted: cover is ended, with its reason, and can be put back."
        title="Members"
      >
        <div className="flex flex-wrap gap-2 border-b border-phx-line p-4">
          {STANDINGS.map(({ id, label }) => (
            <button
              aria-pressed={standing === id}
              className={cn("border border-phx-line bg-white px-3 py-2 text-phx-xs font-bold text-phx-ink hover:border-phx-accent", standing === id && "border-phx-accent bg-phx-accent-soft")}
              key={id}
              onClick={() => setStanding(id)}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
        <SaveError error={reinstate.error} />

        {visible.length === 0 ? (
          <p className="p-4 text-sm font-semibold text-phx-ink-soft">{view.members.length === 0 ? "Nobody is on the register yet." : "Nobody matches this search."}</p>
        ) : (
          <>
            <div className="hidden md:block">
              <table className="w-full table-fixed border-separate border-spacing-0 text-sm">
                <colgroup>
                  <col className="w-[34%]" />
                  <col className="w-[11%]" />
                  <col className="w-[13%]" />
                  <col className="w-[27%]" />
                  <col className="w-[15%]" />
                </colgroup>
                <thead>
                  <tr>
                    <th className={headerClassName}>Person</th>
                    <th className={headerClassName}>Category</th>
                    <th className={headerClassName}>Certificate</th>
                    <th className={headerClassName}>Cover</th>
                    <th className={headerClassName}><span className="sr-only">Change</span></th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((member) => (
                    <React.Fragment key={member.id}>
                      <tr {...rowDetailToggleProps(`medical-insurance-${member.id}`, open?.id === member.id)}>
                        <td className={cellClassName}>{renderPerson(member)}</td>
                        <td className={cellClassName}><span className="text-phx-xs font-bold text-phx-ink">{member.category}</span></td>
                        <td className={cellClassName}><span className="break-words text-phx-xs font-bold text-phx-ink">{member.certificateNumber ?? "Not yet given"}</span></td>
                        <td className={cellClassName}>{renderCover(member)}</td>
                        <td className={cellClassName}>{renderActions(member)}</td>
                      </tr>
                      {open?.id === member.id ? (
                        <TableRowDetail colSpan={5} id={`medical-insurance-${member.id}`}>
                          <MemberForm member={member} mode={open.mode} onDone={() => setOpen(null)} />
                        </TableRowDetail>
                      ) : null}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="space-y-3 p-4 md:hidden">
              {visible.map((member) => (
                <div className="space-y-2 border border-phx-line bg-white p-4" key={member.id}>
                  {renderPerson(member)}
                  <p className="break-words text-phx-xs font-bold text-phx-ink">Category {member.category}, certificate {member.certificateNumber ?? "not yet given"}</p>
                  {renderCover(member)}
                  {renderActions(member)}
                  {open?.id === member.id ? <MemberForm member={member} mode={open.mode} onDone={() => setOpen(null)} /> : null}
                </div>
              ))}
            </div>
          </>
        )}
      </AdminTableShell>

      {canCreate ? <AddMemberPanel view={view} /> : null}
    </div>
  );
}

function MemberForm({ member, mode, onDone }: { member: MedicalInsuranceMemberRow; mode: Mode; onDone: () => void }) {
  const { busy, error, save } = useSave();
  const [category, setCategory] = React.useState<string>(member.category);
  const [certificate, setCertificate] = React.useState(member.certificateNumber ?? "");
  const [start, setStart] = React.useState(member.coverageStart);
  const [notes, setNotes] = React.useState(member.notes ?? "");
  const [end, setEnd] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [keepOut, setKeepOut] = React.useState(false);
  const url = `/api/medical-insurance/members/${member.id}`;

  if (mode === "end") {
    return (
      <div className="space-y-3">
        <div className={phxFieldGridTwoClassName}>
          <label className="block">
            <span className={phxLabelClassName}>Cover ends</span>
            <input className={phxFieldClassName} onChange={(event) => setEnd(event.target.value)} type="date" value={end} />
          </label>
          <label className="block">
            <span className={phxLabelClassName}>Reason</span>
            <input className={phxFieldClassName} onChange={(event) => setReason(event.target.value)} value={reason} />
          </label>
        </div>
        {member.memberType === "employee" ? <p className="text-phx-xs font-semibold text-phx-ink-soft">Their spouse and children on the policy end on the same day.</p> : null}
        {member.memberType === "employee" && member.hrId ? (
          <label className="flex items-center gap-2 text-phx-xs font-bold text-phx-ink">
            <input checked={keepOut} className="h-4 w-4 accent-orange-600" onChange={(event) => setKeepOut(event.target.checked)} type="checkbox" />
            Also keep them off the policy, so the rule does not ask to add them again
          </label>
        ) : null}
        <SaveError error={error} />
        <Button className="h-10" disabled={busy} onClick={() => void save(() => sendJson(url, "PATCH", { action: "end", coverageEnd: end, endReason: reason, keepOut }), onDone)}>End cover</Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className={phxFieldGridTwoClassName}>
        <label className="block">
          <span className={phxLabelClassName}>Category</span>
          <select className={phxSelectClassName} onChange={(event) => setCategory(event.target.value)} value={category}>
            {MEDICAL_INSURANCE_CATEGORIES.map((value) => <option key={value} value={value}>Category {value}</option>)}
          </select>
        </label>
        <label className="block">
          <span className={phxLabelClassName}>Certificate number</span>
          <input className={phxFieldClassName} onChange={(event) => setCertificate(event.target.value)} value={certificate} />
        </label>
        <label className="block">
          <span className={phxLabelClassName}>Cover starts</span>
          <input className={phxFieldClassName} onChange={(event) => setStart(event.target.value)} type="date" value={start} />
        </label>
        <label className="block">
          <span className={phxLabelClassName}>Notes</span>
          <input className={phxFieldClassName} onChange={(event) => setNotes(event.target.value)} value={notes} />
        </label>
      </div>
      <SaveError error={error} />
      <Button className="h-10" disabled={busy} onClick={() => void save(() => sendJson(url, "PATCH", { category, certificateNumber: certificate, coverageStart: start, notes }), onDone)}>Save</Button>
    </div>
  );
}

type NewKind = "child" | "employee" | "no_record" | "spouse";

const NEW_KINDS: Array<{ id: NewKind; label: string }> = [
  { id: "employee", label: "An employee" },
  { id: "spouse", label: "A spouse" },
  { id: "child", label: "A child" },
  { id: "no_record", label: "Someone with no Phoenix record" },
];

function AddMemberPanel({ view }: { view: MedicalInsuranceView }) {
  const { busy, error, save } = useSave();
  const blank = { birthDate: "", category: "", certificate: "", gender: "", hrId: "", name: "", nationalId: "", notes: "", principal: "", start: view.asOf > view.policy.startsOn ? view.asOf : view.policy.startsOn };
  const [kind, setKind] = React.useState<NewKind>("employee");
  const [fields, setFields] = React.useState(blank);
  const set = (key: keyof typeof blank) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setFields((current) => ({ ...current, [key]: event.target.value }));
  const family = kind === "spouse" || kind === "child";

  const onRegister = new Set(view.members.filter((member) => member.open && member.hrId && member.memberType === "employee").map((member) => member.hrId));
  const employeesToAdd = view.employees.filter((employee) => !onRegister.has(employee.hrId));
  const principals = view.members.filter((member) => member.open && member.memberType === "employee").sort((a, b) => a.name.localeCompare(b.name));

  function add() {
    void save(
      () =>
        sendJson("/api/medical-insurance/members", "POST", {
          birthDate: fields.birthDate,
          category: fields.category || undefined,
          certificateNumber: fields.certificate,
          coverageStart: fields.start,
          fullName: fields.name,
          gender: fields.gender,
          hrId: kind === "employee" ? fields.hrId : undefined,
          memberType: family ? kind : "employee",
          nationalId: fields.nationalId,
          notes: fields.notes,
          principalMemberId: family ? fields.principal : undefined,
        }),
      () => setFields(blank),
    );
  }

  return (
    <AdminTableShell description="Puts someone on the register. Family sit under the employee's certificate and take their category unless you choose another." title="Add someone">
      <div className="space-y-3 p-4">
        <div className={phxFieldGridTwoClassName}>
          <label className="block">
            <span className={phxLabelClassName}>Who</span>
            <select className={phxSelectClassName} onChange={(event) => setKind(event.target.value as NewKind)} value={kind}>
              {NEW_KINDS.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
            </select>
          </label>
          {kind === "employee" ? (
            <label className="block">
              <span className={phxLabelClassName}>Employee</span>
              <select className={phxSelectClassName} onChange={set("hrId")} value={fields.hrId}>
                <option value="">Choose</option>
                {employeesToAdd.map((employee) => <option key={employee.hrId} value={employee.hrId}>{employee.name}</option>)}
              </select>
            </label>
          ) : (
            <label className="block">
              <span className={phxLabelClassName}>Full name</span>
              <input className={phxFieldClassName} onChange={set("name")} value={fields.name} />
            </label>
          )}
          {family ? (
            <label className="block">
              <span className={phxLabelClassName}>Under which employee</span>
              <select className={phxSelectClassName} onChange={set("principal")} value={fields.principal}>
                <option value="">Choose</option>
                {principals.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
              </select>
            </label>
          ) : null}
          <label className="block">
            <span className={phxLabelClassName}>Category</span>
            <select className={phxSelectClassName} onChange={set("category")} value={fields.category}>
              <option value="">{family ? "Same as the employee" : "Choose"}</option>
              {MEDICAL_INSURANCE_CATEGORIES.map((value) => <option key={value} value={value}>Category {value}</option>)}
            </select>
          </label>
          <label className="block">
            <span className={phxLabelClassName}>Cover starts</span>
            <input className={phxFieldClassName} onChange={set("start")} type="date" value={fields.start} />
          </label>
          {family ? null : (
            <label className="block">
              <span className={phxLabelClassName}>Certificate number, once the insurer gives one</span>
              <input className={phxFieldClassName} onChange={set("certificate")} value={fields.certificate} />
            </label>
          )}
          {family ? (
            <>
              <label className="block">
                <span className={phxLabelClassName}>Date of birth</span>
                <input className={phxFieldClassName} onChange={set("birthDate")} type="date" value={fields.birthDate} />
              </label>
              <label className="block">
                <span className={phxLabelClassName}>Sex</span>
                <select className={phxSelectClassName} onChange={set("gender")} value={fields.gender}>
                  <option value="">Choose</option>
                  <option value="F">Female</option>
                  <option value="M">Male</option>
                </select>
              </label>
              <label className="block">
                <span className={phxLabelClassName}>National ID</span>
                <input className={phxFieldClassName} onChange={set("nationalId")} value={fields.nationalId} />
              </label>
            </>
          ) : null}
          <label className="block">
            <span className={phxLabelClassName}>Notes</span>
            <input className={phxFieldClassName} onChange={set("notes")} value={fields.notes} />
          </label>
        </div>
        <SaveError error={error} />
        <Button className="h-10" disabled={busy} onClick={add}>Add to the register</Button>
      </div>
    </AdminTableShell>
  );
}
