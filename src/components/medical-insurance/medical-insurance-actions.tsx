"use client";

import { Download, Send } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";

import { AdminTableShell } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { phxFieldClassName, phxFieldGridTwoClassName, phxLabelClassName, phxSelectClassName } from "@/components/ui/form-tokens";
import { rowDetailToggleProps, TableRowDetail } from "@/components/ui/table-row-detail";
import { formatLeftDay } from "@/lib/employees/left-flag";
import { MEDICAL_INSURANCE_CATEGORIES, type MedicalInsuranceCategory } from "@/lib/medical-insurance/cost";
import { defaultDeletionDay, deletionDayProblem, earliestDeletionDay } from "@/lib/medical-insurance/deletion-day";
import { additionCategory, type MedicalInsuranceAction, type MedicalInsuranceActionKind } from "@/lib/medical-insurance/eligibility";
import { LIBANO_MOVEMENT_EMAIL_CC, LIBANO_MOVEMENT_EMAIL_TO, LIBANO_MOVEMENT_TEST_TO } from "@/lib/medical-insurance/libano-movement-recipients";
import { DECLINED_REASON, employeeRecordWords, type MedicalInsuranceView } from "@/lib/medical-insurance/view";
import { cn } from "@/lib/utils";

import { cellClassName, downloadPosted, headerClassName, postJsonAnswer, SaveError, sendJson, textLinkClassName, useSave } from "./medical-insurance-parts";

type Props = { canCreate: boolean; canEdit: boolean; canExport: boolean; view: MedicalInsuranceView };

const KIND_WORDS: Record<MedicalInsuranceActionKind, string> = { add: "Add", remove: "Remove", review: "Check" };
const KIND_TONE: Record<MedicalInsuranceActionKind, string> = { add: "text-phx-ok", remove: "text-phx-warn", review: "text-phx-ink-soft" };
const FILTERS: Array<{ id: MedicalInsuranceActionKind | "all"; label: string }> = [
  { id: "all", label: "Everyone" },
  { id: "add", label: "To add" },
  { id: "remove", label: "To remove" },
  { id: "review", label: "To check" },
];
const MEMBER_FILE_URL = "/api/medical-insurance/movement-file";
const MEMBER_FILE_SEND_URL = "/api/medical-insurance/movement-file/send";

type MovementKind = "additions" | "deletions";
type SendRequest = { kind: MovementKind; test: boolean };
type SendOutcome = { status: "sent" | "queued" | "not_sent"; test: boolean; subject: string; to: string[]; cc: string[]; people: number; message: string };

/** "Addition 27/11/2026": what the subject will read, the day in Cairo, exactly as the server writes it. */
function movementSubject(request: SendRequest): string {
  const day = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", timeZone: "Africa/Cairo", year: "numeric" }).format(new Date());
  return `${request.test ? "TEST - " : ""}${request.kind === "additions" ? "Addition" : "Deletion"} ${day}`;
}
const toolButtonClassName = "border border-phx-line bg-white px-3 py-2 text-phx-xs font-bold text-phx-ink hover:border-phx-accent disabled:opacity-50";

function timingWords(action: MedicalInsuranceAction): string {
  const day = formatLeftDay(action.effectiveOn);
  if (action.timing === "soon") return `Coming up, ${day}`;
  return action.kind === "add" ? `Should have started ${day}` : day;
}

function canTick(action: MedicalInsuranceAction): boolean {
  return action.kind === "add" || action.kind === "remove";
}

/** What an addition still lacks for Libano-Suisse's sheet; anything here and the person cannot be ticked (owner, 27 Nov 2026, rule 1). */
function missingOf(action: MedicalInsuranceAction): string[] {
  return action.kind === "add" ? action.missing ?? [] : [];
}

export function MedicalInsuranceActionsTab({ canCreate, canEdit, canExport, view }: Props) {
  const router = useRouter();
  const [filter, setFilter] = React.useState<MedicalInsuranceActionKind | "all">("all");
  const [openKey, setOpenKey] = React.useState<string | null>(null);
  const [ticked, setTicked] = React.useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = React.useState<"additions" | "deletions" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  // Both Send buttons open a confirm panel first: each is a real email (owner, 27 Nov 2026: "make send and test send").
  const [confirming, setConfirming] = React.useState<SendRequest | null>(null);
  const [sending, setSending] = React.useState(false);
  const [sent, setSent] = React.useState<SendOutcome | null>(null);
  // The deletion date typed beside each person to remove. It is the date the file carries, and the day End cover
  // starts from (owner, 27 Nov 2026: "It must follow what I say"); untouched, it is as far back as Libano-Suisse accepts.
  const [deletionDays, setDeletionDays] = React.useState<Readonly<Record<string, string>>>({});
  const visible = view.actions.filter((action) => filter === "all" || action.kind === filter);

  function deletionWindow(action: MedicalInsuranceAction) {
    const coverStart = view.members.find((member) => member.id === action.memberId)?.coverageStart ?? action.effectiveOn;
    return { coverStart, policyStartsOn: view.policy.startsOn, sendingDay: view.asOf };
  }
  function deletionDayOf(action: MedicalInsuranceAction): string {
    return deletionDays[action.key] ?? defaultDeletionDay(action, deletionWindow(action));
  }
  function deletionProblemOf(action: MedicalInsuranceAction): string | null {
    return deletionDayProblem(deletionDayOf(action), { ...deletionWindow(action), formatDay: formatLeftDay, name: action.name, policyEndsOn: view.policy.endsOn });
  }

  // Only people still on today's list count as ticked; someone who dropped off since the page loaded does not.
  const tickedAdds = view.actions.filter((action) => action.kind === "add" && ticked.has(action.key) && missingOf(action).length === 0);
  const tickedRemoves = view.actions.filter((action) => action.kind === "remove" && ticked.has(action.key));
  const addsWithoutCategory = tickedAdds.filter((action) => !additionCategory(action));
  const removeProblems = tickedRemoves.map(deletionProblemOf).filter((problem): problem is string => Boolean(problem));
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
    return view.actions.filter((action) => action.kind === kind && missingOf(action).length === 0).map((action) => action.key);
  }

  function tickAll(kind: "add" | "remove") {
    setTicked((current) => new Set([...current, ...keysOf(kind)]));
  }

  function clearKind(kind: "add" | "remove") {
    const keys = new Set(keysOf(kind));
    setTicked((current) => new Set([...current].filter((key) => !keys.has(key))));
  }

  /** The deletion date of each ticked person, exactly as the screen shows it; an additions file carries none. */
  function daysOf(kind: MovementKind, chosen: readonly MedicalInsuranceAction[]): { days?: Record<string, string> } {
    if (kind !== "deletions") return {};
    return { days: Object.fromEntries(chosen.map((action) => [action.key, deletionDayOf(action)])) };
  }

  async function exportFile(kind: "additions" | "deletions") {
    const chosen = kind === "additions" ? tickedAdds : tickedRemoves;
    setBusy(kind);
    setError(null);
    try {
      await downloadPosted(
        MEMBER_FILE_URL,
        { ...daysOf(kind, chosen), keys: chosen.map((action) => action.key), kind },
        `Libano-Suisse-members-${kind}.xlsx`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The file could not be built. Try again.");
    } finally {
      setBusy(null);
    }
  }

  function askToSend(request: SendRequest) {
    setSent(null);
    setError(null);
    setConfirming(request);
  }

  async function sendFile(request: SendRequest) {
    const chosen = request.kind === "additions" ? tickedAdds : tickedRemoves;
    setSending(true);
    setError(null);
    setSent(null);
    try {
      const { outcome } = await postJsonAnswer<{ outcome: SendOutcome }>(MEMBER_FILE_SEND_URL, { ...daysOf(request.kind, chosen), keys: chosen.map((action) => action.key), kind: request.kind, test: request.test });
      setSent(outcome);
      setConfirming(null);
      // A real send has just recorded the people on the register, so the lists are read again and they leave this tab.
      if (!request.test) {
        setTicked(new Set());
        router.refresh();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The email could not be sent. Try again.");
    } finally {
      setSending(false);
    }
  }

  function renderTick(action: MedicalInsuranceAction) {
    if (!canExport || !canTick(action)) return null;
    const missing = missingOf(action);
    if (missing.length > 0) {
      return (
        <input
          aria-label={`${action.name} cannot be ticked: missing ${missing.join(", ")}`}
          checked={false}
          className="mt-0.5 h-5 w-5 shrink-0 cursor-not-allowed"
          disabled
          title={`Missing: ${missing.join(", ")}`}
          type="checkbox"
        />
      );
    }
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

  function renderMissing(action: MedicalInsuranceAction) {
    const missing = missingOf(action);
    if (missing.length === 0) return null;
    return (
      <p className="mt-1 break-words text-phx-xs font-black text-phx-danger">
        Missing: {missing.join(", ")}. Cannot be sent until it is filled in.
      </p>
    );
  }

  function renderDeletionDay(action: MedicalInsuranceAction) {
    if (!canExport || action.kind !== "remove") return null;
    const problem = deletionProblemOf(action);
    const earliest = earliestDeletionDay(deletionWindow(action));
    return (
      <label className="mt-2 block max-w-[12rem]">
        <span className={phxLabelClassName}>Deletion date</span>
        <input
          aria-label={`Deletion date for ${action.name}`}
          className={phxFieldClassName}
          max={view.policy.endsOn}
          min={earliest}
          onChange={(event) => {
            const value = event.target.value;
            setDeletionDays((current) => ({ ...current, [action.key]: value }));
          }}
          type="date"
          value={deletionDayOf(action)}
        />
        <span className={cn("mt-1 block break-words text-phx-xs font-semibold", problem ? "text-phx-warn" : "text-phx-ink-faint")}>
          {problem ?? `Earliest Libano-Suisse accepts: ${formatLeftDay(earliest)}`}
        </span>
      </label>
    );
  }

  function renderPerson(action: MedicalInsuranceAction) {
    return (
      <>
        <p className="break-words text-sm font-black text-phx-ink" dir="auto">{action.name}</p>
        {action.jobTitle ? <p className="mt-0.5 break-words text-phx-xs font-semibold text-phx-ink-soft">{action.jobTitle}</p> : null}
        {(action.memberType === "employee" ? employeeRecordWords(action) : action.lineName ? [action.lineName] : []).map((words) => (
          <p className="break-words text-phx-xs font-semibold text-phx-ink-faint" key={words}>{words}</p>
        ))}
        {action.dependants > 0 ? (
          <p className="break-words text-phx-xs font-semibold text-phx-ink-soft">
            {action.dependants === 1 ? "1 family member goes with them" : `${action.dependants} family members go with them`}
          </p>
        ) : null}
      </>
    );
  }

  function renderCategory(action: MedicalInsuranceAction) {
    if (action.category) return <p className="break-words text-phx-xs font-semibold text-phx-ink-faint">Plan {action.category}</p>;
    // A joiner's plan is decided here, before they are on the register, and the additions file reads it.
    if (canEdit && action.kind === "add" && action.hrId) return <CategoryDecision action={action} />;
    return <p className="break-words text-phx-xs font-semibold text-phx-ink-faint">{categoryWords(action)}</p>;
  }

  function renderOpenButton(action: MedicalInsuranceAction) {
    // A late joiner's cover is moved to their first day in one press; nothing else on the row changes.
    if (action.lateStart) return canEdit && action.memberId ? <StartOnFirstDayButton action={action} /> : null;
    if (action.noRecord) return canEdit && action.memberId ? <KeepOutsideButton action={action} /> : null;
    const allowed = action.kind === "add" ? canCreate : canEdit;
    const excludable = canEdit && action.kind === "add" && Boolean(action.hrId);
    if (!allowed && !excludable) return null;
    return (
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {allowed ? (
          <button className={textLinkClassName} onClick={() => setOpenKey(openKey === action.key ? null : action.key)} type="button">
            {openKey === action.key ? "Close" : action.kind === "add" ? "Add" : "End cover or keep on"}
          </button>
        ) : null}
        {excludable ? <ExcludeButton action={action} /> : null}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <AdminTableShell
        description="Where the rule and the register disagree. Tick who goes on Libano-Suisse's member file and export it: deletions and additions are separate files, each on Libano-Suisse's own Additions and Deletions workbook, as they issued it. Send to Libano-Suisse also records it on the register: the additions go on it and the deletions are ended on their dates. Saving a change here records it on the register too."
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
              blocked={removeProblems.length > 0 ? removeProblems.join(" ") : null}
              busy={busy === "deletions"}
              count={tickedRemoves.length}
              disabled={busy !== null || sending}
              listCount={removeCount}
              note="Each person goes with the deletion date beside them, as far back as Libano-Suisse accepts unless you change it. An employee's spouse and children on the policy are listed with them, on the same date, one row each."
              onClear={() => clearKind("remove")}
              onExport={() => void exportFile("deletions")}
              onSend={(test) => askToSend({ kind: "deletions", test })}
              onTickAll={() => tickAll("remove")}
              title="Deletions"
            />
            <EdiPanel
              blocked={addsWithoutCategory.length > 0 ? `Choose a plan for ${addsWithoutCategory.map((action) => action.name).join(", ")}.` : null}
              busy={busy === "additions"}
              count={tickedAdds.length}
              disabled={busy !== null || sending}
              listCount={addCount}
              note="Date of birth, ID number, sex and mobile come from each employee's record. Their staff number is their HR number."
              onClear={() => clearKind("add")}
              onExport={() => void exportFile("additions")}
              onSend={(test) => askToSend({ kind: "additions", test })}
              onTickAll={() => tickAll("add")}
              title="Additions"
            />
            {confirming ? (
              <SendConfirm
                busy={sending}
                count={confirming.kind === "additions" ? tickedAdds.length : tickedRemoves.length}
                dates={confirming.kind === "deletions" ? tickedRemoves.map((action) => `${action.name}, ${formatLeftDay(deletionDayOf(action))}`) : []}
                onCancel={() => setConfirming(null)}
                onSend={() => void sendFile(confirming)}
                request={confirming}
              />
            ) : null}
            {sent ? (
              <p
                className={cn(
                  "break-words border-l-2 bg-white p-3 text-phx-xs font-bold md:col-span-2",
                  sent.status === "sent" ? "border-phx-ok text-phx-ok" : "border-phx-warn text-phx-warn",
                )}
              >
                {sent.status === "sent"
                  ? `"${sent.subject}" sent for ${sent.people} ${sent.people === 1 ? "person" : "people"}. `
                  : sent.status === "queued"
                    ? `"${sent.subject}" is waiting to be sent and will retry by itself. `
                    : ""}
                {sent.message}
              </p>
            ) : null}
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
                          {renderMissing(action)}
                          {renderCategory(action)}
                        </td>
                        <td className={cellClassName}>
                          <span className="break-words text-phx-xs font-bold text-phx-ink">{timingWords(action)}</span>
                          {renderDeletionDay(action)}
                        </td>
                        <td className={cellClassName}>{renderOpenButton(action)}</td>
                      </tr>
                      {openKey === action.key ? (
                        <TableRowDetail colSpan={canExport ? 5 : 4} id={`medical-insurance-${action.key}`}>
                          <ActionForm action={action} endDay={action.kind === "remove" ? deletionDayOf(action) : undefined} key={action.key} onDone={() => setOpenKey(null)} />
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
                  {renderMissing(action)}
                  {renderCategory(action)}
                  {renderDeletionDay(action)}
                  {renderOpenButton(action)}
                  {openKey === action.key ? <ActionForm action={action} endDay={action.kind === "remove" ? deletionDayOf(action) : undefined} onDone={() => setOpenKey(null)} /> : null}
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

function categoryWords(action: MedicalInsuranceAction): string {
  if (action.decidedCategory) return `Plan ${action.decidedCategory}, decided`;
  if (action.suggestedCategory) return `Plan ${action.suggestedCategory}, as the same job holds`;
  return "Plan not decided";
}

/** Saves the plan the moment it is chosen, so it is still there the next time anyone exports. */
function CategoryDecision({ action }: { action: MedicalInsuranceAction }) {
  const { busy, error, save } = useSave();
  const value = action.decidedCategory ?? action.suggestedCategory ?? "";
  const label = action.decidedCategory ? "Plan, decided" : action.suggestedCategory ? "Plan, as the same job holds" : "Decide the plan";
  return (
    <div className="mt-2 max-w-[14rem]">
      <label className="block">
        <span className={cn(phxLabelClassName, !value && "text-phx-warn")}>{label}</span>
        <select
          aria-label={`Plan for ${action.name}`}
          className={phxSelectClassName}
          disabled={busy}
          onChange={(event) => void save(() => sendJson("/api/medical-insurance/categories", "POST", { category: event.target.value, hrId: action.hrId }))}
          value={value}
        >
          {value ? null : <option value="">Choose</option>}
          {MEDICAL_INSURANCE_CATEGORIES.map((category) => <option key={category} value={category}>{category}</option>)}
        </select>
      </label>
      <SaveError error={error} />
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
  /** `true` is Send test: the same email, to the owner alone. */
  onSend: (test: boolean) => void;
  onTickAll: () => void;
  title: string;
}) {
  const cannotSend = props.disabled || props.count === 0 || Boolean(props.blocked);
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
        <button className={toolButtonClassName} disabled={cannotSend} onClick={() => props.onSend(true)} type="button">
          Send test to me
        </button>
        <Button className="h-9 gap-2" disabled={cannotSend} onClick={() => props.onSend(false)} variant="outline">
          <Send className="h-4 w-4" />
          Send to Libano-Suisse
        </Button>
      </div>
      {props.blocked ? <p className="break-words text-phx-xs font-bold text-phx-warn">{props.blocked}</p> : null}
    </div>
  );
}

/** The last look before a real email leaves: who receives it, the subject, and how many people. */
function SendConfirm(props: { busy: boolean; count: number; dates: readonly string[]; onCancel: () => void; onSend: () => void; request: SendRequest }) {
  const { kind, test } = props.request;
  const words = kind === "additions" ? "Additions" : "Deletions";
  const to = test ? LIBANO_MOVEMENT_TEST_TO : LIBANO_MOVEMENT_EMAIL_TO;
  const cc = test ? [] : LIBANO_MOVEMENT_EMAIL_CC;
  return (
    <div className={cn("space-y-2 border bg-white p-3 md:col-span-2", test ? "border-phx-line" : "border-phx-accent")}>
      <p className="text-sm font-black text-phx-ink">
        {test
          ? `Send a test of the ${words.toLowerCase()} file for ${props.count} ${props.count === 1 ? "person" : "people"} to you only?`
          : `Send the ${words.toLowerCase()} file for ${props.count} ${props.count === 1 ? "person" : "people"} to Libano-Suisse?`}
      </p>
      <dl className="grid gap-1 text-phx-xs font-semibold text-phx-ink-soft sm:grid-cols-[6rem_1fr]">
        <dt className="font-black text-phx-ink">To</dt>
        <dd className="break-words">{to.join(", ")}</dd>
        <dt className="font-black text-phx-ink">CC</dt>
        <dd className="break-words">{cc.length > 0 ? cc.join(", ") : "Nobody"}</dd>
        <dt className="font-black text-phx-ink">Subject</dt>
        <dd className="break-words">{movementSubject(props.request)}</dd>
        {props.dates.length > 0 ? (
          <>
            <dt className="font-black text-phx-ink">Deletion date</dt>
            <dd className="break-words" dir="auto">{props.dates.join("; ")}</dd>
          </>
        ) : null}
        <dt className="font-black text-phx-ink">Attached</dt>
        <dd className="break-words">The {words} sheet, the same file Export builds</dd>
      </dl>
      <p className={cn("break-words text-phx-xs font-bold", test ? "text-phx-ink-soft" : "text-phx-warn")}>
        {test
          ? "Nothing goes to Libano-Suisse. You receive exactly the email they would, marked as a test, so you can open the file and check it first."
          : kind === "additions"
            ? "This sends a real email to the insurer, from Phoenix on your behalf, and puts these people on the register from the day and on the plan the file carries. Replies come to you."
            : "This sends a real email to the insurer, from Phoenix on your behalf, and ends these people's cover on the register on the deletion date shown. Replies come to you."}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button className="h-9 gap-2" disabled={props.busy || props.count === 0} onClick={props.onSend}>
          <Send className="h-4 w-4" />
          {props.busy ? "Sending" : test ? "Send test now" : "Send now"}
        </Button>
        <button className={toolButtonClassName} disabled={props.busy} onClick={props.onCancel} type="button">
          Cancel
        </button>
      </div>
    </div>
  );
}

/** `endDay` is the row's deletion date, so End cover ends on the day the file went with unless it is changed here. */
function ActionForm({ action, endDay, onDone }: { action: MedicalInsuranceAction; endDay?: string; onDone: () => void }) {
  const { busy, error, save } = useSave();
  const [category, setCategory] = React.useState<MedicalInsuranceCategory | "">(action.decidedCategory ?? action.suggestedCategory ?? "");
  const [certificate, setCertificate] = React.useState("");
  const [day, setDay] = React.useState(endDay ?? action.effectiveOn);
  const [reason, setReason] = React.useState(action.kind === "add" ? DECLINED_REASON : action.reason);
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
            <span className={phxLabelClassName}>Plan</span>
            <select className={phxSelectClassName} onChange={(event) => setCategory(event.target.value as MedicalInsuranceCategory | "")} value={category}>
              <option value="">Choose</option>
              {MEDICAL_INSURANCE_CATEGORIES.map((value) => <option key={value} value={value}>Plan {value}</option>)}
            </select>
          </label>
        ) : null}
        {adding ? (
          <label className="block">
            <span className={phxLabelClassName}>Member number, once the insurer gives one</span>
            <input className={phxFieldClassName} onChange={(event) => setCertificate(event.target.value)} value={certificate} />
          </label>
        ) : null}
        <label className="block">
          <span className={phxLabelClassName}>{adding ? "Reason, if you exclude them" : "Reason"}</span>
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
            {adding ? "Exclude" : "Keep on the policy"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Medical insurance is optional (owner, 2026-11-17: "people like rasha sama reham salma labib doent
 * want to be in medical insurance so make an option of exclude"). One press records that they are
 * kept off the policy, so the add list stops asking; the exceptions list below reverses it.
 */
function StartOnFirstDayButton({ action }: { action: MedicalInsuranceAction }) {
  const { busy, error, save } = useSave();
  const day = formatLeftDay(action.effectiveOn);
  return (
    <span className="inline-flex flex-col">
      <button
        aria-label={`Start ${action.name}'s cover on ${day}, the day they join`}
        className={textLinkClassName}
        disabled={busy}
        onClick={() => void save(() => sendJson(`/api/medical-insurance/members/${action.memberId}`, "PATCH", { coverageStart: action.effectiveOn }))}
        type="button"
      >
        {busy ? "Saving" : `Start cover on ${day}`}
      </button>
      <SaveError error={error} />
    </span>
  );
}

/** Someone on the policy with no Phoenix record, kept on as outside staff: the row stays on the register and leaves this list. */
function KeepOutsideButton({ action }: { action: MedicalInsuranceAction }) {
  const { busy, error, save } = useSave();
  return (
    <span className="inline-flex flex-col">
      <button
        aria-label={`Keep ${action.name} on the policy as outside staff, not a Phoenix employee`}
        className={textLinkClassName}
        disabled={busy}
        onClick={() => void save(() => sendJson(`/api/medical-insurance/members/${action.memberId}`, "PATCH", { action: "keep_outside" }))}
        type="button"
      >
        {busy ? "Saving" : "Keep: outside staff"}
      </button>
      <SaveError error={error} />
    </span>
  );
}

function ExcludeButton({ action }: { action: MedicalInsuranceAction }) {
  const { busy, error, save } = useSave();
  return (
    <span className="inline-flex flex-col">
      <button
        aria-label={`Exclude ${action.name}: does not want medical insurance`}
        className={textLinkClassName}
        disabled={busy}
        onClick={() => void save(() => sendJson("/api/medical-insurance/exceptions", "POST", { decision: "keep_out", hrId: action.hrId, reason: DECLINED_REASON }))}
        type="button"
      >
        {busy ? "Excluding" : "Exclude"}
      </button>
      <SaveError error={error} />
    </span>
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
    <AdminTableShell description="Medical insurance is optional. Someone who does not want it is excluded here, and the add list stops asking for them. An exception beats the everyone-from-day-one rule in either direction and keeps its reason; removing it puts the rule back." title="Excluded and kept on">
      {view.exceptions.length === 0 ? (
        <p className="p-4 text-sm font-semibold text-phx-ink-soft">No exceptions. Everyone follows the rule.</p>
      ) : (
        <ul>
          {view.exceptions.map((exception) => (
            <li className="flex flex-wrap items-start justify-between gap-2 border-b border-phx-line p-4" key={exception.id}>
              <div className="min-w-0">
                <p className="break-words text-sm font-black text-phx-ink" dir="auto">{exception.name}</p>
                <p className="break-words text-phx-xs font-bold text-phx-ink-soft">{exception.decision === "keep_in" ? "Kept on the policy" : "Excluded"}</p>
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
                <option value="keep_out">Exclude from medical insurance</option>
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
