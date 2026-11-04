"use client";

import { Download } from "lucide-react";
import * as React from "react";

import { AdminTableShell } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { phxFieldClassName, phxFieldGridTwoClassName, phxLabelClassName, phxSelectClassName } from "@/components/ui/form-tokens";
import { rowDetailToggleProps, TableRowDetail } from "@/components/ui/table-row-detail";
import { formatLeftDay } from "@/lib/employees/left-flag";
import { MEDICAL_INSURANCE_CATEGORIES, type MedicalInsuranceCategory } from "@/lib/medical-insurance/cost";
import type { MedicalInsuranceAction, MedicalInsuranceActionKind } from "@/lib/medical-insurance/eligibility";
import type { MedicalInsuranceView } from "@/lib/medical-insurance/view";
import { cn } from "@/lib/utils";

import { cellClassName, downloadPosted, headerClassName, SaveError, sendJson, textLinkClassName, useSave } from "./medical-insurance-parts";

type Props = { canCreate: boolean; canEdit: boolean; canExport: boolean; view: MedicalInsuranceView };

const KIND_WORDS: Record<MedicalInsuranceActionKind, string> = { add: "Add", remove: "Remove", review: "Check" };
const KIND_TONE: Record<MedicalInsuranceActionKind, string> = { add: "text-phx-ok", remove: "text-phx-warn", review: "text-phx-ink-soft" };
const FILTERS: Array<{ id: MedicalInsuranceActionKind | "all"; label: string }> = [
  { id: "all", label: "Everyone" },
  { id: "add", label: "To add" },
  { id: "remove", label: "To remove" },
  { id: "review", label: "To check" },
];
const EDI_URL = "/api/medical-insurance/movement-file";
const toolButtonClassName = "border border-phx-line bg-white px-3 py-2 text-phx-xs font-bold text-phx-ink hover:border-phx-accent disabled:opacity-50";

function timingWords(action: MedicalInsuranceAction): string {
  const day = formatLeftDay(action.effectiveOn);
  if (action.timing === "soon") return `Coming up, ${day}`;
  return action.kind === "add" ? `Should have started ${day}` : day;
}

function canTick(action: MedicalInsuranceAction): boolean {
  return action.kind === "add" || action.kind === "remove";
}

export function MedicalInsuranceActionsTab({ canCreate, canEdit, canExport, view }: Props) {
  const [filter, setFilter] = React.useState<MedicalInsuranceActionKind | "all">("all");
  const [openKey, setOpenKey] = React.useState<string | null>(null);
  const [ticked, setTicked] = React.useState<ReadonlySet<string>>(new Set());
  const [categories, setCategories] = React.useState<Record<string, MedicalInsuranceCategory>>({});
  const [busy, setBusy] = React.useState<"additions" | "deletions" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const visible = view.actions.filter((action) => filter === "all" || action.kind === filter);

  // Only people still on today's list count as ticked; someone who dropped off since the page loaded does not.
  const tickedAdds = view.actions.filter((action) => action.kind === "add" && ticked.has(action.key));
  const tickedRemoves = view.actions.filter((action) => action.kind === "remove" && ticked.has(action.key));
  const addsWithoutCategory = tickedAdds.filter((action) => !(categories[action.key] ?? action.category ?? action.suggestedCategory));
  const addCount = view.actions.filter((action) => action.kind === "add").length;
  const removeCount = view.actions.filter((action) => action.kind === "remove").length;

  function toggle(key: string) {
    setTicked((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function keysOf(kind: "add" | "remove"): string[] {
    return view.actions.filter((action) => action.kind === kind).map((action) => action.key);
  }

  function tickAll(kind: "add" | "remove") {
    setTicked((current) => new Set([...current, ...keysOf(kind)]));
  }

  function clearKind(kind: "add" | "remove") {
    const keys = new Set(keysOf(kind));
    setTicked((current) => new Set([...current].filter((key) => !keys.has(key))));
  }

  async function exportFile(kind: "additions" | "deletions") {
    const chosen = kind === "additions" ? tickedAdds : tickedRemoves;
    setBusy(kind);
    setError(null);
    try {
      await downloadPosted(
        EDI_URL,
        {
          categories: Object.fromEntries(chosen.filter((action) => categories[action.key]).map((action) => [action.key, categories[action.key]])),
          keys: chosen.map((action) => action.key),
          kind,
        },
        `MetLife-EDI-${kind}.xlsx`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The file could not be built. Try again.");
    } finally {
      setBusy(null);
    }
  }

  function renderTick(action: MedicalInsuranceAction) {
    if (!canExport || !canTick(action)) return null;
    return (
      <input
        aria-label={`Tick ${action.name} for the ${action.kind === "add" ? "additions" : "deletions"} file`}
        checked={ticked.has(action.key)}
        className="mt-0.5 h-5 w-5 shrink-0 cursor-pointer accent-phx-accent"
        onChange={() => toggle(action.key)}
        type="checkbox"
      />
    );
  }

  function renderPerson(action: MedicalInsuranceAction) {
    return (
      <>
        <p className="break-words text-sm font-black text-phx-ink" dir="auto">{action.name}</p>
        {action.jobTitle ? <p className="mt-0.5 break-words text-phx-xs font-semibold text-phx-ink-soft">{action.jobTitle}</p> : null}
        {action.lineName ? <p className="break-words text-phx-xs font-semibold text-phx-ink-faint">{action.lineName}</p> : null}
        {action.dependants > 0 ? (
          <p className="break-words text-phx-xs font-semibold text-phx-ink-soft">
            {action.dependants === 1 ? "1 family member goes with them" : `${action.dependants} family members go with them`}
          </p>
        ) : null}
      </>
    );
  }

  function renderCategory(action: MedicalInsuranceAction) {
    // A ticked addition carries its category onto the form, so it is chosen right here.
    if (canExport && action.kind === "add" && ticked.has(action.key)) {
      const value = categories[action.key] ?? action.category ?? action.suggestedCategory ?? "";
      return (
        <label className="mt-2 block max-w-[12rem]">
          <span className={cn(phxLabelClassName, !value && "text-phx-warn")}>{value ? "Category on the form" : "Choose the category"}</span>
          <select
            aria-label={`Category for ${action.name}`}
            className={phxSelectClassName}
            onChange={(event) => setCategories((current) => ({ ...current, [action.key]: event.target.value as MedicalInsuranceCategory }))}
            value={value}
          >
            {value ? null : <option value="">Choose</option>}
            {MEDICAL_INSURANCE_CATEGORIES.map((category) => <option key={category} value={category}>{category}</option>)}
          </select>
        </label>
      );
    }
    if (action.category) return <p className="break-words text-phx-xs font-semibold text-phx-ink-faint">Category {action.category}</p>;
    return (
      <p className="break-words text-phx-xs font-semibold text-phx-ink-faint">
        {action.suggestedCategory ? `Category ${action.suggestedCategory}, as the same job holds` : "Category not decided"}
      </p>
    );
  }

  function renderOpenButton(action: MedicalInsuranceAction) {
    const allowed = action.kind === "add" ? canCreate : canEdit;
    if (!allowed) return null;
    return (
      <button className={textLinkClassName} onClick={() => setOpenKey(openKey === action.key ? null : action.key)} type="button">
        {openKey === action.key ? "Close" : action.kind === "add" ? "Add or keep off" : "End cover or keep on"}
      </button>
    );
  }

  return (
    <div className="space-y-5">
      <AdminTableShell
        description="Where the rule and the register disagree. Tick who goes on the insurer's EDI file and export it: deletions and additions are separate files, each in the insurer's own workbook. The file goes to the insurer by your hand. Saving a change here records it on the register."
        title="Who should be in, and who should be out"
      >
        <div className="flex flex-wrap gap-2 border-b border-phx-line p-4">
          {FILTERS.map(({ id, label }) => (
            <button
              aria-pressed={filter === id}
              className={cn("border border-phx-line bg-white px-3 py-2 text-phx-xs font-bold text-phx-ink hover:border-phx-accent", filter === id && "border-phx-accent bg-phx-accent-soft")}
              key={id}
              onClick={() => setFilter(id)}
              type="button"
            >
              {label} ({id === "all" ? view.actions.length : view.actions.filter((action) => action.kind === id).length})
            </button>
          ))}
        </div>

        {canExport && (addCount > 0 || removeCount > 0) ? (
          <div className="grid gap-3 border-b border-phx-line p-4 md:grid-cols-2">
            <EdiPanel
              busy={busy === "deletions"}
              count={tickedRemoves.length}
              disabled={busy !== null}
              listCount={removeCount}
              note="An employee's spouse and children come off with them, as the insurer's form says, so they are not listed."
              onClear={() => clearKind("remove")}
              onExport={() => void exportFile("deletions")}
              onTickAll={() => tickAll("remove")}
              title="Deletions"
            />
            <EdiPanel
              blocked={addsWithoutCategory.length > 0 ? `Choose a category for ${addsWithoutCategory.map((action) => action.name).join(", ")}.` : null}
              busy={busy === "additions"}
              count={tickedAdds.length}
              disabled={busy !== null}
              listCount={addCount}
              note="ID number, birth date, hiring date, mobile and email come from each employee's record."
              onClear={() => clearKind("add")}
              onExport={() => void exportFile("additions")}
              onTickAll={() => tickAll("add")}
              title="Additions"
            />
            {error ? (
              <div className="md:col-span-2">
                <SaveError error={error} />
              </div>
            ) : null}
          </div>
        ) : null}

        {visible.length === 0 ? (
          <p className="p-4 text-sm font-semibold text-phx-ink-soft">
            {view.actions.length === 0 ? "The register and the rule agree. Nobody needs adding or removing." : "Nobody in this group."}
          </p>
        ) : (
          <>
            <div className="hidden md:block">
              <table className="w-full table-fixed border-separate border-spacing-0 text-sm">
                <colgroup>
                  {canExport ? <col className="w-[6%]" /> : null}
                  <col className={canExport ? "w-[28%]" : "w-[30%]"} />
                  <col className={canExport ? "w-[32%]" : "w-[34%]"} />
                  <col className={canExport ? "w-[18%]" : "w-[20%]"} />
                  <col className="w-[16%]" />
                </colgroup>
                <thead>
                  <tr>
                    {canExport ? <th className={headerClassName}><span className="sr-only">Tick</span></th> : null}
                    <th className={headerClassName}>Person</th>
                    <th className={headerClassName}>What and why</th>
                    <th className={headerClassName}>From</th>
                    <th className={headerClassName}><span className="sr-only">Act</span></th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((action) => (
                    <React.Fragment key={action.key}>
                      <tr {...rowDetailToggleProps(`medical-insurance-${action.key}`, openKey === action.key)}>
                        {canExport ? <td className={cellClassName}>{renderTick(action)}</td> : null}
                        <td className={cellClassName}>{renderPerson(action)}</td>
                        <td className={cellClassName}>
                          <p className={cn("break-words text-phx-xs font-black", KIND_TONE[action.kind])}>{KIND_WORDS[action.kind]}</p>
                          <p className="mt-0.5 break-words text-phx-xs font-semibold text-phx-ink-soft">{action.reason}</p>
                          {renderCategory(action)}
                        </td>
                        <td className={cellClassName}><span className="break-words text-phx-xs font-bold text-phx-ink">{timingWords(action)}</span></td>
                        <td className={cellClassName}>{renderOpenButton(action)}</td>
                      </tr>
                      {openKey === action.key ? (
                        <TableRowDetail colSpan={canExport ? 5 : 4} id={`medical-insurance-${action.key}`}>
                          <ActionForm action={action} key={action.key} onDone={() => setOpenKey(null)} />
                        </TableRowDetail>
                      ) : null}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="space-y-3 p-4 md:hidden">
              {visible.map((action) => (
                <div className="space-y-2 border border-phx-line bg-white p-4" key={action.key}>
                  <div className="flex items-start gap-3">
                    {renderTick(action)}
                    <div className="min-w-0 flex-1">{renderPerson(action)}</div>
                  </div>
                  <p className={cn("break-words text-phx-xs font-black", KIND_TONE[action.kind])}>{KIND_WORDS[action.kind]}: {timingWords(action)}</p>
                  <p className="break-words text-phx-xs font-semibold text-phx-ink-soft">{action.reason}</p>
                  {renderCategory(action)}
                  {renderOpenButton(action)}
                  {openKey === action.key ? <ActionForm action={action} onDone={() => setOpenKey(null)} /> : null}
                </div>
              ))}
            </div>
          </>
        )}
      </AdminTableShell>

      <ExceptionsPanel canEdit={canEdit} view={view} />
    </div>
  );
}

function EdiPanel(props: {
  blocked?: string | null;
  busy: boolean;
  count: number;
  disabled: boolean;
  listCount: number;
  note: string;
  onClear: () => void;
  onExport: () => void;
  onTickAll: () => void;
  title: string;
}) {
  return (
    <div className="space-y-2 border border-phx-line bg-white p-3">
      <p className="text-sm font-black text-phx-ink">
        {props.title}: {props.count} of {props.listCount} ticked
      </p>
      <p className="break-words text-phx-xs font-semibold text-phx-ink-soft">{props.note}</p>
      <div className="flex flex-wrap gap-2">
        <button className={toolButtonClassName} disabled={props.listCount === 0} onClick={props.onTickAll} type="button">Tick all</button>
        <button className={toolButtonClassName} disabled={props.count === 0} onClick={props.onClear} type="button">Clear</button>
        <Button className="h-9 gap-2" disabled={props.disabled || props.count === 0 || Boolean(props.blocked)} onClick={props.onExport}>
          <Download className="h-4 w-4" />
          {props.busy ? "Building the file" : `Export ${props.title.toLowerCase()} (${props.count})`}
        </Button>
      </div>
      {props.blocked ? <p className="break-words text-phx-xs font-bold text-phx-warn">{props.blocked}</p> : null}
    </div>
  );
}

function ActionForm({ action, onDone }: { action: MedicalInsuranceAction; onDone: () => void }) {
  const { busy, error, save } = useSave();
  const [category, setCategory] = React.useState<MedicalInsuranceCategory | "">(action.suggestedCategory ?? "");
  const [certificate, setCertificate] = React.useState("");
  const [day, setDay] = React.useState(action.effectiveOn);
  const [reason, setReason] = React.useState(action.kind === "add" ? "" : action.reason);
  const adding = action.kind === "add";

  function saveAdd() {
    void save(() => sendJson("/api/medical-insurance/members", "POST", { category, certificateNumber: certificate, coverageStart: day, hrId: action.hrId, memberType: "employee" }), onDone);
  }
  function saveEnd() {
    void save(() => sendJson(`/api/medical-insurance/members/${action.memberId}`, "PATCH", { action: "end", coverageEnd: day, endReason: reason }), onDone);
  }
  function saveException() {
    void save(() => sendJson("/api/medical-insurance/exceptions", "POST", { decision: adding ? "keep_out" : "keep_in", hrId: action.hrId, reason }), onDone);
  }

  return (
    <div className="space-y-3">
      <div className={phxFieldGridTwoClassName}>
        <label className="block">
          <span className={phxLabelClassName}>{adding ? "Cover starts" : "Cover ends"}</span>
          <input className={phxFieldClassName} onChange={(event) => setDay(event.target.value)} type="date" value={day} />
        </label>
        {adding ? (
          <label className="block">
            <span className={phxLabelClassName}>Category</span>
            <select className={phxSelectClassName} onChange={(event) => setCategory(event.target.value as MedicalInsuranceCategory | "")} value={category}>
              <option value="">Choose</option>
              {MEDICAL_INSURANCE_CATEGORIES.map((value) => <option key={value} value={value}>Category {value}</option>)}
            </select>
          </label>
        ) : null}
        {adding ? (
          <label className="block">
            <span className={phxLabelClassName}>Certificate number, once the insurer gives one</span>
            <input className={phxFieldClassName} onChange={(event) => setCertificate(event.target.value)} value={certificate} />
          </label>
        ) : null}
        <label className="block">
          <span className={phxLabelClassName}>{adding ? "Reason, to keep them off the policy" : "Reason"}</span>
          <input className={phxFieldClassName} onChange={(event) => setReason(event.target.value)} value={reason} />
        </label>
      </div>
      <SaveError error={error} />
      <div className="flex flex-wrap gap-2">
        {adding ? (
          <Button className="h-10" disabled={busy} onClick={saveAdd}>Add to the register</Button>
        ) : (
          <Button className="h-10" disabled={busy || !action.memberId} onClick={saveEnd}>End cover</Button>
        )}
        {action.hrId ? (
          <Button className="h-10" disabled={busy} onClick={saveException} variant="secondary">
            {adding ? "Keep off the policy" : "Keep on the policy"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function ExceptionsPanel({ canEdit, view }: { canEdit: boolean; view: MedicalInsuranceView }) {
  const { busy, error, save } = useSave();
  const [hrId, setHrId] = React.useState("");
  const [decision, setDecision] = React.useState<"keep_in" | "keep_out">("keep_out");
  const [reason, setReason] = React.useState("");

  function add() {
    void save(
      () => sendJson("/api/medical-insurance/exceptions", "POST", { decision, hrId, reason }),
      () => {
        setHrId("");
        setReason("");
      },
    );
  }

  return (
    <AdminTableShell description="An exception beats the everyone-from-day-one rule, in either direction, and keeps its reason." title="Exceptions">
      {view.exceptions.length === 0 ? (
        <p className="p-4 text-sm font-semibold text-phx-ink-soft">No exceptions. Everyone follows the rule.</p>
      ) : (
        <ul>
          {view.exceptions.map((exception) => (
            <li className="flex flex-wrap items-start justify-between gap-2 border-b border-phx-line p-4" key={exception.id}>
              <div className="min-w-0">
                <p className="break-words text-sm font-black text-phx-ink" dir="auto">{exception.name}</p>
                <p className="break-words text-phx-xs font-bold text-phx-ink-soft">{exception.decision === "keep_in" ? "Kept on the policy" : "Kept off the policy"}</p>
                <p className="break-words text-phx-xs font-semibold text-phx-ink-soft" dir="auto">{exception.reason}</p>
              </div>
              {canEdit ? (
                <button className={textLinkClassName} disabled={busy} onClick={() => void save(() => sendJson(`/api/medical-insurance/exceptions/${exception.id}`, "DELETE"))} type="button">
                  Remove
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canEdit ? (
        <div className="space-y-3 p-4">
          <div className={phxFieldGridTwoClassName}>
            <label className="block">
              <span className={phxLabelClassName}>Employee</span>
              <select className={phxSelectClassName} onChange={(event) => setHrId(event.target.value)} value={hrId}>
                <option value="">Choose</option>
                {view.employees.map((employee) => <option key={employee.hrId} value={employee.hrId}>{employee.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className={phxLabelClassName}>Decision</span>
              <select className={phxSelectClassName} onChange={(event) => setDecision(event.target.value as "keep_in" | "keep_out")} value={decision}>
                <option value="keep_out">Keep off the policy</option>
                <option value="keep_in">Keep on the policy</option>
              </select>
            </label>
            <label className="block sm:col-span-2">
              <span className={phxLabelClassName}>Reason</span>
              <input className={phxFieldClassName} onChange={(event) => setReason(event.target.value)} value={reason} />
            </label>
          </div>
          <SaveError error={error} />
          <Button className="h-10" disabled={busy} onClick={add} variant="secondary">Record the exception</Button>
        </div>
      ) : null}
    </AdminTableShell>
  );
}
