"use client";

/**
 * Phoenix CRM — "My single visits": a manager's own visits, alone (owner, 2026-10-16: "he is submitting
 * single visits if he is alone … with medical rep, the medical rep … submits him"). A district manager's,
 * and since 2026-10-17 the regional, national and product managers' too — a product manager holds no
 * territory, so this is his whole Visits tab.
 *
 * Today's planned single-visit customers, each with Log; and "Log an unplanned customer" for one he did
 * not plan — shown apart in his report. Location optional, NO photo, products optional, comment optional.
 *
 * 🔴 THEY COUNT IN HIS OWN REPORT ONLY — never in a rep's figures, never in a territory KPI. The old "My
 * own visit" on a rep's territory is closed for him for exactly that reason (visit-log-form.tsx).
 *
 * 🔴 A VACANT AREA IS CHOSEN BY ITS NAME, AND ITS LIST IS THE PREVIOUS REP'S (owner, 2026-10-19). "Log an
 * unplanned customer" opens on the areas he plans in, a vacant one among them; choosing one shows its
 * doctors. A visit to a vacant area's doctor needs the address typed OR a captured location, whose address,
 * area and brick are filled in for him — "either this or this" (`vacantVisitPlaceError`). Once logged, the
 * card says where the visit recorded the customer is (`visitPlaceText`).
 *
 * 🔴 AND THE PLACE BLOCK IS THE ADD-A-CUSTOMER SCREEN'S, ON EVERY SINGLE VISIT (owner, 2026-10-20: the
 * unplanned form "asks for a location or address and there is no place to write the address … it should be
 * as the screen when adding new customer"). Capture location, the address, and the area → brick cascade —
 * the same fields in the same order as `manager-customer-form.tsx`, optional everywhere but a vacant area.
 * It opens on what the system already knows: the customer's own area, and the address his own list holds.
 */

import { useEffect, useId, useRef, useState } from "react";

import { crmPost, crmUrl, messageOf, newClientId, useCrmGet } from "@/components/phoenix-crm/api";
import { CaptureLocation, type CapturedPin } from "@/components/phoenix-crm/capture-location";
import { ManagerCustomerForm } from "@/components/phoenix-crm/manager-customer-form";
import { countText } from "@/components/phoenix-crm/format";
import {
  CrmBlock,
  CrmButton,
  CrmCard,
  CrmCheck,
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
  CrmShowMore,
  crmInputClassName,
  crmTextareaClassName,
  type CrmChoiceOption,
} from "@/components/phoenix-crm/ui";
import { dmSingleVisitLimitLine, MANAGER_CUSTOMER_ADDRESS_MAX, VACANT_AREA_NOTE, VACANT_LIST_LABEL, vacantVisitPlaceError } from "@/lib/phoenix-crm/manager-plan-rules";
import type {
  AreaCustomer,
  AreaCustomersView,
  CustomerMatch,
  ManagerAreaBricks,
  ManagerCustomerView,
  ManagerCustomerLocated,
  ManagerTodayCustomer,
  ManagerTodayOwnCustomer,
  ManagerTodayView,
} from "@/lib/phoenix-crm/view-types";

const VISITS = "/api/phoenix-crm/manager-plans/visits";
const AREA = "/api/phoenix-crm/manager-plans/customers/area";
const LOCATE = "/api/phoenix-crm/manager-plans/customers/locate";
/** The bricks of one area — the second drop-list of the cascade, exactly as Add a customer loads it. */
const BRICKS = "/api/phoenix-crm/manager-plans/customers/bricks";
/** The comment's limit, as the server reads it. */
const COMMENT_MAX = 1000;
/** An area's list is shown a page at a time. */
const AREA_PAGE = 40;

type Logging = {
  clientRef: string;
  slotId: string | null;
  customerId: string | null;
  managerCustomerId: string | null;
  name: string;
  /** A vacant area's customer: the address or a captured location is needed. */
  vacant: boolean;
  /** The territory whose list he is on — what Capture location reads against. */
  seatId: string | null;
  /** The seat his area is listed under in the area drop-list (one seat per area), so it opens on his area. */
  areaSeatId: string | null;
  /** The address already on file, so the block opens on what the system knows rather than empty. */
  address: string;
};

function loggingOf(customer: ManagerTodayCustomer): Logging {
  return {
    clientRef: newClientId(),
    slotId: customer.slotId,
    customerId: customer.customerId,
    managerCustomerId: customer.managerCustomerId,
    name: customer.name,
    vacant: customer.vacant,
    seatId: customer.seatId,
    areaSeatId: customer.areaSeatId,
    address: customer.knownAddress ?? "",
  };
}

function ownLogging(customer: ManagerTodayOwnCustomer): Logging {
  return {
    clientRef: newClientId(),
    slotId: null,
    customerId: null,
    managerCustomerId: customer.id,
    name: customer.name,
    // His own list carries the area the customer is in, so a customer of his in a vacant area asks for the
    // address the area screen said it would (owner, 2026-10-20) — it used to ask for nothing at all.
    vacant: customer.vacant,
    seatId: customer.areaSeatId,
    areaSeatId: customer.areaSeatId,
    address: customer.address ?? "",
  };
}

function areaLogging(customer: AreaCustomer, areaSeatId: string | null): Logging {
  return {
    clientRef: newClientId(),
    slotId: null,
    customerId: customer.customerId,
    managerCustomerId: null,
    name: customer.name,
    vacant: customer.vacant,
    seatId: customer.seatId,
    // The area he chose to find the customer in — one area holds several rep seats, and the drop-list lists one.
    areaSeatId,
    address: "",
  };
}

export function ManagerSingleVisits({ test }: { test: boolean }) {
  const today = useCrmGet<ManagerTodayView>(crmUrl(VISITS, { test }), "today");
  const [logging, setLogging] = useState<Logging | null>(null);
  const [finding, setFinding] = useState(false);
  const view = today.data;
  // The form opens at the top of the panel, and on a phone the Log he pressed can sit a screen or more
  // below it — so it is brought into view, or the press looks like it did nothing.
  const formRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (logging) formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [logging]);

  return (
    <CrmPanel
      description="Your own visits, when you go alone. They count in your own report only. A visit with a rep is logged by the rep, who names you."
      eyebrow={view?.isTest ? "Visits · test persona" : "Visits"}
      title="My single visits"
    >
      {today.error ? <CrmLoadError message={today.error} onRetry={today.reload} /> : null}
      {!view && !today.error ? <CrmLoading label="Loading today's single visits" /> : null}
      {view ? (
        <>
          {logging ? (
            <div className="min-w-0 scroll-mt-24" ref={formRef}>
              <CrmBlock>
                <LogForm
                  areas={view.areas}
                  logging={logging}
                  onCancel={() => setLogging(null)}
                  onLogged={(next) => {
                    today.replace(next);
                    setLogging(null);
                  }}
                  products={view.products}
                  test={test}
                />
              </CrmBlock>
            </div>
          ) : null}

          <CrmBlock title="Planned for today">
            {view.planned.length === 0 ? (
              <CrmEmpty message="No single visit is on your plan for today." title="Nothing planned" />
            ) : (
              <div className="grid min-w-0 gap-2">
                {view.planned.map((customer) => (
                  <CrmCard
                    accent={customer.logged ? "border-l-emerald-500" : "border-l-orange-400"}
                    actions={
                      !customer.logged && !logging ? (
                        <CrmButton onClick={() => setLogging(loggingOf(customer))} size="sm" variant="primary">
                          Log
                        </CrmButton>
                      ) : undefined
                    }
                    key={`${customer.slotId}|${customer.customerId ?? customer.managerCustomerId}`}
                    meta={customer.speciality ?? undefined}
                    status={
                      <>
                        {customer.half ? <CrmPill>{customer.half}</CrmPill> : null}
                        {customer.own ? <CrmPill tone="orange">Manager&apos;s own list</CrmPill> : null}
                        {customer.vacant ? <CrmPill tone="warn">Vacant area</CrmPill> : null}
                        {customer.logged ? <CrmPill tone="good">Logged</CrmPill> : null}
                      </>
                    }
                    title={
                      <span className="break-words" dir="auto">
                        {customer.name}
                      </span>
                    }
                  >
                    {customer.place ? <VisitPlace place={customer.place} /> : null}
                  </CrmCard>
                ))}
              </div>
            )}
          </CrmBlock>

          <CrmBlock className="border-t border-slate-100" title="Not planned">
            {/* A district manager's limit, counted as the log counts it — shown BEFORE he finds a customer,
                so a full week is not learned from a refusal after the form (owner, 2026-10-19). */}
            {view.singleVisitLimit ? (
              <p className="mb-3 break-words text-xs font-semibold leading-5 text-slate-500">
                {dmSingleVisitLimitLine(view.singleVisitLimit.used)}
              </p>
            ) : null}
            {view.unplanned.length > 0 ? (
              <div className="mb-3 grid min-w-0 gap-2">
                {view.unplanned.map((customer) => (
                  <CrmCard
                    accent="border-l-slate-300"
                    key={customer.customerId ?? customer.managerCustomerId ?? customer.name}
                    meta={customer.speciality ?? undefined}
                    status={
                      <>
                        {customer.vacant ? <CrmPill tone="warn">Vacant area</CrmPill> : null}
                        <CrmPill tone="good">Logged · not planned</CrmPill>
                      </>
                    }
                    title={
                      <span className="break-words" dir="auto">
                        {customer.name}
                      </span>
                    }
                  >
                    {customer.place ? <VisitPlace place={customer.place} /> : null}
                  </CrmCard>
                ))}
              </div>
            ) : null}
            {finding ? (
              <FindCustomer
                areas={view.areas}
                onCancel={() => setFinding(false)}
                onPick={(picked) => {
                  setFinding(false);
                  setLogging(picked);
                }}
                ownList={view.ownList}
                test={test}
              />
            ) : logging ? null : view.singleVisitLimit?.unplannedFitsNow === false ? (
              // Where the button would be, in words — a button that silently vanished read as a missing
              // button (owner, 2026-10-20: "no button to add the single unplanned visit").
              <CrmNote tone="warn">
                Log an unplanned customer is closed for the rest of this week: your week already holds its two half-days of single visits. A planned single visit can still be logged.
              </CrmNote>
            ) : (
              <CrmButton onClick={() => setFinding(true)} size="sm">
                Log an unplanned customer
              </CrmButton>
            )}
          </CrmBlock>
        </>
      ) : null}
    </CrmPanel>
  );
}

/** Where a vacant area's logged visit says its customer is — the address, area and brick he recorded. */
function VisitPlace({ place }: { place: string }) {
  return (
    <p className="break-words text-xs font-semibold leading-5 text-slate-600">
      <span className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">Where the customer is </span>
      <span dir="auto">{place}</span>
    </p>
  );
}

/**
 * A customer to log: chosen from an area's list — the areas he plans in by name, a vacant one included,
 * whose list is the previous rep's (owner, 2026-10-19) — or found by name across his reps' lists and his own.
 */
function FindCustomer({
  areas,
  onCancel,
  onPick,
  ownList,
  test,
}: {
  areas: ManagerTodayView["areas"];
  onCancel: () => void;
  onPick: (logging: Logging) => void;
  ownList: ManagerTodayView["ownList"];
  test: boolean;
}) {
  const [name, setName] = useState("");
  const [matches, setMatches] = useState<CustomerMatch[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [areaSeatId, setAreaSeatId] = useState<string | null>(null);
  // A customer nobody has yet is added right here, on the same Add-a-customer form Team uses, and the
  // visit is logged next — never a trip to Team first (owner, 2026-10-20: "make him able to create
  // from the same screen the same way").
  const [adding, setAdding] = useState(false);

  async function find() {
    if (name.trim().length < 2) {
      setError("Type at least two letters of the name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setMatches(await crmPost<CustomerMatch[]>("/api/phoenix-crm/manager-plans/customers/match", { name: name.trim(), test }, "matches"));
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  }

  function pick(match: CustomerMatch) {
    // A match of his own list is the same customer the list below holds: open the block on that row's
    // address, the way choosing him from the list does.
    const own = match.source === "own" ? (ownList.find((customer) => customer.id === match.id) ?? null) : null;
    onPick({
      clientRef: newClientId(),
      slotId: null,
      customerId: match.source === "rep" ? match.id : null,
      managerCustomerId: match.source === "own" ? match.id : null,
      name: match.name,
      vacant: match.vacant,
      seatId: match.seatId,
      areaSeatId: match.areaSeatId,
      address: own?.address ?? "",
    });
  }

  /** The customer just added joins Manager's own list; the visit opens on what the form entered. */
  function added(customer: ManagerCustomerView) {
    setAdding(false);
    onPick(ownLogging({ ...customer, vacant: areas.find((entry) => entry.seatId === customer.areaSeatId)?.vacant === true }));
  }

  if (adding) {
    return (
      <div className="grid min-w-0 gap-3 border border-slate-200 p-3">
        <p className="text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-500">Add a new customer to Manager&apos;s own list, then log the visit</p>
        <ManagerCustomerForm
          areas={areas.map((entry) => ({ seatId: entry.seatId, areaName: entry.areaName }))}
          defaultAreaSeatId={areaSeatId}
          defaultName={name.trim()}
          onAdded={added}
          onCancel={() => setAdding(false)}
          onPickExisting={pick}
          test={test}
        />
      </div>
    );
  }

  const areaOptions: Array<CrmChoiceOption<string>> = areas.map((entry) => ({
    value: entry.seatId,
    label: entry.areaName,
    note: entry.vacant ? VACANT_AREA_NOTE : (entry.repName ?? "No rep"),
  }));

  return (
    <div className="grid min-w-0 gap-3 border border-slate-200 p-3">
      {areas.length > 0 ? (
        <CrmChoice columns={3} label="Choose an area" onChange={setAreaSeatId} options={areaOptions} value={areaSeatId} />
      ) : null}
      {/* Keyed by the area, so a new area starts its list, its search and its page from the top. */}
      {areaSeatId ? <AreaList areaSeatId={areaSeatId} key={areaSeatId} onPick={onPick} test={test} /> : null}
      <CrmField hint="A customer of your reps' lists, or of Manager's own list." label="Or find a customer by name">
        <div className="flex min-w-0 flex-wrap gap-2">
          <input
            autoComplete="off"
            className={`${crmInputClassName} flex-1`}
            dir="auto"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void find();
            }}
            value={name}
          />
          <CrmButton busy={busy} onClick={() => void find()} size="sm" variant="primary">
            Find
          </CrmButton>
        </div>
      </CrmField>
      {error ? <CrmNote tone="bad">{error}</CrmNote> : null}
      {matches !== null && matches.length === 0 ? (
        <div className="grid min-w-0 gap-2">
          <CrmNote tone="neutral">No customer of the districts you plan in goes by that name. Add the customer here: the customer joins Manager&apos;s own list, and the visit is logged next.</CrmNote>
          <div>
            <CrmButton onClick={() => setAdding(true)} size="sm" variant="primary">
              Add a new customer
            </CrmButton>
          </div>
        </div>
      ) : null}
      {(matches ?? []).map((match) => (
        <CrmCard
          accent={match.source === "own" ? "border-l-orange-400" : match.vacant ? "border-l-amber-400" : "border-l-sky-400"}
          actions={
            <CrmButton onClick={() => pick(match)} size="sm" variant="primary">
              Log this one
            </CrmButton>
          }
          key={`${match.source}:${match.id}`}
          meta={match.detail}
          title={
            <span className="break-words" dir="auto">
              {match.name}
            </span>
          }
        />
      ))}
      {matches === null && ownList.length > 0 ? (
        <div className="grid min-w-0 gap-2">
          <p className="text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-500">Or one of Manager&apos;s own list</p>
          {ownList.slice(0, 20).map((customer) => (
            <CrmCard
              accent="border-l-orange-400"
              actions={
                <CrmButton onClick={() => onPick(ownLogging(customer))} size="sm" variant="primary">
                  Log this one
                </CrmButton>
              }
              key={customer.id}
              meta={[customer.speciality, customer.areaName].filter(Boolean).join(" · ") || undefined}
              title={
                <span className="break-words" dir="auto">
                  {customer.name}
                </span>
              }
            />
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {matches !== null && matches.length === 0 ? null : (
          <CrmButton onClick={() => setAdding(true)} size="sm">
            Add a new customer
          </CrmButton>
        )}
        <CrmButton onClick={onCancel} size="sm" variant="ghost">
          Cancel
        </CrmButton>
      </div>
    </div>
  );
}

/** One area's customers — a vacant area's are the previous rep's list — to log a visit to one of them. */
function AreaList({ areaSeatId, onPick, test }: { areaSeatId: string; onPick: (logging: Logging) => void; test: boolean }) {
  const idPrefix = useId();
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(AREA_PAGE);
  const area = useCrmGet<AreaCustomersView>(crmUrl(AREA, { area: areaSeatId, test }), "area");

  if (area.error) return <CrmLoadError message={area.error} onRetry={area.reload} />;
  if (!area.data) return <CrmLoading label="Loading the area's customers" />;
  const vacant = area.data.area?.vacant === true;
  // The area he chose, as the place block's area drop-list names it.
  const areaOfList = area.data.area?.seatId ?? areaSeatId;
  const words = query.trim().toLowerCase();
  const list = area.data.repList.filter((customer) => !words || customer.name.toLowerCase().includes(words));
  const shown = list.slice(0, limit);

  return (
    <div className="grid min-w-0 gap-3 border border-slate-200 bg-slate-50/60 p-3">
      <p className="text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-500">{vacant ? `${VACANT_LIST_LABEL} · this area has no rep` : "The area's rep list"}</p>
      {vacant ? (
        <p className="break-words text-xs font-semibold leading-5 text-slate-500">
          Logging a visit here needs the customer&apos;s address typed by hand, or Capture location, which fills in the address, area and brick.
        </p>
      ) : null}
      <CrmSearchField id={`${idPrefix}-area-search`} label="Find a customer" onChange={setQuery} placeholder="Type a name" value={query} />
      {list.length === 0 ? (
        <p className="text-sm font-semibold text-slate-500">
          {words ? "No customer on this list matches." : vacant ? "The previous rep left no list in this area." : "No customer is on this area's list."}
        </p>
      ) : null}
      <div className="grid min-w-0 gap-2">
        {shown.map((customer) => (
          <CrmCard
            accent={customer.vacant ? "border-l-amber-400" : "border-l-sky-400"}
            actions={
              <CrmButton onClick={() => onPick(areaLogging(customer, areaOfList))} size="sm" variant="primary">
                Log this one
              </CrmButton>
            }
            key={customer.customerId}
            meta={[customer.listType, customer.grade ? `Grade ${customer.grade}` : null, customer.speciality, customer.vacant ? VACANT_LIST_LABEL : customer.repName]
              .filter(Boolean)
              .join(" · ")}
            title={
              <span className="break-words" dir="auto">
                {customer.name}
              </span>
            }
          />
        ))}
      </div>
      <CrmShowMore left={list.length - shown.length} onMore={() => setLimit((value) => value + AREA_PAGE)} page={AREA_PAGE} />
    </div>
  );
}

function LogForm({
  areas,
  logging,
  onCancel,
  onLogged,
  products,
  test,
}: {
  areas: ManagerTodayView["areas"];
  logging: Logging;
  onCancel: () => void;
  onLogged: (view: ManagerTodayView) => void;
  products: string[];
  test: boolean;
}) {
  const idPrefix = useId();
  const [picked, setPicked] = useState<string[]>([]);
  const [comment, setComment] = useState("");
  const [pin, setPin] = useState<CapturedPin | null>(null);
  const [address, setAddress] = useState(logging.address);
  const [areaSeatId, setAreaSeatId] = useState(logging.areaSeatId ?? "");
  const [brickId, setBrickId] = useState("");
  const [locating, setLocating] = useState(false);
  const [located, setLocated] = useState<{ text: string; complete: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bricks = useCrmGet<ManagerAreaBricks>(areaSeatId ? crmUrl(BRICKS, { area: areaSeatId }) : null, "bricks");
  const brickList = bricks.data?.bricks ?? [];

  /**
   * Capture location fills in the address, the area and the brick — the same reading the save stores
   * (`locateInReach`). It only ever fills what the capture read: a street or brick it could not read is
   * left as he had it, for him to fill in by hand (owner, 2026-10-20: as the Add a customer screen).
   */
  async function capture(next: CapturedPin | null) {
    setPin(next);
    setLocated(null);
    if (!next) return;
    setLocating(true);
    setError(null);
    try {
      const found = await crmPost<ManagerCustomerLocated>(
        LOCATE,
        { pin: { lat: next.lat, lon: next.lon, accuracyMeters: next.accuracyMeters }, areaSeatId: areaSeatId || logging.seatId, test },
        "located",
      );
      if (found.address) setAddress(found.address);
      // The area first, then the brick that sits in it: the brick drop-list loads for the area it is under.
      if (found.areaSeatId) {
        setAreaSeatId(found.areaSeatId);
        setBrickId(found.brickId ?? "");
      }
      const where = [found.areaName ? `Area: ${found.areaName}` : null, found.brickName ? `Brick: ${found.brickName}` : null].filter(Boolean).join(" · ");
      const complete = Boolean(found.address && found.areaName && found.brickName);
      setLocated({
        text: complete
          ? `The address, area and brick were filled in from the location. ${where}`
          : `The location was captured${where ? ` (${where})` : ""}, but not everything could be read. It is enough to log the visit; fill in what is missing if you know it.`,
        complete,
      });
    } catch (failure) {
      setLocated({ text: `The location was captured, but its address could not be read (${messageOf(failure)}). It is enough to log the visit; type the address if you know it.`, complete: false });
    } finally {
      setLocating(false);
    }
  }

  async function log() {
    const placeError = vacantVisitPlaceError({ vacant: logging.vacant, address, captured: pin !== null });
    if (placeError) {
      setError(placeError);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await crmPost<ManagerTodayView>(
        VISITS,
        {
          clientRef: logging.clientRef,
          slotId: logging.slotId,
          customerId: logging.customerId,
          managerCustomerId: logging.managerCustomerId,
          products: picked,
          comment: comment.trim() || null,
          address: address.trim() || null,
          areaSeatId: areaSeatId || null,
          brickId: brickId || null,
          ...(pin ? { pin: { lat: pin.lat, lon: pin.lon, accuracyMeters: pin.accuracyMeters } } : {}),
          test,
        },
        "today",
      );
      onLogged(next);
    } catch (failure) {
      setError(messageOf(failure));
      setBusy(false);
    }
  }

  return (
    <div className="grid min-w-0 gap-4 border border-orange-200 bg-orange-50/40 p-4">
      <div className="min-w-0">
        <p className="text-phx-2xs font-black uppercase tracking-[0.16em] text-orange-700">{logging.slotId ? "Log a planned visit" : "Log a visit not on the plan"}</p>
        <p className="mt-1 break-words text-base font-black text-slate-950" dir="auto">
          {logging.name}
        </p>
        {logging.vacant ? (
          <p className="mt-1">
            <CrmPill tone="warn">Vacant area · {VACANT_LIST_LABEL.toLowerCase()}</CrmPill>
          </p>
        ) : null}
      </div>
      {products.length > 0 ? (
        <CrmField hint={picked.length > 0 ? `${countText(picked.length)} chosen` : "Optional"} label="Products discussed">
          <div className="grid min-w-0 gap-2 sm:grid-cols-2">
            {products.map((product) => (
              <CrmCheck
                checked={picked.includes(product)}
                key={product}
                onChange={(on) => setPicked((current) => (on ? [...current.filter((entry) => entry !== product), product] : current.filter((entry) => entry !== product)))}
              >
                {product}
              </CrmCheck>
            ))}
          </div>
        </CrmField>
      ) : null}
      <CrmField hint="Optional" label="Comment">
        <textarea className={crmTextareaClassName} dir="auto" maxLength={COMMENT_MAX} onChange={(event) => setComment(event.target.value)} value={comment} />
      </CrmField>
      {/* 🔴 The Add-a-customer place block, on EVERY single visit (owner, 2026-10-20) — the same fields in
          the same order as `manager-customer-form.tsx`. Optional everywhere but a vacant area, where the
          address or the capture is required (owner, 2026-10-19). */}
      <div className="grid min-w-0 gap-4 border-t border-orange-200 pt-4">
        <p className="break-words text-phx-2xs font-black uppercase tracking-[0.16em] text-orange-700">
          Where the customer is · {logging.vacant ? "one of the first two is needed" : "optional"}
        </p>
        <CrmField hint="Stand at the customer and press it: the address, area and brick are filled in for you. Or fill them in below. No photo is needed." label="Location">
          <CaptureLocation disabled={busy || locating} onChange={(next) => void capture(next)} value={pin} />
        </CrmField>
        {locating ? <CrmNote tone="info">Reading the address, area and brick from the location</CrmNote> : null}
        {located ? <CrmNote tone={located.complete ? "good" : "warn"}>{located.text}</CrmNote> : null}
        <CrmField hint="Or type the customer's address by hand." htmlFor={`${idPrefix}-address`} label="Address">
          <input
            autoComplete="off"
            className={crmInputClassName}
            dir="auto"
            id={`${idPrefix}-address`}
            maxLength={MANAGER_CUSTOMER_ADDRESS_MAX}
            onChange={(event) => setAddress(event.target.value)}
            value={address}
          />
        </CrmField>
        <div className="grid min-w-0 gap-4 sm:grid-cols-2">
          <CrmField htmlFor={`${idPrefix}-area`} label="Area">
            <CrmSelect
              id={`${idPrefix}-area`}
              onChange={(event) => {
                // A brick belongs to one area, so a new area empties the brick.
                setAreaSeatId(event.target.value);
                setBrickId("");
              }}
              value={areaSeatId}
            >
              <option value="">Choose the area</option>
              {areas.map((area) => (
                <option key={area.seatId} value={area.seatId}>
                  {area.areaName}
                </option>
              ))}
            </CrmSelect>
          </CrmField>
          <CrmField htmlFor={`${idPrefix}-brick`} label="Brick">
            <CrmSelect
              disabled={!areaSeatId || bricks.loading || brickList.length === 0}
              id={`${idPrefix}-brick`}
              onChange={(event) => setBrickId(event.target.value)}
              value={brickId}
            >
              <option value="">
                {!areaSeatId ? "Choose the area first" : bricks.loading ? "Loading the bricks" : brickList.length === 0 ? "No bricks listed for this area" : "Choose the brick"}
              </option>
              {brickList.map((brick) => (
                <option key={brick.id} value={brick.id}>
                  {brick.name}
                </option>
              ))}
            </CrmSelect>
          </CrmField>
        </div>
        {bricks.error ? <CrmNote tone="warn">The bricks of this area could not be loaded. You can still log the visit without one.</CrmNote> : null}
      </div>
      {error ? <CrmNote tone="bad">{error}</CrmNote> : null}
      <div className="flex flex-wrap gap-2">
        <CrmButton busy={busy} disabled={locating} onClick={() => void log()} variant="primary">
          Log the visit
        </CrmButton>
        <CrmButton disabled={busy} onClick={onCancel} variant="ghost">
          Cancel
        </CrmButton>
      </div>
    </div>
  );
}
