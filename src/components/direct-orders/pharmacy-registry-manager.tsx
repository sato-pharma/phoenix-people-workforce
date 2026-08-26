"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { DistributorCustomerPicker } from "@/components/direct-orders/distributor-customer-picker";
import type { DirectOrderRegistryPharmacy } from "@/lib/direct-orders/service";
import {
  choiceRequiresDistributorCode,
  VENUE_TYPE_UNANSWERED_MESSAGE,
  VENUE_TYPES,
  venueTypeChoiceLabel,
  venueTypeIsAnswered,
  venueTypeLabel,
  type VenueTypeChoice,
} from "@/lib/venues/venue-type";

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

  // Per-row editing. Only one pharmacy is open at a time — a grid of simultaneously-dirty rows is
  // how you save the wrong one at 4am.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editAreaCode, setEditAreaCode] = useState("");
  const [editBrickId, setEditBrickId] = useState("");
  const [editDoctor, setEditDoctor] = useState("");
  const [editAddress, setEditAddress] = useState("");
  const [editCodes, setEditCodes] = useState<CodeRow[]>([]);

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
          ),
      )
    : rows;

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
  }

  const inputClass = "w-full border border-slate-300 px-2 py-1.5 text-sm";
  const pendingCount = rows.filter((r) => r.verificationStatus === "pending_review").length;
  const uncodedCount = rows.filter((r) => r.distributorCodes.length === 0).length;

  return (
    <div className="space-y-4">
      {!canManage ? (
        <p className="border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800">
          View-only. Only a System Admin or the SFE Manager can register or edit pharmacies.
        </p>
      ) : null}
      {error ? <p className="text-sm font-semibold text-rose-600">{error}</p> : null}
      {ok ? <p className="text-sm font-semibold text-emerald-600">{ok}</p> : null}

      {/* What is worth acting on, said as counts rather than left for the eye to find. */}
      <div className="flex flex-wrap gap-3 text-[12px]">
        <span className="border border-slate-200 bg-white px-3 py-1.5 font-bold text-slate-700">
          {rows.length.toLocaleString("en-US")} pharmacies
        </span>
        {pendingCount > 0 ? (
          <span className="border border-rose-200 bg-rose-50 px-3 py-1.5 font-bold text-rose-800">
            {pendingCount} waiting for a System Admin to confirm
          </span>
        ) : null}
        {uncodedCount > 0 ? (
          <span className="border border-amber-200 bg-amber-50 px-3 py-1.5 font-bold text-amber-800">
            {uncodedCount} with no distributor code — their distributor sales cannot be linked
          </span>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          className="w-72 border border-slate-300 px-3 py-1.5 text-sm"
          placeholder="Search by pharmacy, Phoenix code, distributor or customer code…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {canManage ? (
          <button
            type="button"
            className="bg-orange-500 px-3 py-1.5 text-[12px] font-black uppercase tracking-wider text-white hover:bg-orange-600"
            onClick={() => {
              setAdding((prev) => !prev);
              setEditingId(null);
            }}
          >
            {adding ? "Cancel" : "+ Register a pharmacy"}
          </button>
        ) : null}
      </div>

      {adding && canManage ? (
        <section className="border border-orange-200 bg-orange-50/40 p-4">
          <h3 className="mb-1 text-[11px] font-black uppercase tracking-wider text-slate-600">Register a pharmacy</h3>
          <p className="mb-3 text-[12px] text-slate-600">
            A pharmacy registered here counts as confirmed — you are the authority the approval chain
            would otherwise wait for. An order placed on it later takes the ordinary route:
            SFE → managers → CEO, with no System Admin step.
          </p>
          <div
            className={
              venueTypeIsAnswered(newVenueType)
                ? "mb-2 border border-slate-200 bg-white p-2"
                : "mb-2 border border-orange-300 bg-orange-50 p-2"
            }
          >
            <p className="text-[11px] font-black uppercase tracking-wider text-slate-500">What is this? *</p>
            <div className="mt-1 flex items-center gap-1.5">
              {VENUE_TYPES.map((venueType) => (
                <button
                  className={
                    newVenueType === venueType
                      ? "border border-orange-300 bg-orange-50 px-2.5 py-1 text-[12px] font-black text-orange-700"
                      : "border border-slate-200 bg-white px-2.5 py-1 text-[12px] font-bold text-slate-600 hover:bg-slate-50"
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
              <p className="mt-1 text-[11px] font-bold text-orange-700">{VENUE_TYPE_UNANSWERED_MESSAGE}</p>
            ) : choiceRequiresDistributorCode(newVenueType) ? null : (
              <p className="mt-1 text-[11px] font-semibold text-slate-500">
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
              placeholder="Pharmacy address"
            />
          </div>

          {/* Hidden until the type is known, and for good once it is a nursery: a venue with no
              distributor account has no code to give, and asking anyway is what produced `0000`. */}
          <div className={choiceRequiresDistributorCode(newVenueType) ? "mt-3 border border-slate-200 bg-white p-2" : "hidden"}>
            <p className="text-[11px] font-black uppercase tracking-wider text-slate-500">Distributor customer codes</p>
            <p className="mb-2 text-[11px] font-semibold text-slate-500">
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
              className="text-[12px] font-bold text-orange-600 hover:text-orange-700"
              onClick={() => setNewCodes((prev) => [...prev, { ...EMPTY_ROW }])}
            >
              + Add distributor
            </button>
          </div>

          <button
            type="button"
            disabled={busy || !newName.trim() || !venueTypeIsAnswered(newVenueType)}
            className="mt-3 bg-orange-500 px-4 py-2 text-[12px] font-black uppercase tracking-wider text-white hover:bg-orange-600 disabled:opacity-50"
            onClick={() => run(register, `Registered ${newName.trim()}.`)}
          >
            {busy ? "Saving…" : `Register ${venueTypeChoiceLabel(newVenueType).toLowerCase()}`}
          </button>
        </section>
      ) : null}

      {/* Desktop: the full table. Mobile gets the cards below. */}
      <div className="hidden overflow-x-auto border border-slate-200 md:block">
        <table className="w-full min-w-[1100px] border-collapse text-sm">
          <thead className="bg-slate-900 text-white">
            <tr className="text-left text-[11px] font-black uppercase tracking-wider">
              <th className="px-3 py-2">Pharmacy</th>
              <th className="px-3 py-2">Geography</th>
              <th className="px-3 py-2">Doctor</th>
              <th className="px-3 py-2">Distributor codes</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Orders</th>
              {canManage ? <th className="px-3 py-2">Edit</th> : null}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={canManage ? 7 : 6} className="px-3 py-6 text-center text-slate-500">
                  {term ? "No pharmacy matches that search." : "No pharmacies registered yet."}
                </td>
              </tr>
            ) : null}
            {visible.map((row) => (
              <tr key={row.id} className="border-b border-slate-100 align-top">
                <td className="whitespace-nowrap px-3 py-2">
                  <div className="font-semibold text-slate-800">{row.pharmacyName}</div>
                  <div className="text-[11px] text-slate-400">{row.phoenixPharmacyCode}</div>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-[12px] text-slate-600">
                  <div>{row.brickName ?? "—"}</div>
                  <div className="text-[11px] text-slate-400">
                    {row.areaName ?? "—"} · {row.regionName ?? "—"}
                  </div>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-[12px] text-slate-600">{row.doctorName ?? "—"}</td>
                <td className="px-3 py-2 text-[12px] text-slate-600">
                  {row.distributorCodes.length === 0 ? (
                    <span className="font-semibold text-amber-700">No code — sales cannot be linked</span>
                  ) : (
                    row.distributorCodes.map((c, i) => (
                      <div key={i} className="whitespace-nowrap">
                        {c.distributorName}: <span className="font-semibold text-slate-800">{c.customerCode}</span>
                        {c.mappedBrickId ? null : <span className="text-amber-700"> · not in their list</span>}
                      </div>
                    ))
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  {/* Same reason as the mobile card below: this was a two-way branch, so a rejected
                      pharmacy rendered green as "Confirmed". Tested first, deliberately. */}
                  {row.verificationStatus === "rejected" ? (
                    <div className="space-y-1">
                      <span className="inline-block bg-rose-200 px-2 py-0.5 text-[11px] font-black text-rose-900">
                        Rejected — proven false
                      </span>
                      <p className="text-[11px] text-slate-500">Deactivated; cannot be used or confirmed.</p>
                    </div>
                  ) : row.verificationStatus === "pending_review" ? (
                    <div className="space-y-1">
                      <span className="inline-block bg-rose-100 px-2 py-0.5 text-[11px] font-bold text-rose-800">
                        Waiting for confirmation
                      </span>
                      {canClearReview ? (
                        <button
                          type="button"
                          disabled={busy}
                          className="block bg-slate-900 px-2 py-1 text-[11px] font-bold text-white hover:bg-slate-700 disabled:opacity-50"
                          onClick={() => run(() => post({ action: "confirm", pharmacyId: row.id }), `Confirmed ${row.pharmacyName}.`)}
                        >
                          Confirm this pharmacy
                        </button>
                      ) : null}
                    </div>
                  ) : (
                    <span className="inline-block bg-emerald-100 px-2 py-0.5 text-[11px] font-bold text-emerald-800">
                      Confirmed
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-[12px] text-slate-600">
                  {row.orderCount.toLocaleString("en-US")}
                  {row.pendingOrderCount > 0 ? (
                    <span className="text-orange-700"> · {row.pendingOrderCount} in flight</span>
                  ) : null}
                </td>
                {canManage ? (
                  <td className="whitespace-nowrap px-3 py-2">
                    <button
                      type="button"
                      className="border border-slate-300 px-2 py-1 text-[11px] font-bold text-slate-600 hover:bg-slate-50"
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
        {visible.map((row) => (
          <div key={row.id} className="border border-slate-200 bg-white p-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-semibold text-slate-800">{row.pharmacyName}</div>
                <div className="text-[11px] text-slate-400">{row.phoenixPharmacyCode}</div>
              </div>
              {/* `rejected` MUST be tested before the else. This was a two-way if/else, so a
                  rejected pharmacy fell through and rendered as a green "Confirmed" — a pharmacy
                  proven false, shown as trusted, with no type error to catch it. */}
              {row.verificationStatus === "rejected" ? (
                <span className="bg-rose-200 px-2 py-0.5 text-[11px] font-black text-rose-900">Rejected</span>
              ) : row.verificationStatus === "pending_review" ? (
                <span className="bg-rose-100 px-2 py-0.5 text-[11px] font-bold text-rose-800">Waiting</span>
              ) : (
                <span className="bg-emerald-100 px-2 py-0.5 text-[11px] font-bold text-emerald-800">Confirmed</span>
              )}
            </div>
            <div className="mt-2 text-[12px] text-slate-600">
              {row.brickName ?? "—"} · {row.areaName ?? "—"} · {row.regionName ?? "—"}
            </div>
            <div className="mt-1 text-[12px] text-slate-600">
              {row.distributorCodes.length === 0
                ? "No distributor code"
                : row.distributorCodes.map((c) => `${c.distributorName}: ${c.customerCode}`).join(" · ")}
            </div>
            {canManage ? (
              <button
                type="button"
                className="mt-2 border border-slate-300 px-2 py-1 text-[11px] font-bold text-slate-600"
                onClick={() => (editingId === row.id ? setEditingId(null) : openEdit(row))}
              >
                {editingId === row.id ? "Close" : "Edit"}
              </button>
            ) : null}
          </div>
        ))}
      </div>

      {editingId && canManage ? (
        <section className="border border-slate-300 bg-white p-4">
          <h3 className="mb-3 text-[11px] font-black uppercase tracking-wider text-slate-600">
            Editing {rows.find((r) => r.id === editingId)?.pharmacyName ?? ""}
          </h3>
          {(() => {
            const row = rows.find((r) => r.id === editingId);
            if (!row) return null;
            return (
              <>
                {row.pendingOrderCount > 0 ? (
                  <p className="mb-3 border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] font-semibold text-amber-900">
                    {row.pendingOrderCount} order{row.pendingOrderCount === 1 ? " is" : "s are"} still climbing the
                    approval chain on this pharmacy. Changing a distributor code changes which distributor sales
                    Phoenix will match to {row.pendingOrderCount === 1 ? "it" : "them"}.
                  </p>
                ) : null}
                <div className="grid gap-2 md:grid-cols-2">
                  <input className={inputClass} value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="Pharmacy name *" />
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
                    placeholder="Pharmacy address"
                  />
                </div>

                <div className="mt-3 border border-slate-200 p-2">
                  <p className="text-[11px] font-black uppercase tracking-wider text-slate-500">Distributor customer codes</p>
                  <p className="mb-2 text-[11px] font-semibold text-slate-500">
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
                    className="text-[12px] font-bold text-orange-600 hover:text-orange-700"
                    onClick={() => setEditCodes((prev) => [...prev, { ...EMPTY_ROW }])}
                  >
                    + Add distributor
                  </button>
                </div>

                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    disabled={busy || !editName.trim()}
                    className="bg-orange-500 px-4 py-2 text-[12px] font-black uppercase tracking-wider text-white hover:bg-orange-600 disabled:opacity-50"
                    onClick={() => run(() => saveEdit(row), `Saved ${editName.trim()}.`)}
                  >
                    {busy ? "Saving…" : "Save changes"}
                  </button>
                  <button
                    type="button"
                    className="border border-slate-300 px-4 py-2 text-[12px] font-bold text-slate-600 hover:bg-slate-50"
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
