"use client";

import { useEffect, useState } from "react";
import { Pencil, Plus, Search, Trash2 } from "lucide-react";

import { PortalSection } from "@/components/employee-portal/portal-primitives";
import { FormActions, FormError, FormField } from "@/components/ui/form-kit";
import {
  phxButtonDangerDenseClassName,
  phxButtonGhostClassName,
  phxButtonPrimaryClassName,
  phxFieldClassName,
  phxFieldGridTwoClassName,
  phxSelectClassName,
} from "@/components/ui/form-tokens";
import { LoadingSpinner } from "@/components/ui/loading-state";
import type { PharmacyCodeFinding } from "@/lib/marketing-requests/customer-edit";
import { MARKETING_CUSTOMER_SPECIALITIES } from "@/lib/marketing-requests/types";

type Suggestion = { placeId: string; primaryText: string; secondaryText: string | null };
type Place = { area?: string | null; formattedAddress?: string | null; governorate?: string | null; lat: number; lng: number; name?: string | null };

async function readJson(response: Response): Promise<{ message?: string } & Record<string, unknown>> {
  return (await response.json().catch(() => ({ message: "The server's reply could not be read." }))) as never;
}

/**
 * The Super Admin's edit of a customer already on file — name, speciality and phone, and its
 * pharmacies: add one by its distributor code (the one on file is attached, never copied), or take
 * one off. Every write goes through `src/lib/marketing-requests/customer-edit.ts`.
 */
export function CustomerEditPanel({
  customerId,
  displayName,
  mobileNumber,
  speciality,
  onChanged,
}: {
  customerId: string;
  displayName: string;
  mobileNumber: string | null;
  speciality: string | null;
  onChanged: (message: string) => void;
}) {
  return (
    <PortalSection
      description="Change this customer, or add and remove its pharmacies, without saving them again on Customer Validation."
      eyebrow="Super Admin"
      title="Edit this customer"
    >
      <div className="space-y-6 px-4 py-4 sm:px-5">
        <DetailsForm
          customerId={customerId}
          displayName={displayName}
          mobileNumber={mobileNumber}
          onChanged={onChanged}
          speciality={speciality}
        />
        <AddPharmacyForm customerId={customerId} onChanged={onChanged} />
      </div>
    </PortalSection>
  );
}

function DetailsForm(props: {
  customerId: string;
  displayName: string;
  mobileNumber: string | null;
  speciality: string | null;
  onChanged: (message: string) => void;
}) {
  const [name, setName] = useState(props.displayName);
  const [speciality, setSpeciality] = useState(props.speciality ?? "");
  const [mobile, setMobile] = useState(props.mobileNumber ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unchanged = name.trim() === props.displayName && speciality === (props.speciality ?? "") && mobile.trim() === (props.mobileNumber ?? "");

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/marketing-requests/validated-customers/${props.customerId}/edit`, {
        body: JSON.stringify({ displayName: name, mobileNumber: mobile || null, speciality: speciality || null }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      const payload = await readJson(response);
      if (!response.ok) {
        setError(payload.message ?? "Could not save the customer.");
        return;
      }
      props.onChanged("Customer saved.");
    } catch {
      setError("Network error. Nothing was saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="flex items-center gap-2 text-sm font-black text-slate-900">
        <Pencil className="h-4 w-4 text-slate-500" /> Name, speciality and phone
      </p>
      <div className={phxFieldGridTwoClassName}>
        <FormField htmlFor="customer-edit-name" label="Customer name" required>
          <input className={phxFieldClassName} id="customer-edit-name" onChange={(event) => setName(event.target.value)} value={name} />
        </FormField>
        <FormField htmlFor="customer-edit-speciality" label="Speciality">
          <select className={phxSelectClassName} id="customer-edit-speciality" onChange={(event) => setSpeciality(event.target.value)} value={speciality}>
            <option value="">Not recorded</option>
            {MARKETING_CUSTOMER_SPECIALITIES.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </FormField>
        <FormField htmlFor="customer-edit-mobile" label="Phone">
          <input className={phxFieldClassName} id="customer-edit-mobile" inputMode="tel" onChange={(event) => setMobile(event.target.value)} value={mobile} />
        </FormField>
      </div>
      <FormError>{error}</FormError>
      <FormActions
        right={(
          <button className={phxButtonPrimaryClassName} disabled={busy || unchanged || !name.trim()} onClick={() => void save()} type="button">
            {busy ? <LoadingSpinner /> : null} Save changes
          </button>
        )}
      />
    </div>
  );
}

function AddPharmacyForm({ customerId, onChanged }: { customerId: string; onChanged: (message: string) => void }) {
  const [distributors, setDistributors] = useState<Array<{ id: number; name: string }>>([]);
  const [distributorId, setDistributorId] = useState("");
  const [code, setCode] = useState("");
  const [finding, setFinding] = useState<PharmacyCodeFinding | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only for a pharmacy no venue holds yet.
  const [newName, setNewName] = useState("");
  const [placeQuery, setPlaceQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [place, setPlace] = useState<Place | null>(null);

  useEffect(() => {
    let live = true;
    void fetch(`/api/marketing-requests/validated-customers/${customerId}/pharmacies`, { cache: "no-store" })
      .then(readJson)
      .then((payload) => {
        if (live) setDistributors((payload.distributors as Array<{ id: number; name: string }>) ?? []);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [customerId]);

  function resetFinding() {
    setFinding(null);
    setNewName("");
    setPlace(null);
    setSuggestions([]);
    setPlaceQuery("");
  }

  async function find() {
    setBusy(true);
    setError(null);
    resetFinding();
    try {
      const query = new URLSearchParams({ code: code.trim(), distributorId });
      const response = await fetch(`/api/marketing-requests/validated-customers/${customerId}/pharmacies?${query}`, { cache: "no-store" });
      const payload = await readJson(response);
      if (!response.ok) {
        setError(payload.message ?? "Could not look up that code.");
        return;
      }
      setFinding(payload as unknown as PharmacyCodeFinding);
    } catch {
      setError("Network error. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function searchPlaces() {
    setError(null);
    const response = await fetch(`/api/marketing-requests/place-search?input=${encodeURIComponent(placeQuery.trim())}`, { cache: "no-store" });
    const payload = await readJson(response);
    setSuggestions((payload.suggestions as Suggestion[]) ?? []);
    if (!response.ok) setError(payload.message ?? "The map search did not answer.");
  }

  async function choosePlace(suggestion: Suggestion) {
    const response = await fetch(`/api/marketing-requests/place-search?placeId=${encodeURIComponent(suggestion.placeId)}`, { cache: "no-store" });
    const payload = await readJson(response);
    if (!response.ok || !payload.location) {
      setError(payload.message ?? "That place could not be pinned.");
      return;
    }
    setPlace(payload.location as Place);
    setSuggestions([]);
    if (!newName.trim()) setNewName(suggestion.primaryText);
  }

  async function add(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/marketing-requests/validated-customers/${customerId}/pharmacies`, {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await readJson(response);
      if (!response.ok) {
        setError(payload.message ?? "Could not add the pharmacy.");
        return;
      }
      setCode("");
      resetFinding();
      onChanged("Pharmacy added to this customer.");
    } catch {
      setError("Network error. Open the page again before retrying — it may already be added.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 border-t border-slate-100 pt-5">
      <p className="flex items-center gap-2 text-sm font-black text-slate-900">
        <Plus className="h-4 w-4 text-slate-500" /> Add a pharmacy by its distributor code
      </p>
      <div className={phxFieldGridTwoClassName}>
        <FormField htmlFor="customer-edit-distributor" label="Distributor" required>
          <select className={phxSelectClassName} id="customer-edit-distributor" onChange={(event) => { setDistributorId(event.target.value); resetFinding(); }} value={distributorId}>
            <option value="">Choose the distributor</option>
            {distributors.map((distributor) => (
              <option key={distributor.id} value={String(distributor.id)}>{distributor.name}</option>
            ))}
          </select>
        </FormField>
        <FormField htmlFor="customer-edit-code" label="Pharmacy code at that distributor" required>
          <input className={phxFieldClassName} id="customer-edit-code" onChange={(event) => { setCode(event.target.value); resetFinding(); }} value={code} />
        </FormField>
      </div>
      <FormActions
        right={(
          <button className={phxButtonGhostClassName} disabled={busy || !distributorId || !code.trim()} onClick={() => void find()} type="button">
            {busy && !finding ? <LoadingSpinner /> : <Search className="h-4 w-4" />} Find pharmacy
          </button>
        )}
      />

      {finding && finding.onFile.length > 0 ? (
        <ul className="divide-y divide-slate-100 border border-slate-200">
          {finding.onFile.map((venue) => (
            <li className="flex flex-wrap items-start justify-between gap-3 px-4 py-3" key={venue.pharmacyId}>
              <div className="min-w-0 space-y-1">
                <p className="break-words text-sm font-black text-slate-900">{venue.name}</p>
                <p className="break-words text-xs text-slate-600">{venue.address || "No address on file"}</p>
                <p className="break-words text-xs text-slate-500">{venue.codes.join(" · ")}{venue.hasPin ? " · on the map" : " · no map pin"}</p>
              </div>
              {venue.alreadyOnCustomer ? (
                <span className="text-xs font-bold text-emerald-700">Already on this customer</span>
              ) : (
                <button className={phxButtonPrimaryClassName} disabled={busy} onClick={() => void add({ pharmacyId: venue.pharmacyId })} type="button">
                  Add to this customer
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}

      {finding && finding.onFile.length === 0 ? (
        <div className="space-y-4 border border-slate-200 px-4 py-4">
          <p className="text-sm text-slate-700">
            {finding.distributorRecord
              ? `No pharmacy holds this code yet. The distributor has it at: ${[finding.distributorRecord.address, finding.distributorRecord.area].filter(Boolean).join(", ") || "no address"}.`
              : "No pharmacy holds this code yet, and the distributor's list does not have it either. Check the code before adding it."}
          </p>
          <FormField htmlFor="customer-edit-place" hint="Type the shop's NAME, not its street — Google finds shops by name." label="Find the shop on the map" required>
            <div className="flex gap-2">
              <input className={phxFieldClassName} id="customer-edit-place" onChange={(event) => setPlaceQuery(event.target.value)} value={placeQuery} />
              <button className={phxButtonGhostClassName} disabled={placeQuery.trim().length < 2} onClick={() => void searchPlaces()} type="button">
                <Search className="h-4 w-4" /> Search
              </button>
            </div>
          </FormField>
          {suggestions.length > 0 ? (
            <ul className="divide-y divide-slate-100 border border-slate-200">
              {suggestions.map((suggestion) => (
                <li key={suggestion.placeId}>
                  <button className="block w-full px-3 py-2 text-left hover:bg-slate-50" onClick={() => void choosePlace(suggestion)} type="button">
                    <span className="block break-words text-sm font-bold text-slate-900">{suggestion.primaryText}</span>
                    <span className="block break-words text-xs text-slate-500">{suggestion.secondaryText}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {place ? (
            <p className="break-words text-xs font-bold text-emerald-700">Pinned: {place.formattedAddress || `${place.lat.toFixed(5)}, ${place.lng.toFixed(5)}`}</p>
          ) : null}
          <FormField htmlFor="customer-edit-new-name" label="Pharmacy name" required>
            <input className={phxFieldClassName} id="customer-edit-new-name" onChange={(event) => setNewName(event.target.value)} value={newName} />
          </FormField>
          <FormActions
            right={(
              <button
                className={phxButtonPrimaryClassName}
                disabled={busy || !place || !newName.trim()}
                onClick={() => void add({
                  address: place?.formattedAddress ?? finding.distributorRecord?.address ?? null,
                  area: place?.area ?? null,
                  displayName: newName,
                  distributorId,
                  governorate: place?.governorate ?? null,
                  latitude: place?.lat,
                  longitude: place?.lng,
                  pharmacyCode: code,
                })}
                type="button"
              >
                {busy ? <LoadingSpinner /> : null} Add new pharmacy
              </button>
            )}
          />
        </div>
      ) : null}
      <FormError>{error}</FormError>
    </div>
  );
}

/** "Remove" on one linked pharmacy. Asks why first; the links are switched off, never deleted. */
export function RemovePharmacyControl({
  customerId,
  pharmacyId,
  pharmacyName,
  onChanged,
}: {
  customerId: string;
  pharmacyId: string;
  pharmacyName: string;
  onChanged: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/marketing-requests/validated-customers/${customerId}/pharmacies`, {
        body: JSON.stringify({ pharmacyId, reason }),
        headers: { "Content-Type": "application/json" },
        method: "DELETE",
      });
      const payload = await readJson(response);
      if (!response.ok) {
        setError(payload.message ?? "Could not remove the pharmacy.");
        return;
      }
      onChanged(`"${pharmacyName}" removed from this customer.`);
    } catch {
      setError("Network error. Nothing was removed.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className={phxButtonDangerDenseClassName} onClick={() => setOpen(true)} type="button">
        <Trash2 className="h-3.5 w-3.5" /> Remove from this customer
      </button>
    );
  }
  return (
    <div className="mt-3 space-y-3 border border-rose-200 px-3 py-3">
      <FormField htmlFor={`remove-${pharmacyId}`} label={`Why does "${pharmacyName}" come off this customer?`} required>
        <input className={phxFieldClassName} id={`remove-${pharmacyId}`} onChange={(event) => setReason(event.target.value)} value={reason} />
      </FormField>
      <FormError>{error}</FormError>
      <FormActions
        left={<button className={phxButtonGhostClassName} onClick={() => setOpen(false)} type="button">Keep it</button>}
        right={(
          <button className={phxButtonDangerDenseClassName} disabled={busy || !reason.trim()} onClick={() => void remove()} type="button">
            {busy ? <LoadingSpinner /> : null} Remove
          </button>
        )}
      />
    </div>
  );
}
