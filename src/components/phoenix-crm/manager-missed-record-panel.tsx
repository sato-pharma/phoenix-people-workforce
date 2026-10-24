"use client";

import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";

import { crmPost, crmUrl, newClientId, useCrmAction, useCrmGet } from "@/components/phoenix-crm/api";
import { dayLabelLong } from "@/components/phoenix-crm/format";
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
  CrmSelect,
  CrmShowMore,
  crmInputClassName,
  crmTextareaClassName,
} from "@/components/phoenix-crm/ui";
import { DAY_ACTIVITY_NOTE_MAX, PHOENIX_CRM_DAY_ACTIVITIES, type PhoenixCrmDayActivity } from "@/lib/phoenix-crm/day-activities";
import { MISSED_RECORD_MARK } from "@/lib/phoenix-crm/missed-records";
import type { DayActivityRow, EnteredManagerMissedVisit, ManagerMissedRecordCustomer, ManagerMissedRecordForm } from "@/lib/phoenix-crm/view-types";
import { cn } from "@/lib/utils";

/**
 * Phoenix CRM — the Super Admin enters what a MANAGER missed recording, on the manager's own day page (owner,
 * 2026-10-24, asked: "Visits and days").
 *
 * The rep's twin is `MissedRecordPanel`. A visit is a single visit of the manager's own, picked from Manager's
 * own list or from a territory he reaches; whether it was planned is read from HIS plan, so it is not asked.
 * A day is offered only to a district or regional manager, the two who record a day of their own. The server
 * decided whether the panel shows at all (`missedRecords`, null for everyone but the Super Admin) and asserts
 * the same gate again on every save.
 */

const PAGE = 20;
const COMMENT_MAX = 1000;
const PRODUCTS_MAX = 12;
const ADDRESS_MAX = 300;

type Mode = "visit" | "activity";
type SavedEntry = { kind: "visit"; customerName: string; planned: boolean } | { kind: "activity"; label: string | null } | { kind: "cleared" };

function SavedNote({ entry }: { entry: SavedEntry }) {
  if (entry.kind === "cleared") return <CrmNote tone="good">The day&apos;s activity you had entered is cleared.</CrmNote>;
  if (entry.kind === "activity") return <CrmNote tone="good">{`The day is recorded as ${entry.label ?? "you chose"}. It shows as "${MISSED_RECORD_MARK}".`}</CrmNote>;
  return (
    <CrmNote tone="good">
      The visit to <bdi>{entry.customerName}</bdi>
      {` is saved as ${entry.planned ? "planned" : "unplanned"}. It shows as "${MISSED_RECORD_MARK}".`}
    </CrmNote>
  );
}

function CustomerPicker({
  customers,
  disabled,
  onPick,
  selected,
}: {
  customers: ReadonlyArray<ManagerMissedRecordCustomer>;
  disabled: boolean;
  onPick: (customer: ManagerMissedRecordCustomer) => void;
  selected: ManagerMissedRecordCustomer | null;
}) {
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? customers.filter((customer) => customer.name.toLowerCase().includes(needle)) : customers;
  }, [customers, query]);
  const visible = matches.slice(0, shown);
  const keyOf = (customer: ManagerMissedRecordCustomer) => customer.customerId ?? customer.managerCustomerId ?? customer.name;

  return (
    <div className="grid min-w-0 gap-2">
      <CrmSearchField
        id="phoenix-crm-manager-missed-search"
        label="Customer"
        onChange={(next) => {
          setQuery(next);
          setShown(PAGE);
        }}
        placeholder="Type a name"
        value={query}
      />
      {matches.length === 0 ? (
        <p className="text-xs font-semibold text-slate-500">No customer on this list matches that name.</p>
      ) : (
        <div aria-label="Customer" className="grid min-w-0 gap-1.5" role="radiogroup">
          {visible.map((customer) => {
            const isSelected = selected !== null && keyOf(selected) === keyOf(customer);
            return (
              <button
                aria-checked={isSelected}
                className={cn(
                  "min-h-11 w-full min-w-0 rounded-none border px-3 py-2 text-left transition disabled:cursor-not-allowed disabled:opacity-60",
                  isSelected ? "border-orange-500 bg-orange-50" : "border-slate-200 bg-white hover:border-slate-300",
                )}
                disabled={disabled || customer.visited}
                key={keyOf(customer)}
                onClick={() => onPick(customer)}
                role="radio"
                type="button"
              >
                <span className="block break-words text-sm font-black text-slate-900">
                  <bdi>{customer.name}</bdi>
                </span>
                {customer.speciality ? (
                  <span className="mt-0.5 block break-words text-xs font-semibold text-slate-500">
                    <bdi>{customer.speciality}</bdi>
                  </span>
                ) : null}
                {customer.planned || customer.visited || customer.vacant ? (
                  <span className="mt-1 flex min-w-0 flex-wrap gap-1">
                    {customer.planned ? <CrmPill tone="good">Planned that day</CrmPill> : null}
                    {customer.vacant ? <CrmPill>Vacant area</CrmPill> : null}
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

function VisitForm({
  date,
  form,
  list,
  managerKey,
  onCancel,
  onList,
  onSaved,
}: {
  date: string;
  form: ManagerMissedRecordForm;
  list: string | null;
  managerKey: string;
  onCancel: () => void;
  onList: (next: string | null) => void;
  onSaved: (entry: SavedEntry) => void;
}) {
  const action = useCrmAction();
  // The entry's id, made the first time it is sent and kept until it saves: a retry is the SAME entry.
  const idRef = useRef<string | null>(null);
  const [customer, setCustomer] = useState<ManagerMissedRecordCustomer | null>(null);
  const [time, setTime] = useState("");
  const [products, setProducts] = useState<string[]>([]);
  const [comment, setComment] = useState("");
  const [address, setAddress] = useState("");
  const busy = action.busy !== null;
  const needsAddress = customer?.vacant === true;
  const ready = customer !== null && (!needsAddress || address.trim().length > 0);

  function pick(next: ManagerMissedRecordCustomer) {
    setCustomer(next);
    setAddress(next.knownAddress ?? "");
    idRef.current = null;
  }

  async function save() {
    if (!customer) return;
    idRef.current ??= newClientId();
    const body = {
      record: "manager-visit",
      manager: managerKey,
      id: idRef.current,
      customerId: customer.customerId,
      managerCustomerId: customer.managerCustomerId,
      visitDate: date,
      visitTime: time,
      products,
      comment,
      address: address.trim() || null,
    };
    await action.run(
      "visit",
      () => crmPost<EnteredManagerMissedVisit>("/api/phoenix-crm/missed-records", body, "saved"),
      (saved) => {
        idRef.current = null;
        onSaved({ customerName: saved.customerName, kind: "visit", planned: saved.planned });
      },
    );
  }

  return (
    <div className="grid min-w-0 gap-4">
      <CrmField htmlFor="phoenix-crm-manager-missed-list" label="Whose list">
        <CrmSelect
          disabled={busy}
          id="phoenix-crm-manager-missed-list"
          onChange={(event) => {
            setCustomer(null);
            onList(event.target.value || null);
          }}
          value={list ?? ""}
        >
          <option value="">Choose a list</option>
          {form.lists.map((entry) => (
            <option key={entry.key} value={entry.key}>
              {entry.note ? `${entry.name} · ${entry.note}` : entry.name}
            </option>
          ))}
        </CrmSelect>
      </CrmField>

      {list && form.list === list ? (
        <>
          {form.customers.length === 0 ? <CrmNote tone="info">Nobody is on this list.</CrmNote> : null}
          <CustomerPicker customers={form.customers} disabled={busy} onPick={pick} selected={customer} />
        </>
      ) : null}

      {customer ? (
        <>
          <p className="break-words text-xs font-semibold leading-5 text-slate-600">
            {customer.planned
              ? "This customer is on the manager's plan for that day, so the visit is filed as planned."
              : "This customer is not on the manager's plan for that day, so the visit is filed as unplanned."}
          </p>
          {/* `appearance-none`, as on every time input in the module: without it iOS draws its own rounded control. */}
          <CrmField className="sm:max-w-[14rem]" hint="Optional. Left empty, the visit is filed at noon." htmlFor="phoenix-crm-manager-missed-time" label="Time of the visit">
            <input
              className={cn(crmInputClassName, "appearance-none")}
              disabled={busy}
              id="phoenix-crm-manager-missed-time"
              onChange={(event) => setTime(event.target.value)}
              step={300}
              type="time"
              value={time}
            />
          </CrmField>
          <CrmField
            hint={needsAddress ? "Required: nobody holds this area, so the address is the only record of where the customer is." : "Optional."}
            htmlFor="phoenix-crm-manager-missed-address"
            label="Address"
          >
            <input
              className={crmInputClassName}
              dir="auto"
              disabled={busy}
              id="phoenix-crm-manager-missed-address"
              maxLength={ADDRESS_MAX}
              onChange={(event) => setAddress(event.target.value)}
              value={address}
            />
          </CrmField>
          {form.products.length > 0 ? (
            <CrmField hint={`Optional · ${products.length} chosen · at most ${PRODUCTS_MAX}`} label="Products discussed">
              <div className="grid min-w-0 gap-1.5 sm:grid-cols-2">
                {form.products.map((product) => (
                  <CrmCheck
                    checked={products.includes(product)}
                    disabled={busy || (!products.includes(product) && products.length >= PRODUCTS_MAX)}
                    key={product}
                    onChange={(on) => setProducts((current) => (on ? [...current, product] : current.filter((entry) => entry !== product)))}
                  >
                    {product}
                  </CrmCheck>
                ))}
              </div>
            </CrmField>
          ) : null}
          <CrmField hint={`Optional · ${comment.trim().length} of ${COMMENT_MAX} characters`} htmlFor="phoenix-crm-manager-missed-comment" label="What happened on the visit">
            <textarea
              className={crmTextareaClassName}
              dir="auto"
              disabled={busy}
              id="phoenix-crm-manager-missed-comment"
              maxLength={COMMENT_MAX}
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

function ActivityForm({
  form,
  managerKey,
  onCancel,
  onSaved,
}: {
  form: ManagerMissedRecordForm;
  managerKey: string;
  onCancel: () => void;
  onSaved: (entry: SavedEntry) => void;
}) {
  const action = useCrmAction();
  const current = form.dayActivity;
  const [activity, setActivity] = useState<PhoenixCrmDayActivity | null>(current?.activityType ?? null);
  const [halfDay, setHalfDay] = useState(current?.halfDay ?? false);
  const [note, setNote] = useState(current?.note ?? "");
  const busy = action.busy !== null;

  // 🔴 His own record stays his: only a day he left empty, or one the Super Admin entered, is offered here.
  if (current && form.activityIsOwn) {
    return (
      <div className="grid min-w-0 gap-3">
        <CrmNote title="Recorded by the manager" tone="info">
          {`This day is recorded as ${current.activityLabel}${current.halfDay ? " (half day)" : ""}. It is the manager's own record, so it stays as recorded.`}
        </CrmNote>
        <div>
          <CrmButton onClick={onCancel}>Back</CrmButton>
        </div>
      </div>
    );
  }

  async function save() {
    if (activity === null) return;
    const body = { record: "manager-activity", manager: managerKey, activityDate: form.date, activityType: activity, halfDay, note: note.trim() || null };
    await action.run(
      "activity",
      () => crmPost<{ cleared: boolean; activity: DayActivityRow | null }>("/api/phoenix-crm/missed-records", body, "saved"),
      (saved) => onSaved({ kind: "activity", label: saved.activity?.activityLabel ?? null }),
    );
  }

  async function clear() {
    const body = { record: "manager-activity", manager: managerKey, activityDate: form.date, clear: true };
    await action.run(
      "clear",
      () => crmPost<{ cleared: boolean; activity: DayActivityRow | null }>("/api/phoenix-crm/missed-records", body, "saved"),
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
      <CrmField hint={`Optional · ${note.trim().length} of ${DAY_ACTIVITY_NOTE_MAX} characters`} htmlFor="phoenix-crm-manager-missed-note" label="Note">
        <textarea
          className={crmTextareaClassName}
          dir="auto"
          disabled={busy}
          id="phoenix-crm-manager-missed-note"
          maxLength={DAY_ACTIVITY_NOTE_MAX}
          onChange={(event) => setNote(event.target.value)}
          rows={3}
          value={note}
        />
      </CrmField>
      <p className="text-xs font-semibold text-slate-500">A record of the day only. It changes no figure, exactly as when the manager records it.</p>
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

export function ManagerMissedRecordPanel({ date, managerKey, managerName }: { date: string; managerKey: string; managerName: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode | null>(null);
  const [opened, setOpened] = useState(false);
  const [list, setList] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedEntry | null>(null);
  const form = useCrmGet<ManagerMissedRecordForm>(opened ? crmUrl("/api/phoenix-crm/missed-records", { date, list, manager: managerKey }) : null, "form");

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

  const canRecordDay = form.data?.canRecordDay ?? true;

  return (
    <CrmBlock className="border-t border-slate-100" title="Enter a missed record">
      <div className="grid min-w-0 gap-3">
        <p className="break-words text-xs font-semibold leading-5 text-slate-600">
          {`If ${managerName} missed recording a single visit or how ${dayLabelLong(date)} was spent, enter it here. A visit entered here has no location, and it shows as "${MISSED_RECORD_MARK}".`}
        </p>
        {saved ? <SavedNote entry={saved} /> : null}

        {mode === null ? (
          <div className="grid gap-2 sm:flex sm:flex-wrap">
            <CrmButton onClick={() => open("visit")} variant="primary">
              Enter a missed visit
            </CrmButton>
            {canRecordDay ? <CrmButton onClick={() => open("activity")}>Record how the day was spent</CrmButton> : null}
          </div>
        ) : (
          <>
            {form.error ? <CrmLoadError message={form.error} onRetry={form.reload} /> : null}
            {!form.data && !form.error ? <CrmLoading label="Reading the day" /> : null}
            {form.data && mode === "visit" ? (
              <VisitForm date={date} form={form.data} list={list} managerKey={managerKey} onCancel={() => setMode(null)} onList={setList} onSaved={done} />
            ) : null}
            {form.data && mode === "activity" ? (
              form.data.canRecordDay ? (
                <ActivityForm
                  form={form.data}
                  key={`${form.data.dayActivity?.activityType ?? "none"}|${form.data.dayActivity?.enteredByAdmin ?? false}`}
                  managerKey={managerKey}
                  onCancel={() => setMode(null)}
                  onSaved={done}
                />
              ) : (
                <CrmNote tone="info">A national sales manager and a product manager record no day of their own, so only a visit can be entered.</CrmNote>
              )
            ) : null}
          </>
        )}
      </div>
    </CrmBlock>
  );
}
