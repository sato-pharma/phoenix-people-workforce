"use client";

import { useMemo, useState } from "react";

import { countVenueGaps, type VenueGap, venueHasGap } from "@/lib/direct-orders/venue-gaps";
import { useRouter } from "next/navigation";

import { CrmContactPicker } from "@/components/direct-orders/crm-contact-picker";
import { DistributorCustomerPicker } from "@/components/direct-orders/distributor-customer-picker";
import type { DirectOrderRegistryPharmacy } from "@/lib/direct-orders/service";
import type { VenueContactOption } from "@/lib/direct-orders/venue-contact-options";
import {
  choiceRequiresDistributorCode,
  VENUE_TYPE_UNANSWERED_MESSAGE,
  VENUE_TYPES,
  venueTypeChoiceLabel,
  venueTypeIsAnswered,
  venueTypeLabel,
  type VenueTypeChoice,
} from "@/lib/venues/venue-type";
import { phxFieldClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";
import { adminControlDepthClassName, adminPanelHeaderClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";

type AreaOption = { areaCode: string; areaName: string; regionCode: string; regionName: string };
type BrickOption = {
  brickId: string;
  brickName: string;
  areaCode: string;
  areaName: string;
  regionCode: string;
  regionName: string;
};
type DistributorOption = { distributorCode: string; distributorName: string };

type CodeRow = { distributorCode: string; customerCode: string; customerName?: string };

const EMPTY_ROW: CodeRow = { distributorCode: "", customerCode: "" };

async function post(body: unknown): Promise<void> {
  const res = await fetch("/api/direct-orders/pharmacies/registry", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string };
  if (!res.ok || !data.success) throw new Error(data.message || "Update failed.");
}

/**
 * One venue's declared CRM contact, NAMED — the owner's rule that a screen never prints a raw id.
 *
 * Three states, and they are genuinely different answers rather than a present/absent pair:
 * declared and nameable; declared but not nameable from here (the contact is outside the viewer's
 * CRM reach, or the mirror no longer holds it); and not declared at all, which is the state the
 * admin is being invited to fix.
 */
function CrmContactLine({ row }: { row: DirectOrderRegistryPharmacy }) {
  if (row.crmContact) {
    return (
      <div className="mt-0.5 break-words text-phx-xs font-semibold text-emerald-700">
        CRM: {row.crmContact.name}
        {row.crmContact.nameAr && row.crmContact.nameAr !== row.crmContact.name ? ` · ${row.crmContact.nameAr}` : ""}
        {row.crmContact.agentName ? ` · on ${row.crmContact.agentName}'s list` : ""}
      </div>
    );
  }
  if (row.crmContactId !== null) {
    return (
      <div className="mt-0.5 break-words text-phx-xs font-semibold text-amber-700">
        CRM: linked, but that contact is not on any list you can see
      </div>
    );
  }
  return <div className="mt-0.5 text-phx-xs font-semibold text-slate-400">Not linked to the CRM</div>;
}

/**
 * The gap chips, in the order an admin should work them.
 *
 * `pharmacist` is last and deliberately the quietest of the four: unlike the other three it is not
 * a fault. A venue materialised from the distributor directory has no pharmacist to record, so this
 * chip is an invitation to fill something in, not a defect count. Painting it like the others would
 * tell the reader 37 things are broken when nothing is.
 */
const GAP_CHIPS: ReadonlyArray<{
  activeClass: string;
  gap: VenueGap;
  idleClass: string;
  label: string;
}> = [
  {
    gap: "pending",
    label: "waiting for a System Admin to confirm",
    idleClass: "border-rose-200 bg-rose-50 text-rose-800 hover:border-rose-400",
    activeClass: "border-rose-700 bg-rose-700 text-white",
  },
  {
    gap: "uncoded",
    label: "with no distributor code — their distributor sales cannot be linked",
    idleClass: "border-amber-200 bg-amber-50 text-amber-800 hover:border-amber-400",
    activeClass: "border-amber-700 bg-amber-700 text-white",
  },
  {
    gap: "unlinked",
    label: "not linked to a CRM contact — no trade badge reaches the rep’s list",
    idleClass: "border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-400",
    activeClass: "border-slate-900 bg-slate-900 text-white",
  },
  {
    gap: "pharmacist",
    label: "with no pharmacist recorded — fill one in if you know it",
    idleClass: "border-slate-200 bg-white text-slate-600 hover:border-slate-400",
    activeClass: "border-slate-700 bg-slate-700 text-white",
  },
];

export function PharmacyRegistryManager({
  rows,
  areas,
  bricks,
  distributors,
  canManage,
  canClearReview,
}: {
  rows: DirectOrderRegistryPharmacy[];
  areas: AreaOption[];
  bricks: BrickOption[];
  distributors: DistributorOption[];
  canManage: boolean;
  canClearReview: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  // Which gap the list is narrowed to, if any. The chips below are the only way to set it —
  // clicking the active one clears it, so the filter can always be undone where it was applied.
  const [gap, setGap] = useState<VenueGap | null>(null);

  // Add form
  const [adding, setAdding] = useState(false);
  // This form never asked at all — it posted no venue type, so the server read every admin
  // registration as a pharmacy. That is the silent default the picker on the rep's form was
  // supposed to close, and it stayed open here.
  const [newVenueType, setNewVenueType] = useState<VenueTypeChoice>(null);
  const [newName, setNewName] = useState("");
  const [newAreaCode, setNewAreaCode] = useState("");
  const [newBrickId, setNewBrickId] = useState("");
  const [newDoctor, setNewDoctor] = useState("");
  const [newAddress, setNewAddress] = useState("");
  const [newCodes, setNewCodes] = useState<CodeRow[]>([{ ...EMPTY_ROW }]);
  const [newContact, setNewContact] = useState<VenueContactOption | null>(null);

  // Per-row editing. Only one pharmacy is open at a time — a grid of simultaneously-dirty rows is
  // how you save the wrong one at 4am.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editAreaCode, setEditAreaCode] = useState("");
  const [editBrickId, setEditBrickId] = useState("");
  const [editDoctor, setEditDoctor] = useState("");
  const [editAddress, setEditAddress] = useState("");
  const [editCodes, setEditCodes] = useState<CodeRow[]>([]);
  const [editContact, setEditContact] = useState<VenueContactOption | null>(null);
  // Whether the CRM link was TOUCHED in this edit. The three-way patch semantics run all the way
  // from here: an untouched link is not sent at all, so saving an address change can never clear a
  // link someone else declared — and it also protects a link this board could not NAME (a contact
  // outside the viewer's CRM reach, or one the mirror has since dropped), which would otherwise be
  // posted back as `null` simply because the picker had nothing to show.
  const [editContactTouched, setEditContactTouched] = useState(false);

  async function run(fn: () => Promise<void>, message: string) {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      await fn();
      setOk(message);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed.");
    } finally {
      setBusy(false);
    }
  }

  const newBricks = useMemo(
    () => (newAreaCode ? bricks.filter((b) => b.areaCode === newAreaCode) : []),
    [bricks, newAreaCode],
  );
  const editBricks = useMemo(
    () => (editAreaCode ? bricks.filter((b) => b.areaCode === editAreaCode) : []),
    [bricks, editAreaCode],
  );
  const brickById = useMemo(() => new Map(bricks.map((b) => [b.brickId, b])), [bricks]);

  const term = search.trim().toLowerCase();
  const visible = term
    ? rows.filter(
        (r) =>
          r.pharmacyName.toLowerCase().includes(term) ||
          r.phoenixPharmacyCode.toLowerCase().includes(term) ||
          r.distributorCodes.some(
            (c) => c.customerCode.toLowerCase().includes(term) || c.distributorName.toLowerCase().includes(term),
          ) ||
          // The CRM name is often the only name an admin knows a shop by — the whole reason the
          // declared link exists is that the two strings do not meet.
          (r.crmContact
            ? `${r.crmContact.name} ${r.crmContact.nameAr ?? ""} ${r.crmContact.agentName}`.toLowerCase().includes(term)
            : false),
      )
    : rows;
  const shown = gap ? visible.filter((r) => venueHasGap(r, gap)) : visible;

  function openEdit(row: DirectOrderRegistryPharmacy) {
    setEditingId(row.id);
    setEditName(row.pharmacyName);
    setEditAreaCode(row.areaCode ?? "");
    setEditBrickId(row.brickId ?? "");
    setEditDoctor(row.doctorName ?? "");
    setEditAddress(row.pharmacyAddress ?? "");
    setEditCodes(
      row.distributorCodes.length > 0
        ? row.distributorCodes.map((c) => ({ distributorCode: c.distributorCode, customerCode: c.customerCode }))
        : [{ ...EMPTY_ROW }],
    );
    setEditContact(row.crmContact);
    setEditContactTouched(false);
    setError(null);
    setOk(null);
  }

  async function saveEdit(row: DirectOrderRegistryPharmacy) {
    const brick = editBrickId ? brickById.get(editBrickId) : null;
    // Details and codes are two writes because they are two different service contracts — one
    // patches columns, the other replaces a child table. Details first: if the code replacement
    // fails validation, the name/geography fix is still saved rather than silently lost.
    await post({
      action: "updateDetails",
      pharmacyId: row.id,
      pharmacyName: editName,
      brickId: editBrickId || null,
      areaCode: brick?.areaCode ?? editAreaCode ?? null,
      regionCode: brick?.regionCode ?? null,
      doctorName: editDoctor,
      pharmacyAddress: editAddress,
      // Present only when touched — the route forwards on the KEY, not on the value.
      ...(editContactTouched ? { crmContactId: editContact?.contactCrmId ?? null } : {}),
    });
    await post({
      action: "replaceCodes",
      pharmacyId: row.id,
      distributorCodes: editCodes,
    });
    setEditingId(null);
  }

  async function register() {
    // The button is disabled until this is answered; repeated here so the request cannot be sent
    // without it, and so the value narrows below without an assertion.
    if (!venueTypeIsAnswered(newVenueType)) throw new Error(VENUE_TYPE_UNANSWERED_MESSAGE);
    const brick = newBrickId ? brickById.get(newBrickId) : null;
    await post({
      action: "register",
      pharmacyName: newName,
      brickId: newBrickId || null,
      areaCode: brick?.areaCode ?? newAreaCode ?? null,
      regionCode: brick?.regionCode ?? null,
      doctorName: newDoctor,
      pharmacyAddress: newAddress,
      venueType: newVenueType,
      crmContactId: newContact?.contactCrmId ?? null,
      // The server refuses a code on a venue that cannot hold one, so rows left behind by a type
      // switch would 400 the whole registration instead of being quietly dropped.
      distributorCodes: choiceRequiresDistributorCode(newVenueType) ? newCodes : [],
    });
    setAdding(false);
    setNewVenueType(null);
    setNewName("");
    setNewAreaCode("");
    setNewBrickId("");
    setNewDoctor("");
    setNewAddress("");
    setNewCodes([{ ...EMPTY_ROW }]);
    setNewContact(null);
  }

  const inputClass  = phxFieldClassName;
  // One vocabulary for count AND filter, so a chip can never claim 37 while the list shows a
  // different 37.
  const gapCounts = countVenueGaps(rows);

  return (
    <div className="space-y-4">
      {!canManage ? (
        <p className="border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800">
          View-only. Only a System Admin or the SFE Manager can register or edit venues.
        </p>
      ) : null}
      {error ? <p className="text-sm font-semibold text-rose-600">{error}</p> : null}
      {ok ? <p className="text-sm font-semibold text-emerald-600">{ok}</p> : null}

      {/* What is worth acting on, said as counts rather than left for the eye to find. */}
      {/* The gap chips. These were counts and nothing else: a number told you 37 venues had a hole
          and left you to find them by scrolling. Each is now a toggle that narrows the list to
          exactly the rows it counted — clicking the active one clears it, so the filter is always
          undone where it was applied. */}
      <div className="flex flex-wrap gap-3 text-phx-sm">
        <button
          type="button"
          onClick={() => setGap(null)}
          aria-pressed={gap === null}
          className={`border px-3 py-1.5 text-left font-bold ${
            gap === null ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-700 hover:border-slate-400"
          }`}
        >
          {rows.length.toLocaleString("en-US")} venues
        </button>
        {GAP_CHIPS.map((chip) =>
          gapCounts[chip.gap] > 0 ? (
            <button
              key={chip.gap}
              type="button"
              onClick={() => setGap((current) => (current === chip.gap ? null : chip.gap))}
              aria-pressed={gap === chip.gap}
              className={`border px-3 py-1.5 text-left font-bold ${gap === chip.gap ? chip.activeClass : chip.idleClass}`}
            >
              {gapCounts[chip.gap]} {chip.label}
            </button>
          ) : null,
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          className={cn(phxFieldClassName, "w-72")}
          placeholder="Search by venue, doctor, distributor or customer code…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {canManage ? (
          <button
            type="button"
            className="bg-orange-500 px-3 py-1.5 text-phx-sm font-black uppercase tracking-wider text-white hover:bg-orange-600"
            onClick={() => {
              setAdding((prev) => !prev);
              setEditingId(null);
            }}
          >
            {adding ? "Cancel" : "+ Register a venue"}
          </button>
        ) : null}
      </div>

      {adding && canManage ? (
        <section className="border border-orange-200 bg-orange-50/40 p-4">
          <h3 className="mb-1 text-phx-xs font-black uppercase tracking-wider text-slate-600">Register a venue</h3>
          <p className="mb-3 text-phx-sm text-slate-600">
            A venue registered here counts as confirmed — you are the authority the approval chain
            would otherwise wait for. An order placed on it later takes the ordinary route:
            SFE → managers → CEO, with no System Admin step.
          </p>
          <div
            className={
              venueTypeIsAnswered(newVenueType)
                ? `mb-2 border border-slate-200 bg-white p-2 ${adminSoftDepthClassName}`
                : "mb-2 border border-orange-300 bg-orange-50 p-2"
            }
          >
            <p className="text-phx-xs font-black uppercase tracking-wider text-slate-500">What is this? *</p>
            <div className="mt-1 flex items-center gap-1.5">
              {VENUE_TYPES.map((venueType) => (
                <button
                  className={
                    newVenueType === venueType
                      ? "border border-orange-300 bg-orange-50 px-2.5 py-1 text-phx-sm font-black text-orange-700"
                      : `border border-slate-200 bg-white px-2.5 py-1 text-phx-sm font-bold text-slate-600 hover:bg-slate-50 ${adminControlDepthClassName}`
                  }
                  key={venueType}
                  onClick={() => setNewVenueType(venueType)}
                  type="button"
                >
                  {venueTypeLabel(venueType)}
                </button>
              ))}
            </div>
            {!venueTypeIsAnswered(newVenueType) ? (
              <p className="mt-1 text-phx-xs font-bold text-orange-700">{VENUE_TYPE_UNANSWERED_MESSAGE}</p>
            ) : choiceRequiresDistributorCode(newVenueType) ? null : (
              <p className="mt-1 text-phx-xs font-semibold text-slate-500">
                A {venueTypeLabel(newVenueType).toLowerCase()} has no distributor account, so it has no customer
                code. Register it as one — never as a pharmacy with a made-up code.
              </p>
            )}
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            <input
              className={inputClass}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={`${venueTypeChoiceLabel(newVenueType)} name *`}
            />
            <input className={inputClass} value={newDoctor} onChange={(e) => setNewDoctor(e.target.value)} placeholder="Doctor name" />
            <select
              className={inputClass}
              value={newAreaCode}
              onChange={(e) => {
                setNewAreaCode(e.target.value);
                setNewBrickId("");
              }}
            >
              <option value="">Select area…</option>
              {areas.map((a) => (
                <option key={a.areaCode} value={a.areaCode}>
                  {a.areaName} — {a.regionName}
                </option>
              ))}
            </select>
            <select className={inputClass} value={newBrickId} onChange={(e) => setNewBrickId(e.target.value)} disabled={!newAreaCode}>
              <option value="">{newAreaCode ? "Select brick…" : "Select an area first…"}</option>
              {newBricks.map((b) => (
                <option key={b.brickId} value={b.brickId}>
                  {b.brickName}
                </option>
              ))}
            </select>
            <input
              className={`${inputClass} md:col-span-2`}
              value={newAddress}
              onChange={(e) => setNewAddress(e.target.value)}
              placeholder="Venue address"
            />
          </div>

          {/* Hidden until the type is known, and for good once it is a nursery: a venue with no
              distributor account has no code to give, and asking anyway is what produced `0000`. */}
          <div className={choiceRequiresDistributorCode(newVenueType) ? `mt-3 border border-slate-200 bg-white p-2 ${adminSoftDepthClassName}` : "hidden"}>
            <p className="text-phx-xs font-black uppercase tracking-wider text-slate-500">Distributor customer codes</p>
            <p className="mb-2 text-phx-xs font-semibold text-slate-500">
              This is the point of registering ahead of time — search the distributor&apos;s own customer
              list by name and Phoenix will link this pharmacy&apos;s distributor sales to it.
            </p>
            {newCodes.map((row, index) => (
              <DistributorCustomerPicker
                key={index}
                row={row}
                distributors={distributors}
                areas={areas}
                inputClassName={inputClass}
                onChange={(patch) => setNewCodes((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)))}
                onRemove={newCodes.length > 1 ? () => setNewCodes((prev) => prev.filter((_, i) => i !== index)) : undefined}
              />
            ))}
            <button
              type="button"
              className="text-phx-sm font-bold text-orange-600 hover:text-orange-700"
              onClick={() => setNewCodes((prev) => [...prev, { ...EMPTY_ROW }])}
            >
              + Add distributor
            </button>
          </div>

          {/* Asked of EVERY venue type, unlike the distributor codes above. A nursery has no
              distributor account but it can still be a doctor on a rep's AM list, and that is
              precisely the venue a name match would never find. */}
          <CrmContactPicker disabled={busy} onChange={setNewContact} picked={newContact} />

          <button
            type="button"
            disabled={busy || !newName.trim() || !venueTypeIsAnswered(newVenueType)}
            className="mt-3 bg-orange-500 px-4 py-2 text-phx-sm font-black uppercase tracking-wider text-white hover:bg-orange-600 disabled:opacity-50"
            onClick={() => run(register, `Registered ${newName.trim()}.`)}
          >
            {busy ? "Saving…" : `Register ${venueTypeChoiceLabel(newVenueType).toLowerCase()}`}
          </button>
        </section>
      ) : null}

      {/* Desktop: the full table. Mobile gets the cards below. Fixed layout with merged columns
          (geography into Venue, order count into Status) so it fits at every width and wraps
          instead of scrolling sideways. */}
      <div className="hidden border border-slate-200 md:block">
        <table className="w-full table-fixed border-collapse text-sm">
          {/* `table-fixed` + a colgroup is the shape the golden rule asks for: the table is exactly
              as wide as its frame at every viewport, and an over-long value WRAPS instead of
              pushing a scrollbar. The two sets both sum to 100% — percentages that fall short get
              redistributed, which quietly undoes the proportions the moment Edit is absent. */}
          <colgroup>
            {(canManage ? ["26%", "24%", "22%", "18%", "10%"] : ["29%", "26%", "25%", "20%"]).map((width) => (
              <col key={width} style={{ width }} />
            ))}
          </colgroup>
          <thead className={`${adminPanelHeaderClassName} text-white`}>
            <tr className="text-left text-phx-xs font-black uppercase tracking-wider">
              {/* Geography MERGED into Venue, and Orders into Status — the golden rule's own
                  remedy. A venue's brick is part of the same answer as its name, and its order
                  count is part of the same answer as its standing. Nothing is shortened and
                  nothing is dropped: the ellipsis ban is untouched, and the order count carries
                  the word "orders" now that no column heading says it. */}
              <th className="px-3 py-2">Venue</th>
              {/* MERGED rather than a new column: the CRM row is part of the venue's identity, so
                  it belongs beside the doctor it names. */}
              <th className="px-3 py-2">Doctor · CRM contact</th>
              <th className="px-3 py-2">Distributor codes</th>
              <th className="px-3 py-2">Status · Orders</th>
              {canManage ? <th className="px-3 py-2">Edit</th> : null}
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 ? (
              <tr>
                <td colSpan={canManage ? 5 : 4} className="px-3 py-6 text-center text-slate-500">
                  {term ? "No venue matches that search." : "No venues registered yet."}
                </td>
              </tr>
            ) : null}
            {shown.map((row) => (
              <tr key={row.id} className="border-b border-slate-100 align-top">
                {/* Cells wrap (`break-words` covers an unbroken customer code) — under a fixed table
                    layout a cell that cannot wrap would be silently cut. */}
                <td className="break-words px-3 py-2">
                  <div className="font-semibold text-slate-800">{row.pharmacyName}</div>
                  {/* Geography, merged in — the same brick · area · region line the mobile card
                      below already shows, so the two surfaces now read identically. */}
                  <div className="mt-0.5 text-phx-xs text-slate-500">
                    {row.brickName ?? "—"} · {row.areaName ?? "—"} · {row.regionName ?? "—"}
                  </div>
                </td>
                <td className="break-words px-3 py-2 text-phx-sm text-slate-600">
                  <div>{row.doctorName ?? "—"}</div>
                  <CrmContactLine row={row} />
                </td>
                <td className="break-words px-3 py-2 text-phx-sm text-slate-600">
                  {row.distributorCodes.length === 0 ? (
                    <span className="font-semibold text-amber-700">No code — sales cannot be linked</span>
                  ) : (
                    row.distributorCodes.map((c, i) => (
                      <div key={i}>
                        {c.distributorName}: <span className="font-semibold text-slate-800">{c.customerCode}</span>
                        {c.mappedBrickId ? null : <span className="text-amber-700"> · not in their list</span>}
                      </div>
                    ))
                  )}
                </td>
                <td className="break-words px-3 py-2">
                  {/* Same reason as the mobile card below: this was a two-way branch, so a rejected
                      pharmacy rendered green as "Confirmed". Tested first, deliberately. */}
                  {row.verificationStatus === "rejected" ? (
                    <div className="space-y-1">
                      <span className="inline-block bg-rose-200 px-2 py-0.5 text-phx-xs font-black text-rose-900">
                        Rejected — proven false
                      </span>
                      <p className="text-phx-xs text-slate-500">Deactivated; cannot be used or confirmed.</p>
                    </div>
                  ) : row.verificationStatus === "pending_review" ? (
                    <div className="space-y-1">
                      <span className="inline-block bg-rose-100 px-2 py-0.5 text-phx-xs font-bold text-rose-800">
                        Waiting for confirmation
                      </span>
                      {canClearReview ? (
                        <button
                          type="button"
                          disabled={busy}
                          className="block bg-slate-900 px-2 py-1 text-phx-xs font-bold text-white hover:bg-slate-700 disabled:opacity-50"
                          onClick={() => run(() => post({ action: "confirm", pharmacyId: row.id }), `Confirmed ${row.pharmacyName}.`)}
                        >
                          Confirm this venue
                        </button>
                      ) : null}
                    </div>
                  ) : (
                    <span className="inline-block bg-emerald-100 px-2 py-0.5 text-phx-xs font-bold text-emerald-800">
                      Confirmed
                    </span>
                  )}
                  {/* The order count, merged in under the standing it belongs to. It carries the
                      word "orders" now that no column heading supplies it — a bare number under a
                      status badge would be a riddle, and abbreviating it is what the ellipsis ban
                      forbids. */}
                  <div className="mt-1 text-phx-sm text-slate-600">
                    {row.orderCount.toLocaleString("en-US")} order{row.orderCount === 1 ? "" : "s"}
                    {row.pendingOrderCount > 0 ? (
                      <span className="text-orange-700"> · {row.pendingOrderCount} in flight</span>
                    ) : null}
                  </div>
                </td>
                {canManage ? (
                  <td className="break-words px-3 py-2">
                    <button
                      type="button"
                      className="border border-slate-300 px-2 py-1 text-phx-xs font-bold text-slate-600 hover:bg-slate-50"
                      onClick={() => (editingId === row.id ? setEditingId(null) : openEdit(row))}
                    >
                      {editingId === row.id ? "Close" : "Edit"}
                    </button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile cards — the admin shell never shows a table on a phone. */}
      <div className="space-y-2 md:hidden">
        {shown.map((row) => (
          <div key={row.id} className={`border border-slate-200 bg-white p-3 ${adminSoftDepthClassName}`}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-semibold text-slate-800">{row.pharmacyName}</div>
              </div>
              {/* `rejected` MUST be tested before the else. This was a two-way if/else, so a
                  rejected pharmacy fell through and rendered as a green "Confirmed" — a pharmacy
                  proven false, shown as trusted, with no type error to catch it. */}
              {row.verificationStatus === "rejected" ? (
                <span className="bg-rose-200 px-2 py-0.5 text-phx-xs font-black text-rose-900">Rejected</span>
              ) : row.verificationStatus === "pending_review" ? (
                <span className="bg-rose-100 px-2 py-0.5 text-phx-xs font-bold text-rose-800">Waiting</span>
              ) : (
                <span className="bg-emerald-100 px-2 py-0.5 text-phx-xs font-bold text-emerald-800">Confirmed</span>
              )}
            </div>
            <div className="mt-2 text-phx-sm text-slate-600">
              {row.brickName ?? "—"} · {row.areaName ?? "—"} · {row.regionName ?? "—"}
            </div>
            <div className="mt-1 text-phx-sm text-slate-600">
              {row.distributorCodes.length === 0
                ? "No distributor code"
                : row.distributorCodes.map((c) => `${c.distributorName}: ${c.customerCode}`).join(" · ")}
            </div>
            <CrmContactLine row={row} />
            {canManage ? (
              <button
                type="button"
                className="mt-2 border border-slate-300 px-2 py-1 text-phx-xs font-bold text-slate-600"
                onClick={() => (editingId === row.id ? setEditingId(null) : openEdit(row))}
              >
                {editingId === row.id ? "Close" : "Edit"}
              </button>
            ) : null}
          </div>
        ))}
      </div>

      {editingId && canManage ? (
        <section className={`border border-slate-300 bg-white p-4 ${adminSoftDepthClassName}`}>
          <h3 className="mb-3 text-phx-xs font-black uppercase tracking-wider text-slate-600">
            Editing {rows.find((r) => r.id === editingId)?.pharmacyName ?? ""}
          </h3>
          {(() => {
            const row = rows.find((r) => r.id === editingId);
            if (!row) return null;
            return (
              <>
                {row.pendingOrderCount > 0 ? (
                  <p className="mb-3 border border-amber-200 bg-amber-50 px-3 py-2 text-phx-sm font-semibold text-amber-900">
                    {row.pendingOrderCount} order{row.pendingOrderCount === 1 ? " is" : "s are"} still climbing the
                    approval chain on this pharmacy. Changing a distributor code changes which distributor sales
                    Phoenix will match to {row.pendingOrderCount === 1 ? "it" : "them"}.
                  </p>
                ) : null}
                <div className="grid gap-2 md:grid-cols-2">
                  <input className={inputClass} value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="Venue name *" />
                  <input className={inputClass} value={editDoctor} onChange={(e) => setEditDoctor(e.target.value)} placeholder="Doctor name" />
                  <select
                    className={inputClass}
                    value={editAreaCode}
                    onChange={(e) => {
                      setEditAreaCode(e.target.value);
                      setEditBrickId("");
                    }}
                  >
                    <option value="">Select area…</option>
                    {areas.map((a) => (
                      <option key={a.areaCode} value={a.areaCode}>
                        {a.areaName} — {a.regionName}
                      </option>
                    ))}
                  </select>
                  <select className={inputClass} value={editBrickId} onChange={(e) => setEditBrickId(e.target.value)} disabled={!editAreaCode}>
                    <option value="">{editAreaCode ? "Select brick…" : "Select an area first…"}</option>
                    {editBricks.map((b) => (
                      <option key={b.brickId} value={b.brickId}>
                        {b.brickName}
                      </option>
                    ))}
                  </select>
                  <input
                    className={`${inputClass} md:col-span-2`}
                    value={editAddress}
                    onChange={(e) => setEditAddress(e.target.value)}
                    placeholder="Venue address"
                  />
                </div>

                <div className="mt-3 border border-slate-200 p-2">
                  <p className="text-phx-xs font-black uppercase tracking-wider text-slate-500">Distributor customer codes</p>
                  <p className="mb-2 text-phx-xs font-semibold text-slate-500">
                    What you save here REPLACES every code on this pharmacy. Remove a row to drop that
                    distributor entirely.
                  </p>
                  {editCodes.map((codeRow, index) => (
                    <DistributorCustomerPicker
                      key={index}
                      row={codeRow}
                      distributors={distributors}
                      areas={areas}
                      inputClassName={inputClass}
                      onChange={(patch) => setEditCodes((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)))}
                      onRemove={() => setEditCodes((prev) => prev.filter((_, i) => i !== index))}
                    />
                  ))}
                  <button
                    type="button"
                    className="text-phx-sm font-bold text-orange-600 hover:text-orange-700"
                    onClick={() => setEditCodes((prev) => [...prev, { ...EMPTY_ROW }])}
                  >
                    + Add distributor
                  </button>
                </div>

                {/* THE RETROACTIVE DOOR. Every venue registered before 2026-09-03 carries no link,
                    because the column did not exist when it was created — and a rep's own submit
                    form cannot fix that, since only an admin may edit an existing venue. This is
                    the only place those venues can be linked. */}
                {row.crmContactId !== null && !row.crmContact && !editContactTouched ? (
                  <p className="mt-3 border border-amber-200 bg-amber-50 px-3 py-2 text-phx-sm font-semibold text-amber-900">
                    This venue is linked to a CRM contact that is not on any list you can see — it may
                    have been removed from the CRM mirror. Leaving this alone keeps the link exactly as
                    it is; picking a contact below replaces it.
                  </p>
                ) : null}
                <CrmContactPicker
                  disabled={busy}
                  onChange={(option) => {
                    setEditContact(option);
                    setEditContactTouched(true);
                  }}
                  picked={editContact}
                />

                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    disabled={busy || !editName.trim()}
                    className="bg-orange-500 px-4 py-2 text-phx-sm font-black uppercase tracking-wider text-white hover:bg-orange-600 disabled:opacity-50"
                    onClick={() => run(() => saveEdit(row), `Saved ${editName.trim()}.`)}
                  >
                    {busy ? "Saving…" : "Save changes"}
                  </button>
                  <button
                    type="button"
                    className="border border-slate-300 px-4 py-2 text-phx-sm font-bold text-slate-600 hover:bg-slate-50"
                    onClick={() => setEditingId(null)}
                  >
                    Cancel
                  </button>
                </div>
              </>
            );
          })()}
        </section>
      ) : null}
    </div>
  );
}
