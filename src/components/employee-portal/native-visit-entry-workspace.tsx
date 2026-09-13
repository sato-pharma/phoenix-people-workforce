"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { LocateFixed, Save, Send, Trash2, WifiOff, X } from "lucide-react";

import {
  PortalEmptyState,
  PortalRecordCard,
  PortalRecordFields,
  PortalSection,
  portalInputClassName,
} from "@/components/employee-portal/portal-primitives";
import { Button } from "@/components/ui/button";
import {
  readPendingNativeVisits,
  readRefusedNativeVisits,
  savePendingNativeVisits,
  saveRefusedNativeVisits,
  type QueuedNativeVisit,
  type RefusedNativeVisit,
} from "@/lib/crm/native-visits/queue-store";
import {
  NATIVE_VISIT_COMMENT_MAX,
  NATIVE_VISIT_DELETE_REASON_MAX,
  NATIVE_VISIT_PARTNERS_MAX,
  NATIVE_VISIT_PROSPECT_MAX,
  type NativeVisitShift,
  type NativeVisitTypeKey,
} from "@/lib/crm/native-visits/rules";
import type { NativeVisitFormOptions, NativeVisitRow } from "@/lib/crm/native-visits/types";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";

/**
 * The rep's phone form for the native-visit pilot.
 *
 * A visit is put on the phone's shelf FIRST and sent second, so pressing Save with no signal never
 * loses it: it waits here and goes out when the connection returns. The server's rules decide; this
 * form only saves the rep a round trip on the obvious ones.
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

type GpsState =
  | { status: "idle" }
  | { status: "locating" }
  | { status: "captured"; latitude: number; longitude: number; accuracy: number | null }
  | { status: "missing"; note: string };

type SendOutcome = { kind: "saved" } | { kind: "refused"; message: string } | { kind: "wait"; message: string };

function dayLabel(isoDay: string) {
  return DAY_FORMAT.format(new Date(`${isoDay}T12:00:00Z`));
}

function gpsLabel(status: NativeVisitRow["gpsStatus"]) {
  if (status === "captured") return "Captured";
  if (status === "out_of_bounds") return "Outside Egypt";
  return "No location";
}

function partnerStatusLabel(status: NativeVisitRow["partners"][number]["status"]) {
  if (status === "confirmed") return "confirmed";
  if (status === "rejected") return "said he was not there";
  return "not answered yet";
}

function newSubmissionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function sendQueued(entry: QueuedNativeVisit): Promise<SendOutcome> {
  let response: Response;
  try {
    response = await fetch("/api/crm/native-visits", {
      body: JSON.stringify(entry.payload),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  } catch {
    return { kind: "wait", message: "No connection. Waiting visits send when you are back online." };
  }
  if (response.ok) return { kind: "saved" };
  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  if (response.status === 401) {
    return { kind: "wait", message: "You are signed out. Sign in again and the waiting visits will send." };
  }
  if (response.status >= 500 || response.status === 429) {
    return { kind: "wait", message: "Phoenix could not save right now. The visits stay on this phone and try again." };
  }
  return { kind: "refused", message: body?.message ?? "Phoenix refused this visit." };
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

export function NativeVisitEntryWorkspace() {
  const [options, setOptions] = useState<NativeVisitFormOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [recent, setRecent] = useState<NativeVisitRow[] | null>(null);
  const [pending, setPending] = useState<QueuedNativeVisit[]>([]);
  const [refused, setRefused] = useState<RefusedNativeVisit[]>([]);
  const [queueNote, setQueueNote] = useState<string | null>(null);
  const [online, setOnline] = useState(true);

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
  const [gps, setGps] = useState<GpsState>({ status: "idle" });
  const [formError, setFormError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteReason, setDeleteReason] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const pendingRef = useRef<QueuedNativeVisit[]>([]);
  const refusedRef = useRef<RefusedNativeVisit[]>([]);
  const flushing = useRef(false);

  const loadRecent = useCallback(async () => {
    try {
      const response = await fetch("/api/crm/native-visits", { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as { rows?: NativeVisitRow[] } | null;
      if (response.ok) setRecent(body?.rows ?? []);
      else setRecent((current) => current ?? []);
    } catch {
      setRecent((current) => current ?? []);
    }
  }, []);

  const commitQueues = useCallback((nextPending: QueuedNativeVisit[], nextRefused: RefusedNativeVisit[]) => {
    pendingRef.current = nextPending;
    refusedRef.current = nextRefused;
    setPending(nextPending);
    setRefused(nextRefused);
    void savePendingNativeVisits(nextPending);
    void saveRefusedNativeVisits(nextRefused);
  }, []);

  const flush = useCallback(async () => {
    if (flushing.current) return;
    flushing.current = true;
    let sent = 0;
    try {
      while (pendingRef.current.length > 0) {
        const entry = pendingRef.current[0];
        const outcome = await sendQueued(entry);
        if (outcome.kind === "wait") {
          setQueueNote(outcome.message);
          break;
        }
        // Removed by id, never by position: the rep may have saved another visit during the send.
        const rest = pendingRef.current.filter((item) => item.clientSubmissionId !== entry.clientSubmissionId);
        if (outcome.kind === "saved") {
          sent += 1;
          commitQueues(rest, refusedRef.current);
        } else {
          commitQueues(rest, [...refusedRef.current, { ...entry, error: outcome.message }]);
        }
      }
      if (pendingRef.current.length === 0) setQueueNote(null);
    } finally {
      flushing.current = false;
    }
    if (sent > 0) await loadRecent();
  }, [commitQueues, loadRecent]);

  const captureLocation = useCallback(() => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      setGps({ status: "missing", note: "This phone cannot share its location. The visit still saves, flagged as having none." });
      return;
    }
    setGps({ status: "locating" });
    navigator.geolocation.getCurrentPosition(
      (position) =>
        setGps({
          accuracy: Number.isFinite(position.coords.accuracy) ? Math.round(position.coords.accuracy) : null,
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          status: "captured",
        }),
      (error) =>
        setGps({
          note:
            error.code === error.PERMISSION_DENIED
              ? "Location is switched off for Phoenix. The visit still saves, flagged as having no location."
              : "The phone found no location. The visit still saves, flagged as having no location.",
          status: "missing",
        }),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
    );
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/crm/native-visits/form-options", { cache: "no-store" });
        const body = (await response.json().catch(() => null)) as { options?: NativeVisitFormOptions; message?: string } | null;
        if (!response.ok || !body?.options) throw new Error(body?.message ?? "Could not load the visit form.");
        if (cancelled) return;
        setOptions(body.options);
        setVisitDate(body.options.openDays[0] ?? "");
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : "Could not load the visit form.");
      }
    })();
    // loadRecent sets state only after its fetch resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadRecent();
    void (async () => {
      const [storedPending, storedRefused] = await Promise.all([readPendingNativeVisits(), readRefusedNativeVisits()]);
      if (cancelled) return;
      const pendingIds = new Set(pendingRef.current.map((entry) => entry.clientSubmissionId));
      const refusedIds = new Set(refusedRef.current.map((entry) => entry.clientSubmissionId));
      commitQueues(
        [...storedPending.filter((entry) => !pendingIds.has(entry.clientSubmissionId)), ...pendingRef.current],
        [...storedRefused.filter((entry) => !refusedIds.has(entry.clientSubmissionId)), ...refusedRef.current],
      );
      void flush();
    })();
    return () => {
      cancelled = true;
    };
  }, [commitQueues, flush, loadRecent]);

  useEffect(() => {
    // navigator.onLine is a browser API and cannot be read server-side, so it is synced after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOnline(navigator.onLine);
    const goOnline = () => {
      setOnline(true);
      void flush();
    };
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, [flush]);

  const formOpen = Boolean(options?.pilot && options.openDays.length > 0);
  useEffect(() => {
    // The location is taken as soon as the form opens; the phone's answer arrives in a callback.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (formOpen && gps.status === "idle") captureLocation();
  }, [captureLocation, formOpen, gps.status]);

  const typeDef = options?.types.find((type) => type.key === visitType) ?? null;
  const wantsContact =
    typeDef?.contact === "required" || (typeDef?.contact === "contact_or_prospect" && campaignTarget === "contact");
  const wantsProspect = typeDef?.contact === "contact_or_prospect" && campaignTarget === "prospect";
  const selectedContact = options?.contacts.find((contact) => contact.contactCrmId === contactCrmId) ?? null;
  const allowedShifts: NativeVisitShift[] = wantsContact && selectedContact ? selectedContact.lists : ["AM", "PM"];

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
    if (!options || !typeDef) return;
    if (!visitDate) return setFormError("Choose the day of the visit.");
    if (!shift || !allowedShifts.includes(shift)) return setFormError("Choose AM or PM.");
    if (wantsContact && !selectedContact) return setFormError("Choose the doctor you visited.");
    if (wantsProspect && !prospectName.trim()) return setFormError("Write the prospect's name.");
    if (gps.status === "locating") return setFormError("Wait for the location to finish, then save.");

    const clientSubmissionId = newSubmissionId();
    const payload = {
      accuracyMeters: gps.status === "captured" ? gps.accuracy : null,
      clientSubmissionId,
      comment: comment.trim() || null,
      contactCrmId: wantsContact ? (selectedContact?.contactCrmId ?? null) : null,
      deviceRecordedAt: new Date().toISOString(),
      latitude: gps.status === "captured" ? gps.latitude : null,
      longitude: gps.status === "captured" ? gps.longitude : null,
      partnerHrIds,
      prospectName: wantsProspect ? prospectName.trim() : null,
      prospectSpeciality: wantsProspect ? prospectSpeciality.trim() || null : null,
      shift,
      visitDate,
      visitType,
    };
    const who = wantsContact ? selectedContact?.name : wantsProspect ? prospectName.trim() : null;
    const summary = [dayLabel(visitDate), shift, typeDef.label, who].filter(Boolean).join(" · ");

    commitQueues(
      [...pendingRef.current, { clientSubmissionId, payload, queuedAt: new Date().toISOString(), summary }],
      refusedRef.current,
    );
    setContactCrmId(null);
    setContactSearch("");
    setProspectName("");
    setProspectSpeciality("");
    setComment("");
    setPartnerHrIds([]);
    setSavedNote(`Saved: ${summary}.`);
    await flush();
    captureLocation();
  }

  async function deleteVisit(row: NativeVisitRow) {
    setDeleteError(null);
    setDeleteBusy(true);
    try {
      const response = await fetch("/api/crm/native-visits/delete", {
        body: JSON.stringify({ reason: deleteReason, visitId: row.id }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      if (!response.ok) throw new Error(body?.message ?? "Could not delete the visit.");
      setDeletingId(null);
      setDeleteReason("");
      await loadRecent();
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Could not delete the visit.");
    } finally {
      setDeleteBusy(false);
    }
  }

  function renderForm() {
    if (loadError) {
      return <p className="border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{loadError}</p>;
    }
    if (!options) return <p className="px-1 py-2 text-sm text-slate-500">Loading the visit form</p>;
    if (!options.pilot) {
      return (
        <PortalSection>
          <PortalEmptyState
            message="Entering visits in Phoenix is a one-week pilot for one line. Keep entering your visits in iReports360."
            title="Visit entry is not open for your line"
          />
        </PortalSection>
      );
    }
    if (!formOpen || !typeDef) {
      return (
        <PortalSection>
          <PortalEmptyState
            message={`The ${options.pilot.lineName} pilot runs from ${dayLabel(options.pilot.startsOn)} to ${dayLabel(options.pilot.endsOn)}. Keep entering your visits in iReports360.`}
            title="The pilot is not open today"
          />
        </PortalSection>
      );
    }

    const entryDays = [
      { iso: options.entryDays.today, label: "Today" },
      { iso: options.entryDays.yesterday, label: "Yesterday" },
    ];
    const shownContacts = filteredContacts.slice(0, CONTACTS_SHOWN);

    return (
      <PortalSection
        description="Keep entering your visits in iReports360 too. During the pilot it is still the record your pay and reports use."
        eyebrow={`${options.pilot.lineName} pilot`}
        title="New visit"
      >
        <div className="grid min-w-0 gap-5 px-4 py-4 sm:px-5">
          {options.vacationDayRuleInForce ? (
            <p className="text-sm text-slate-600">
              On a day HR approved as your vacation, a visit saves only after your manager and HR approve your{" "}
              <Link className="font-bold text-orange-700 underline" href="/employee-portals/visits/vacation-day-requests">
                request to work that day
              </Link>
              . A regular visit saves only for a doctor planned on that very day, in a week plan your manager verified.
            </p>
          ) : null}
          <Field label="Day">
            <div className="flex flex-wrap gap-2">
              {entryDays.map((day) => (
                <Button
                  disabled={!options.openDays.includes(day.iso)}
                  key={day.iso}
                  onClick={() => setVisitDate(day.iso)}
                  type="button"
                  variant={visitDate === day.iso ? "default" : "outline"}
                >
                  {`${day.label}, ${dayLabel(day.iso)}`}
                </Button>
              ))}
            </div>
          </Field>

          <Field label="Type">
            <select
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
                  A doctor on my list
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
                <p className="text-sm text-slate-600">
                  Phoenix has no doctors on your AM or PM list. Choose another type, or ask your manager to check your list.
                </p>
              ) : (
                <div className="grid min-w-0 gap-2">
                  <input
                    aria-label="Search your doctors"
                    className={portalInputClassName}
                    onChange={(event) => setContactSearch(event.target.value)}
                    placeholder="Search your doctors by name or speciality"
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
                      <p className="bg-white px-3 py-2 text-sm text-slate-500">No doctor on your lists matches that search.</p>
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
                ? `This doctor is on your ${selectedContact.lists[0]} list, so this is a ${selectedContact.lists[0]} visit.`
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
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <p className="min-w-0 break-words text-sm text-slate-700">
                {gps.status === "captured"
                  ? `Captured${gps.accuracy != null ? `, accurate to ${gps.accuracy} m` : ""}`
                  : gps.status === "locating"
                    ? "Finding your location"
                    : gps.status === "missing"
                      ? gps.note
                      : "Not captured yet"}
              </p>
              <Button disabled={gps.status === "locating"} onClick={captureLocation} size="sm" type="button" variant="outline">
                <LocateFixed />
                {gps.status === "captured" ? "Capture again" : "Try again"}
              </Button>
            </div>
          </Field>

          {options.partners.length > 0 ? (
            <Field
              hint={`The person you name confirms it himself. Up to ${NATIVE_VISIT_PARTNERS_MAX}.`}
              label="Accompanied by"
            >
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
                      {` · ${[partner.jobTitle, partner.isDirectManager ? "your direct manager" : null].filter(Boolean).join(" · ")}`}
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
          {savedNote ? (
            <p className="border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{savedNote}</p>
          ) : null}

          <div>
            <Button disabled={gps.status === "locating"} onClick={() => void save()} size="lg" type="button">
              <Save />
              Save visit
            </Button>
          </div>
        </div>
      </PortalSection>
    );
  }

  return (
    <div className="grid min-w-0 gap-4">
      {!online ? (
        <p className="flex items-center gap-2 border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <WifiOff className="size-4 shrink-0" />
          You are offline. Visits you save wait on this phone and send when the connection returns.
        </p>
      ) : null}

      {renderForm()}

      {pending.length > 0 || refused.length > 0 ? (
        <PortalSection
          actions={
            pending.length > 0 ? (
              <Button onClick={() => void flush()} size="sm" type="button" variant="outline">
                <Send />
                Send now
              </Button>
            ) : undefined
          }
          description={queueNote ?? "Visits saved on this phone that Phoenix has not accepted yet."}
          title="Waiting on this phone"
        >
          <div className="grid gap-px bg-slate-100">
            {pending.map((entry) => (
              <PortalRecordCard
                accent="sky"
                key={entry.clientSubmissionId}
                meta={`Saved on this phone ${TIME_FORMAT.format(new Date(entry.queuedAt))}`}
                title={entry.summary}
              />
            ))}
            {refused.map((entry) => (
              <PortalRecordCard
                accent="rose"
                actions={
                  <Button
                    onClick={() =>
                      commitQueues(
                        pendingRef.current,
                        refusedRef.current.filter((item) => item.clientSubmissionId !== entry.clientSubmissionId),
                      )
                    }
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    <X />
                    Remove
                  </Button>
                }
                key={entry.clientSubmissionId}
                meta="Not saved. Enter it again if it still applies."
                title={entry.summary}
              >
                <p className="break-words text-sm text-red-700">{entry.error}</p>
              </PortalRecordCard>
            ))}
          </div>
        </PortalSection>
      ) : null}

      <PortalSection description="What Phoenix has saved from you in the last two weeks." title="Your pilot visits">
        {recent === null ? (
          <p className="px-4 py-6 text-sm text-slate-500">Loading your visits</p>
        ) : recent.length === 0 ? (
          <PortalEmptyState message="Visits you save here appear in this list." title="No pilot visits yet" />
        ) : (
          <div className="grid gap-px bg-slate-100">
            {recent.map((row) => (
              <PortalRecordCard
                accent={row.deletedAt ? "slate" : row.gpsStatus === "captured" ? "emerald" : "amber"}
                actions={
                  row.canDelete ? (
                    deletingId === row.id ? (
                      <div className="grid w-full gap-2">
                        <input
                          aria-label="Why are you deleting this visit?"
                          className={portalInputClassName}
                          maxLength={NATIVE_VISIT_DELETE_REASON_MAX}
                          onChange={(event) => setDeleteReason(event.target.value)}
                          placeholder="Why are you deleting this visit?"
                          value={deleteReason}
                        />
                        <div className="flex flex-wrap gap-2">
                          <Button
                            disabled={deleteBusy || !deleteReason.trim()}
                            onClick={() => void deleteVisit(row)}
                            size="sm"
                            type="button"
                            variant="destructive"
                          >
                            <Trash2 />
                            Delete visit
                          </Button>
                          <Button
                            onClick={() => {
                              setDeletingId(null);
                              setDeleteReason("");
                              setDeleteError(null);
                            }}
                            size="sm"
                            type="button"
                            variant="outline"
                          >
                            Keep it
                          </Button>
                        </div>
                        {deleteError ? <p className="text-sm text-red-700">{deleteError}</p> : null}
                      </div>
                    ) : (
                      <Button
                        onClick={() => {
                          setDeletingId(row.id);
                          setDeleteReason("");
                          setDeleteError(null);
                        }}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        <Trash2 />
                        Delete
                      </Button>
                    )
                  ) : undefined
                }
                key={row.id}
                meta={`${dayLabel(row.visitDate)} · ${row.shift} · ${row.typeLabel}`}
                status={
                  <span className="text-xs font-black uppercase tracking-[0.12em] text-slate-600">
                    {row.deletedAt ? "Deleted" : gpsLabel(row.gpsStatus)}
                  </span>
                }
                title={row.contactName ?? row.prospectName ?? row.typeLabel}
              >
                <PortalRecordFields
                  fields={[
                    { label: "Saved", value: TIME_FORMAT.format(new Date(row.serverReceivedAt)) },
                    {
                      label: "Accompanied by",
                      value:
                        row.partners.length > 0
                          ? row.partners.map((partner) => `${partner.name}, ${partnerStatusLabel(partner.status)}`).join("; ")
                          : "Nobody",
                    },
                    { label: "Comment", value: row.comment ?? "None" },
                    ...(row.deletedAt ? [{ label: "Why deleted", value: row.deleteReason ?? "None" }] : []),
                  ]}
                />
              </PortalRecordCard>
            ))}
          </div>
        )}
      </PortalSection>
    </div>
  );
}
