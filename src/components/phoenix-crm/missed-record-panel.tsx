"use client";

import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";

import { crmPost, crmUrl, newClientId, useCrmAction, useCrmGet } from "@/components/phoenix-crm/api";
import { dayLabelLong } from "@/components/phoenix-crm/format";
import { gradeSpecialityParts, listText } from "@/components/phoenix-crm/labels";
import {
  CrmBlock,
  CrmButton,
  CrmCheck,
  CrmChoice,
  CrmField,
  CrmLoadError,
  CrmLoading,
  CrmNote,
  CrmPill,
  CrmSaveError,
  CrmSearchField,
  CrmShowMore,
  crmInputClassName,
  crmTextareaClassName,
} from "@/components/phoenix-crm/ui";
import { DAY_ACTIVITY_NOTE_MAX, PHOENIX_CRM_DAY_ACTIVITIES, type PhoenixCrmDayActivity } from "@/lib/phoenix-crm/day-activities";
import { VISIT_COMMENT_MAX, VISIT_PRODUCTS_MAX } from "@/lib/phoenix-crm/entry-rules";
import { MISSED_RECORD_MARK } from "@/lib/phoenix-crm/missed-records";
import { UNPLANNED_REASON_MAX, UNPLANNED_REASON_MIN } from "@/lib/phoenix-crm/unplanned-rules";
import type { DayActivityRow, EnteredMissedVisit, MissedRecordCustomer, MissedRecordForm } from "@/lib/phoenix-crm/view-types";
import { cn } from "@/lib/utils";

/**
 * Phoenix CRM — the Super Admin enters a record a rep MISSED, on the day's own page.
 *
 * Owner, 2026-10-01: "show it beside the miss, and the system admin can enter a manual record for
 * anyone, anytime, anywhere" — "the rep is responsible for all his records, but if he missed a visit or
 * a record, admin can enter it for him" — "I choose planned or unplanned" — "marked as entered by admin".
 *
 * It lives on the day page because that is where the miss is: the calendar opens any day that has begun
 * for him, the empty ones included, and this panel sits under what the day already holds. The server
 * decided whether it shows at all (`missedRecords`, null for everyone but the Super Admin) and asserts
 * the same gate again on every save; nothing here decides who may enter.
 *
 * Nothing on it asks where he is: a visit entered here has no location, by design, and is marked as
 * entered by the Super Admin on every screen that shows it. After a save the page itself is re-read, so
 * the visit or the day's activity appears above in the order it happened.
 */

const PAGE = 20;

type Mode = "visit" | "activity";

type ActivitySaved = { cleared: boolean; activity: DayActivityRow | null };

/** What was just saved, said back to him once. The customer's name is isolated: it is often Arabic. */
type SavedEntry =
  | { kind: "visit"; customerName: string; planned: boolean }
  | { kind: "activity"; label: string | null }
  | { kind: "cleared" };

function SavedNote({ entry }: { entry: SavedEntry }) {
  if (entry.kind === "cleared") return <CrmNote tone="good">The day&apos;s activity you had entered is cleared.</CrmNote>;
  if (entry.kind === "activity") {
    return <CrmNote tone="good">{`The day is recorded as ${entry.label ?? "you chose"}. It shows as "${MISSED_RECORD_MARK}".`}</CrmNote>;
  }
  return (
    <CrmNote tone="good">
      The visit to <bdi>{entry.customerName}</bdi>
      {entry.planned
        ? ` is saved and counts. It shows as "${MISSED_RECORD_MARK}".`
        : ` is saved and waits for the manager, then SFE, to approve it. It shows as "${MISSED_RECORD_MARK}".`}
    </CrmNote>
  );
}

/** "PM · Grade A · Paediatrics" with each part isolated, so an Arabic speciality cannot reorder the row. */
function CustomerMeta({ customer }: { customer: MissedRecordCustomer }) {
  const parts = [listText(customer.listType), ...gradeSpecialityParts(customer)];
  return (
    <span className="mt-0.5 block break-words text-xs font-semibold text-slate-500">
      {parts.map((part, index) => (
        <span key={`${index}-${part}`}>
          {index > 0 ? " · " : null}
          <bdi>{part}</bdi>
        </span>
      ))}
    </span>
  );
}

function CustomerPicker({
  customers,
  disabled,
  onPick,
  selectedId,
}: {
  customers: ReadonlyArray<MissedRecordCustomer>;
  disabled: boolean;
  onPick: (customer: MissedRecordCustomer) => void;
  selectedId: string | null;
}) {
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? customers.filter((customer) => customer.name.toLowerCase().includes(needle)) : customers;
  }, [customers, query]);
  const visible = matches.slice(0, shown);

  return (
    <div className="grid min-w-0 gap-2">
      <CrmSearchField
        id="phoenix-crm-missed-visit-search"
        label="Customer"
        onChange={(next) => {
          setQuery(next);
          setShown(PAGE);
        }}
        placeholder="Type a name"
        value={query}
      />
      {matches.length === 0 ? (
        <p className="text-xs font-semibold text-slate-500">No customer on the list matches that name.</p>
      ) : (
        <div aria-label="Customer" className="grid min-w-0 gap-1.5" role="radiogroup">
          {visible.map((customer) => {
            const selected = customer.customerId === selectedId;
            return (
              <button
                aria-checked={selected}
                className={cn(
                  "min-h-11 w-full min-w-0 rounded-none border px-3 py-2 text-left transition disabled:cursor-not-allowed disabled:opacity-60",
                  selected ? "border-orange-500 bg-orange-50" : "border-slate-200 bg-white hover:border-slate-300",
                )}
                disabled={disabled || customer.visited}
                key={customer.customerId}
                onClick={() => onPick(customer)}
                role="radio"
                type="button"
              >
                <span className="block break-words text-sm font-black text-slate-900">
                  <bdi>{customer.name}</bdi>
                </span>
                <CustomerMeta customer={customer} />
                {customer.onSentPlan || customer.pending || customer.visited ? (
                  <span className="mt-1 flex min-w-0 flex-wrap gap-1">
                    {customer.onSentPlan ? <CrmPill tone="good">Planned that day</CrmPill> : null}
                    {customer.pending ? <CrmPill>Not validated yet</CrmPill> : null}
                    {customer.visited ? <CrmPill>Already visited that day</CrmPill> : null}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
      <CrmShowMore left={matches.length - visible.length} onMore={() => setShown((count) => count + PAGE)} page={PAGE} />
    </div>
  );
}

function MissedVisitForm({
  form,
  isTest,
  onCancel,
  onSaved,
  seatId,
}: {
  form: MissedRecordForm;
  isTest: boolean;
  onCancel: () => void;
  onSaved: (entry: SavedEntry) => void;
  seatId: string;
}) {
  const action = useCrmAction();
  // The entry's id, made the first time it is sent and kept until it saves: a retry after a dropped
  // connection is the SAME entry, and the server answers it with the visit already saved.
  const idRef = useRef<string | null>(null);
  const [customer, setCustomer] = useState<MissedRecordCustomer | null>(null);
  const [planned, setPlanned] = useState<"planned" | "unplanned" | null>(null);
  const [time, setTime] = useState("");
  const [products, setProducts] = useState<string[]>([]);
  const [comment, setComment] = useState("");
  const [reason, setReason] = useState("");
  const busy = action.busy !== null;

  const reasonLength = reason.trim().replace(/\s+/g, " ").length;
  const ready =
    customer !== null &&
    planned !== null &&
    products.length > 0 &&
    comment.trim().length > 0 &&
    (planned === "planned" || (reasonLength >= UNPLANNED_REASON_MIN && reasonLength <= UNPLANNED_REASON_MAX));

  function pick(next: MissedRecordCustomer) {
    setCustomer(next);
    // HIS choice, started from the plan the rep had sent for that day — one tap when it is the usual
    // answer, and either way he can turn it.
    setPlanned(next.onSentPlan ? "planned" : "unplanned");
    idRef.current = null;
  }

  function toggleProduct(product: string, on: boolean) {
    setProducts((current) => (on ? (current.includes(product) ? current : [...current, product]) : current.filter((entry) => entry !== product)));
  }

  async function save() {
    if (!customer || planned === null) return;
    idRef.current ??= newClientId();
    const body = {
      record: "visit",
      seatId,
      test: isTest,
      id: idRef.current,
      customerId: customer.customerId,
      visitDate: form.date,
      visitTime: time,
      planned: planned === "planned",
      products,
      comment,
      reason: planned === "unplanned" ? reason : null,
    };
    // `body` carries `idRef.current`, so a Try again after a dropped connection re-sends the SAME
    // client id and the server recognises the visit it may already have filed. Clearing the id is
    // part of the completion for that reason — never before the save is through.
    await action.run(
      "visit",
      () => crmPost<EnteredMissedVisit>("/api/phoenix-crm/missed-records", body, "saved"),
      (saved) => {
        idRef.current = null;
        onSaved({ customerName: saved.customerName, kind: "visit", planned: saved.planned });
      },
    );
  }

  if (form.blockedReason) {
    return (
      <div className="grid min-w-0 gap-3">
        <CrmNote title="A visit cannot be entered here" tone="warn">
          {form.blockedReason}
        </CrmNote>
        <div>
          <CrmButton onClick={onCancel}>Back</CrmButton>
        </div>
      </div>
    );
  }

  const choosable = form.customers.filter((entry) => !entry.visited).length;

  return (
    <div className="grid min-w-0 gap-4">
      {choosable === 0 ? (
        <CrmNote tone="info">Every customer on the list already has a visit on this day.</CrmNote>
      ) : null}
      {!form.planSent ? (
        <CrmNote tone="info">No plan had been sent for this day, so every customer starts as unplanned. You can still choose planned.</CrmNote>
      ) : null}

      <CustomerPicker customers={form.customers} disabled={busy} onPick={pick} selectedId={customer?.customerId ?? null} />

      {customer ? (
        <>
          <CrmField label="Planned or unplanned">
            <CrmChoice<"planned" | "unplanned">
              columns={2}
              label="Planned or unplanned"
              onChange={(next) => setPlanned(next)}
              options={[
                { label: "Planned", note: "Counts at once", value: "planned" },
                { label: "Unplanned", note: "The manager, then SFE, approve it", value: "unplanned" },
              ]}
              value={planned}
            />
          </CrmField>

          {planned === "unplanned" ? (
            <CrmField
              hint={`${reasonLength} of ${UNPLANNED_REASON_MAX} characters · at least ${UNPLANNED_REASON_MIN}`}
              htmlFor="phoenix-crm-missed-visit-reason"
              label="Why the rep was there off the plan"
            >
              <textarea
                className={crmTextareaClassName}
                dir="auto"
                disabled={busy}
                id="phoenix-crm-missed-visit-reason"
                maxLength={UNPLANNED_REASON_MAX}
                onChange={(event) => setReason(event.target.value)}
                rows={3}
                value={reason}
              />
            </CrmField>
          ) : null}

          {/* `appearance-none`, as on every time input in the module: without it iOS draws its own rounded control. */}
          <CrmField
            className="sm:max-w-[14rem]"
            hint="Optional. Left empty, the visit is filed at noon."
            htmlFor="phoenix-crm-missed-visit-time"
            label="Time of the visit"
          >
            <input
              className={cn(crmInputClassName, "appearance-none")}
              disabled={busy}
              id="phoenix-crm-missed-visit-time"
              onChange={(event) => setTime(event.target.value)}
              step={300}
              type="time"
              value={time}
            />
          </CrmField>

          <CrmField hint={`${products.length} chosen · at most ${VISIT_PRODUCTS_MAX}`} label="Products discussed">
            <div className="grid min-w-0 gap-1.5 sm:grid-cols-2">
              {form.products.map((product) => (
                <CrmCheck
                  checked={products.includes(product)}
                  disabled={busy || (!products.includes(product) && products.length >= VISIT_PRODUCTS_MAX)}
                  key={product}
                  onChange={(on) => toggleProduct(product, on)}
                >
                  {product}
                </CrmCheck>
              ))}
            </div>
          </CrmField>

          <CrmField hint={`${comment.trim().length} of ${VISIT_COMMENT_MAX} characters`} htmlFor="phoenix-crm-missed-visit-comment" label="What happened on the visit">
            <textarea
              className={crmTextareaClassName}
              dir="auto"
              disabled={busy}
              id="phoenix-crm-missed-visit-comment"
              maxLength={VISIT_COMMENT_MAX}
              onChange={(event) => setComment(event.target.value)}
              rows={3}
              value={comment}
            />
          </CrmField>
        </>
      ) : null}

      {action.error ? <CrmSaveError message={action.error} onRetry={action.retry} title="Not saved" /> : null}
      <div className="grid gap-2 sm:flex sm:flex-wrap">
        <CrmButton busy={busy} disabled={!ready} onClick={() => void save()} variant="primary">
          Save the visit
        </CrmButton>
        <CrmButton disabled={busy} onClick={onCancel}>
          Back
        </CrmButton>
      </div>
    </div>
  );
}

function MissedActivityForm({
  form,
  isTest,
  onCancel,
  onSaved,
  seatId,
}: {
  form: MissedRecordForm;
  isTest: boolean;
  onCancel: () => void;
  onSaved: (entry: SavedEntry) => void;
  seatId: string;
}) {
  const action = useCrmAction();
  const current = form.dayActivity;
  const [activity, setActivity] = useState<PhoenixCrmDayActivity | null>(current?.activityType ?? null);
  const [halfDay, setHalfDay] = useState(current?.halfDay ?? false);
  const [note, setNote] = useState(current?.note ?? "");
  const busy = action.busy !== null;

  // 🔴 The rep's own record stays his: only a day he left empty, or one the Super Admin entered, is
  // offered here. The server refuses the rest anyway.
  if (current && form.activityIsRepsOwn) {
    return (
      <div className="grid min-w-0 gap-3">
        <CrmNote title="Recorded by the rep" tone="info">
          {`This day is recorded as ${current.activityLabel}${current.halfDay ? " (half day)" : ""}. It is the rep's own record, so it stays as recorded.`}
        </CrmNote>
        <div>
          <CrmButton onClick={onCancel}>Back</CrmButton>
        </div>
      </div>
    );
  }

  async function save() {
    if (activity === null) return;
    const body = { record: "activity", seatId, test: isTest, activityDate: form.date, activityType: activity, halfDay, note: note.trim() || null };
    await action.run(
      "activity",
      () => crmPost<ActivitySaved>("/api/phoenix-crm/missed-records", body, "saved"),
      (saved) => onSaved({ kind: "activity", label: saved.activity?.activityLabel ?? null }),
    );
  }

  async function clear() {
    const body = { record: "activity", seatId, test: isTest, activityDate: form.date, clear: true };
    await action.run(
      "clear",
      () => crmPost<ActivitySaved>("/api/phoenix-crm/missed-records", body, "saved"),
      () => onSaved({ kind: "cleared" }),
    );
  }

  return (
    <div className="grid min-w-0 gap-4">
      <CrmField label="What the day was">
        <CrmChoice<PhoenixCrmDayActivity>
          columns={3}
          label="What the day was"
          onChange={(next) => setActivity(next)}
          options={PHOENIX_CRM_DAY_ACTIVITIES.map((entry) => ({ label: entry.label, value: entry.key }))}
          value={activity}
        />
      </CrmField>
      <CrmCheck checked={halfDay} disabled={busy} onChange={setHalfDay}>
        Half day — the other half was field work
      </CrmCheck>
      <CrmField hint={`Optional · ${note.trim().length} of ${DAY_ACTIVITY_NOTE_MAX} characters`} htmlFor="phoenix-crm-missed-activity-note" label="Note">
        <textarea
          className={crmTextareaClassName}
          dir="auto"
          disabled={busy}
          id="phoenix-crm-missed-activity-note"
          maxLength={DAY_ACTIVITY_NOTE_MAX}
          onChange={(event) => setNote(event.target.value)}
          rows={3}
          value={note}
        />
      </CrmField>
      <p className="text-xs font-semibold text-slate-500">A record of the day only. It changes no figure, exactly as when the rep records it.</p>
      {action.error ? <CrmSaveError message={action.error} onRetry={action.retry} title="Not saved" /> : null}
      <div className="grid gap-2 sm:flex sm:flex-wrap">
        <CrmButton busy={action.busy === "activity"} disabled={activity === null || busy} onClick={() => void save()} variant="primary">
          Save the day&apos;s activity
        </CrmButton>
        {current ? (
          <CrmButton busy={action.busy === "clear"} disabled={busy} onClick={() => void clear()} variant="danger">
            Clear what you entered
          </CrmButton>
        ) : null}
        <CrmButton disabled={busy} onClick={onCancel}>
          Back
        </CrmButton>
      </div>
    </div>
  );
}

export function MissedRecordPanel({
  date,
  isTest,
  repName,
  seatId,
}: {
  date: string;
  isTest: boolean;
  repName: string | null;
  seatId: string;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode | null>(null);
  const [opened, setOpened] = useState(false);
  const [saved, setSaved] = useState<SavedEntry | null>(null);
  // Read once the panel is first opened, and again after every save — the customers already visited
  // that day change with each visit entered.
  const form = useCrmGet<MissedRecordForm>(opened ? crmUrl("/api/phoenix-crm/missed-records", { date, seatId, test: isTest }) : null, "form");

  function open(next: Mode) {
    setSaved(null);
    setMode(next);
    if (opened) form.reload();
    else setOpened(true);
  }

  function done(entry: SavedEntry) {
    setSaved(entry);
    setMode(null);
    form.reload();
    // The day above is the server's page: re-read it so the entry appears where it happened.
    router.refresh();
  }

  return (
    <CrmBlock className="border-t border-slate-100" title="Enter a missed record">
      <div className="grid min-w-0 gap-3">
        <p className="break-words text-xs font-semibold leading-5 text-slate-600">
          {`If ${repName ?? "the rep"} missed recording a visit or how ${dayLabelLong(date)} was spent, enter it here. A visit entered here has no location, and it shows as "${MISSED_RECORD_MARK}" to the rep, the managers and SFE.`}
        </p>
        {isTest ? (
          <CrmNote tone="info">Test mode is on, so what you enter here is a test entry and reaches no real report.</CrmNote>
        ) : null}
        {saved ? <SavedNote entry={saved} /> : null}

        {mode === null ? (
          <div className="grid gap-2 sm:flex sm:flex-wrap">
            <CrmButton onClick={() => open("visit")} variant="primary">
              Enter a missed visit
            </CrmButton>
            <CrmButton onClick={() => open("activity")}>Record how the day was spent</CrmButton>
          </div>
        ) : (
          <>
            {form.error ? <CrmLoadError message={form.error} onRetry={form.reload} /> : null}
            {!form.data && !form.error ? <CrmLoading label="Reading the day" /> : null}
            {form.data && mode === "visit" ? (
              <MissedVisitForm form={form.data} isTest={isTest} onCancel={() => setMode(null)} onSaved={done} seatId={seatId} />
            ) : null}
            {form.data && mode === "activity" ? (
              <MissedActivityForm
                // A fresh form for each read, so it starts from what the day holds now.
                form={form.data}
                isTest={isTest}
                key={`${form.data.dayActivity?.activityType ?? "none"}|${form.data.dayActivity?.enteredByAdmin ?? false}`}
                onCancel={() => setMode(null)}
                onSaved={done}
                seatId={seatId}
              />
            ) : null}
          </>
        )}
      </div>
    </CrmBlock>
  );
}
