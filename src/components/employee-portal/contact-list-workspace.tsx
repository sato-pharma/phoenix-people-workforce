"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Plus, RefreshCcw, Search, Send, Undo2, XCircle } from "lucide-react";

import {
  PortalEmptyState,
  PortalRecordCard,
  PortalRecordFields,
  PortalSection,
  PortalSegmentedTabs,
  PortalSkeleton,
  portalInputClassName,
} from "@/components/employee-portal/portal-primitives";
import { Button } from "@/components/ui/button";
import {
  CONTACT_LIST_GRADES,
  CONTACT_LIST_SHIFTS,
  contactListActionLabel,
  contactListStatusLabel,
  type ContactListChangeStatus,
  type ContactListGrade,
  type ContactListShift,
} from "@/lib/crm/contact-lists/rules";
import type {
  ContactListChangeRow,
  ContactListEntry,
  ContactListSearchResult,
  ContactListView,
} from "@/lib/crm/contact-lists/types";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";
import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";

/**
 * Doctor lists maintained in Phoenix (CRM phase 7). A rep asks for a change to his own AM or PM list
 * and his manager approves or refuses it with his own click; the SFE Manager and the administrator
 * change a rep's list directly. Rows a viewer may not act on arrive without the buttons — the server
 * decides. Shared by the employee portal (reps and managers) and the admin shell (the editors).
 */

const ENDPOINT = "/api/crm/contact-lists";

const DAY_FORMAT = stableEnGbFormatter({ day: "numeric", month: "long", timeZone: "Africa/Cairo", year: "numeric" });
const TIME_FORMAT = stableEnGbFormatter({
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  month: "short",
  timeZone: "Africa/Cairo",
});

const labelClassName = "text-phx-sm font-black uppercase tracking-[0.12em] text-slate-500";

function dayLabel(isoDay: string | null) {
  return isoDay ? DAY_FORMAT.format(new Date(`${isoDay.slice(0, 10)}T12:00:00Z`)) : "Unknown";
}

function accentFor(status: ContactListChangeStatus) {
  if (status === "approved") return "emerald" as const;
  if (status === "rejected") return "rose" as const;
  if (status === "cancelled") return "slate" as const;
  return "amber" as const;
}

function changeTitle(row: ContactListChangeRow) {
  return `${contactListActionLabel(row.action)} · ${row.doctorName}`;
}

function changeFields(row: ContactListChangeRow, withRep: boolean) {
  return [
    ...(withRep ? [{ label: "Rep", value: row.repName }] : []),
    { label: "List", value: `${row.listType}${row.grade ? ` · grade ${row.grade}` : ""}` },
    { label: "Speciality", value: row.doctorSpeciality ?? "Not recorded" },
    { label: "Reason", value: row.reason },
    { label: "Asked by", value: `${row.requestedByName} · ${TIME_FORMAT.format(new Date(row.createdAt))}` },
    ...(row.direct ? [] : [{ label: "Manager", value: row.managerName ?? "None" }]),
    ...(row.decidedByName && row.decidedAt
      ? [{ label: "Decided", value: `${row.decidedByName} · ${TIME_FORMAT.format(new Date(row.decidedAt))}` }]
      : []),
    ...(row.decisionNote ? [{ label: "Note", value: row.decisionNote }] : []),
  ];
}

type EditTarget = { entry: ContactListEntry; action: "remove" | "regrade" };

/** Where a send result belongs: "add" for the "Add a doctor" form, else the entryKey of the list row
 * whose editor sent it. */
type FormScope = string;

function entryKey(entry: Pick<ContactListEntry, "contactCrmId" | "listType">) {
  return `${entry.contactCrmId}-${entry.listType}`;
}

/**
 * A send result, printed INSIDE the form that sent it. It used to sit at the top of the page, while
 * the rep submits from a row editor or from "Add a doctor" further down — so on a phone the answer
 * to "did my request go?" was a screen and a half above his thumb, and he never saw it.
 */
function FormMessage({ error, note }: { error: string | null; note: string | null }) {
  if (!error && !note) return null;
  return (
    <div className="grid min-w-0 gap-2">
      {error ? (
        <p className="break-words border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      ) : null}
      {note ? (
        <p className="break-words border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800" role="status">
          {note}
        </p>
      ) : null}
    </div>
  );
}

export function ContactListWorkspace() {
  const [view, setView] = useState<ContactListView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [repHrId, setRepHrId] = useState("");
  const [filter, setFilter] = useState("");

  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [editGrade, setEditGrade] = useState<ContactListGrade | "">("");
  const [editReason, setEditReason] = useState("");

  const [searchTerm, setSearchTerm] = useState("");
  const [results, setResults] = useState<ContactListSearchResult[] | null>(null);
  const [chosen, setChosen] = useState<ContactListSearchResult | null>(null);
  const [describeNew, setDescribeNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newSpeciality, setNewSpeciality] = useState("");
  const [newAddress, setNewAddress] = useState("");
  const [addList, setAddList] = useState<ContactListShift>("AM");
  const [addGrade, setAddGrade] = useState<ContactListGrade | "">("");
  const [addReason, setAddReason] = useState("");

  // The AM and PM lists are shown one at a time, each with its own count — never one merged list.
  const [listShift, setListShift] = useState<ContactListShift>("AM");

  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formNote, setFormNote] = useState<string | null>(null);
  const [formScope, setFormScope] = useState<FormScope | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});

  const load = useCallback(async (rep: string) => {
    setLoadError(null);
    try {
      const url = rep ? `${ENDPOINT}?rep=${encodeURIComponent(rep)}` : ENDPOINT;
      const response = await fetch(url, { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as { view?: ContactListView; message?: string } | null;
      if (!response.ok || !body?.view) throw new Error(body?.message ?? "Could not load the doctor list.");
      setView(body.view);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load the doctor list.");
    }
  }, []);

  useEffect(() => {
    void load(repHrId);
  }, [load, repHrId]);

  async function post(payload: Record<string, unknown>, fallback: string) {
    const response = await fetch(ENDPOINT, {
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    if (!response.ok) throw new Error(body?.message ?? fallback);
  }

  const direct = Boolean(view?.canEditDirectly);
  const mayChange = Boolean(view?.inForce && view.rep && (view.canRequest || view.canEditDirectly));
  const sendLabel = direct ? "Apply now" : "Send to my manager";

  async function sendChange(change: Record<string, unknown>, scope: FormScope) {
    setFormBusy(true);
    setFormError(null);
    setFormNote(null);
    setFormScope(scope);
    try {
      if (direct) {
        await post({ action: "apply", change: { ...change, repHrId: view?.rep?.hrId } }, "Could not change the list.");
      } else {
        await post({ action: "request", change }, "Could not send your request.");
      }
      setFormNote(direct ? "The list is changed." : "Sent to your manager. The list changes once they approve.");
      return true;
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Could not save that.");
      return false;
    } finally {
      setFormBusy(false);
    }
  }

  async function submitEdit() {
    if (!editing) return;
    const saved = await sendChange(
      {
        action: editing.action,
        contactCrmId: editing.entry.contactCrmId,
        grade: editing.action === "regrade" ? editGrade : null,
        listType: editing.entry.listType,
        reason: editReason,
      },
      entryKey(editing.entry),
    );
    if (saved) {
      setEditing(null);
      setEditGrade("");
      setEditReason("");
      await load(repHrId);
    }
  }

  async function submitAdd() {
    const saved = await sendChange(
      {
        action: "add",
        contactCrmId: chosen && !describeNew ? chosen.contactCrmId : null,
        grade: addGrade,
        listType: addList,
        newContact: describeNew ? { address: newAddress, name: newName, speciality: newSpeciality } : null,
        reason: addReason,
      },
      "add",
    );
    if (saved) {
      setChosen(null);
      setResults(null);
      setSearchTerm("");
      setDescribeNew(false);
      setNewName("");
      setNewSpeciality("");
      setNewAddress("");
      setAddGrade("");
      setAddReason("");
      await load(repHrId);
    }
  }

  async function runSearch() {
    setFormError(null);
    setFormNote(null);
    setFormScope("add");
    try {
      const response = await fetch(`${ENDPOINT}?search=${encodeURIComponent(searchTerm.trim())}`, { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as { doctors?: ContactListSearchResult[]; message?: string } | null;
      if (!response.ok || !body?.doctors) throw new Error(body?.message ?? "Could not search.");
      setResults(body.doctors);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Could not search.");
    }
  }

  async function act(row: ContactListChangeRow, payload: Record<string, unknown>, fallback: string) {
    setBusyId(row.id);
    setRowError((current) => ({ ...current, [row.id]: "" }));
    try {
      await post(payload, fallback);
      await load(repHrId);
    } catch (error) {
      setRowError((current) => ({ ...current, [row.id]: error instanceof Error ? error.message : fallback }));
    } finally {
      setBusyId(null);
    }
  }

  const shownEntries = useMemo(() => {
    const term = filter.trim().toLowerCase();
    const entries = (view?.entries ?? []).filter((entry) => entry.listType === listShift);
    return term
      ? entries.filter((entry) => `${entry.name} ${entry.speciality ?? ""}`.toLowerCase().includes(term))
      : entries;
  }, [filter, listShift, view?.entries]);

  const refresh = (
    <Button onClick={() => void load(repHrId)} size="sm" type="button" variant="outline">
      <RefreshCcw />
      Refresh
    </Button>
  );

  if (!view) {
    return loadError ? (
      <p className="border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{loadError}</p>
    ) : (
      <div aria-busy="true" className="grid min-w-0 gap-4">
        <span className="sr-only">Loading the doctor list</span>
        <PortalSkeleton className="h-28 w-full" />
        <PortalSkeleton className="h-48 w-full" />
      </div>
    );
  }

  const waiting = view.toDecide.filter((row) => row.canDecide);
  const answered = view.toDecide.filter((row) => !row.canDecide);
  const amCount = view.entries.filter((entry) => entry.listType === "AM").length;
  const pmCount = view.entries.filter((entry) => entry.listType === "PM").length;
  // A row-editor result whose row is no longer on screen (a direct removal, or a filter) still has to
  // land somewhere the viewer is looking: the top of the list section it came from.
  const rowScopeHidden =
    formScope !== null && formScope !== "add" && !shownEntries.some((entry) => entryKey(entry) === formScope);

  return (
    <div className="grid min-w-0 gap-4">
      {loadError ? <p className="border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{loadError}</p> : null}

      {!view.inForce ? (
        <p className="border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {view.rep
            ? `${view.rep.name}'s doctor list still comes from iReports360, so it cannot be changed here yet — their team has not started in Phoenix CRM.`
            : view.cutoverDate
              ? `Doctor lists still come from iReports360. Changes open here on ${dayLabel(view.cutoverDate)}.`
              : "Doctor lists still come from iReports360 for every team. A team's list opens here the day it starts in Phoenix CRM."}
        </p>
      ) : null}

      {view.canEditDirectly ? (
        <PortalSection description="Choose the rep whose list you want to see or change." title="Rep">
          <div className="grid min-w-0 gap-2 px-4 py-4 sm:px-5">
            <select
              aria-label="Rep"
              className={portalInputClassName}
              onChange={(event) => {
                setEditing(null);
                setFormNote(null);
                setFormError(null);
                setFormScope(null);
                setRepHrId(event.target.value);
              }}
              value={repHrId}
            >
              <option value="">Choose a rep</option>
              {view.repOptions.map((option) => (
                <option key={option.hrId} value={option.hrId}>
                  {[
                    option.detail ? `${option.name} (${option.detail})` : option.name,
                    option.listOpen ? null : "— list not open yet",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                </option>
              ))}
            </select>
          </div>
        </PortalSection>
      ) : null}

      {view.rep ? (
        <PortalSection
          actions={refresh}
          description={`${view.rep.name} · ${amCount} on the AM list · ${pmCount} on the PM list${
            view.rep.managerName ? ` · manager ${view.rep.managerName}` : ""
          }`}
          title={view.canRequest ? "My doctor list" : "Doctor list"}
        >
          <div className="grid min-w-0 gap-3 px-4 py-4 sm:px-5">
            {/* AM · PM, two lists and two counts, never one merged figure. AM first. */}
            <PortalSegmentedTabs className="grid grid-cols-2">
              {CONTACT_LIST_SHIFTS.map((shift) => {
                const active = listShift === shift;
                return (
                  <button
                    aria-pressed={active}
                    className={`min-h-10 min-w-0 px-2 py-2 text-center transition ${
                      active ? "bg-orange-600 text-white shadow-sm" : "text-slate-600 hover:bg-white"
                    }`}
                    key={shift}
                    onClick={() => {
                      setListShift(shift);
                      setEditing(null);
                    }}
                    type="button"
                  >
                    <span className="block break-words text-xs font-black leading-tight">{`${shift} list`}</span>
                    <span className={`mt-0.5 block text-sm font-black tabular-nums ${active ? "text-white" : "text-slate-900"}`}>
                      {shift === "AM" ? amCount : pmCount}
                    </span>
                  </button>
                );
              })}
            </PortalSegmentedTabs>
            {rowScopeHidden ? <FormMessage error={formError} note={formNote} /> : null}
            {view.entries.length > 0 ? (
              <input
                aria-label={`Find a doctor on the ${listShift} list`}
                className={portalInputClassName}
                onChange={(event) => setFilter(event.target.value)}
                placeholder={`Find a doctor on the ${listShift} list`}
                value={filter}
              />
            ) : null}
            {view.entries.length === 0 ? (
              <PortalEmptyState message="No doctor is on this rep's AM or PM list." title="The list is empty" />
            ) : shownEntries.length === 0 ? (
              <PortalEmptyState
                message={
                  filter.trim()
                    ? `No doctor on the ${listShift} list matches that name.`
                    : `No doctor is on this rep's ${listShift} list.`
                }
                title={`Nothing on the ${listShift} list`}
              />
            ) : (
              <div className="grid gap-px bg-slate-100">
                {shownEntries.map((entry) => {
                  const key = entryKey(entry);
                  const isEditing =
                    editing?.entry.contactCrmId === entry.contactCrmId && editing.entry.listType === entry.listType;
                  return (
                    <div className="grid min-w-0 gap-2 bg-white px-3 py-3" key={key}>
                      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="break-words text-sm font-bold text-slate-900">{entry.name}</p>
                          <p className="break-words text-xs text-slate-500">
                            {[entry.speciality, `${entry.listType} list`, entry.grade ? `grade ${entry.grade}` : null, `since ${dayLabel(entry.since)}`]
                              .filter(Boolean)
                              .join(" · ")}
                          </p>
                        </div>
                        {entry.pendingChange ? (
                          <span className="border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs text-amber-900">
                            Change waiting for the manager
                          </span>
                        ) : mayChange && !isEditing ? (
                          <div className="flex flex-wrap gap-2">
                            <Button
                              onClick={() => {
                                setEditing({ action: "regrade", entry });
                                setEditGrade("");
                                setEditReason("");
                                setFormScope(null);
                              }}
                              size="sm"
                              type="button"
                              variant="outline"
                            >
                              Change grade
                            </Button>
                            <Button
                              onClick={() => {
                                setEditing({ action: "remove", entry });
                                setEditGrade("");
                                setEditReason("");
                                setFormScope(null);
                              }}
                              size="sm"
                              type="button"
                              variant="outline"
                            >
                              Remove
                            </Button>
                          </div>
                        ) : null}
                      </div>
                      {isEditing && editing ? (
                        <div className="grid min-w-0 gap-2 border border-slate-200 px-3 py-3">
                          {editing.action === "regrade" ? (
                            <label className="grid gap-1">
                              <span className={labelClassName}>New grade</span>
                              <select
                                className={portalInputClassName}
                                onChange={(event) => setEditGrade(event.target.value as ContactListGrade | "")}
                                value={editGrade}
                              >
                                <option value="">Choose a grade</option>
                                {CONTACT_LIST_GRADES.filter((grade) => grade !== (entry.grade ?? "").toUpperCase()).map((grade) => (
                                  <option key={grade} value={grade}>
                                    {`Grade ${grade}`}
                                  </option>
                                ))}
                              </select>
                            </label>
                          ) : null}
                          <label className="grid gap-1">
                            <span className={labelClassName}>
                              {editing.action === "remove" ? "Why this doctor should leave the list" : "Why the grade should change"}
                            </span>
                            <textarea
                              className={`${portalInputClassName} min-h-20`}
                              maxLength={1000}
                              onChange={(event) => setEditReason(event.target.value)}
                              value={editReason}
                            />
                          </label>
                          <div className="flex flex-wrap gap-2">
                            <Button
                              disabled={formBusy || !editReason.trim() || (editing.action === "regrade" && !editGrade)}
                              onClick={() => void submitEdit()}
                              type="button"
                              variant={editing.action === "remove" ? "destructive" : "default"}
                            >
                              <Send />
                              {sendLabel}
                            </Button>
                            <Button onClick={() => setEditing(null)} type="button" variant="outline">
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : null}
                      {formScope === key ? <FormMessage error={formError} note={formNote} /> : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </PortalSection>
      ) : null}

      {mayChange ? (
        <PortalSection
          description={
            direct
              ? "Search Phoenix for the doctor, or describe a new one. The doctor goes on the list at once."
              : "Search Phoenix for the doctor, or describe a new one. The doctor goes on your list once your manager approves."
          }
          title="Add a doctor"
        >
          <div className="grid min-w-0 gap-3 px-4 py-4 sm:px-5">
            {!describeNew ? (
              <>
                <div className="flex min-w-0 flex-wrap gap-2">
                  <input
                    aria-label="Doctor's name"
                    className={`${portalInputClassName} min-w-0 flex-1`}
                    onChange={(event) => setSearchTerm(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && searchTerm.trim().length >= 2) void runSearch();
                    }}
                    placeholder="Doctor's name"
                    value={searchTerm}
                  />
                  <Button disabled={searchTerm.trim().length < 2} onClick={() => void runSearch()} type="button" variant="outline">
                    <Search />
                    Search
                  </Button>
                </div>
                {chosen ? (
                  <p className={`border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 ${adminSoftDepthClassName}`}>
                    {`Chosen: ${chosen.name}${chosen.speciality ? ` · ${chosen.speciality}` : ""}${chosen.address ? ` · ${chosen.address}` : ""}`}
                  </p>
                ) : null}
                {results && !chosen ? (
                  results.length === 0 ? (
                    <p className="text-sm text-slate-500">No doctor by that name. Check the spelling, or describe a new doctor.</p>
                  ) : (
                    <div className="grid gap-px bg-slate-100">
                      {results.map((doctor) => (
                        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 bg-white px-3 py-2" key={doctor.contactCrmId}>
                          <div className="min-w-0">
                            <p className="break-words text-sm font-bold text-slate-900">{doctor.name}</p>
                            <p className="break-words text-xs text-slate-500">
                              {[doctor.speciality, doctor.address].filter(Boolean).join(" · ") || "No details recorded"}
                            </p>
                          </div>
                          <Button onClick={() => setChosen(doctor)} size="sm" type="button" variant="outline">
                            Choose
                          </Button>
                        </div>
                      ))}
                    </div>
                  )
                ) : null}
                <div className="flex flex-wrap gap-2">
                  {chosen ? (
                    <Button onClick={() => setChosen(null)} size="sm" type="button" variant="outline">
                      Choose another doctor
                    </Button>
                  ) : null}
                  <Button
                    onClick={() => {
                      setChosen(null);
                      setDescribeNew(true);
                    }}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    <Plus />
                    The doctor is not in Phoenix
                  </Button>
                </div>
              </>
            ) : (
              <>
                <label className="grid gap-1">
                  <span className={labelClassName}>New doctor&apos;s name</span>
                  <input className={portalInputClassName} maxLength={200} onChange={(event) => setNewName(event.target.value)} value={newName} />
                </label>
                <label className="grid gap-1">
                  <span className={labelClassName}>Speciality</span>
                  <select className={portalInputClassName} onChange={(event) => setNewSpeciality(event.target.value)} value={newSpeciality}>
                    <option value="">Choose a speciality</option>
                    {view.specialityOptions.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1">
                  <span className={labelClassName}>Clinic address</span>
                  <input className={portalInputClassName} maxLength={500} onChange={(event) => setNewAddress(event.target.value)} value={newAddress} />
                </label>
                <div>
                  <Button onClick={() => setDescribeNew(false)} size="sm" type="button" variant="outline">
                    Search Phoenix instead
                  </Button>
                </div>
              </>
            )}

            <div className="grid min-w-0 gap-3 sm:grid-cols-2">
              <label className="grid gap-1">
                <span className={labelClassName}>List</span>
                <select
                  className={portalInputClassName}
                  onChange={(event) => setAddList(event.target.value as ContactListShift)}
                  value={addList}
                >
                  {CONTACT_LIST_SHIFTS.map((shift) => (
                    <option key={shift} value={shift}>
                      {`${shift} list`}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1">
                <span className={labelClassName}>Grade</span>
                <select
                  className={portalInputClassName}
                  onChange={(event) => setAddGrade(event.target.value as ContactListGrade | "")}
                  value={addGrade}
                >
                  <option value="">Choose a grade</option>
                  {CONTACT_LIST_GRADES.map((grade) => (
                    <option key={grade} value={grade}>
                      {`Grade ${grade}`}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="grid gap-1">
              <span className={labelClassName}>Why this doctor should be on the list</span>
              <textarea
                className={`${portalInputClassName} min-h-20`}
                maxLength={1000}
                onChange={(event) => setAddReason(event.target.value)}
                value={addReason}
              />
            </label>
            {formScope === "add" ? <FormMessage error={formError} note={formNote} /> : null}
            <div>
              <Button
                disabled={
                  formBusy ||
                  !addGrade ||
                  !addReason.trim() ||
                  (describeNew ? !newName.trim() || !newSpeciality : !chosen)
                }
                onClick={() => void submitAdd()}
                type="button"
              >
                <Send />
                {sendLabel}
              </Button>
            </div>
          </div>
        </PortalSection>
      ) : null}

      {view.rep ? (
        <PortalSection description="Changes to this list from the last 60 days." title={view.canRequest ? "Your requests" : "Changes to this list"}>
          {view.changes.length === 0 ? (
            <PortalEmptyState message="No change to this list in the last 60 days." title="No changes" />
          ) : (
            <div className="grid gap-px bg-slate-100">
              {view.changes.map((row) => (
                <PortalRecordCard
                  accent={accentFor(row.status)}
                  actions={
                    row.canCancel ? (
                      <div className="grid w-full gap-2">
                        <div>
                          <Button
                            disabled={busyId === row.id}
                            onClick={() => void act(row, { action: "cancel", changeId: row.id }, "Could not withdraw it.")}
                            type="button"
                            variant="outline"
                          >
                            <Undo2 />
                            Withdraw
                          </Button>
                        </div>
                        {rowError[row.id] ? <p className="text-sm text-red-700">{rowError[row.id]}</p> : null}
                      </div>
                    ) : undefined
                  }
                  key={row.id}
                  meta={contactListStatusLabel(row.status, row.direct)}
                  title={changeTitle(row)}
                >
                  <PortalRecordFields fields={changeFields(row, false)} />
                </PortalRecordCard>
              ))}
            </div>
          )}
        </PortalSection>
      ) : null}

      {view.canDecide ? (
        <PortalSection
          actions={view.rep ? undefined : refresh}
          description="Approve only when the change is right for the rep's territory. Approving changes the list at once. A refusal must say why."
          title="Waiting for your answer"
        >
          {waiting.length === 0 ? (
            <PortalEmptyState message="No doctor-list request is waiting for your answer." title="Nothing waiting" />
          ) : (
            <div className="grid gap-px bg-slate-100">
              {waiting.map((row) => (
                <PortalRecordCard
                  accent="amber"
                  actions={
                    <div className="grid w-full gap-2">
                      <input
                        aria-label="Note (needed to refuse)"
                        className={portalInputClassName}
                        maxLength={500}
                        onChange={(event) => setNotes((current) => ({ ...current, [row.id]: event.target.value }))}
                        placeholder="Note (needed to refuse)"
                        value={notes[row.id] ?? ""}
                      />
                      <div className="flex flex-wrap gap-2">
                        <Button
                          disabled={busyId === row.id || !view.inForce}
                          onClick={() =>
                            void act(
                              row,
                              { action: "decide", changeId: row.id, decision: "approved", note: notes[row.id] ?? "" },
                              "Could not record your answer.",
                            )
                          }
                          type="button"
                        >
                          <CheckCircle2 />
                          Approve
                        </Button>
                        <Button
                          disabled={busyId === row.id}
                          onClick={() =>
                            void act(
                              row,
                              { action: "decide", changeId: row.id, decision: "rejected", note: notes[row.id] ?? "" },
                              "Could not record your answer.",
                            )
                          }
                          type="button"
                          variant="destructive"
                        >
                          <XCircle />
                          Refuse
                        </Button>
                      </div>
                      {rowError[row.id] ? <p className="text-sm text-red-700">{rowError[row.id]}</p> : null}
                    </div>
                  }
                  key={row.id}
                  meta={contactListActionLabel(row.action)}
                  title={row.repName}
                >
                  <PortalRecordFields fields={[{ label: "Doctor", value: row.doctorName }, ...changeFields(row, false)]} />
                </PortalRecordCard>
              ))}
            </div>
          )}
        </PortalSection>
      ) : null}

      {answered.length > 0 ? (
        <PortalSection description="Requests you answered in the last 60 days, or that are no longer waiting for you." title="Answered">
          <div className="grid gap-px bg-slate-100">
            {answered.map((row) => (
              <PortalRecordCard
                accent={accentFor(row.status)}
                key={row.id}
                meta={`${contactListActionLabel(row.action)} · ${contactListStatusLabel(row.status, row.direct)}`}
                title={row.repName}
              >
                <PortalRecordFields fields={[{ label: "Doctor", value: row.doctorName }, ...changeFields(row, false)]} />
              </PortalRecordCard>
            ))}
          </div>
        </PortalSection>
      ) : null}

      {view.canEditDirectly ? (
        <PortalSection description="Reps' requests in your scope still waiting for their manager. Only that manager can answer them." title="Waiting for a manager">
          {view.waitingCompany.length === 0 ? (
            <PortalEmptyState message="No request is waiting for a manager." title="Nothing waiting" />
          ) : (
            <div className="grid gap-px bg-slate-100">
              {view.waitingCompany.map((row) => (
                <PortalRecordCard accent="amber" key={row.id} meta={contactListActionLabel(row.action)} title={row.repName}>
                  <PortalRecordFields fields={[{ label: "Doctor", value: row.doctorName }, ...changeFields(row, false)]} />
                </PortalRecordCard>
              ))}
            </div>
          )}
        </PortalSection>
      ) : null}
    </div>
  );
}
