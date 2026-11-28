"use client";

/**
 * Phoenix CRM — the Focus list tab (owner, 2026-11-28).
 *
 *   - The REP reads his PM customers in focus, grouped by grade then brick, with the reason and where each one
 *     stands; he adds one (a written reason, required, and a pick, optional) and returns one to the normal list.
 *     🔴 No visit count and no last visit on his screen (Golden rule #1, the blind half).
 *   - A MANAGER picks a rep (or all of them) and a From–To period, decides the pushes waiting on him first
 *     (Keep or Return), and reads the tracking: visits in the period, per field week, the weekly average, and the
 *     latest visit — when it was saved, where, and by whom. He adds a PM customer from a rep's list too.
 *
 * Square edges, no horizontal scroll: a table from `md` up, cards on a phone, every cell wrapping.
 */

import { useMemo, useState } from "react";

import { crmPost, crmUrl, messageOf, useCrmGet } from "@/components/phoenix-crm/api";
import { dayLabel, plural, visitMomentText } from "@/components/phoenix-crm/format";
import {
  CrmButton,
  CrmCard,
  CrmCardsOnPhone,
  CrmChoice,
  CrmEmpty,
  CrmField,
  CrmLoadError,
  CrmLoading,
  CrmNote,
  CrmPanel,
  CrmPill,
  CrmSearchField,
  CrmSelect,
  CrmTable,
  crmInputClassName,
  crmTdClassName,
  crmTextareaClassName,
  crmThClassName,
} from "@/components/phoenix-crm/ui";
import {
  FOCUS_REASON_MAX,
  FOCUS_REASON_PICKS,
  groupFocusEntries,
  type FocusCandidate,
  type FocusEntry,
  type FocusListView,
  type FocusReasonPick,
} from "@/lib/phoenix-crm/focus-list-rules";

const FOCUS_API = "/api/phoenix-crm/focus";

type Filters = { seatId: string; from: string; to: string };

export function FocusListTab({ test }: { test: boolean }) {
  const [filters, setFilters] = useState<Filters>({ seatId: "", from: "", to: "" });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const resource = useCrmGet<FocusListView>(
    crmUrl(FOCUS_API, { seatId: filters.seatId || null, test, from: filters.from || null, to: filters.to || null }),
    "focus",
  );
  const view = resource.data;

  async function act(entry: FocusEntry, action: "keep" | "return") {
    setBusyId(entry.id);
    setActionError(null);
    try {
      await crmPost<string>(FOCUS_API, { action, focusId: entry.id, test }, "focusId");
      resource.reload();
    } catch (cause) {
      setActionError(messageOf(cause));
    } finally {
      setBusyId(null);
    }
  }

  if (!view) {
    return (
      <CrmPanel eyebrow="Focus list" title="Focus list">
        {resource.error ? <CrmLoadError message={resource.error} onRetry={resource.reload} /> : <CrmLoading label="Loading the Focus list" />}
      </CrmPanel>
    );
  }

  const manager = view.mode === "manager";
  const waiting = manager ? view.entries.filter((entry) => entry.reviewStatus === "waiting") : [];
  const listed = manager ? view.entries.filter((entry) => entry.reviewStatus !== "waiting") : view.entries;

  return (
    <div className="min-w-0 space-y-4">
      <CrmPanel
        actions={
          view.canPush ? (
            <CrmButton onClick={() => setAdding((open) => !open)} variant={adding ? "secondary" : "primary"}>
              {adding ? "Close" : "Add a PM customer"}
            </CrmButton>
          ) : null
        }
        description={
          manager
            ? "The PM customers your reps put in focus, and how often each one is visited."
            : "The PM customers in focus on your list, grouped by grade and brick. They stay on your normal list too."
        }
        eyebrow="Focus list"
        title={manager ? "Focus list tracking" : "Your Focus list"}
      >
        {manager ? <ManagerFilters filters={filters} key={`${view.period?.from}|${view.period?.to}`} onChange={setFilters} view={view} /> : null}
        {adding && view.canPush ? (
          <AddFocusCustomer
            onAdded={() => {
              setAdding(false);
              resource.reload();
            }}
            seatId={view.selected}
            test={test}
          />
        ) : null}
        {actionError ? (
          <div className="px-4 pb-3 sm:px-5">
            <CrmNote tone="bad">{actionError}</CrmNote>
          </div>
        ) : null}
        {resource.error ? <CrmLoadError message={resource.error} onRetry={resource.reload} /> : null}
        {resource.loading ? <CrmLoading label="Loading the Focus list" /> : null}
      </CrmPanel>

      {manager && waiting.length > 0 ? (
        <CrmPanel
          description="A rep put these on the Focus list. Keep them, or return them to the normal list."
          eyebrow="Waiting your decision"
          title={plural(waiting.length, "PM customer to decide", "PM customers to decide")}
        >
          <FocusGroups busyId={busyId} entries={waiting} manager onAct={act} view={view} />
        </CrmPanel>
      ) : null}

      <CrmPanel
        eyebrow={manager ? "On the Focus list" : "In focus"}
        title={plural(listed.length, "PM customer", "PM customers")}
      >
        {listed.length === 0 ? (
          <CrmEmpty
            message={
              view.canPush
                ? "Add a PM customer from the list, with why it needs focus."
                : manager
                  ? "Nothing is on the Focus list for this choice yet."
                  : "Nothing is on your Focus list yet."
            }
            title="The Focus list is empty"
          />
        ) : (
          <FocusGroups busyId={busyId} entries={listed} manager={manager} onAct={act} view={view} />
        )}
      </CrmPanel>
    </div>
  );
}

function ManagerFilters({ filters, onChange, view }: { filters: Filters; onChange: (next: Filters) => void; view: FocusListView }) {
  // Started from the period the server answered; the parent's `key` starts it afresh when that period moves.
  const [from, setFrom] = useState(view.period?.from ?? "");
  const [to, setTo] = useState(view.period?.to ?? "");
  return (
    <div className="grid min-w-0 gap-3 border-b border-slate-100 px-4 py-4 sm:grid-cols-2 sm:px-5 lg:grid-cols-4">
      <CrmField htmlFor="focus-rep" label="Rep">
        <CrmSelect id="focus-rep" onChange={(event) => onChange({ ...filters, seatId: event.target.value })} value={view.selected}>
          <option value="all">All my reps</option>
          {view.territories.map((territory) => (
            <option key={territory.seatId} value={territory.seatId}>
              {territory.repNames.length > 0 ? `${territory.repNames.join(" and ")} · ${territory.name}` : `Vacant · ${territory.name}`}
            </option>
          ))}
        </CrmSelect>
      </CrmField>
      <CrmField htmlFor="focus-from" label="From">
        <input className={`${crmInputClassName} appearance-none`} id="focus-from" max={view.today} onChange={(event) => setFrom(event.target.value)} type="date" value={from} />
      </CrmField>
      <CrmField htmlFor="focus-to" label="To">
        <input className={`${crmInputClassName} appearance-none`} id="focus-to" max={view.today} onChange={(event) => setTo(event.target.value)} type="date" value={to} />
      </CrmField>
      <div className="flex min-w-0 items-end">
        <CrmButton className="w-full" onClick={() => onChange({ ...filters, from, to })} variant="primary">
          Show this period
        </CrmButton>
      </div>
    </div>
  );
}

function FocusGroups({
  busyId,
  entries,
  manager,
  onAct,
  view,
}: {
  busyId: string | null;
  entries: FocusEntry[];
  manager: boolean;
  onAct: (entry: FocusEntry, action: "keep" | "return") => void;
  view: FocusListView;
}) {
  const groups = useMemo(() => groupFocusEntries(entries), [entries]);
  return (
    <div className="min-w-0 divide-y divide-slate-100">
      {groups.map((group) => (
        <section className="min-w-0" key={group.grade}>
          <div className="flex flex-wrap items-center gap-2 bg-slate-50 px-4 py-2.5 sm:px-5">
            <h3 className="text-sm font-black text-slate-950">{group.grade === "No grade" ? group.grade : `Grade ${group.grade}`}</h3>
            <CrmPill>{plural(group.count, "PM customer", "PM customers")}</CrmPill>
          </div>
          {group.bricks.map((brick) => (
            <div className="min-w-0" key={brick.brick}>
              <p className="border-t border-slate-100 px-4 pt-3 text-phx-sm font-black uppercase tracking-[0.12em] text-orange-600 sm:px-5">{brick.brick}</p>
              {manager ? (
                <ManagerRows busyId={busyId} entries={brick.entries} onAct={onAct} view={view} />
              ) : (
                <div className="divide-y divide-slate-100">
                  {brick.entries.map((entry) => (
                    <CrmCard
                      actions={
                        entry.canReturn ? (
                          <CrmButton busy={busyId === entry.id} onClick={() => onAct(entry, "return")} size="sm">
                            Back to the normal list
                          </CrmButton>
                        ) : null
                      }
                      key={entry.id}
                      meta={entry.speciality}
                      status={<CrmPill tone={entry.reviewStatus === "waiting" ? "warn" : "good"}>{entry.standing}</CrmPill>}
                      title={entry.customerName}
                    >
                      <Reason entry={entry} />
                    </CrmCard>
                  ))}
                </div>
              )}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

function Reason({ entry }: { entry: FocusEntry }) {
  return (
    <p className="break-words text-sm font-medium leading-6 text-slate-700">
      {entry.reasonPickLabel ? <span className="font-black text-slate-950">{entry.reasonPickLabel}: </span> : null}
      {entry.reason}
    </p>
  );
}

function Actions({ busyId, entry, onAct }: { busyId: string | null; entry: FocusEntry; onAct: (entry: FocusEntry, action: "keep" | "return") => void }) {
  if (!entry.canKeep && !entry.canReturn) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {entry.canKeep ? (
        <CrmButton busy={busyId === entry.id} onClick={() => onAct(entry, "keep")} size="sm" variant="primary">
          Keep
        </CrmButton>
      ) : null}
      {entry.canReturn ? (
        <CrmButton busy={busyId === entry.id} onClick={() => onAct(entry, "return")} size="sm">
          Return to normal list
        </CrmButton>
      ) : null}
    </div>
  );
}

function WeekStrip({ entry }: { entry: FocusEntry }) {
  const weeks = entry.tracking?.weeks ?? [];
  if (weeks.length === 0) return null;
  return (
    <div aria-label="Visits by week" className="mt-1.5 flex flex-wrap gap-1">
      {weeks.map((week) => (
        <span
          className={
            week.visits > 0
              ? "inline-flex min-w-7 justify-center border border-orange-200 bg-orange-50 px-1 py-0.5 text-phx-sm font-black text-orange-700"
              : "inline-flex min-w-7 justify-center border border-slate-200 bg-white px-1 py-0.5 text-phx-sm font-black text-slate-400"
          }
          key={week.weekStart}
          title={`Week of ${dayLabel(week.weekStart)}: ${plural(week.visits, "visit", "visits")}`}
        >
          {week.visits}
        </span>
      ))}
    </div>
  );
}

function Frequency({ entry }: { entry: FocusEntry }) {
  const tracking = entry.tracking;
  if (!tracking) return null;
  return (
    <div className="min-w-0">
      <p className="text-sm font-black text-slate-950">{plural(tracking.visits, "visit", "visits")}</p>
      <p className="text-xs font-semibold text-slate-500">{`${tracking.weeklyAverage} a week on average`}</p>
      <WeekStrip entry={entry} />
    </div>
  );
}

function LastVisit({ entry, today }: { entry: FocusEntry; today: string }) {
  const last = entry.tracking?.last ?? null;
  if (!last) return <p className="text-sm font-semibold text-slate-500">Not visited yet</p>;
  const where = [last.place, last.address].filter(Boolean).join(", ");
  return (
    <div className="min-w-0 space-y-0.5 text-sm">
      <p className="font-black text-slate-950">{visitMomentText({ date: last.day, at: last.savedAt }, today, { saved: true })}</p>
      <p className="text-xs font-semibold text-slate-600">{last.imported ? `${last.kind}, from the old CRM` : last.kind}</p>
      {where ? <p className="break-words text-xs font-semibold text-slate-600">{where}</p> : null}
      {last.brick ? <p className="break-words text-xs font-semibold text-slate-500">{`Brick ${last.brick}`}</p> : null}
      {last.by ? <p className="break-words text-xs font-semibold text-slate-500">{`By ${last.by}`}</p> : null}
    </div>
  );
}

function WhoAndWhy({ entry }: { entry: FocusEntry }) {
  const by = entry.pushedAs === "manager" ? `Added by ${entry.pushedByName ?? "a manager"}` : `Put in focus by ${entry.pushedByName ?? "the rep"}`;
  return (
    <div className="min-w-0 space-y-1">
      <Reason entry={entry} />
      <p className="text-xs font-semibold text-slate-500">{`${by}, ${dayLabel(entry.pushedAt.slice(0, 10))}`}</p>
    </div>
  );
}

function ManagerRows({
  busyId,
  entries,
  onAct,
  view,
}: {
  busyId: string | null;
  entries: FocusEntry[];
  onAct: (entry: FocusEntry, action: "keep" | "return") => void;
  view: FocusListView;
}) {
  return (
    <div className="min-w-0 px-0 pb-2 pt-1">
      <CrmCardsOnPhone>
        {entries.map((entry) => (
          <CrmCard
            actions={<Actions busyId={busyId} entry={entry} onAct={onAct} />}
            key={entry.id}
            meta={[entry.speciality, (entry.repNames ?? []).join(" and ") || "Vacant territory", entry.territoryName].filter(Boolean).join(" · ")}
            status={entry.reviewStatus === "waiting" ? <CrmPill tone="warn">Waiting your decision</CrmPill> : null}
            title={entry.customerName}
          >
            <div className="grid min-w-0 gap-3">
              <WhoAndWhy entry={entry} />
              <Frequency entry={entry} />
              <LastVisit entry={entry} today={view.today} />
            </div>
          </CrmCard>
        ))}
      </CrmCardsOnPhone>
      <CrmTable columns={["22%", "26%", "17%", "21%", "14%"]}>
        <thead>
          <tr>
            <th className={crmThClassName}>PM customer</th>
            <th className={crmThClassName}>Why in focus</th>
            <th className={crmThClassName}>Visits in period</th>
            <th className={crmThClassName}>Last visit</th>
            <th className={crmThClassName}>Decide</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id}>
              <td className={crmTdClassName}>
                <p className="font-black text-slate-950">{entry.customerName}</p>
                {entry.speciality ? <p className="text-xs font-semibold text-slate-500">{entry.speciality}</p> : null}
                <p className="text-xs font-semibold text-slate-500">{(entry.repNames ?? []).join(" and ") || "Vacant territory"}</p>
                <p className="text-xs font-semibold text-slate-400">{entry.territoryName}</p>
              </td>
              <td className={crmTdClassName}>
                <WhoAndWhy entry={entry} />
              </td>
              <td className={crmTdClassName}>
                <Frequency entry={entry} />
              </td>
              <td className={crmTdClassName}>
                <LastVisit entry={entry} today={view.today} />
              </td>
              <td className={crmTdClassName}>
                <Actions busyId={busyId} entry={entry} onAct={onAct} />
              </td>
            </tr>
          ))}
        </tbody>
      </CrmTable>
    </div>
  );
}

function AddFocusCustomer({ onAdded, seatId, test }: { onAdded: () => void; seatId: string; test: boolean }) {
  const read = useCrmGet<FocusCandidate[]>(crmUrl(FOCUS_API, { candidates: 1, seatId, test }), "candidates");
  const candidates = read.data;
  const [search, setSearch] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [reason, setReason] = useState("");
  const [pick, setPick] = useState<FocusReasonPick | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const shown = useMemo(() => {
    const words = search.trim().toLowerCase();
    const list = candidates ?? [];
    return words ? list.filter((candidate) => `${candidate.name} ${candidate.speciality ?? ""} ${candidate.brick ?? ""}`.toLowerCase().includes(words)) : list;
  }, [candidates, search]);

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      await crmPost<string>(FOCUS_API, { action: "push", seatId, customerId, reason, reasonPick: pick, test }, "focusId");
      onAdded();
    } catch (cause) {
      setSaveError(messageOf(cause));
    } finally {
      setSaving(false);
    }
  }

  if (read.error) return <CrmLoadError message={read.error} onRetry={read.reload} />;
  if (!candidates) return <CrmLoading label="Loading the PM customers" />;

  return (
    <div className="grid min-w-0 gap-4 border-b border-slate-100 px-4 py-4 sm:px-5">
      {candidates.length === 0 ? (
        <CrmNote>Every PM customer on this list is on the Focus list already.</CrmNote>
      ) : (
        <>
          <CrmSearchField id="focus-search" label="Find the PM customer" onChange={setSearch} placeholder="Name, speciality or brick" value={search} />
          <CrmField htmlFor="focus-customer" label="PM customer">
            <CrmSelect id="focus-customer" onChange={(event) => setCustomerId(event.target.value)} value={customerId}>
              <option value="">Pick a PM customer</option>
              {shown.map((candidate) => (
                <option key={candidate.customerId} value={candidate.customerId}>
                  {[candidate.name, candidate.grade ? `Grade ${candidate.grade}` : null, candidate.brick].filter(Boolean).join(" · ")}
                </option>
              ))}
            </CrmSelect>
          </CrmField>
          <CrmField hint="Required: what makes this PM customer worth the focus." htmlFor="focus-reason" label="Why in focus">
            <textarea
              className={crmTextareaClassName}
              id="focus-reason"
              maxLength={FOCUS_REASON_MAX}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
              value={reason}
            />
          </CrmField>
          <CrmChoice
            label="Pick one too (optional)"
            onChange={(next) => setPick((current) => (current === next ? null : next))}
            options={FOCUS_REASON_PICKS.map((option) => ({ value: option.value, label: option.label }))}
            value={pick}
          />
          {saveError ? <CrmNote tone="bad">{saveError}</CrmNote> : null}
          <div className="flex flex-wrap gap-2">
            <CrmButton busy={saving} disabled={!customerId || reason.trim().length < 3} onClick={() => void save()} variant="primary">
              Put on the Focus list
            </CrmButton>
          </div>
        </>
      )}
    </div>
  );
}
