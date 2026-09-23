import { Image } from "expo-image";
import { useEffect, useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  CrmBackBar,
  CrmChoice,
  CrmEmpty,
  CrmNote,
  CrmPill,
  CrmSearch,
  CrmSection,
  type CrmChoiceOption,
} from "@/components/crm/crm-kit";
import { CrmLivePhoto } from "@/components/crm/live-photo";
import { CrmTimingsInput } from "@/components/crm/timings-input";
import { ErrorNotice, Field, LoadingScreen, MicroLabel, PrimaryButton, SecondaryButton, StatTile } from "@/components/ui";
import { ApiError } from "@/lib/api";
import { crmErrorCode, crmErrorMessage, crmGet, crmPost, crmUrl, useCrm } from "@/lib/crm/client";
import { CUSTOMER_NAME_MAX, PLACE_TEXT_MAX, SPECIALITY_TEXT_MAX } from "@/lib/crm/entry-rules";
import { cairoStamp, countText } from "@/lib/crm/format";
import {
  customerMetaText,
  listText,
  monthStanding,
  monthVisitsText,
  PENDING_PILL,
  pendingVisitsText,
  placesDaysText,
  referenceAddressText,
  referenceLastVisitText,
  territoryLine,
} from "@/lib/crm/labels";
import type { CrmCapturedPhoto } from "@/lib/crm/photo";
import { useSession } from "@/lib/session";
import { emptyPlaceDraft, placeDraftProblem, placePayload, ramadanHoursNote, type PlaceDraftState } from "@/features/crm/place-draft";
import type { PendingValidate, PendingVisit } from "@/features/crm/handoff";
import { hairline, radius, space, type } from "@/theme/tokens";
import { usePalette } from "@/theme/use-palette";
import type { CrmGrade, CrmListType, ListCustomer, TerritoryListView, ValidateResult } from "@/lib/crm/types";

/**
 * Phoenix CRM — the List screen on the phone: a territory's customer list, and validating a customer.
 *
 * The native counterpart of the web `ListTab` (src/components/phoenix-crm/list-tab.tsx), on the same
 * route. A rep keeps his whole iReports360 list from day one; every customer on it is real, PENDING
 * until he validates it at the clinic with a live photo, the location and at least one timing — once per
 * customer, forever. A pending customer is planned and visited exactly like any other and counts in no
 * metric until he is validated. AM and PM stand apart everywhere and are never added together (owner).
 *
 * This first screen covers the rep's core: the list, To validate (Validate and Add a visit), and the
 * validated Customers, plus Add a new customer. The customer's own page, the timetable, requests, and
 * bringing a customer back are later screens.
 */

const GRADES: readonly CrmGrade[] = ["A", "B", "C"];
const LIST_TYPES: readonly CrmListType[] = ["AM", "PM"];

const PHOTO_NEEDED = "Take a live photo of the clinic sign or door.";
const UNCHECKED = "The save may have gone through, but Phoenix could not check. Check the connection, then press Save again.";

/** A save whose answer was lost may still have landed; these answers are the ones a landed save can give. */
const MAY_HAVE_SAVED = new Set(["offline", "failed", "internal_error", "statement_timeout", "phoenix_crm_photo_used", "phoenix_crm_already_validated", "phoenix_crm_same_name"]);

type ListSection = "validate" | "customers" | "left";
type TypeFilter = "all" | CrmListType;

function listUrl(seatId: string, test: boolean): string {
  return crmUrl("/api/phoenix-crm/list", { seatId, test });
}

function normalizedName(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function matchesQuery(needle: string, parts: ReadonlyArray<string | null | undefined>): boolean {
  if (!needle) return true;
  return parts.some((part) => typeof part === "string" && part.toLowerCase().includes(needle));
}

function customerMatches(needle: string, customer: ListCustomer): boolean {
  return matchesQuery(needle, [
    customer.name,
    customer.speciality,
    customer.reference?.address ?? null,
    customer.reference?.city ?? null,
    customer.reference?.zone ?? null,
    ...customer.places.flatMap((place) => [place.label, place.address, place.zone, place.brickName]),
  ]);
}

function byTypeThenName(left: ListCustomer, right: ListCustomer): number {
  if (left.listType !== right.listType) return left.listType.localeCompare(right.listType);
  return left.name.localeCompare(right.name);
}

function countByType<T extends { listType: CrmListType }>(rows: ReadonlyArray<T>): Record<CrmListType, number> {
  return { AM: rows.filter((row) => row.listType === "AM").length, PM: rows.filter((row) => row.listType === "PM").length };
}

/** "3 AM · 41 PM" — AM and PM side by side, never added together. */
function pairText(counts: Record<CrmListType, number>): string {
  return `${countText(counts.AM)} AM · ${countText(counts.PM)} PM`;
}

function deciderText(view: Pick<TerritoryListView, "isTest" | "territory">): string {
  if (view.isTest) return "In test mode you decide it yourself, under Requests.";
  return view.territory.reviewerName ? `${view.territory.reviewerName} decides it.` : "The manager above this territory decides it.";
}

// ── The screen state machine ────────────────────────────────────────────────────────────────────

type SavedPlace = { kind: "validated" | "restored"; customerId: string; customerName: string; listType: CrmListType; gradeRequested: boolean; savedAtMs: number };

type ListState =
  | { name: "home" }
  | { name: "validate"; contactCrmId: number }
  | { name: "new" }
  | { name: "saved"; saved: SavedPlace; photo: CrmCapturedPhoto };

export function ListScreen({
  cairoToday,
  onPendingValidateDone,
  onStartVisit,
  onWorkChange,
  pendingValidate,
  seatId,
  test,
}: {
  cairoToday: string;
  onPendingValidateDone: () => void;
  /** Add a visit with the photo a place was just saved with, or a plain one. Absent where visits are not entered. */
  onStartVisit?: (visit: PendingVisit) => void;
  onWorkChange: (working: boolean) => void;
  pendingValidate: PendingValidate | null;
  seatId: string;
  test: boolean;
}) {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const resource = useCrm<TerritoryListView>(listUrl(seatId, test), "list");
  const [screen, setScreen] = useState<ListState>({ name: "home" });
  const [section, setSection] = useState<ListSection | null>(null);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");

  const validateHandoff = pendingValidate && pendingValidate.seatId === seatId && pendingValidate.test === test ? pendingValidate : null;
  const current: ListState = validateHandoff ? { name: "validate", contactCrmId: validateHandoff.contactCrmId } : screen;
  const working = current.name !== "home" && current.name !== "saved";

  useEffect(() => {
    onWorkChange(working);
  }, [onWorkChange, working]);

  function go(next: ListState) {
    if (validateHandoff) onPendingValidateDone();
    setScreen(next);
  }
  const home = () => go({ name: "home" });

  function placeSaved(saved: SavedPlace, photo: CrmCapturedPhoto) {
    resource.reload();
    go({ name: "saved", saved, photo });
  }

  function startVisit(customerId: string, customerName: string, photo: CrmCapturedPhoto | null, validatedAtMs: number) {
    if (!onStartVisit) return;
    if (validateHandoff) onPendingValidateDone();
    setScreen({ name: "home" });
    onStartVisit({ seatId, test, customerId, customerName, photo, validatedAtMs });
  }

  const view = resource.data;

  if (!view) {
    return (
      <View style={{ backgroundColor: palette.paper, flex: 1, gap: space.lg, padding: space.lg, paddingTop: space.md }}>
        {resource.error ? <ErrorNotice message={resource.error} /> : <LoadingScreen label="Loading the customer list" />}
      </View>
    );
  }

  if (current.name === "validate" || current.name === "new") {
    const subject = current.name === "new" ? ({ mode: "new" } as const) : ({ mode: "reference", contactCrmId: current.contactCrmId } as const);
    return (
      <ValidateScreen
        cairoToday={cairoToday}
        key={current.name === "new" ? "new" : `validate-${current.contactCrmId}`}
        onBack={home}
        onSaved={placeSaved}
        onView={resource.replace}
        reload={resource.reload}
        seatId={seatId}
        subject={subject}
        test={test}
        view={view}
      />
    );
  }

  if (current.name === "saved") {
    return (
      <SavedScreen
        onBack={home}
        onStartVisit={onStartVisit ? () => startVisit(current.saved.customerId, current.saved.customerName, current.photo, current.saved.savedAtMs) : null}
        photo={current.photo}
        saved={current.saved}
        view={view}
      />
    );
  }

  return (
    <ListHome
      cairoToday={cairoToday}
      error={resource.error}
      insetsBottom={insets.bottom}
      onNew={() => go({ name: "new" })}
      onRefresh={resource.reload}
      onValidate={(contactCrmId) => go({ name: "validate", contactCrmId })}
      onVisitCustomer={onStartVisit ? (customer) => startVisit(customer.customerId, customer.name, null, Date.now()) : undefined}
      query={query}
      refreshing={resource.refreshing}
      section={section}
      setQuery={setQuery}
      setSection={setSection}
      setTypeFilter={setTypeFilter}
      typeFilter={typeFilter}
      view={view}
    />
  );
}

// ── The list's home ─────────────────────────────────────────────────────────────────────────────

function ListHome({
  error,
  insetsBottom,
  onNew,
  onRefresh,
  onValidate,
  onVisitCustomer,
  query,
  refreshing,
  section,
  setQuery,
  setSection,
  setTypeFilter,
  typeFilter,
  view,
}: {
  cairoToday: string;
  error: string | null;
  insetsBottom: number;
  onNew: () => void;
  onRefresh: () => void;
  onValidate: (contactCrmId: number) => void;
  onVisitCustomer?: (customer: ListCustomer) => void;
  query: string;
  refreshing: boolean;
  section: ListSection | null;
  setQuery: (next: string) => void;
  setSection: (next: ListSection) => void;
  setTypeFilter: (next: TypeFilter) => void;
  typeFilter: TypeFilter;
  view: TerritoryListView;
}) {
  const palette = usePalette();

  const pending = view.customers.filter((customer) => customer.status === "pending");
  const active = view.customers.filter((customer) => customer.status === "active");
  const dropped = view.customers.filter((customer) => customer.status === "dropped");
  const hasReference = view.reference.length > 0 || pending.length > 0;

  const defaultSection: ListSection = view.canEdit && pending.length > 0 ? "validate" : "customers";
  const currentSection: ListSection = section === "validate" && !hasReference ? "customers" : (section ?? defaultSection);

  const needle = query.trim().toLowerCase();
  const typeMatches = (listType: CrmListType) => typeFilter === "all" || typeFilter === listType;
  const filtered = Boolean(needle) || typeFilter !== "all";

  const sectionOptions: Array<CrmChoiceOption<ListSection>> = [
    ...(hasReference ? [{ value: "validate" as const, label: "To validate", note: pending.length > 0 ? `${countText(pending.length)} to go` : "All done" }] : []),
    { value: "customers" as const, label: "Customers", note: pairText(countByType(active)) },
    { value: "left" as const, label: "Left the list", note: countText(dropped.length) },
  ];

  const shownPending = pending.filter((customer) => typeMatches(customer.listType) && customerMatches(needle, customer)).sort(byTypeThenName);
  const shownActive = active.filter((customer) => typeMatches(customer.listType) && customerMatches(needle, customer)).sort(byTypeThenName);
  const shownDropped = dropped
    .filter((customer) => typeMatches(customer.listType) && customerMatches(needle, customer))
    .sort((left, right) => right.statusChangedAt.localeCompare(left.statusChangedAt));

  return (
    <ScrollView
      contentContainerStyle={{ gap: space.lg, paddingBottom: insetsBottom + space.xl, paddingHorizontal: space.lg, paddingTop: space.md }}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl onRefresh={onRefresh} refreshing={refreshing} tintColor={palette.accent} />}
      style={{ backgroundColor: palette.paper }}
    >
      <View style={{ gap: space.xs }}>
        <Text style={[type.title, { color: palette.ink }]}>Customer list</Text>
        <Text style={[type.meta, { color: palette.inkSoft }]}>{territoryLine(view.territory)}</Text>
      </View>

      {error ? <ErrorNotice message={error} /> : null}

      <ReadinessBlock pending={pending} view={view} />

      {view.canEdit ? <PrimaryButton label="Add a new customer" onPress={onNew} /> : null}

      <CrmSection title="Which part of the list">
        <CrmChoice columns={3} onChange={setSection} options={sectionOptions} value={currentSection} />
      </CrmSection>

      <View style={{ gap: space.sm }}>
        <CrmSearch onChangeText={setQuery} placeholder="Name, speciality, address or zone" value={query} />
        <CrmChoice
          columns={3}
          onChange={setTypeFilter}
          options={[
            { value: "all", label: "All" },
            { value: "PM", label: "PM" },
            { value: "AM", label: "AM" },
          ]}
          value={typeFilter}
        />
      </View>

      {currentSection === "validate" ? (
        <PendingSection customers={shownPending} filtered={filtered} onValidate={onValidate} onVisitCustomer={onVisitCustomer} view={view} />
      ) : null}
      {currentSection === "customers" ? <CustomersSection customers={shownActive} filtered={filtered} onVisitCustomer={onVisitCustomer} view={view} /> : null}
      {currentSection === "left" ? <LeftSection customers={shownDropped} filtered={filtered} /> : null}
    </ScrollView>
  );
}

function ReadinessBlock({ pending, view }: { pending: ReadonlyArray<ListCustomer>; view: TerritoryListView }) {
  const palette = usePalette();
  const { readiness } = view;
  const toGo = pending.length;

  if (view.reference.length === 0 && pending.length === 0) {
    return (
      <CrmNote title="No iReports360 list for this territory" tone="info">
        {view.canEdit
          ? "Add the territory's customers as new customers: a live photo at the clinic, the location and the days and hours. Weekly plans use the customers on this list."
          : "The rep adds the territory's customers as new customers, each with a live photo at the clinic, the location and the days and hours."}
      </CrmNote>
    );
  }

  const reference = countByType(view.reference);
  return (
    <View style={{ gap: space.sm }}>
      <MicroLabel>The list</MicroLabel>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
        <StatTile label="Validated" value={`${countText(readiness.validated)} of ${countText(readiness.total)}`} />
        <StatTile label="To validate" tone={toGo > 0 ? "accent" : "default"} value={countText(toGo)} />
      </View>
      <Text style={[type.meta, { color: palette.inkSoft }]}>{`Reference list: ${pairText(reference)}`}</Text>
      {toGo === 0 ? (
        <CrmNote title="Every customer is validated" tone="good">
          {readiness.readyAt ? `Ready since ${cairoStamp(readiness.readyAt)}. ` : ""}
          Customers who appear on the iReports360 list later show under To validate, and can be planned and visited straight away.
        </CrmNote>
      ) : (
        <CrmNote title={`${countText(toGo)} not validated yet`} tone="info">
          {view.canEdit
            ? "Plan them and visit them as normal — nothing here holds your week up. Validate each one at the clinic, and the visits you have already saved against it start counting."
            : "The rep plans and visits them as normal. Each one starts counting once the rep validates it at the clinic."}
        </CrmNote>
      )}
    </View>
  );
}

function PendingCard({
  customer,
  onValidate,
  onVisitCustomer,
  view,
}: {
  customer: ListCustomer;
  onValidate: (contactCrmId: number) => void;
  onVisitCustomer?: (customer: ListCustomer) => void;
  view: TerritoryListView;
}) {
  const palette = usePalette();
  return (
    <View style={{ borderColor: palette.line, borderLeftColor: palette.accent, borderLeftWidth: 3, borderRadius: radius, borderWidth: hairline, gap: space.sm, padding: space.md }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs, justifyContent: "space-between" }}>
        <Text style={[type.bodyStrong, { color: palette.ink, flex: 1, minWidth: 0 }]}>{customer.name}</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
          <CrmPill tone="warn">{PENDING_PILL}</CrmPill>
          {customer.pendingDropRequestId ? <CrmPill tone="neutral">Drop waiting</CrmPill> : null}
        </View>
      </View>
      <Text style={[type.meta, { color: palette.inkSoft }]}>{customerMetaText(customer)}</Text>
      <Text style={[type.meta, { color: palette.ink2 }]}>{referenceAddressText(customer.reference) ?? "No address in iReports360"}</Text>
      <Text style={[type.meta, { color: palette.inkSoft }]}>{`Last visit in iReports360: ${referenceLastVisitText(customer.reference)}`}</Text>
      <Text style={[type.meta, { color: palette.ink2 }]}>{pendingVisitsText(customer.visitsThisMonth)}</Text>
      <View style={{ gap: space.sm }}>
        {view.canEdit && customer.referenceContactCrmId !== null ? (
          <PrimaryButton label="Validate" onPress={() => onValidate(customer.referenceContactCrmId as number)} />
        ) : null}
        {view.canEdit && onVisitCustomer ? <SecondaryButton label="Add a visit" onPress={() => onVisitCustomer(customer)} /> : null}
      </View>
    </View>
  );
}

function PendingSection({
  customers,
  filtered,
  onValidate,
  onVisitCustomer,
  view,
}: {
  customers: ReadonlyArray<ListCustomer>;
  filtered: boolean;
  onValidate: (contactCrmId: number) => void;
  onVisitCustomer?: (customer: ListCustomer) => void;
  view: TerritoryListView;
}) {
  if (customers.length === 0) {
    return filtered ? (
      <CrmEmpty message="Clear the search or show all customers." title="No customer to validate matches" />
    ) : (
      <CrmEmpty message="Every customer carried over from iReports360 is validated or has left the list." title="Every customer is validated" />
    );
  }
  return (
    <View style={{ gap: space.sm }}>
      {customers.map((customer) => (
        <PendingCard customer={customer} key={customer.customerId} onValidate={onValidate} onVisitCustomer={onVisitCustomer} view={view} />
      ))}
    </View>
  );
}

function CustomerPills({ customer }: { customer: ListCustomer }) {
  const standing = monthStanding(customer.visitsThisMonth, customer.target);
  return (
    <>
      <CrmPill tone={standing.tone}>{standing.label}</CrmPill>
      {customer.origin === "new" ? <CrmPill tone="warn">New customer</CrmPill> : null}
      {customer.pendingGradeRequestId ? <CrmPill tone="info">{customer.pendingGrade ? `Grade ${customer.pendingGrade} proposed` : "Grade proposed"}</CrmPill> : null}
      {customer.pendingDropRequestId ? <CrmPill tone="neutral">Drop waiting</CrmPill> : null}
    </>
  );
}

function CustomersSection({
  customers,
  filtered,
  onVisitCustomer,
  view,
}: {
  customers: ReadonlyArray<ListCustomer>;
  filtered: boolean;
  onVisitCustomer?: (customer: ListCustomer) => void;
  view: TerritoryListView;
}) {
  const palette = usePalette();
  if (customers.length === 0) {
    return filtered ? (
      <CrmEmpty message="Clear the search or show all customers." title="No customer matches" />
    ) : (
      <CrmEmpty
        message={view.canEdit ? "A customer shows here once validated at the clinic with a live photo, the location and the days and hours." : "A customer shows here once the rep validates it at the clinic."}
        title="No customers validated yet"
      />
    );
  }
  return (
    <View style={{ gap: space.sm }}>
      {customers.map((customer) => (
        <View key={customer.customerId} style={{ borderColor: palette.line, borderRadius: radius, borderWidth: hairline, gap: space.xs, padding: space.md }}>
          <Text style={[type.bodyStrong, { color: palette.ink }]}>{customer.name}</Text>
          <Text style={[type.meta, { color: palette.inkSoft }]}>{customerMetaText(customer)}</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
            <CustomerPills customer={customer} />
          </View>
          <Text style={[type.meta, { color: palette.ink2 }]}>{placesDaysText(customer)}</Text>
          <Text style={[type.meta, { color: palette.inkSoft }]}>{monthVisitsText(customer.visitsThisMonth, customer.target)}</Text>
          {view.canEdit && onVisitCustomer ? <SecondaryButton label="Add a visit" onPress={() => onVisitCustomer(customer)} /> : null}
        </View>
      ))}
    </View>
  );
}

function LeftSection({ customers, filtered }: { customers: ReadonlyArray<ListCustomer>; filtered: boolean }) {
  const palette = usePalette();
  if (customers.length === 0) {
    return filtered ? (
      <CrmEmpty message="Clear the search or show all customers." title="No customer matches" />
    ) : (
      <CrmEmpty message="A customer shows here after the district manager approves its drop." title="No customer has left the list" />
    );
  }
  return (
    <View style={{ gap: space.sm }}>
      {customers.map((customer) => (
        <View key={customer.customerId} style={{ borderColor: palette.line, borderRadius: radius, borderWidth: hairline, gap: space.xs, padding: space.md }}>
          <Text style={[type.bodyStrong, { color: palette.ink }]}>{customer.name}</Text>
          <Text style={[type.meta, { color: palette.inkSoft }]}>{customerMetaText(customer)}</Text>
          <Text style={[type.meta, { color: palette.ink2 }]}>
            <Text style={{ color: palette.ink }}>Reason: </Text>
            {customer.droppedReason ?? "Not recorded"}
          </Text>
          {customer.droppedNote ? <Text style={[type.meta, { color: palette.inkSoft }]}>{customer.droppedNote}</Text> : null}
          <Text style={[type.meta, { color: palette.inkSoft }]}>{`Left the list ${cairoStamp(customer.statusChangedAt)}`}</Text>
        </View>
      ))}
    </View>
  );
}

// ── The place fields (photo · days and hours · name) ──────────────────────────────────────────────

function PlaceFields({
  cairoToday,
  capture,
  customerName,
  disabled,
  draft,
  firstStep,
  photoBlockedReason,
  seatId,
  setDraft,
  test,
  view,
}: {
  cairoToday: string;
  capture: boolean;
  customerName: string;
  disabled: boolean;
  draft: PlaceDraftState;
  firstStep: number;
  photoBlockedReason: string | null;
  seatId: string;
  setDraft: (update: (current: PlaceDraftState) => PlaceDraftState) => void;
  test: boolean;
  view: TerritoryListView;
}) {
  const palette = usePalette();
  const timingsStep = firstStep + (capture ? 1 : 0);
  const nameStep = timingsStep + 1;
  return (
    <>
      {capture ? (
        <CrmSection title={`${firstStep} · Live photo`}>
          {photoBlockedReason && !draft.photo ? (
            <Text style={[type.meta, { color: palette.inkSoft }]}>{photoBlockedReason}</Text>
          ) : (
            <CrmLivePhoto
              disabled={disabled}
              hint="Stand at the clinic sign or door. The photo is saved with your location and the time."
              onChange={(photo) => setDraft((current) => ({ ...current, photo }))}
              purpose="place"
              seatId={seatId}
              test={test}
              title={customerName}
              value={draft.photo}
            />
          )}
        </CrmSection>
      ) : null}

      <CrmSection title={`${timingsStep} · Days and hours`}>
        <CrmTimingsInput disabled={disabled} onChange={(timings) => setDraft((current) => ({ ...current, timings }))} ramadanNote={ramadanHoursNote(view.ramadan, cairoToday)} value={draft.timings} />
      </CrmSection>

      <CrmSection title={`${nameStep} · Place name`}>
        <Field
          editable={!disabled}
          label="Place name (optional)"
          maxLength={PLACE_TEXT_MAX}
          onChangeText={(label) => setDraft((current) => ({ ...current, label }))}
          placeholder="For example: Evening clinic, or Al Salam Hospital"
          value={draft.label}
        />
      </CrmSection>
    </>
  );
}

// ── Validating a customer ─────────────────────────────────────────────────────────────────────────

type ValidateSubject = { mode: "reference"; contactCrmId: number } | { mode: "new" };

async function lookUpPhoto(seatId: string, test: boolean, photoPath: string, token: string | null): Promise<{ view: TerritoryListView; customer: ListCustomer | null } | null> {
  try {
    const view = await crmGet<TerritoryListView>(listUrl(seatId, test), "list", token);
    for (const customer of view.customers) {
      if (customer.places.some((place) => place.photoPath === photoPath)) return { view, customer };
    }
    return { view, customer: null };
  } catch {
    return null;
  }
}

function ValidateScreen({
  cairoToday,
  onBack,
  onSaved,
  onView,
  reload,
  seatId,
  subject,
  test,
  view,
}: {
  cairoToday: string;
  onBack: () => void;
  onSaved: (saved: SavedPlace, photo: CrmCapturedPhoto) => void;
  onView: (next: TerritoryListView) => void;
  reload: () => void;
  seatId: string;
  subject: ValidateSubject;
  test: boolean;
  view: TerritoryListView;
}) {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const { handleExpiredSession, token } = useSession();
  const [draft, setDraft] = useState<PlaceDraftState>(emptyPlaceDraft);
  const [listType, setListType] = useState<CrmListType | null>(null);
  const [name, setName] = useState("");
  const [speciality, setSpeciality] = useState("");
  const [grade, setGrade] = useState<CrmGrade | null>(null);
  const [sameName, setSameName] = useState<ListCustomer[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const reference = subject.mode === "reference" ? view.reference.find((entry) => entry.contactCrmId === subject.contactCrmId) ?? null : null;
  const title = subject.mode === "new" ? "Add a new customer" : "Validate a customer";

  const gone =
    !view.canEdit
      ? "Only the territory's rep changes this list."
      : subject.mode === "reference"
        ? !reference
          ? "This customer is no longer on the territory's reference list."
          : reference.state === "validated"
            ? "This customer is already validated. Find it under Customers."
            : reference.state === "dropped"
              ? "This customer left the list. Bring it back from Left the list."
              : null
        : null;

  const cleanName = normalizedName(name);
  const customerName = reference?.name ?? cleanName;

  function clientProblem(): string | null {
    if (subject.mode === "new") {
      if (!listType) return "Choose AM or PM.";
      if (cleanName.length < 3) return "Write the customer's full name.";
      if (!grade) return "Propose a grade (A, B or C).";
    }
    return placeDraftProblem(draft, { needsPhoto: true });
  }

  function payloadFor(photo: CrmCapturedPhoto, allowSameName: boolean): Record<string, unknown> {
    const place = placePayload(photo, draft);
    if (subject.mode === "reference") return { seatId, test, mode: "reference", referenceContactCrmId: subject.contactCrmId, place };
    return {
      seatId,
      test,
      mode: "new",
      customer: { listType, name: cleanName, speciality: normalizedName(speciality) || null, proposedGrade: grade },
      allowSameName,
      place,
    };
  }

  function sameNameIn(list: TerritoryListView): ListCustomer[] {
    const needle = cleanName.toLowerCase();
    return list.customers.filter((customer) => customer.status === "active" && customer.listType === listType && customer.name.toLowerCase() === needle);
  }

  async function save(allowSameName: boolean) {
    if (saving) return;
    const gap = clientProblem();
    const photo = draft.photo;
    if (gap || !photo) {
      setProblem(gap ?? PHOTO_NEEDED);
      return;
    }
    setSaving(true);
    setProblem(null);
    setSameName(null);
    try {
      const result = await crmPost<ValidateResult>("/api/phoenix-crm/list/validate", "result", payloadFor(photo, allowSameName), token);
      onSaved(
        { kind: result.restored ? "restored" : "validated", customerId: result.customerId, customerName: result.customerName, listType: result.listType, gradeRequested: Boolean(result.gradeRequestId), savedAtMs: Date.now() },
        photo,
      );
    } catch (error) {
      if (error instanceof ApiError && error.isSessionExpired) return void handleExpiredSession();
      const code = crmErrorCode(error);
      const lookup = code && MAY_HAVE_SAVED.has(code) ? await lookUpPhoto(seatId, test, photo.path, token) : null;
      if (lookup && lookup.customer) {
        const saved = lookup.customer;
        onView(lookup.view);
        onSaved(
          {
            kind: "validated",
            customerId: saved.customerId,
            customerName: saved.name,
            listType: saved.listType,
            gradeRequested: subject.mode === "new" && saved.pendingGradeRequestId !== null,
            savedAtMs: Date.now(),
          },
          photo,
        );
        return;
      }
      if (lookup) onView(lookup.view);
      setSaving(false);
      if (code === "phoenix_crm_same_name") {
        setSameName(sameNameIn(lookup?.view ?? view));
        return;
      }
      if (!lookup && (code === "phoenix_crm_photo_used" || code === "phoenix_crm_already_validated")) {
        setProblem(UNCHECKED);
        return;
      }
      if (code && code.startsWith("phoenix_crm_photo_")) {
        setDraft((current) => (current.photo?.path === photo.path ? { ...current, photo: null } : current));
      } else if (code === "phoenix_crm_not_on_reference_list" || code === "phoenix_crm_customer_not_found") {
        reload();
      }
      setProblem(crmErrorMessage(error));
    }
  }

  if (gone) {
    return (
      <View style={{ backgroundColor: palette.paper, flex: 1, gap: space.lg, padding: space.lg, paddingTop: space.md }}>
        <CrmBackBar backLabel="List" onBack={onBack} title={title} />
        <CrmNote tone="info">{gone}</CrmNote>
        <SecondaryButton label="Back to the list" onPress={onBack} />
      </View>
    );
  }

  const referenceAddress = referenceAddressText(reference);
  const saveLabel = subject.mode === "new" ? "Save the customer" : "Validate the customer";

  return (
    <ScrollView
      contentContainerStyle={{ gap: space.lg, paddingBottom: insets.bottom + space.xl, paddingHorizontal: space.lg, paddingTop: space.md }}
      keyboardShouldPersistTaps="handled"
      style={{ backgroundColor: palette.paper }}
    >
      <CrmBackBar backLabel="List" onBack={() => (saving ? undefined : onBack())} title={title} />
      <Text style={[type.meta, { color: palette.inkSoft }]}>{territoryLine(view.territory)}</Text>

      {reference ? (
        <CrmSection title="Customer">
          <View style={{ borderColor: palette.line, borderRadius: radius, borderWidth: hairline, gap: space.xs, padding: space.md }}>
            <Text style={[type.bodyStrong, { color: palette.ink }]}>{reference.name}</Text>
            <Text style={[type.meta, { color: palette.inkSoft }]}>{customerMetaText(reference)}</Text>
            {referenceAddress ? (
              <Text style={[type.meta, { color: palette.ink2 }]}>
                <Text style={{ color: palette.ink }}>Address in iReports360: </Text>
                {referenceAddress}
              </Text>
            ) : null}
            <Text style={[type.meta, { color: palette.inkSoft }]}>{`Last visit in iReports360: ${referenceLastVisitText(reference)}`}</Text>
          </View>
          <Text style={[type.meta, { color: palette.inkSoft }]}>
            The name and grade are iReports360&apos;s for now — you can change them later. Your live photo, the location and the days and hours become this customer&apos;s real record, and its visits start counting. You validate a customer once.
          </Text>
        </CrmSection>
      ) : null}

      {subject.mode === "new" ? (
        <CrmSection title="1 · Customer">
          <View style={{ gap: space.xs }}>
            <MicroLabel>AM or PM</MicroLabel>
            <CrmChoice
              columns={2}
              disabled={saving}
              onChange={(next) => {
                setListType(next);
                setSameName(null);
                setProblem(null);
              }}
              options={[
                { value: "PM", label: listText("PM"), note: "In a clinic" },
                { value: "AM", label: listText("AM"), note: "A hospital or a center" },
              ]}
              value={listType}
            />
          </View>
          <Field
            editable={!saving}
            label="Full name"
            maxLength={CUSTOMER_NAME_MAX}
            onChangeText={(next) => {
              setName(next);
              setSameName(null);
              setProblem(null);
            }}
            placeholder="As written on the sign"
            value={name}
          />
          <Field
            editable={!saving}
            label="Speciality (optional)"
            maxLength={SPECIALITY_TEXT_MAX}
            onChangeText={setSpeciality}
            placeholder="For example: Internal Medicine"
            value={speciality}
          />
          <View style={{ gap: space.xs }}>
            <MicroLabel>Proposed grade</MicroLabel>
            <CrmChoice
              columns={3}
              disabled={saving}
              onChange={(next) => {
                setGrade(next);
                setProblem(null);
              }}
              options={GRADES.map((option) => ({ value: option, label: `Grade ${option}` }))}
              value={grade}
            />
            <Text style={[type.meta, { color: palette.inkSoft }]}>{deciderText(view)}</Text>
          </View>
        </CrmSection>
      ) : null}

      <PlaceFields
        cairoToday={cairoToday}
        capture
        customerName={customerName || "the customer"}
        disabled={saving}
        draft={draft}
        firstStep={subject.mode === "new" ? 2 : 1}
        photoBlockedReason={subject.mode === "new" && !cleanName ? "Write the customer's full name first. It is printed on the photo." : null}
        seatId={seatId}
        setDraft={setDraft}
        test={test}
        view={view}
      />

      {sameName ? (
        <CrmNote title="A customer with this name is already on the list" tone="warn">
          <View style={{ gap: space.sm }}>
            <Text style={[type.body, { color: palette.ink }]}>
              A different person with the same name: save as a different person. The same customer at another place is added from that customer&apos;s own page.
            </Text>
            <SecondaryButton label="Save as a different person" onPress={() => void save(true)} />
          </View>
        </CrmNote>
      ) : null}

      {problem ? <CrmNote tone="bad">{problem}</CrmNote> : null}
      <PrimaryButton busy={saving} busyLabel="Saving…" label={saveLabel} onPress={() => void save(false)} />
      <SecondaryButton label="Cancel" onPress={() => (saving ? undefined : onBack())} />
    </ScrollView>
  );
}

// ── After a place is saved ──────────────────────────────────────────────────────────────────────

function SavedScreen({
  onBack,
  onStartVisit,
  photo,
  saved,
  view,
}: {
  onBack: () => void;
  onStartVisit: (() => void) | null;
  photo: CrmCapturedPhoto;
  saved: SavedPlace;
  view: TerritoryListView;
}) {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const heading = saved.kind === "restored" ? `Back on the list: ${saved.customerName}` : `Validated: ${saved.customerName}`;
  return (
    <ScrollView
      contentContainerStyle={{ gap: space.lg, paddingBottom: insets.bottom + space.xl, paddingHorizontal: space.lg, paddingTop: space.md }}
      style={{ backgroundColor: palette.paper }}
    >
      <CrmBackBar backLabel="List" onBack={onBack} title="Customer saved" />
      <View style={{ backgroundColor: palette.paper2, borderColor: palette.line, borderRadius: radius, borderWidth: hairline, overflow: "hidden" }}>
        <Image contentFit="contain" source={{ uri: photo.previewUri }} style={{ height: 220, width: "100%" }} transition={120} />
      </View>
      <CrmNote title={heading} tone="good">{`${listText(saved.listType)} · ${photo.locationLabel}`}</CrmNote>
      {saved.gradeRequested ? <CrmNote title="The proposed grade is waiting for a decision" tone="info">{deciderText(view)}</CrmNote> : null}

      {onStartVisit ? (
        <CrmSection title="Visiting now?">
          <Text style={[type.body, { color: palette.ink }]}>You are at the clinic, so this photo can stand for today&apos;s visit when you save the visit within 30 minutes.</Text>
          <PrimaryButton label="Add today's visit with this photo" onPress={onStartVisit} />
        </CrmSection>
      ) : null}

      <SecondaryButton label="Back to the list" onPress={onBack} />
    </ScrollView>
  );
}
