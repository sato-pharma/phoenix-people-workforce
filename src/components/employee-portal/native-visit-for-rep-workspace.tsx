"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { RefreshCw, Save } from "lucide-react";

import {
  PortalEmptyState,
  PortalRecordCard,
  PortalRecordFields,
  PortalSection,
  portalInputClassName,
} from "@/components/employee-portal/portal-primitives";
import { Button } from "@/components/ui/button";
import {
  NATIVE_VISIT_COMMENT_MAX,
  NATIVE_VISIT_PARTNERS_MAX,
  NATIVE_VISIT_PROSPECT_MAX,
  type NativeVisitShift,
  type NativeVisitTypeKey,
} from "@/lib/crm/native-visits/rules";
import type { NativeVisitAdminRow, NativeVisitAdminView, NativeVisitFormOptions } from "@/lib/crm/native-visits/types";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";

/**
 * The Super Admin's visit entry for a rep, and every rep's saved visits (the owner, 2026-09-14).
 *
 * Unlike the rep's phone form there is no offline shelf and no location: he types at a desk, the visit
 * is sent at once, and it saves with no location, marked as entered by the Super Admin. The server's
 * rules decide; this form only saves a round trip on the obvious ones.
 */

const CONTACTS_SHOWN = 40;

const DAY_FORMAT = stableEnGbFormatter({
  day: "numeric",
  month: "long",
  timeZone: "Africa/Cairo",
  weekday: "long",
});
const TIME_FORMAT = stableEnGbFormatter({
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  month: "short",
  timeZone: "Africa/Cairo",
});

function dayLabel(isoDay: string) {
  return DAY_FORMAT.format(new Date(`${isoDay}T12:00:00Z`));
}

function gpsLabel(status: NativeVisitAdminRow["gpsStatus"]) {
  if (status === "captured") return "Captured";
  if (status === "out_of_bounds") return "Outside Egypt";
  return "No location";
}

function partnerStatusLabel(status: NativeVisitAdminRow["partners"][number]["status"]) {
  if (status === "confirmed") return "confirmed";
  if (status === "rejected") return "said he was not there";
  return "not answered yet";
}

function partnersText(row: NativeVisitAdminRow) {
  return row.partners.length > 0
    ? row.partners.map((partner) => `${partner.name}, ${partnerStatusLabel(partner.status)}`).join("; ")
    : "Nobody";
}

function enteredText(row: NativeVisitAdminRow) {
  return row.enteredBy ? `By the Super Admin (${row.enteredBy})` : "By the rep";
}

function Field({ children, hint, label }: { children: ReactNode; hint?: ReactNode; label: string }) {
  return (
    <div className="grid min-w-0 gap-1.5">
      <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">{label}</p>
      {children}
      {hint ? <p className="text-xs font-medium text-slate-500">{hint}</p> : null}
    </div>
  );
}

async function readJson<T>(response: Response): Promise<T | null> {
  return (await response.json().catch(() => null)) as T | null;
}

export function NativeVisitForRepWorkspace() {
  // ── Saved visits ──
  const [view, setView] = useState<NativeVisitAdminView | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);
  const [viewBusy, setViewBusy] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [filterRep, setFilterRep] = useState("");

  // ── Entry for a rep ──
  const [repHrId, setRepHrId] = useState("");
  const [options, setOptions] = useState<NativeVisitFormOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [visitDate, setVisitDate] = useState("");
  const [visitType, setVisitType] = useState<NativeVisitTypeKey>("regular");
  const [campaignTarget, setCampaignTarget] = useState<"contact" | "prospect">("contact");
  const [contactSearch, setContactSearch] = useState("");
  const [contactCrmId, setContactCrmId] = useState<number | null>(null);
  const [shift, setShift] = useState<NativeVisitShift | null>(null);
  const [prospectName, setProspectName] = useState("");
  const [prospectSpeciality, setProspectSpeciality] = useState("");
  const [partnerHrIds, setPartnerHrIds] = useState<string[]>([]);
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  const loadView = useCallback(async (filters: { from: string; to: string; repHrId: string }) => {
    setViewBusy(true);
    setViewError(null);
    try {
      const params = new URLSearchParams();
      if (filters.from) params.set("from", filters.from);
      if (filters.to) params.set("to", filters.to);
      if (filters.repHrId) params.set("repHrId", filters.repHrId);
      const response = await fetch(`/api/crm/native-visits/all?${params.toString()}`, { cache: "no-store" });
      const body = await readJson<{ view?: NativeVisitAdminView; message?: string }>(response);
      if (!response.ok || !body?.view) throw new Error(body?.message ?? "Could not load the saved visits.");
      setView(body.view);
      setFrom(body.view.from);
      setTo(body.view.to);
    } catch (error) {
      setViewError(error instanceof Error ? error.message : "Could not load the saved visits.");
    } finally {
      setViewBusy(false);
    }
  }, []);

  useEffect(() => {
    // loadView sets state only after its fetch resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadView({ from: "", to: "", repHrId: "" });
  }, [loadView]);

  function resetVisitFields() {
    setContactCrmId(null);
    setContactSearch("");
    setProspectName("");
    setProspectSpeciality("");
    setComment("");
    setPartnerHrIds([]);
  }

  async function chooseRep(nextRepHrId: string) {
    setRepHrId(nextRepHrId);
    setOptions(null);
    setOptionsError(null);
    setFormError(null);
    setSavedNote(null);
    resetVisitFields();
    setShift(null);
    if (!nextRepHrId) return;
    try {
      const response = await fetch(`/api/crm/native-visits/on-behalf?repHrId=${encodeURIComponent(nextRepHrId)}`, {
        cache: "no-store",
      });
      const body = await readJson<{ options?: NativeVisitFormOptions; message?: string }>(response);
      if (!response.ok || !body?.options) throw new Error(body?.message ?? "Could not load the visit form for that rep.");
      setOptions(body.options);
      setVisitDate(body.options.openDays[0] ?? "");
    } catch (error) {
      setOptionsError(error instanceof Error ? error.message : "Could not load the visit form for that rep.");
    }
  }

  const typeDef = options?.types.find((type) => type.key === visitType) ?? null;
  const wantsContact =
    typeDef?.contact === "required" || (typeDef?.contact === "contact_or_prospect" && campaignTarget === "contact");
  const wantsProspect = typeDef?.contact === "contact_or_prospect" && campaignTarget === "prospect";
  const selectedContact = options?.contacts.find((contact) => contact.contactCrmId === contactCrmId) ?? null;
  const allowedShifts: NativeVisitShift[] = wantsContact && selectedContact ? selectedContact.lists : ["AM", "PM"];
  const repName = options?.rep?.name ?? "the rep";

  const filteredContacts = useMemo(() => {
    const query = contactSearch.trim().toLowerCase();
    const list = options?.contacts ?? [];
    if (!query) return list;
    return list.filter(
      (contact) => contact.name.toLowerCase().includes(query) || (contact.speciality ?? "").toLowerCase().includes(query),
    );
  }, [contactSearch, options]);

  function chooseContact(id: number) {
    const contact = options?.contacts.find((option) => option.contactCrmId === id);
    if (!contact) return;
    setContactCrmId(id);
    if (contact.lists.length === 1) setShift(contact.lists[0]);
    else if (shift && !contact.lists.includes(shift)) setShift(null);
  }

  function togglePartner(hrId: string) {
    setPartnerHrIds((current) =>
      current.includes(hrId)
        ? current.filter((item) => item !== hrId)
        : current.length >= NATIVE_VISIT_PARTNERS_MAX
          ? current
          : [...current, hrId],
    );
  }

  async function save() {
    setFormError(null);
    setSavedNote(null);
    if (!options || !typeDef || !repHrId) return;
    if (!visitDate) return setFormError("Choose the day of the visit.");
    if (!shift || !allowedShifts.includes(shift)) return setFormError("Choose AM or PM.");
    if (wantsContact && !selectedContact) return setFormError("Choose the doctor the rep visited.");
    if (wantsProspect && !prospectName.trim()) return setFormError("Write the prospect's name.");

    const visit = {
      clientSubmissionId: crypto.randomUUID(),
      comment: comment.trim() || null,
      contactCrmId: wantsContact ? (selectedContact?.contactCrmId ?? null) : null,
      deviceRecordedAt: new Date().toISOString(),
      partnerHrIds,
      prospectName: wantsProspect ? prospectName.trim() : null,
      prospectSpeciality: wantsProspect ? prospectSpeciality.trim() || null : null,
      shift,
      visitDate,
      visitType,
    };
    const who = wantsContact ? selectedContact?.name : wantsProspect ? prospectName.trim() : null;
    const summary = [dayLabel(visitDate), shift, typeDef.label, who].filter(Boolean).join(" · ");

    setSaving(true);
    try {
      const response = await fetch("/api/crm/native-visits/on-behalf", {
        body: JSON.stringify({ repHrId, visit }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const body = await readJson<{ message?: string }>(response);
      if (!response.ok) throw new Error(body?.message ?? "Phoenix refused this visit.");
      resetVisitFields();
      setSavedNote(`Saved for ${repName}: ${summary}. ${repName} is told in the app.`);
      await loadView({ from, to, repHrId: filterRep });
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Could not save the visit.");
    } finally {
      setSaving(false);
    }
  }

  function renderForm() {
    if (optionsError) return <p className="border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{optionsError}</p>;
    if (!repHrId) return null;
    if (!options) return <p className="px-1 py-2 text-sm text-slate-500">Loading the visit form</p>;
    const { cutoverDate, pilot } = options;
    if (!pilot && !cutoverDate) {
      return (
        <PortalSection>
          <PortalEmptyState
            message="This rep's line is not piloting visit entry in Phoenix, and the CRM cutover date is not set."
            title="Visit entry is not open for this rep's line"
          />
        </PortalSection>
      );
    }
    if (options.openDays.length === 0 || !typeDef) {
      return (
        <PortalSection>
          <PortalEmptyState
            message={
              pilot && !cutoverDate
                ? `The ${pilot.lineName} pilot runs from ${dayLabel(pilot.startsOn)} to ${dayLabel(pilot.endsOn)}. A visit can be entered for a pilot day once that day has come.`
                : `Phoenix becomes the record for visits on ${dayLabel(cutoverDate ?? "")}. A visit can be entered for a day from then on.`
            }
            title="No open day to enter yet"
          />
        </PortalSection>
      );
    }

    const shownContacts = filteredContacts.slice(0, CONTACTS_SHOWN);

    return (
      <PortalSection
        description={`It saves with no location, marked as entered by the Super Admin, and ${repName} is told in the app. It is never counted as a check-in.`}
        eyebrow={options.rep?.detail || "Visit entry"}
        title={`New visit for ${repName}`}
      >
        <div className="grid min-w-0 gap-5 px-4 py-4 sm:px-5">
          <Field hint="Any open day of the rep's line, up to today." label="Day">
            <select
              aria-label="Day"
              className={portalInputClassName}
              onChange={(event) => setVisitDate(event.target.value)}
              value={visitDate}
            >
              {options.openDays.map((day) => (
                <option key={day} value={day}>
                  {dayLabel(day)}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Type">
            <select
              aria-label="Type"
              className={portalInputClassName}
              onChange={(event) => {
                setVisitType(event.target.value as NativeVisitTypeKey);
                setContactCrmId(null);
                setProspectName("");
                setProspectSpeciality("");
              }}
              value={visitType}
            >
              {options.types.map((type) => (
                <option key={type.key} value={type.key}>
                  {type.label}
                </option>
              ))}
            </select>
          </Field>

          {typeDef.contact === "contact_or_prospect" ? (
            <Field label="Campaign visit to">
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => setCampaignTarget("contact")}
                  type="button"
                  variant={campaignTarget === "contact" ? "default" : "outline"}
                >
                  A doctor on the rep&apos;s list
                </Button>
                <Button
                  onClick={() => {
                    setCampaignTarget("prospect");
                    setContactCrmId(null);
                  }}
                  type="button"
                  variant={campaignTarget === "prospect" ? "default" : "outline"}
                >
                  A new prospect
                </Button>
              </div>
            </Field>
          ) : null}

          {wantsContact ? (
            <Field label="Doctor">
              {selectedContact ? (
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border border-orange-200 bg-orange-50 px-3 py-2">
                  <div className="min-w-0">
                    <p className="break-words text-sm font-black text-slate-950">{selectedContact.name}</p>
                    <p className="break-words text-xs font-semibold text-slate-600">
                      {[selectedContact.speciality, selectedContact.grade, `${selectedContact.lists.join(" and ")} list`]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                  <Button onClick={() => setContactCrmId(null)} size="sm" type="button" variant="outline">
                    Change
                  </Button>
                </div>
              ) : options.contacts.length === 0 ? (
                <p className="text-sm text-slate-600">Phoenix has no doctors on this rep&apos;s AM or PM list. Choose another type.</p>
              ) : (
                <div className="grid min-w-0 gap-2">
                  <input
                    aria-label="Search the rep's doctors"
                    className={portalInputClassName}
                    onChange={(event) => setContactSearch(event.target.value)}
                    placeholder="Search the rep's doctors by name or speciality"
                    value={contactSearch}
                  />
                  <div className="grid max-h-80 min-w-0 gap-px overflow-y-auto border border-slate-100 bg-slate-100">
                    {shownContacts.map((contact) => (
                      <button
                        className="grid min-w-0 gap-0.5 bg-white px-3 py-2 text-left hover:bg-orange-50"
                        key={contact.contactCrmId}
                        onClick={() => chooseContact(contact.contactCrmId)}
                        type="button"
                      >
                        <span className="break-words text-sm font-bold text-slate-900">{contact.name}</span>
                        <span className="break-words text-xs font-medium text-slate-500">
                          {[contact.speciality, contact.grade, `${contact.lists.join(" and ")} list`].filter(Boolean).join(" · ")}
                        </span>
                      </button>
                    ))}
                    {shownContacts.length === 0 ? (
                      <p className="bg-white px-3 py-2 text-sm text-slate-500">No doctor on the rep&apos;s lists matches that search.</p>
                    ) : null}
                  </div>
                  {filteredContacts.length > CONTACTS_SHOWN ? (
                    <p className="text-xs font-medium text-slate-500">
                      {`Showing ${CONTACTS_SHOWN} of ${filteredContacts.length}. Type part of a name to narrow the list.`}
                    </p>
                  ) : null}
                </div>
              )}
            </Field>
          ) : null}

          {wantsProspect ? (
            <Field label="Prospect">
              <div className="grid min-w-0 gap-2 sm:grid-cols-2">
                <input
                  aria-label="Prospect name"
                  className={portalInputClassName}
                  maxLength={NATIVE_VISIT_PROSPECT_MAX}
                  onChange={(event) => setProspectName(event.target.value)}
                  placeholder="Doctor's name"
                  value={prospectName}
                />
                <input
                  aria-label="Prospect speciality"
                  className={portalInputClassName}
                  maxLength={NATIVE_VISIT_PROSPECT_MAX}
                  onChange={(event) => setProspectSpeciality(event.target.value)}
                  placeholder="Speciality (optional)"
                  value={prospectSpeciality}
                />
              </div>
            </Field>
          ) : null}

          <Field
            hint={
              wantsContact && selectedContact && selectedContact.lists.length === 1
                ? `This doctor is on the rep's ${selectedContact.lists[0]} list, so this is a ${selectedContact.lists[0]} visit.`
                : undefined
            }
            label="Half-day"
          >
            <div className="flex flex-wrap gap-2">
              {(["AM", "PM"] as const).map((option) => (
                <Button
                  disabled={!allowedShifts.includes(option)}
                  key={option}
                  onClick={() => setShift(option)}
                  type="button"
                  variant={shift === option ? "default" : "outline"}
                >
                  {option}
                </Button>
              ))}
            </div>
          </Field>

          <Field label="Location">
            <p className="text-sm text-slate-700">None. You were not at the doctor, so this visit saves with no location.</p>
          </Field>

          {options.partners.length > 0 ? (
            <Field hint={`The person named confirms it himself. Up to ${NATIVE_VISIT_PARTNERS_MAX}.`} label="Accompanied by">
              <div className="grid min-w-0 gap-2">
                {options.partners.map((partner) => (
                  <label className="flex min-w-0 items-start gap-2 text-sm text-slate-800" key={partner.hrId}>
                    <input
                      checked={partnerHrIds.includes(partner.hrId)}
                      className="mt-1"
                      onChange={() => togglePartner(partner.hrId)}
                      type="checkbox"
                    />
                    <span className="min-w-0 break-words">
                      <span className="font-bold">{partner.name}</span>
                      {` · ${[partner.jobTitle, partner.isDirectManager ? "the rep's direct manager" : null].filter(Boolean).join(" · ")}`}
                    </span>
                  </label>
                ))}
              </div>
            </Field>
          ) : null}

          <Field label="Comment">
            <textarea
              aria-label="Comment"
              className={`${portalInputClassName} min-h-20`}
              maxLength={NATIVE_VISIT_COMMENT_MAX}
              onChange={(event) => setComment(event.target.value)}
              placeholder="Optional"
              value={comment}
            />
          </Field>

          {formError ? <p className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p> : null}

          <div>
            <Button disabled={saving} onClick={() => void save()} size="lg" type="button">
              <Save />
              {saving ? "Saving" : "Save visit"}
            </Button>
          </div>
        </div>
      </PortalSection>
    );
  }

  const rows = view?.rows ?? [];

  return (
    <div className="grid min-w-0 gap-4">
      <PortalSection description="Choose the rep you are entering a visit for." title="Rep">
        <div className="grid min-w-0 gap-2 px-4 py-4 sm:px-5">
          {view && view.reps.length === 0 ? (
            <p className="text-sm text-slate-600">
              No rep can have a visit entered yet: no line is piloting visit entry and the CRM cutover date is not set.
            </p>
          ) : (
            <select
              aria-label="Rep"
              className={portalInputClassName}
              disabled={!view}
              onChange={(event) => void chooseRep(event.target.value)}
              value={repHrId}
            >
              <option value="">{view ? "Choose a rep" : "Loading the reps"}</option>
              {(view?.reps ?? []).map((option) => (
                <option key={option.hrId} value={option.hrId}>
                  {option.detail ? `${option.name} (${option.detail})` : option.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </PortalSection>

      {savedNote ? (
        <p className="border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{savedNote}</p>
      ) : null}

      {renderForm()}

      <PortalSection
        description="Every rep's visits saved in Phoenix, newest first, with who entered each one."
        title="Saved visits"
      >
        <div className="grid min-w-0 gap-4 px-4 py-4 sm:px-5">
          <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-4 lg:items-end">
            <Field label="From">
              <input
                aria-label="From"
                className={portalInputClassName}
                onChange={(event) => setFrom(event.target.value)}
                type="date"
                value={from}
              />
            </Field>
            <Field label="To">
              <input
                aria-label="To"
                className={portalInputClassName}
                onChange={(event) => setTo(event.target.value)}
                type="date"
                value={to}
              />
            </Field>
            <Field label="Rep">
              <select
                aria-label="Show the visits of"
                className={portalInputClassName}
                onChange={(event) => setFilterRep(event.target.value)}
                value={filterRep}
              >
                <option value="">All reps</option>
                {(view?.reps ?? []).map((option) => (
                  <option key={option.hrId} value={option.hrId}>
                    {option.name}
                  </option>
                ))}
              </select>
            </Field>
            <div>
              <Button disabled={viewBusy} onClick={() => void loadView({ from, to, repHrId: filterRep })} type="button" variant="outline">
                <RefreshCw />
                Show visits
              </Button>
            </div>
          </div>

          {viewError ? <p className="border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{viewError}</p> : null}

          {view === null ? (
            <p className="text-sm text-slate-500">Loading the saved visits</p>
          ) : rows.length === 0 ? (
            <PortalEmptyState message="No visit is saved in Phoenix for those days." title="No saved visits" />
          ) : (
            <>
              <p className="text-sm font-semibold text-slate-600">
                {view.truncated
                  ? `Showing the newest ${rows.length} visits. Narrow the days or choose a rep to see the rest.`
                  : `${rows.length} ${rows.length === 1 ? "visit" : "visits"} from ${dayLabel(view.from)} to ${dayLabel(view.to)}.`}
              </p>

              <div className="hidden md:block">
                <table className="w-full table-fixed border-collapse text-left text-sm">
                  <colgroup>
                    <col className="w-[15%]" />
                    <col className="w-[20%]" />
                    <col className="w-[25%]" />
                    <col className="w-[18%]" />
                    <col className="w-[22%]" />
                  </colgroup>
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">
                      <th className="px-3 py-2">Day</th>
                      <th className="px-3 py-2">Rep</th>
                      <th className="px-3 py-2">Visit</th>
                      <th className="px-3 py-2">Accompanied by</th>
                      <th className="px-3 py-2">Entered and location</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {rows.map((row) => (
                      <tr className={row.deletedAt ? "bg-slate-50 text-slate-500" : "text-slate-800"} key={row.id}>
                        <td className="break-words px-3 py-2 align-top">
                          <p className="font-bold">{dayLabel(row.visitDate)}</p>
                          <p className="text-xs">{row.shift}</p>
                        </td>
                        <td className="break-words px-3 py-2 align-top">
                          <p className="font-bold">{row.repName}</p>
                          {row.repDetail ? <p className="text-xs">{row.repDetail}</p> : null}
                        </td>
                        <td className="break-words px-3 py-2 align-top">
                          <p className="font-bold">{row.contactName ?? row.prospectName ?? row.typeLabel}</p>
                          <p className="text-xs">{row.typeLabel}</p>
                          {row.comment ? <p className="mt-1 text-xs">{row.comment}</p> : null}
                        </td>
                        <td className="break-words px-3 py-2 align-top text-xs">{partnersText(row)}</td>
                        <td className="break-words px-3 py-2 align-top text-xs">
                          <p className="font-bold">{enteredText(row)}</p>
                          <p>{`${gpsLabel(row.gpsStatus)} · saved ${TIME_FORMAT.format(new Date(row.serverReceivedAt))}`}</p>
                          {row.deletedAt ? <p className="mt-1 font-bold text-red-700">{`Deleted: ${row.deleteReason ?? "no reason given"}`}</p> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="grid gap-px bg-slate-100 md:hidden">
                {rows.map((row) => (
                  <PortalRecordCard
                    accent={row.deletedAt ? "slate" : row.enteredBy ? "sky" : row.gpsStatus === "captured" ? "emerald" : "amber"}
                    key={row.id}
                    meta={`${dayLabel(row.visitDate)} · ${row.shift} · ${row.typeLabel}`}
                    status={
                      <span className="text-xs font-black uppercase tracking-[0.12em] text-slate-600">
                        {row.deletedAt ? "Deleted" : gpsLabel(row.gpsStatus)}
                      </span>
                    }
                    title={`${row.repName} · ${row.contactName ?? row.prospectName ?? row.typeLabel}`}
                  >
                    <PortalRecordFields
                      fields={[
                        { label: "Rep", value: row.repDetail || row.repName },
                        { label: "Entered", value: enteredText(row) },
                        { label: "Saved", value: TIME_FORMAT.format(new Date(row.serverReceivedAt)) },
                        { label: "Accompanied by", value: partnersText(row) },
                        { label: "Comment", value: row.comment ?? "None" },
                        ...(row.deletedAt ? [{ label: "Why deleted", value: row.deleteReason ?? "None" }] : []),
                      ]}
                    />
                  </PortalRecordCard>
                ))}
              </div>
            </>
          )}
        </div>
      </PortalSection>
    </div>
  );
}
