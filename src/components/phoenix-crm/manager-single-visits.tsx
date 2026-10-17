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
 */

import { useEffect, useRef, useState } from "react";

import { crmPost, crmUrl, messageOf, newClientId, useCrmGet } from "@/components/phoenix-crm/api";
import { CaptureLocation, type CapturedPin } from "@/components/phoenix-crm/capture-location";
import { countText } from "@/components/phoenix-crm/format";
import {
  CrmBlock,
  CrmButton,
  CrmCard,
  CrmCheck,
  CrmEmpty,
  CrmField,
  CrmLoadError,
  CrmLoading,
  CrmNote,
  CrmPanel,
  CrmPill,
  crmInputClassName,
  crmTextareaClassName,
} from "@/components/phoenix-crm/ui";
import type { CustomerMatch, ManagerTodayCustomer, ManagerTodayView } from "@/lib/phoenix-crm/view-types";

const VISITS = "/api/phoenix-crm/manager-plans/visits";
/** The comment's limit, as the server reads it. */
const COMMENT_MAX = 1000;

type Logging = {
  clientRef: string;
  slotId: string | null;
  customerId: string | null;
  managerCustomerId: string | null;
  name: string;
};

function loggingOf(customer: ManagerTodayCustomer): Logging {
  return {
    clientRef: newClientId(),
    slotId: customer.slotId,
    customerId: customer.customerId,
    managerCustomerId: customer.managerCustomerId,
    name: customer.name,
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
                onCancel={() => setFinding(false)}
                onPick={(picked) => {
                  setFinding(false);
                  setLogging(picked);
                }}
                ownList={view.ownList}
                test={test}
              />
            ) : !logging ? (
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

/** A customer of his district's rep lists or of his own list, found by name. */
function FindCustomer({
  onCancel,
  onPick,
  ownList,
  test,
}: {
  onCancel: () => void;
  onPick: (logging: Logging) => void;
  ownList: ManagerTodayView["ownList"];
  test: boolean;
}) {
  const [name, setName] = useState("");
  const [matches, setMatches] = useState<CustomerMatch[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    });
  }

  return (
    <div className="grid min-w-0 gap-3 border border-slate-200 p-3">
      <CrmField hint="A customer of your reps' lists, or of Manager's own list." label="Customer's name">
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
          accent={match.source === "own" ? "border-l-orange-400" : "border-l-sky-400"}
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
                <CrmButton
                  onClick={() => onPick({ clientRef: newClientId(), slotId: null, customerId: null, managerCustomerId: customer.id, name: customer.name })}
                  size="sm"
                  variant="primary"
                >
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
  const [picked, setPicked] = useState<string[]>([]);
  const [comment, setComment] = useState("");
  const [pin, setPin] = useState<CapturedPin | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function log() {
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
      <CrmField hint="Optional. No photo is needed." label="Location">
        <CaptureLocation disabled={busy} onChange={setPin} value={pin} />
      </CrmField>
      {error ? <CrmNote tone="bad">{error}</CrmNote> : null}
      <div className="flex flex-wrap gap-2">
        <CrmButton busy={busy} onClick={() => void log()} variant="primary">
          Log the visit
        </CrmButton>
        <CrmButton disabled={busy} onClick={onCancel} variant="ghost">
          Cancel
        </CrmButton>
      </div>
    </div>
  );
}
