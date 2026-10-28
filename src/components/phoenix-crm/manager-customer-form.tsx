"use client";

/**
 * Phoenix CRM — "Add a customer" to a district manager's own list (owner, 2026-10-16).
 *
 * Name, the grade AND the potential grade, and the area of his region are what it needs. The speciality, the
 * phone, the address and the brick are OPTIONAL (owner, 2026-10-18: "make everything optional"): he fills
 * them in, or presses Capture location and the capture fills them in, and he can still correct what it
 * read. The area and the brick are CASCADING drop-lists — the areas of his region, then the bricks of the
 * area he chose. No photo and NO validation step: "there will not be validation because they are managers".
 *
 * 🔴 A NAME ALREADY ON A LIST IS OFFERED FIRST, never refused. As he types, the customers of his reps'
 * lists and of his own list under that name are shown, and he picks the one he means. Namesakes are real,
 * so "a different customer with the same name" is always his to choose — he carries on and adds him.
 *
 * Manager's own list is HIS: it is never merged into a rep's list, and a rep never sees it.
 */

import { useEffect, useId, useRef, useState } from "react";

import { crmPost, crmUrl, messageOf, useCrmGet } from "@/components/phoenix-crm/api";
import { CaptureLocation, type CapturedPin } from "@/components/phoenix-crm/capture-location";
import { CrmButton, CrmCard, CrmChoice, CrmField, CrmNote, CrmPill, CrmSelect, crmInputClassName, crmTextareaClassName } from "@/components/phoenix-crm/ui";
import { parseCustomerPhone } from "@/lib/phoenix-crm/entry-rules";
import {
  MANAGER_CUSTOMER_ADDRESS_MAX,
  MANAGER_CUSTOMER_GRADES,
  MANAGER_CUSTOMER_POTENTIAL_GRADES,
  MANAGER_PLAN_NOTE_MAX,
  missingManagerCustomerField,
  sameCustomerName,
} from "@/lib/phoenix-crm/manager-plan-rules";
import type { CustomerMatch, ManagerAreaBricks, ManagerCustomerLocated, ManagerCustomerView } from "@/lib/phoenix-crm/view-types";

/** The bricks of one area he plans in — the second drop-list of the cascade. */
const BRICKS = "/api/phoenix-crm/manager-plans/customers/bricks";

/** How long after his last keystroke the name is looked up. */
const MATCH_DELAY_MS = 500;
/** A name shorter than this is not looked up — two letters match half the district. */
const MATCH_FROM = 3;

export function ManagerCustomerForm({
  areas,
  defaultAreaSeatId,
  defaultName,
  onAdded,
  onCancel,
  onPickExisting,
  test,
}: {
  areas: ReadonlyArray<{ seatId: string; areaName: string }>;
  defaultAreaSeatId?: string | null;
  /** The name he already typed in a search that found nobody, so he does not type it twice. */
  defaultName?: string;
  onAdded: (customer: ManagerCustomerView) => void;
  onCancel: () => void;
  /** Where a match can be chosen instead (a single visit's customers). Absent, a match is only shown. */
  onPickExisting?: (match: CustomerMatch) => void;
  test: boolean;
}) {
  const idPrefix = useId();
  const [name, setName] = useState(defaultName ?? "");
  const [speciality, setSpeciality] = useState("");
  const [phone, setPhone] = useState("");
  const [contactNote, setContactNote] = useState("");
  const [grade, setGrade] = useState<string | null>(null);
  const [potentialGrade, setPotentialGrade] = useState<string | null>(null);
  const [areaSeatId, setAreaSeatId] = useState(defaultAreaSeatId ?? areas[0]?.seatId ?? "");
  const [comment, setComment] = useState("");
  const [address, setAddress] = useState("");
  const [brickId, setBrickId] = useState("");
  const [pin, setPin] = useState<CapturedPin | null>(null);
  const [locating, setLocating] = useState(false);
  const [located, setLocated] = useState<{ text: string; complete: boolean } | null>(null);
  const [matches, setMatches] = useState<CustomerMatch[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The customers already on a list under exactly this name, found at the save; he says which it is. */
  const [sameFound, setSameFound] = useState<{ name: string; matches: CustomerMatch[] } | null>(null);
  // Held for the name it was found for: a change to the name lets him save again.
  const sameNamed = sameFound && sameFound.name === name ? sameFound.matches : null;
  const asked = useRef(0);
  const bricks = useCrmGet<ManagerAreaBricks>(areaSeatId ? crmUrl(BRICKS, { area: areaSeatId }) : null, "bricks");

  useEffect(() => {
    const typed = name.trim();
    const ask = ++asked.current;
    if (typed.length < MATCH_FROM) return;
    const timer = window.setTimeout(() => {
      crmPost<CustomerMatch[]>("/api/phoenix-crm/manager-plans/customers/match", { name: typed, test }, "matches").then(
        (found) => {
          if (ask === asked.current) setMatches(found);
        },
        () => {
          // A failed lookup offers nothing; the add itself is never held up by it.
          if (ask === asked.current) setMatches([]);
        },
      );
    }, MATCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [name, test]);

  const shownMatches = name.trim().length >= MATCH_FROM ? matches : [];
  const phoneRead = parseCustomerPhone(phone);
  // A phone is optional, but one he wrote wrongly says so.
  const missing =
    missingManagerCustomerField({ name: name.trim() || null, areaChosen: Boolean(areaSeatId), grade, potentialGrade }) ??
    (phoneRead.ok ? null : "Write the phone as digits — 7 to 15 of them — or leave it empty.");
  const brickList = bricks.data?.bricks ?? [];

  /**
   * Capture location fills the address, the area and the brick (owner, 2026-10-17). It only ever fills what
   * the capture read: a street or brick it could not read is left as he had it, to be filled in by hand.
   */
  async function capture(next: CapturedPin | null) {
    setPin(next);
    setLocated(null);
    if (!next) return;
    setLocating(true);
    setError(null);
    try {
      const found = await crmPost<ManagerCustomerLocated>(
        "/api/phoenix-crm/manager-plans/customers/locate",
        { pin: { lat: next.lat, lon: next.lon, accuracyMeters: next.accuracyMeters }, areaSeatId, test },
        "located",
      );
      if (found.address) setAddress(found.address);
      // The area first, then the brick that sits in it: the brick drop-list loads for the area it is shown under.
      if (found.areaSeatId) {
        setAreaSeatId(found.areaSeatId);
        setBrickId(found.brickId ?? "");
      }
      const unread = [found.address ? null : "address", found.areaSeatId && found.brickId ? null : "brick"].filter((part): part is string => part !== null);
      setLocated(
        unread.length === 0
          ? { text: "The address, area and brick were filled in from the location.", complete: true }
          : {
              text: `The location was captured, but its ${unread.join(" and ")} could not be read. Choose ${unread.length === 1 ? "it" : "them"} yourself, or leave ${unread.length === 1 ? "it" : "them"} empty.`,
              complete: false,
            },
      );
    } catch (failure) {
      setLocated({ text: `The location was captured, but the address and brick could not be read (${messageOf(failure)}). Fill them in yourself, or leave them empty.`, complete: false });
    } finally {
      setLocating(false);
    }
  }

  /**
   * The save looks the name up itself (owner walk, 2026-10-28: a quick save beat the offer and the same
   * hospital went on two lists). The same name on a list stops it once, to choose that one or to say it is a
   * different customer; `differentCustomer` tells the server he said so.
   */
  async function add(differentCustomer = false) {
    if (missing) {
      setError(missing);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (!differentCustomer) {
        const found = await crmPost<CustomerMatch[]>("/api/phoenix-crm/manager-plans/customers/match", { name: name.trim(), test }, "matches").catch(() => []);
        const same = found.filter((match) => sameCustomerName(match.name, name));
        if (same.length > 0) {
          setMatches(found);
          setSameFound({ name, matches: same });
          setSaving(false);
          return;
        }
      }
      const added = await crmPost<ManagerCustomerView>(
        "/api/phoenix-crm/manager-plans/customers",
        {
          name: name.trim(),
          speciality: speciality.trim() || null,
          phone: phone.trim() || null,
          address: address.trim() || null,
          brickId: brickId || null,
          contactNote: contactNote.trim() || null,
          grade,
          potentialGrade,
          areaSeatId,
          comment: comment.trim() || null,
          ...(pin ? { pin: { lat: pin.lat, lon: pin.lon, accuracyMeters: pin.accuracyMeters } } : {}),
          ...(differentCustomer ? { differentCustomer: true } : {}),
          test,
        },
        "customer",
      );
      onAdded(added);
    } catch (failure) {
      setError(messageOf(failure));
      setSaving(false);
    }
  }

  return (
    <div className="grid min-w-0 gap-4 border border-slate-200 bg-slate-50/60 p-4">
      <p className="text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-500">Add a customer to Manager&apos;s own list</p>
      <CrmField htmlFor={`${idPrefix}-name`} label="Name *">
        <input
          autoComplete="off"
          className={crmInputClassName}
          dir="auto"
          id={`${idPrefix}-name`}
          maxLength={200}
          onChange={(event) => setName(event.target.value)}
          value={name}
        />
      </CrmField>

      {shownMatches.length > 0 ? (
        <CrmNote title="Already on a list under this name" tone="info">
          <p>Is it one of these? Choose that one rather than adding the same customer twice. A different customer with the same name? Carry on and add the new one.</p>
          <div className="mt-2 grid gap-2">
            {shownMatches.map((match) => (
              <CrmCard
                accent={match.source === "own" ? "border-l-orange-400" : "border-l-sky-400"}
                actions={
                  onPickExisting ? (
                    <CrmButton onClick={() => onPickExisting(match)} size="sm" variant="primary">
                      Choose this one
                    </CrmButton>
                  ) : undefined
                }
                key={`${match.source}:${match.id}`}
                meta={<span className="break-words">{match.detail}</span>}
                status={<CrmPill tone={match.source === "own" ? "orange" : "info"}>{match.source === "own" ? "Manager's own list" : "A rep's list"}</CrmPill>}
                title={
                  <span className="break-words" dir="auto">
                    {match.name}
                  </span>
                }
              />
            ))}
          </div>
        </CrmNote>
      ) : null}

      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <CrmField htmlFor={`${idPrefix}-speciality`} label="Speciality">
          <input className={crmInputClassName} id={`${idPrefix}-speciality`} maxLength={120} onChange={(event) => setSpeciality(event.target.value)} value={speciality} />
        </CrmField>
        <CrmField htmlFor={`${idPrefix}-phone`} label="Phone">
          <input className={crmInputClassName} id={`${idPrefix}-phone`} inputMode="tel" maxLength={30} onChange={(event) => setPhone(event.target.value)} type="tel" value={phone} />
        </CrmField>
      </div>
      <CrmField hint="Who to ask for, or how to reach the customer." htmlFor={`${idPrefix}-contact`} label="Contact">
        <input className={crmInputClassName} id={`${idPrefix}-contact`} maxLength={300} onChange={(event) => setContactNote(event.target.value)} value={contactNote} />
      </CrmField>
      <CrmField label="Grade *">
        <CrmChoice columns={3} label="Grade" onChange={setGrade} options={MANAGER_CUSTOMER_GRADES.map((value) => ({ value, label: value }))} value={grade} />
      </CrmField>
      <CrmField label="Potential grade *">
        <CrmChoice
          columns={3}
          label="Potential grade"
          onChange={setPotentialGrade}
          options={MANAGER_CUSTOMER_POTENTIAL_GRADES.map((value) => ({ value, label: value }))}
          value={potentialGrade}
        />
      </CrmField>
      <CrmField htmlFor={`${idPrefix}-comment`} label="Comment">
        <textarea
          className={crmTextareaClassName}
          dir="auto"
          id={`${idPrefix}-comment`}
          maxLength={MANAGER_PLAN_NOTE_MAX}
          onChange={(event) => setComment(event.target.value)}
          value={comment}
        />
      </CrmField>

      <div className="grid min-w-0 gap-4 border-t border-slate-200 pt-4">
        {/* The area is required and the rest is not (owner walk, 2026-10-28: "optional" sat over "Area *"). */}
        <p className="text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-500">Where the customer is · the area is required</p>
        <CrmField hint="Stand at the customer and press it: the address, area and brick are filled in for you. Or fill them in below." label="Location">
          <CaptureLocation disabled={saving || locating} onChange={(next) => void capture(next)} value={pin} />
        </CrmField>
        {locating ? <CrmNote tone="info">Reading the address, area and brick from the location</CrmNote> : null}
        {located ? <CrmNote tone={located.complete ? "good" : "warn"}>{located.text}</CrmNote> : null}
        <CrmField htmlFor={`${idPrefix}-address`} label="Address">
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
          <CrmField htmlFor={`${idPrefix}-area`} label="Area *">
            <CrmSelect
              id={`${idPrefix}-area`}
              onChange={(event) => {
                // A brick belongs to one area, so a new area empties the brick.
                setAreaSeatId(event.target.value);
                setBrickId("");
              }}
              value={areaSeatId}
            >
              {areas.map((area) => (
                <option key={area.seatId} value={area.seatId}>
                  {area.areaName}
                </option>
              ))}
            </CrmSelect>
          </CrmField>
          <CrmField htmlFor={`${idPrefix}-brick`} label="Brick">
            <CrmSelect disabled={bricks.loading || brickList.length === 0} id={`${idPrefix}-brick`} onChange={(event) => setBrickId(event.target.value)} value={brickId}>
              <option value="">{bricks.loading ? "Loading the bricks" : brickList.length === 0 ? "No bricks listed for this area" : "Choose the brick"}</option>
              {brickList.map((brick) => (
                <option key={brick.id} value={brick.id}>
                  {brick.name}
                </option>
              ))}
            </CrmSelect>
          </CrmField>
        </div>
        {bricks.error ? <CrmNote tone="warn">The bricks of this area could not be loaded. You can still add the customer without one.</CrmNote> : null}
      </div>

      {error ? <CrmNote tone="bad">{error}</CrmNote> : null}
      {sameNamed ? (
        <CrmNote title={`${sameNamed[0].name} is already on a list`} tone="warn">
          <p className="break-words">
            {`${sameNamed.map((match) => match.detail).join("; ")}. ${onPickExisting ? "Choose that one above" : "Plan that one"} rather than adding the same customer twice.`}
          </p>
          <div className="mt-2">
            <CrmButton busy={saving} disabled={locating} onClick={() => void add(true)} size="sm">
              It is a different customer — add it
            </CrmButton>
          </div>
        </CrmNote>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <CrmButton busy={saving} disabled={locating || sameNamed !== null} onClick={() => void add()} variant="primary">
          Add to my list
        </CrmButton>
        <CrmButton disabled={saving} onClick={onCancel} variant="ghost">
          Cancel
        </CrmButton>
      </div>
    </div>
  );
}
