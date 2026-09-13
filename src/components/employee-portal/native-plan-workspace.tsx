"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, RefreshCcw, RotateCcw, Save, Send, Trash2 } from "lucide-react";

import {
  PortalEmptyState,
  PortalRecordCard,
  PortalRecordFields,
  PortalSection,
  portalInputClassName,
} from "@/components/employee-portal/portal-primitives";
import { Button } from "@/components/ui/button";
import { nativePlanStatusLabel, type NativePlanItemOutcome, type NativePlanStatus } from "@/lib/crm/native-visits/plan-rules";
import type { NativePlanDayView, NativePlannerView, NativePlanWeekView } from "@/lib/crm/native-visits/plan-types";
import type { NativeVisitShift } from "@/lib/crm/native-visits/rules";
import type { NativeVisitContactOption } from "@/lib/crm/native-visits/types";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";

/**
 * The rep's weekly plan (pilot). The rep picks doctors from the rep's own AM and PM lists for each
 * day, and sends the week to the manager, who verifies it or returns it with a note. The whole week
 * goes up on every save; the server keeps each doctor's row and id, so nothing here tracks ids.
 */

const CONTACTS_SHOWN = 40;

const DAY_FORMAT = stableEnGbFormatter({
  day: "numeric",
  month: "long",
  timeZone: "Africa/Cairo",
  weekday: "long",
});
const SHORT_DAY_FORMAT = stableEnGbFormatter({
  day: "numeric",
  month: "short",
  timeZone: "Africa/Cairo",
});
const TIME_FORMAT = stableEnGbFormatter({
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  month: "short",
  timeZone: "Africa/Cairo",
});

type DraftItem = {
  planDate: string;
  contactCrmId: number;
  shift: NativeVisitShift;
  contactName: string;
  speciality: string | null;
  grade: string | null;
  outcome: NativePlanItemOutcome | null;
};

function dayLabel(isoDay: string) {
  return DAY_FORMAT.format(new Date(`${isoDay}T12:00:00Z`));
}

function weekLabel(week: { weekStart: string; weekEnd: string }) {
  return `${SHORT_DAY_FORMAT.format(new Date(`${week.weekStart}T12:00:00Z`))} to ${SHORT_DAY_FORMAT.format(new Date(`${week.weekEnd}T12:00:00Z`))}`;
}

function outcomeLabel(outcome: NativePlanItemOutcome | null) {
  if (outcome === "visited") return "Visited";
  if (outcome === "missed") return "Not visited";
  if (outcome === "due_today") return "Today";
  if (outcome === "upcoming") return "Planned";
  return "Not saved yet";
}

function statusAccent(status: NativePlanStatus | null) {
  if (status === "verified") return "emerald" as const;
  if (status === "submitted") return "amber" as const;
  if (status === "returned") return "rose" as const;
  if (status === "draft") return "sky" as const;
  return "slate" as const;
}

function draftsFrom(week: NativePlanWeekView): DraftItem[] {
  return week.items.map((item) => ({
    planDate: item.planDate,
    contactCrmId: item.contactCrmId,
    shift: item.shift,
    contactName: item.contactName,
    speciality: item.speciality,
    grade: item.grade,
    outcome: item.outcome,
  }));
}

function sameItems(left: readonly DraftItem[], right: readonly DraftItem[]) {
  const key = (item: DraftItem) => `${item.planDate}|${item.contactCrmId}|${item.shift}`;
  const a = left.map(key).sort();
  const b = right.map(key).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function NativePlanWorkspace() {
  const [planner, setPlanner] = useState<NativePlannerView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [weekStart, setWeekStart] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, DraftItem[]>>({});
  const [addingDay, setAddingDay] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const response = await fetch("/api/crm/native-visits/plans", { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as { planner?: NativePlannerView; message?: string } | null;
      if (!response.ok || !body?.planner) throw new Error(body?.message ?? "Could not load your plan.");
      const next = body.planner;
      setPlanner(next);
      setDrafts(Object.fromEntries(next.weeks.map((week) => [week.weekStart, draftsFrom(week)])));
      setWeekStart((current) =>
        current && next.weeks.some((week) => week.weekStart === current) ? current : next.weeks[0]?.weekStart ?? null,
      );
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load your plan.");
    }
  }, []);

  useEffect(() => {
    // The first fetch of the planner. Its state updates land after the request, not in this render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const week = planner?.weeks.find((candidate) => candidate.weekStart === weekStart) ?? null;
  const items = useMemo(() => (week ? drafts[week.weekStart] ?? [] : []), [drafts, week]);
  const dirty = week ? !sameItems(items, draftsFrom(week)) : false;

  function setItems(next: DraftItem[]) {
    if (!week) return;
    setDrafts((current) => ({ ...current, [week.weekStart]: next }));
    setMessage(null);
    setActionError(null);
  }

  function addItem(day: NativePlanDayView, contact: NativeVisitContactOption, shift: NativeVisitShift) {
    if (items.some((item) => item.planDate === day.date && item.contactCrmId === contact.contactCrmId)) return;
    setItems([
      ...items,
      {
        planDate: day.date,
        contactCrmId: contact.contactCrmId,
        shift,
        contactName: contact.name,
        speciality: contact.speciality,
        grade: contact.grade,
        outcome: null,
      },
    ]);
  }

  function removeItem(item: DraftItem) {
    setItems(items.filter((candidate) => !(candidate.planDate === item.planDate && candidate.contactCrmId === item.contactCrmId)));
  }

  async function send(action: "save" | "submit" | "reopen") {
    if (!week) return;
    setBusy(true);
    setActionError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/crm/native-visits/plans", {
        body: JSON.stringify({
          action,
          items: items.map((item) => ({ contactCrmId: item.contactCrmId, planDate: item.planDate, shift: item.shift })),
          revision: week.revision,
          weekStart: week.weekStart,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      if (!response.ok) throw new Error(body?.message ?? "Could not save your plan.");
      await load();
      setAddingDay(null);
      setMessage(
        action === "submit"
          ? "Your plan was sent to your manager."
          : action === "reopen"
            ? "Your plan is open for changes again. Send it once you are done, and it goes back to your manager."
            : "Your plan was saved.",
      );
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not save your plan.");
    } finally {
      setBusy(false);
    }
  }

  if (planner === null) {
    return (
      <div className="grid min-w-0 gap-4">
        {loadError ? <p className="border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{loadError}</p> : null}
        {loadError ? null : <p className="px-4 py-6 text-sm text-slate-500">Loading your plan</p>}
      </div>
    );
  }

  if (!planner.pilot || planner.weeks.length === 0) {
    return (
      <PortalSection eyebrow="Pilot" title="My weekly plan">
        <PortalEmptyState
          message="Planning in Phoenix is open only to the pilot line, for weeks with pilot days still ahead. Keep planning in iReports360."
          title="Nothing to plan here"
        />
      </PortalSection>
    );
  }

  const contactsById = new Map(planner.contacts.map((contact) => [contact.contactCrmId, contact]));
  const query = search.trim().toLowerCase();

  return (
    <div className="grid min-w-0 gap-4">
      {loadError ? <p className="border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{loadError}</p> : null}

      <div className="flex flex-wrap gap-2">
        {planner.weeks.map((candidate) => (
          <Button
            key={candidate.weekStart}
            onClick={() => {
              setWeekStart(candidate.weekStart);
              setAddingDay(null);
              setActionError(null);
              setMessage(null);
            }}
            type="button"
            variant={candidate.weekStart === weekStart ? "default" : "outline"}
          >
            {`Week of ${weekLabel(candidate)}`}
          </Button>
        ))}
      </div>

      {week ? (
        <>
          <PortalSection
            actions={
              <Button disabled={busy} onClick={() => void load()} size="sm" type="button" variant="outline">
                <RefreshCcw />
                Refresh
              </Button>
            }
            description={`The ${planner.pilot.lineName} pilot runs from ${dayLabel(planner.pilot.startsOn)} to ${dayLabel(planner.pilot.endsOn)}. Days that have passed are fixed.`}
            eyebrow="Pilot"
            title={`Week of ${weekLabel(week)}`}
          >
            <div className="grid gap-px bg-slate-100">
              <PortalRecordCard
                accent={statusAccent(week.status)}
                actions={
                  <div className="grid w-full gap-2">
                    <div className="flex flex-wrap gap-2">
                      {week.canEdit ? (
                        <>
                          <Button disabled={busy || !dirty} onClick={() => void send("save")} type="button" variant="outline">
                            <Save />
                            Save
                          </Button>
                          <Button disabled={busy || items.length === 0} onClick={() => void send("submit")} type="button">
                            <Send />
                            Send to my manager
                          </Button>
                        </>
                      ) : null}
                      {week.canReopen ? (
                        <Button disabled={busy} onClick={() => void send("reopen")} type="button" variant="outline">
                          <RotateCcw />
                          Reopen for changes
                        </Button>
                      ) : null}
                    </div>
                    {dirty ? <p className="text-sm text-amber-700">You have changes that are not saved yet.</p> : null}
                    {message ? <p className="text-sm text-emerald-700">{message}</p> : null}
                    {actionError ? <p className="text-sm text-red-700">{actionError}</p> : null}
                  </div>
                }
                meta={`${items.length} ${items.length === 1 ? "doctor" : "doctors"} planned`}
                status={
                  <span className="text-xs font-black uppercase tracking-[0.12em] text-slate-600">
                    {nativePlanStatusLabel(week.status)}
                  </span>
                }
                title="Plan status"
              >
                <PortalRecordFields
                  fields={[
                    { label: "Goes to", value: week.verifierName ?? planner.managerName ?? "No manager on record" },
                    { label: "Sent", value: week.submittedAt ? TIME_FORMAT.format(new Date(week.submittedAt)) : "Not yet" },
                    { label: "Answered", value: week.decidedAt ? TIME_FORMAT.format(new Date(week.decidedAt)) : "Not yet" },
                    { label: "Manager's note", value: week.decisionNote ?? "None" },
                  ]}
                />
              </PortalRecordCard>
            </div>
          </PortalSection>

          {week.days.map((day) => {
            const dayItems = items.filter((item) => item.planDate === day.date);
            const editable = week.canEdit && day.editable;
            const plannedIds = new Set(dayItems.map((item) => item.contactCrmId));
            const options = addingDay === day.date
              ? planner.contacts
                  .filter((contact) => !plannedIds.has(contact.contactCrmId))
                  .filter((contact) => contact.lists.some((list) => day.shifts.includes(list)))
                  .filter(
                    (contact) =>
                      !query ||
                      contact.name.toLowerCase().includes(query) ||
                      (contact.speciality ?? "").toLowerCase().includes(query),
                  )
              : [];
            return (
              <PortalSection
                actions={
                  editable ? (
                    <Button
                      disabled={busy}
                      onClick={() => {
                        setAddingDay(addingDay === day.date ? null : day.date);
                        setSearch("");
                      }}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      <Plus />
                      {addingDay === day.date ? "Close" : "Add a doctor"}
                    </Button>
                  ) : null
                }
                description={
                  day.shifts.length === 1
                    ? "Morning only."
                    : editable
                      ? "Morning and evening."
                      : "This day is fixed."
                }
                key={day.date}
                title={dayLabel(day.date)}
              >
                {day.doubleVisits.length > 0 ? (
                  <div className="grid gap-1 border-b border-slate-100 bg-sky-50 px-4 py-3 text-sm text-sky-800 sm:px-5">
                    {day.doubleVisits.map((visit, index) => (
                      <p className="break-words" key={`${visit.managerName}-${index}`}>
                        {`Double visit with ${visit.managerName}${visit.managerJobTitle ? ` (${visit.managerJobTitle})` : ""}: ${visit.title}`}
                      </p>
                    ))}
                  </div>
                ) : null}

                {addingDay === day.date ? (
                  <div className="grid min-w-0 gap-2 border-b border-slate-100 px-4 py-3 sm:px-5">
                    <input
                      aria-label="Search your doctors"
                      className={portalInputClassName}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Search your doctors by name or speciality"
                      value={search}
                    />
                    {options.length === 0 ? (
                      <p className="text-sm text-slate-500">No doctor on your lists matches.</p>
                    ) : (
                      <div className="grid max-h-80 min-w-0 gap-px overflow-y-auto border border-slate-100 bg-slate-100">
                        {options.slice(0, CONTACTS_SHOWN).map((contact) => {
                          const shifts = day.shifts.filter((shift) => contact.lists.includes(shift));
                          return (
                            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 bg-white px-3 py-2" key={contact.contactCrmId}>
                              <div className="grid min-w-0 gap-0.5">
                                <span className="break-words text-sm font-bold text-slate-900">{contact.name}</span>
                                <span className="break-words text-xs text-slate-500">
                                  {[contact.speciality, contact.grade ? `Grade ${contact.grade}` : null, contact.lists.join(" and ")]
                                    .filter(Boolean)
                                    .join(" · ")}
                                </span>
                              </div>
                              <div className="flex flex-wrap gap-2">
                                {shifts.map((shift) => (
                                  <Button key={shift} onClick={() => addItem(day, contact, shift)} size="sm" type="button">
                                    {`Add ${shift}`}
                                  </Button>
                                ))}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {options.length > CONTACTS_SHOWN ? (
                      <p className="text-xs text-slate-500">{`Showing ${CONTACTS_SHOWN} of ${options.length}. Search to narrow the list.`}</p>
                    ) : null}
                  </div>
                ) : null}

                {dayItems.length === 0 ? (
                  <p className="px-4 py-4 text-sm text-slate-500 sm:px-5">No doctors planned for this day.</p>
                ) : (
                  <div className="grid gap-px bg-slate-100">
                    {day.shifts.map((shift) =>
                      dayItems
                        .filter((item) => item.shift === shift)
                        .sort((left, right) => left.contactName.localeCompare(right.contactName))
                        .map((item) => {
                          const contact = contactsById.get(item.contactCrmId);
                          return (
                            <PortalRecordCard
                              accent={item.outcome === "visited" ? "emerald" : item.outcome === "missed" ? "rose" : "orange"}
                              actions={
                                editable && item.outcome !== "visited" ? (
                                  <Button disabled={busy} onClick={() => removeItem(item)} size="sm" type="button" variant="outline">
                                    <Trash2 />
                                    Remove
                                  </Button>
                                ) : null
                              }
                              key={`${item.planDate}-${item.contactCrmId}`}
                              meta={[item.shift, item.speciality ?? contact?.speciality, item.grade ? `Grade ${item.grade}` : null]
                                .filter(Boolean)
                                .join(" · ")}
                              status={
                                <span className="text-xs font-black uppercase tracking-[0.12em] text-slate-600">
                                  {outcomeLabel(item.outcome)}
                                </span>
                              }
                              title={item.contactName}
                            />
                          );
                        }),
                    )}
                  </div>
                )}
              </PortalSection>
            );
          })}
        </>
      ) : null}
    </div>
  );
}
