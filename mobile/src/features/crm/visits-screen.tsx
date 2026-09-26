import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { useEffect, useRef, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  CrmBackBar,
  CrmChoice,
  CrmEmpty,
  CrmNote,
  CrmPhotoThumb,
  CrmPill,
  CrmSearch,
  CrmSection,
  type CrmChoiceOption,
  type CrmTone,
} from "@/components/crm/crm-kit";
import { CrmLivePhoto } from "@/components/crm/live-photo";
import { CrmSpeakComment } from "@/components/crm/speak-comment";
import { ErrorNotice, LoadingScreen, PrimaryButton, SecondaryButton, StatTile } from "@/components/ui";
import { crmErrorCode, crmErrorMessage, crmGet, crmPost, crmUrl, newClientId } from "@/lib/crm/client";
import { cairoClock, dayLabelLong, shiftIsoDay } from "@/lib/crm/format";
import { PendingVisit, PendingValidate, reuseWindowOver } from "@/features/crm/handoff";
import {
  customerMetaText,
  listText,
  monthVisitsText,
  PENDING_COUNTS_NOTE,
  PENDING_PILL,
  pendingVisitsText,
  territoryLine,
} from "@/lib/crm/labels";
import type { CrmCapturedPhoto } from "@/lib/crm/photo";
import { appendCrmDictated, type CrmVoiceNote } from "@/lib/crm/voice";
import { ApiError } from "@/lib/api";
import { useSession } from "@/lib/session";
import { hairline, radius, space, type } from "@/theme/tokens";
import { usePalette } from "@/theme/use-palette";
import type {
  CrmListType,
  CrmVisitKind,
  SavedVisit,
  VisitCustomerOption,
  VisitDayView,
  VisitFormView,
  VisitPerson,
  VisitRow,
} from "@/lib/crm/types";

/**
 * Phoenix CRM — the Visits screen on the phone: a territory's visits of a day, and Add Visit.
 *
 * The native counterpart of the web `VisitsTab` (src/components/phoenix-crm/visits-tab.tsx), on the
 * same two routes. A rep enters visits on the day at the clinic, so earlier days are read only; a
 * district manager's double visit and a senior manager's chain visit both count straight away. AM and
 * PM are counted apart on every figure and never added together (owner rule).
 */

const VISIT_PRODUCTS_MAX = 12;

/**
 * The kind of visit, chosen BEFORE the doctor (owner, 2026-09-26). Planned offers only the doctors on
 * a plan the rep has sent for today; unplanned opens his whole list and asks him why he went, and the
 * visit counts in nothing until his manager and then SFE approve it. Unplanned is what replaces the
 * old iReports360 "Campaign (Prospection)".
 *
 * Mirrors src/lib/phoenix-crm/unplanned-rules.ts; the numbers are copied rather than imported so the
 * phone bundle never reaches into the web app’s modules.
 */
type VisitTypeChoice = "planned" | "unplanned";
const UNPLANNED_REASON_MIN = 10;
const UNPLANNED_REASON_MAX = 500;
const VISIT_COMMENT_MAX = 1000;

const NOT_RECEIVING = "Does not receive this day";

const LOCATION_PILL: Record<VisitRow["locationFlag"], { label: string; tone: CrmTone }> = {
  ok: { label: "At the place", tone: "good" },
  far: { label: "Far from the place", tone: "warn" },
  weak_gps: { label: "Weak location", tone: "warn" },
  no_place: { label: "No place to compare", tone: "neutral" },
};

function isFlagged(flag: VisitRow["locationFlag"]): boolean {
  return flag === "far" || flag === "weak_gps";
}

function visitPeople(visit: VisitRow): Array<{ name: string; role: string }> {
  const people: Array<{ name: string; role: string }> = [];
  if (visit.repName) people.push({ name: visit.repName, role: "Rep" });
  if (visit.managerName) people.push({ name: visit.managerName, role: "Manager" });
  if (visit.seniorName) people.push({ name: visit.seniorName, role: "Senior manager" });
  return people;
}

function enteredByOther(visit: VisitRow): boolean {
  return visit.repName !== null && visit.enteredByName !== visit.repName;
}

function dayFigures(visits: ReadonlyArray<VisitRow>) {
  const count = (listType: CrmListType, match: (visit: VisitRow) => boolean) =>
    visits.filter((visit) => visit.listType === listType && match(visit)).length;
  const any = () => true;
  const paired = (visit: VisitRow) => visit.kind !== "single";
  const flagged = (visit: VisitRow) => isFlagged(visit.locationFlag);
  return {
    pm: count("PM", any),
    am: count("AM", any),
    pairedPm: count("PM", paired),
    pairedAm: count("AM", paired),
    flaggedPm: count("PM", flagged),
    flaggedAm: count("AM", flagged),
  };
}

// ── A day's visits ──────────────────────────────────────────────────────────────────────────────

function VisitCard({ visit }: { visit: VisitRow }) {
  const palette = usePalette();
  const people = visitPeople(visit);
  const location = LOCATION_PILL[visit.locationFlag];
  return (
    <View
      style={{
        borderColor: palette.line,
        borderLeftColor: isFlagged(visit.locationFlag) ? palette.accent : palette.success,
        borderLeftWidth: 3,
        borderRadius: radius,
        borderWidth: hairline,
        gap: space.sm,
        padding: space.md,
      }}
    >
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs, justifyContent: "space-between" }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[type.bodyStrong, { color: palette.ink }]}>{visit.customerName}</Text>
          <Text style={[type.meta, { color: palette.inkSoft }]}>{`${cairoClock(visit.capturedAt)} · ${listText(visit.listType)} · ${visit.kindLabel}`}</Text>
        </View>
        <View style={{ alignItems: "flex-end", flexDirection: "row", flexWrap: "wrap", gap: space.xs, justifyContent: "flex-end" }}>
          <CrmPill tone={location.tone}>{location.label}</CrmPill>
          {visit.unplanned ? (
            <CrmPill tone={visit.unplanned.status === "approved" ? "good" : visit.unplanned.status === "refused" ? "warn" : "warn"}>
              {visit.unplanned.statusLabel}
            </CrmPill>
          ) : null}
          {visit.clockOff ? <CrmPill tone="warn">Phone clock off</CrmPill> : null}
        </View>
      </View>
      <View style={{ flexDirection: "row", gap: space.sm }}>
        <CrmPhotoThumb path={visit.photoPath} size={72} />
        <View style={{ flex: 1, gap: 4, minWidth: 0 }}>
          {people.length > 0 ? (
            <Text style={[type.meta, { color: palette.ink2 }]}>
              <Text style={{ color: palette.ink }}>On the visit: </Text>
              {people.map((person) => `${person.name} (${person.role})`).join(", ")}
            </Text>
          ) : null}
          <Text style={[type.meta, { color: palette.ink2 }]}>
            <Text style={{ color: palette.ink }}>Products: </Text>
            {visit.products.join(", ") || "—"}
          </Text>
          {visit.comment ? (
            <Text style={[type.meta, { color: palette.ink2 }]}>
              <Text style={{ color: palette.ink }}>Comment: </Text>
              {visit.comment}
            </Text>
          ) : null}
          <Text style={[type.meta, { color: palette.inkSoft }]}>{visit.locationLabel}</Text>
          {visit.unplanned ? (
            <Text style={[type.meta, { color: palette.ink2 }]}>
              <Text style={{ color: palette.ink }}>Off the plan: </Text>
              {`${visit.unplanned.clarification} — ${visit.unplanned.note}`}
            </Text>
          ) : null}
          {enteredByOther(visit) ? <Text style={[type.meta, { color: palette.inkSoft }]}>{`Entered by ${visit.enteredByName}`}</Text> : null}
        </View>
      </View>
    </View>
  );
}

/** What the day screen shows after a visit is saved, and — for a pending customer — what to do next. */
type SavedState = { visit: SavedVisit; customerName: string; validate: number | null };

function SavedNote({ onValidate, saved }: { onValidate: (() => void) | null; saved: SavedState }) {
  const palette = usePalette();
  const { customerName, visit } = saved;
  const note = visit.duplicate ? (
    <CrmNote title={customerName} tone="info">{`This visit was already saved, at ${cairoClock(visit.capturedAt)}.`}</CrmNote>
  ) : (
    <CrmNote title={`Visit saved: ${customerName}`} tone={isFlagged(visit.locationFlag) ? "warn" : "good"}>
      {`${cairoClock(visit.capturedAt)} · ${visit.locationLabel}${isFlagged(visit.locationFlag) ? ". The visit is saved with this flag." : ""}`}
    </CrmNote>
  );
  if (!onValidate) return note;
  return (
    <View style={{ gap: space.sm }}>
      {note}
      <CrmNote title={PENDING_PILL} tone="info">
        <View style={{ gap: space.sm }}>
          <Text style={[type.body, { color: palette.ink }]}>{`${PENDING_COUNTS_NOTE} It takes the location, one photo and the opening hours, once.`}</Text>
          <PrimaryButton label="Validate now" onPress={onValidate} />
        </View>
      </CrmNote>
    </View>
  );
}

export function VisitsScreen({
  cairoToday,
  onPendingVisitDone,
  onStartValidate,
  onWorkChange,
  pendingVisit,
  seatId,
  test,
}: {
  cairoToday: string;
  onPendingVisitDone: () => void;
  /** Validate the customer this visit was just saved on. Absent where this page cannot edit the list. */
  onStartValidate?: (validate: PendingValidate) => void;
  onWorkChange: (working: boolean) => void;
  pendingVisit: PendingVisit | null;
  seatId: string;
  test: boolean;
}) {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const { handleExpiredSession, token } = useSession();
  const [date, setDate] = useState(cairoToday);
  const [adding, setAdding] = useState(false);
  const [saved, setSaved] = useState<SavedState | null>(null);
  const [view, setView] = useState<VisitDayView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const runRef = useRef(0);

  const handoff = pendingVisit && pendingVisit.seatId === seatId && pendingVisit.test === test ? pendingVisit : null;
  const working = adding || handoff !== null;

  useEffect(() => {
    onWorkChange(working);
  }, [onWorkChange, working]);

  async function load(target: string, mode: "initial" | "refresh") {
    if (!token) return;
    const run = runRef.current + 1;
    runRef.current = run;
    if (mode === "refresh") setRefreshing(true);
    else setLoading(true);
    try {
      const day = await crmGet<VisitDayView>(crmUrl("/api/phoenix-crm/visits", { date: target, seatId, test }), "day", token);
      if (runRef.current !== run) return;
      setView(day);
      setError(null);
    } catch (caught) {
      if (caught instanceof ApiError && caught.isSessionExpired) return void handleExpiredSession();
      if (runRef.current !== run) return;
      setError(crmErrorMessage(caught));
    } finally {
      if (runRef.current === run) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }

  useEffect(() => {
    void load(date, "initial");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, seatId, test, token]);

  function moveTo(next: string) {
    if (next > cairoToday) return;
    setSaved(null);
    setDate(next);
  }

  if (adding || handoff) {
    return (
      <AddVisit
        handoff={handoff}
        onClose={() => {
          setAdding(false);
          if (handoff) onPendingVisitDone();
        }}
        onSaved={(visit, customerName, validate) => {
          setAdding(false);
          if (handoff) onPendingVisitDone();
          setSaved({ visit, customerName, validate });
          setDate(visit.visitDate);
          void load(visit.visitDate, "refresh");
        }}
        seatId={seatId}
        test={test}
      />
    );
  }

  const visits = view?.visits ?? [];
  const figures = dayFigures(visits);
  const isToday = date === cairoToday;

  if (loading && !view) return <LoadingScreen label="Loading the day's visits" />;

  return (
    <ScrollView
      contentContainerStyle={{ gap: space.lg, paddingBottom: insets.bottom + space.xl, paddingHorizontal: space.lg, paddingTop: space.md }}
      refreshControl={<RefreshControl onRefresh={() => void load(date, "refresh")} refreshing={refreshing} tintColor={palette.accent} />}
      style={{ backgroundColor: palette.paper }}
    >
      {view ? <Text style={[type.meta, { color: palette.inkSoft }]}>{territoryLine(view.territory)}</Text> : null}

      <View style={{ alignItems: "center", flexDirection: "row", gap: space.sm }}>
        <Pressable
          accessibilityLabel="Previous day"
          accessibilityRole="button"
          onPress={() => moveTo(shiftIsoDay(date, -1))}
          style={{ alignItems: "center", borderColor: palette.line, borderRadius: radius, borderWidth: hairline, height: 44, justifyContent: "center", width: 44 }}
        >
          <Ionicons color={palette.ink2} name="chevron-back" size={20} />
        </Pressable>
        <View style={{ alignItems: "center", flex: 1, gap: 2 }}>
          <Text style={[type.bodyStrong, { color: palette.ink, textAlign: "center" }]}>{dayLabelLong(date)}</Text>
          {isToday ? <CrmPill tone="good">Today</CrmPill> : null}
        </View>
        <Pressable
          accessibilityLabel="Next day"
          accessibilityRole="button"
          disabled={isToday}
          onPress={() => moveTo(shiftIsoDay(date, 1))}
          style={{
            alignItems: "center",
            borderColor: palette.line,
            borderRadius: radius,
            borderWidth: hairline,
            height: 44,
            justifyContent: "center",
            opacity: isToday ? 0.4 : 1,
            width: 44,
          }}
        >
          <Ionicons color={palette.ink2} name="chevron-forward" size={20} />
        </Pressable>
      </View>
      {!isToday ? (
        <View style={{ gap: space.xs }}>
          <SecondaryButton label="Back to today" onPress={() => moveTo(cairoToday)} />
          <Text style={[type.meta, { color: palette.inkSoft }]}>Visits are added on the day, at the clinic.</Text>
        </View>
      ) : null}

      {saved ? (
        <SavedNote
          onValidate={
            onStartValidate && saved.validate !== null
              ? () => {
                  const contactCrmId = saved.validate;
                  if (contactCrmId === null) return;
                  setSaved(null);
                  onStartValidate({ seatId, test, contactCrmId, customerName: saved.customerName });
                }
              : null
          }
          saved={saved}
        />
      ) : null}

      {error ? <ErrorNotice message={error} /> : null}

      {view ? (
        <>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
            <StatTile label="PM visited" value={String(figures.pm)} />
            <StatTile label="AM visited" value={String(figures.am)} />
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
            <StatTile label="PM flagged" tone={figures.flaggedPm > 0 ? "accent" : "default"} value={String(figures.flaggedPm)} />
            <StatTile label="AM flagged" tone={figures.flaggedAm > 0 ? "accent" : "default"} value={String(figures.flaggedAm)} />
          </View>

          {view.canAdd ? (
            <PrimaryButton
              label="Add a visit"
              onPress={() => {
                setSaved(null);
                setAdding(true);
              }}
            />
          ) : null}

          {visits.length === 0 ? (
            <CrmEmpty
              message={view.canAdd ? "Add each visit at the clinic, with a live photo of the sign or door." : null}
              title={isToday ? "No visits yet today" : "No visits this day"}
            />
          ) : (
            <View style={{ gap: space.sm }}>
              {visits.map((visit) => (
                <VisitCard key={visit.visitId} visit={visit} />
              ))}
            </View>
          )}
        </>
      ) : null}
    </ScrollView>
  );
}

// ── Add Visit ───────────────────────────────────────────────────────────────────────────────────

function PlaceWindows({ customer }: { customer: VisitCustomerOption }) {
  const palette = usePalette();
  return (
    <View style={{ gap: 2, marginTop: 2 }}>
      {customer.places.map((place, index) => {
        const where = customer.places.length > 1 ? `${place.label ?? place.address ?? `Place ${index + 1}`}: ` : "";
        const receiving = place.todayWindows !== NOT_RECEIVING;
        return (
          <Text key={place.placeId} style={[type.meta, { color: receiving ? palette.success : palette.inkSoft }]}>
            {where}
            {receiving ? `Receives today ${place.todayWindows}` : place.todayWindows}
          </Text>
        );
      })}
    </View>
  );
}

function CustomerPicker({
  customers,
  disabled,
  onPick,
  selectedId,
  visitType,
}: {
  customers: ReadonlyArray<VisitCustomerOption>;
  disabled: boolean;
  onPick: (customerId: string) => void;
  selectedId: string | null;
  visitType: VisitTypeChoice;
}) {
  const palette = usePalette();
  const [query, setQuery] = useState("");
  const [listType, setListType] = useState<"all" | CrmListType>("all");
  const needle = query.trim().toLowerCase();
  // The door, not the gate: the server decides which kind the visit really was from the plan's own
  // history and refuses a mismatch with a named refusal the screen turns into the reason box.
  const offered = visitType === "planned" ? customers.filter((customer) => customer.plannedToday) : customers;
  const shown = offered.filter(
    (customer) =>
      (listType === "all" || customer.listType === listType) &&
      (!needle || customer.name.toLowerCase().includes(needle) || (customer.speciality ?? "").toLowerCase().includes(needle)),
  );

  return (
    <View style={{ gap: space.md }}>
      <CrmSearch onChangeText={setQuery} placeholder="Search by name or speciality" value={query} />
      <CrmChoice
        columns={3}
        onChange={setListType}
        options={[
          { value: "all", label: "All" },
          { value: "PM", label: "PM" },
          { value: "AM", label: "AM" },
        ]}
        value={listType}
      />
      {shown.length === 0 ? (
        <CrmEmpty
          title={offered.length === 0 && visitType === "planned" ? "Nobody is on today’s plan" : "No customer matches"}
        />
      ) : (
        <View style={{ gap: space.sm }}>
          {shown.map((customer) => {
            const selected = customer.customerId === selectedId;
            const off = disabled || customer.visitedToday;
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: off, selected }}
                disabled={off}
                key={customer.customerId}
                onPress={() => onPick(customer.customerId)}
                style={{
                  backgroundColor: selected ? palette.accentSoft : palette.surface,
                  borderColor: selected ? palette.accent : palette.line,
                  borderRadius: radius,
                  borderWidth: hairline,
                  gap: 2,
                  opacity: off ? 0.55 : 1,
                  padding: space.md,
                }}
              >
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs, justifyContent: "space-between" }}>
                  <Text style={[type.bodyStrong, { color: palette.ink, flex: 1, minWidth: 0 }]}>{customer.name}</Text>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
                    {customer.pending ? <CrmPill tone="warn">{PENDING_PILL}</CrmPill> : null}
                    {customer.plannedToday ? <CrmPill tone="warn">On today&apos;s plan</CrmPill> : null}
                    {customer.visitedToday ? <CrmPill tone="good">Visited today</CrmPill> : null}
                  </View>
                </View>
                <Text style={[type.meta, { color: palette.inkSoft }]}>{customerMetaText(customer)}</Text>
                <PlaceWindows customer={customer} />
                <Text style={[type.meta, { color: palette.ink2 }]}>
                  {customer.pending ? pendingVisitsText(customer.visitsThisMonth) : monthVisitsText(customer.visitsThisMonth, customer.target)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}

type Participants = {
  options: Array<CrmChoiceOption<CrmVisitKind>>;
  managerOptions: VisitPerson[];
  manager: VisitPerson | null;
  seniorOptions: VisitPerson[];
  senior: VisitPerson | null;
};

function pickPerson(options: ReadonlyArray<VisitPerson>, hrId: string | null): VisitPerson | null {
  return options.find((person) => person.hrId === hrId) ?? (options.length === 1 ? options[0] : null);
}

function participantsOf(form: VisitFormView, kind: CrmVisitKind, managerHrId: string | null, seniorHrId: string | null): Participants {
  const people = form.managers;
  if (form.enteredAs === "manager") {
    const me = people.find((person) => person.position === form.viewerPosition) ?? null;
    const rep = form.territory.repHrId && form.territory.repHrId !== me?.hrId ? form.territory.repName : null;
    const seniorOptions = me ? people.filter((person) => person.position > me.position) : [];
    return {
      options: [
        { value: "single", label: "My own visit", note: "Without the rep" },
        { value: "double", label: "Double visit", note: rep ? `With ${rep}` : "This territory has no rep", disabled: !rep },
        {
          value: "chain",
          label: "Chain visit",
          note: !rep ? "This territory has no rep" : seniorOptions.length === 0 ? "No senior manager above you" : `With ${rep} and a senior manager`,
          disabled: !rep || seniorOptions.length === 0,
        },
      ],
      managerOptions: [],
      manager: me,
      seniorOptions,
      senior: pickPerson(seniorOptions, seniorHrId),
    };
  }

  const managerOptions = kind === "chain" ? people.filter((person) => people.some((other) => other.position > person.position)) : people;
  const manager = pickPerson(managerOptions, managerHrId);
  const seniorOptions = manager ? people.filter((person) => person.position > manager.position) : [];
  return {
    options: [
      { value: "single", label: "Single visit", note: "On my own" },
      { value: "double", label: "Double visit", note: people.length > 0 ? "With a manager" : "No manager above this territory", disabled: people.length === 0 },
      {
        value: "chain",
        label: "Chain visit",
        note: people.length > 1 ? "With a manager and a senior manager" : "Needs a manager and a senior manager above this territory",
        disabled: people.length < 2,
      },
    ],
    managerOptions,
    manager,
    seniorOptions,
    senior: pickPerson(seniorOptions, seniorHrId),
  };
}

function personOptions(people: ReadonlyArray<VisitPerson>): Array<CrmChoiceOption<string>> {
  return people.map((person) => ({ value: person.hrId, label: person.name, note: person.title }));
}

type Draft = { ok: true; payload: Record<string, unknown>; customerName: string } | { ok: false; problem: string };

function AddVisit({
  handoff,
  onClose,
  onSaved,
  seatId,
  test,
}: {
  handoff: PendingVisit | null;
  onClose: () => void;
  onSaved: (visit: SavedVisit, customerName: string, validate: number | null) => void;
  seatId: string;
  test: boolean;
}) {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const { handleExpiredSession, token } = useSession();
  const [form, setForm] = useState<VisitFormView | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const [customerId, setCustomerId] = useState<string | null>(handoff?.customerId ?? null);
  const [picking, setPicking] = useState(!handoff);
  const [visitType, setVisitType] = useState<VisitTypeChoice>("planned");
  const [unplannedReason, setUnplannedReason] = useState("");
  const [kind, setKind] = useState<CrmVisitKind>("single");
  const [managerHrId, setManagerHrId] = useState<string | null>(null);
  const [seniorHrId, setSeniorHrId] = useState<string | null>(null);
  const [products, setProducts] = useState<string[]>([]);
  const [comment, setComment] = useState("");
  // The recording lives HERE and not inside the microphone control, because the save is what attaches it:
  // a recording uploaded and left out of the payload is an orphan in the bucket. Beside the photo, and
  // deliberately not one of its fields — the photo's slot dates the visit and a recording dates nothing.
  const [voiceNote, setVoiceNote] = useState<CrmVoiceNote | null>(null);
  const [photo, setPhoto] = useState<CrmCapturedPhoto | null>(null);
  const [usePlacePhoto, setUsePlacePhoto] = useState(Boolean(handoff?.photo));
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const visitIdRef = useRef<string | null>(null);

  async function loadForm() {
    if (!token) return;
    setFormError(null);
    try {
      const next = await crmGet<VisitFormView>(crmUrl("/api/phoenix-crm/visits/form", { seatId, test }), "form", token);
      setForm(next);
    } catch (caught) {
      if (caught instanceof ApiError && caught.isSessionExpired) return void handleExpiredSession();
      setFormError(crmErrorMessage(caught));
    }
  }

  useEffect(() => {
    void loadForm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seatId, test, token]);

  if (!form) {
    return (
      <View style={{ backgroundColor: palette.paper, flex: 1, gap: space.lg, padding: space.lg }}>
        <CrmBackBar backLabel="Visits" onBack={onClose} title="Add a visit" />
        {formError ? <ErrorNotice message={formError} /> : <LoadingScreen label="Opening Add Visit" />}
      </View>
    );
  }

  if (form.blockedReason) {
    return (
      <View style={{ backgroundColor: palette.paper, flex: 1, gap: space.lg, padding: space.lg }}>
        <CrmBackBar backLabel="Visits" onBack={onClose} title="Add a visit" />
        <CrmNote title="A visit cannot be added here yet" tone="warn">{form.blockedReason}</CrmNote>
      </View>
    );
  }

  const customer = customerId ? form.customers.find((option) => option.customerId === customerId) ?? null : null;
  const placePhoto = handoff?.photo && usePlacePhoto && customer && customer.customerId === handoff.customerId ? handoff.photo : null;
  const who = participantsOf(form, kind, managerHrId, seniorHrId);
  const commentLength = comment.trim().length;

  function pickCustomer(nextId: string) {
    setProblem(null);
    setPicking(false);
    if (nextId === customerId) return;
    if (photo) setPhoto(null); // The name is burned into the photo, so a photo for another customer is retaken.
    setCustomerId(nextId);
  }

  /** Changing the kind changes who is on offer, so a chosen customer who is no longer offered goes. */
  function chooseVisitType(next: VisitTypeChoice) {
    setProblem(null);
    setVisitType(next);
    if (next === "planned" && customer && !customer.plannedToday) {
      setPhoto(null);
      setCustomerId(null);
      setPicking(true);
    }
    if (next === "planned") setUnplannedReason("");
  }

  function toggleProduct(product: string) {
    setProblem(null);
    setProducts((current) =>
      current.includes(product) ? current.filter((entry) => entry !== product) : current.length >= VISIT_PRODUCTS_MAX ? current : [...current, product],
    );
  }

  function draft(visitId: string): Draft {
    if (!customer) return { ok: false, problem: "Choose the customer you visited." };
    if (customer.visitedToday) return { ok: false, problem: "This customer's visit for today is already saved." };
    if (visitType === "unplanned" && unplannedReason.trim().length < UNPLANNED_REASON_MIN) {
      return { ok: false, problem: "Write why you visited this customer off your plan." };
    }
    if (kind !== "single" && !who.manager) {
      return { ok: false, problem: form!.enteredAs === "manager" ? "You are not a manager of this territory. Reload." : "Choose the manager who was on the visit." };
    }
    if (kind === "chain" && !who.senior) return { ok: false, problem: "Choose the senior manager who was on the visit." };
    if (products.length === 0) return { ok: false, problem: "Choose the products you discussed." };
    const evidence = placePhoto ?? photo;
    if (!evidence) return { ok: false, problem: "Take a live photo of the clinic sign or door." };
    return {
      ok: true,
      customerName: customer.name,
      payload: {
        id: visitId,
        seatId,
        test,
        customerId: customer.customerId,
        // What he chose. The server re-decides it from the plan's own history; this only settles
        // whether the reason travels with the visit.
        visitType,
        unplannedReason: visitType === "unplanned" ? unplannedReason.trim() : null,
        kind,
        managerHrId: kind === "single" ? null : who.manager?.hrId ?? null,
        seniorHrId: kind === "chain" ? who.senior?.hrId ?? null : null,
        products,
        comment: comment.trim() || null,
        voiceNotePath: voiceNote?.path ?? null,
        voiceNoteSeconds: voiceNote?.seconds ?? null,
        voiceNoteBytes: voiceNote?.bytes ?? null,
        photoPath: evidence.path,
        lat: evidence.lat,
        lon: evidence.lon,
        accuracyMeters: evidence.accuracyMeters,
        deviceCapturedAt: evidence.deviceCapturedAt,
        deviceMocked: evidence.deviceMocked,
        ...(placePhoto ? { reusePlacePhoto: true } : {}),
      },
    };
  }

  async function save() {
    if (saving) return;
    if (placePhoto && handoff && reuseWindowOver(handoff.validatedAtMs)) {
      setUsePlacePhoto(false);
      setProblem("The validation photo stands for a visit only in the first 30 minutes. Take a new photo of the clinic sign or door.");
      return;
    }
    const visitId = visitIdRef.current ?? newClientId();
    const next = draft(visitId);
    if (!next.ok) {
      setProblem(next.problem);
      return;
    }
    visitIdRef.current = visitId;
    setSaving(true);
    setProblem(null);
    try {
      const savedVisit = await crmPost<SavedVisit>("/api/phoenix-crm/visits", "visit", next.payload, token);
      onSaved(savedVisit, next.customerName, customer?.pending ? customer.referenceContactCrmId : null);
    } catch (caught) {
      if (caught instanceof ApiError && caught.isSessionExpired) return void handleExpiredSession();
      const code = crmErrorCode(caught);
      let message = crmErrorMessage(caught);
      if (code === "phoenix_crm_photo_not_issued" && placePhoto) {
        setUsePlacePhoto(false);
        message = "The validation photo stands for a visit only in the first 30 minutes. Take a new photo of the clinic sign or door.";
      } else if (code === "phoenix_crm_photo_used" && placePhoto) {
        setUsePlacePhoto(false);
      } else if (code && code.startsWith("phoenix_crm_photo_")) {
        setPhoto(null);
      } else if (code === "phoenix_crm_clarification_required") {
        // The server's own test says this customer was not on a plan sent for today. Open the reason
        // box and keep the photo and the visit id: one line, and the SAME visit saves again.
        setVisitType("unplanned");
      } else if (code === "phoenix_crm_id_conflict") {
        visitIdRef.current = null;
      } else if (
        code === "phoenix_crm_already_visited" ||
        code === "phoenix_crm_customer_dropped" ||
        code === "phoenix_crm_customer_not_found" ||
        code === "phoenix_crm_place_changed"
      ) {
        void loadForm();
      }
      setProblem(message);
      setSaving(false);
    }
  }

  return (
    <ScrollView
      contentContainerStyle={{ gap: space.lg, paddingBottom: insets.bottom + space.xl, paddingHorizontal: space.lg, paddingTop: space.md }}
      keyboardShouldPersistTaps="handled"
      style={{ backgroundColor: palette.paper }}
    >
      <CrmBackBar backLabel="Visits" onBack={() => (saving ? undefined : onClose())} title="Add a visit" />
      <Text style={[type.meta, { color: palette.inkSoft }]}>{territoryLine(form.territory)}</Text>

      <CrmSection title="1 · Customer">
        {/* The kind of visit comes FIRST: it decides which customers the picker offers at all. */}
        <CrmChoice
          columns={2}
          disabled={saving}
          onChange={chooseVisitType}
          options={[
            { value: "planned" as VisitTypeChoice, label: "Planned visit" },
            { value: "unplanned" as VisitTypeChoice, label: "Unplanned visit" },
          ]}
          value={visitType}
        />
        {visitType === "unplanned" ? (
          <CrmNote title="It counts once it is approved" tone="info">
            {form.managers[0]
              ? `Write why you went. ${form.managers[0].name} decides it first, then SFE. Until then it counts in nothing.`
              : "Write why you went. SFE decides it. Until then it counts in nothing."}
          </CrmNote>
        ) : null}
        {customer && !picking ? (
          <View style={{ borderColor: palette.accentLine, borderRadius: radius, borderWidth: hairline, backgroundColor: palette.accentSoft, gap: space.xs, padding: space.md }}>
            <Text style={[type.bodyStrong, { color: palette.ink }]}>{customer.name}</Text>
            <Text style={[type.meta, { color: palette.inkSoft }]}>{customerMetaText(customer)}</Text>
            <PlaceWindows customer={customer} />
            <Text style={[type.meta, { color: palette.ink2 }]}>
              {customer.pending ? pendingVisitsText(customer.visitsThisMonth) : monthVisitsText(customer.visitsThisMonth, customer.target)}
            </Text>
            {customer.pending ? <CrmNote title={PENDING_PILL} tone="info">{PENDING_COUNTS_NOTE}</CrmNote> : null}
            {customer.visitedToday ? <CrmNote tone="info">This customer&apos;s visit for today is already saved.</CrmNote> : null}
            {!placePhoto ? <SecondaryButton label="Change customer" onPress={() => setPicking(true)} /> : null}
          </View>
        ) : (
          <>
            {handoff && !customer ? (
              <CrmNote tone="warn">{`${handoff.customerName} is not on the list of customers to visit. Choose the customer below.`}</CrmNote>
            ) : null}
            <CustomerPicker customers={form.customers} disabled={saving} onPick={pickCustomer} selectedId={customerId} visitType={visitType} />
          </>
        )}
        {visitType === "unplanned" ? (
          <View style={{ gap: space.sm }}>
            <Text style={[type.micro, { color: palette.inkSoft, textTransform: "uppercase" }]}>Why you went</Text>
            <TextInput
              editable={!saving}
              maxLength={UNPLANNED_REASON_MAX}
              multiline
              onChangeText={(next) => {
                setProblem(null);
                setUnplannedReason(next);
              }}
              placeholder="A sentence your manager can act on — what took you there."
              placeholderTextColor={palette.inkFaint}
              style={[
                type.body,
                {
                  backgroundColor: palette.surface,
                  borderColor: palette.line,
                  borderRadius: radius,
                  borderWidth: hairline,
                  color: palette.ink,
                  minHeight: 80,
                  padding: space.md,
                  textAlignVertical: "top",
                },
              ]}
              value={unplannedReason}
            />
            <Text style={[type.meta, { color: palette.inkSoft }]}>
              {unplannedReason.trim().length < UNPLANNED_REASON_MIN
                ? `At least ${UNPLANNED_REASON_MIN} characters.`
                : `${UNPLANNED_REASON_MAX - unplannedReason.length} left.`}
            </Text>
          </View>
        ) : null}
      </CrmSection>

      <CrmSection title="2 · Who was on the visit">
        <CrmChoice
          columns={3}
          disabled={saving}
          onChange={(next) => {
            setProblem(null);
            setKind(next);
          }}
          options={who.options}
          value={kind}
        />
        {kind !== "single" && form.enteredAs === "rep" ? (
          <View style={{ gap: space.sm }}>
            <Text style={[type.micro, { color: palette.inkSoft, textTransform: "uppercase" }]}>The manager</Text>
            {who.managerOptions.length > 0 ? (
              <CrmChoice
                columns={2}
                disabled={saving}
                onChange={(next) => {
                  setProblem(null);
                  setManagerHrId(next);
                  setSeniorHrId(null);
                }}
                options={personOptions(who.managerOptions)}
                value={who.manager?.hrId ?? null}
              />
            ) : (
              <Text style={[type.meta, { color: palette.inkSoft }]}>No manager sits above this territory.</Text>
            )}
          </View>
        ) : null}
        {kind === "chain" && (form.enteredAs === "manager" || who.manager) ? (
          <View style={{ gap: space.sm }}>
            <Text style={[type.micro, { color: palette.inkSoft, textTransform: "uppercase" }]}>The senior manager</Text>
            {who.seniorOptions.length > 0 ? (
              <CrmChoice
                columns={2}
                disabled={saving}
                onChange={(next) => {
                  setProblem(null);
                  setSeniorHrId(next);
                }}
                options={personOptions(who.seniorOptions)}
                value={who.senior?.hrId ?? null}
              />
            ) : (
              <Text style={[type.meta, { color: palette.inkSoft }]}>No senior manager sits above the manager you chose.</Text>
            )}
          </View>
        ) : null}
      </CrmSection>

      <CrmSection title="3 · Products discussed">
        <CrmChoice
          columns={2}
          disabled={saving}
          onChange={toggleProduct}
          options={form.products.map((product) => ({ value: product, label: product, disabled: !products.includes(product) && products.length >= VISIT_PRODUCTS_MAX }))}
          value={products}
        />
        <Text style={[type.meta, { color: palette.inkSoft }]}>
          {products.length === 0 ? `Choose up to ${VISIT_PRODUCTS_MAX}.` : `${products.length} chosen, up to ${VISIT_PRODUCTS_MAX}.`}
        </Text>
      </CrmSection>

      <CrmSection title="4 · Comment">
        <TextInput
          editable={!saving}
          maxLength={VISIT_COMMENT_MAX}
          multiline
          onChangeText={(next) => {
            setProblem(null);
            setComment(next);
          }}
          placeholder="What happened on the visit (optional)"
          placeholderTextColor={palette.inkFaint}
          style={[
            type.body,
            {
              backgroundColor: palette.surface,
              borderColor: palette.line,
              borderRadius: radius,
              borderWidth: hairline,
              color: palette.ink,
              minHeight: 96,
              padding: space.md,
              textAlignVertical: "top",
            },
          ]}
          value={comment}
        />
        <Text style={[type.meta, { color: palette.inkSoft }]}>{`${commentLength} of ${VISIT_COMMENT_MAX} characters`}</Text>
        <CrmSpeakComment
          disabled={saving}
          onAppend={(spoken) => {
            setProblem(null);
            setComment((current) => appendCrmDictated(current, spoken, VISIT_COMMENT_MAX));
          }}
          onChange={(next) => {
            setProblem(null);
            setVoiceNote(next);
          }}
          seatId={seatId}
          test={test}
          value={voiceNote}
        />
      </CrmSection>

      <CrmSection title="5 · Live photo">
        {placePhoto ? (
          <View style={{ gap: space.sm }}>
            <View style={{ backgroundColor: palette.paper2, borderColor: palette.line, borderRadius: radius, borderWidth: hairline, overflow: "hidden" }}>
              <Image contentFit="contain" source={{ uri: placePhoto.previewUri }} style={{ height: 240, width: "100%" }} transition={120} />
            </View>
            <Text style={[type.meta, { color: palette.inkSoft }]}>{placePhoto.locationLabel}</Text>
            <CrmNote tone="info">The photo you took to validate this customer stands for this visit when you save within 30 minutes of validating.</CrmNote>
            <SecondaryButton label="Take a new photo instead" onPress={() => setUsePlacePhoto(false)} />
          </View>
        ) : customer ? (
          <CrmLivePhoto
            disabled={saving}
            onChange={(next) => {
              setProblem(null);
              setPhoto(next);
            }}
            purpose="visit"
            seatId={seatId}
            test={test}
            title={customer.name}
            value={photo}
          />
        ) : (
          <Text style={[type.meta, { color: palette.inkSoft }]}>Choose the customer first.</Text>
        )}
      </CrmSection>

      {problem ? <CrmNote tone="bad">{problem}</CrmNote> : null}
      <PrimaryButton busy={saving} busyLabel="Saving the visit…" label="Save the visit" onPress={() => void save()} />
      <SecondaryButton label="Cancel" onPress={() => (saving ? undefined : onClose())} />
    </ScrollView>
  );
}
