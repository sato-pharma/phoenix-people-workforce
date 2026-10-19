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
 * area and brick are filled in for him — "either this or this" (`vacantVisitPlaceError`).
 */

import { useEffect, useId, useRef, useState } from "react";

import { crmPost, crmUrl, messageOf, newClientId, useCrmGet } from "@/components/phoenix-crm/api";
import { CaptureLocation, type CapturedPin } from "@/components/phoenix-crm/capture-location";
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
  CrmShowMore,
  crmInputClassName,
  crmTextareaClassName,
  type CrmChoiceOption,
} from "@/components/phoenix-crm/ui";
import { dmSingleVisitLimitLine, MANAGER_CUSTOMER_ADDRESS_MAX, VACANT_AREA_NOTE, VACANT_LIST_LABEL, vacantVisitPlaceError } from "@/lib/phoenix-crm/manager-plan-rules";
import type { AreaCustomer, AreaCustomersView, CustomerMatch, ManagerCustomerLocated, ManagerTodayCustomer, ManagerTodayView } from "@/lib/phoenix-crm/view-types";

const VISITS = "/api/phoenix-crm/manager-plans/visits";
const AREA = "/api/phoenix-crm/manager-plans/customers/area";
const LOCATE = "/api/phoenix-crm/manager-plans/customers/locate";
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
  };
}

function ownLogging(customer: { id: string; name: string }): Logging {
  return { clientRef: newClientId(), slotId: null, customerId: null, managerCustomerId: customer.id, name: customer.name, vacant: false, seatId: null };
}

function areaLogging(customer: AreaCustomer): Logging {
  return {
    clientRef: newClientId(),
    slotId: null,
    customerId: customer.customerId,
    managerCustomerId: null,
    name: customer.name,
    vacant: customer.vacant,
    seatId: customer.seatId,
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
                  />
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
                {view.singleVisitLimit.unplannedFitsNow ? "" : " Your week has no half-day of single visits left, so an unplanned customer cannot be logged now."}
              </p>
            ) : null}
            {view.unplanned.length > 0 ? (
              <div className="mb-3 grid min-w-0 gap-2">
                {view.unplanned.map((customer) => (
                  <CrmCard
                    accent="border-l-slate-300"
                    key={customer.customerId ?? customer.managerCustomerId ?? customer.name}
                    meta={customer.speciality ?? undefined}
                    status={<CrmPill tone="good">Logged · not planned</CrmPill>}
                    title={
                      <span className="break-words" dir="auto">
                        {customer.name}
                      </span>
                    }
                  />
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
            ) : !logging && view.singleVisitLimit?.unplannedFitsNow !== false ? (
              <CrmButton onClick={() => setFinding(true)} size="sm">
                Log an unplanned customer
              </CrmButton>
            ) : null}
          </CrmBlock>
        </>
      ) : null}
    </CrmPanel>
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
    onPick({
      clientRef: newClientId(),
      slotId: null,
      customerId: match.source === "rep" ? match.id : null,
      managerCustomerId: match.source === "own" ? match.id : null,
      name: match.name,
      vacant: match.vacant,
      seatId: match.seatId,
    });
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
        <CrmNote tone="neutral">No customer of the districts you plan in goes by that name. Add the customer to Manager&apos;s own list from Team first.</CrmNote>
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
      <div>
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
              <CrmButton onClick={() => onPick(areaLogging(customer))} size="sm" variant="primary">
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
  logging,
  onCancel,
  onLogged,
  products,
  test,
}: {
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
  const [address, setAddress] = useState("");
  const [locating, setLocating] = useState(false);
  const [located, setLocated] = useState<{ text: string; complete: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * In a vacant area, Capture location fills in the address, and says the area and brick it fell in — the
   * same reading the save stores (owner, 2026-10-19). Elsewhere the location is only kept, as before.
   */
  async function capture(next: CapturedPin | null) {
    setPin(next);
    setLocated(null);
    if (!next || !logging.vacant) return;
    setLocating(true);
    setError(null);
    try {
      const found = await crmPost<ManagerCustomerLocated>(
        LOCATE,
        { pin: { lat: next.lat, lon: next.lon, accuracyMeters: next.accuracyMeters }, areaSeatId: logging.seatId, test },
        "located",
      );
      if (found.address) setAddress(found.address);
      const where = [found.areaName ? `Area: ${found.areaName}` : null, found.brickName ? `Brick: ${found.brickName}` : null].filter(Boolean).join(" · ");
      const complete = Boolean(found.address && found.areaName && found.brickName);
      setLocated({
        text: complete
          ? `The address, area and brick were filled in from the location. ${where}`
          : `The location was captured${where ? ` (${where})` : ""}, but not everything could be read. It is enough to log the visit; correct the address if you know it.`,
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
          ...(logging.vacant ? { address: address.trim() || null } : {}),
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
      {logging.vacant ? (
        <div className="grid min-w-0 gap-4 border-t border-orange-200 pt-4">
          <p className="break-words text-phx-2xs font-black uppercase tracking-[0.16em] text-orange-700">Where the customer is · one of the two is needed</p>
          <CrmField hint="Stand at the customer and press it: the address, area and brick are filled in for you. No photo is needed." label="Capture location">
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
        </div>
      ) : (
        <CrmField hint="Optional. No photo is needed." label="Location">
          <CaptureLocation disabled={busy} onChange={setPin} value={pin} />
        </CrmField>
      )}
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
