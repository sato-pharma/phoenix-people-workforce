"use client";

/**
 * Phoenix CRM — a pharmacy's own location and its responsible person's phone.
 *
 * Owner, 2026-10-09: "visiting pharmacy or adding a new pharmacy, make it optional to add its
 * location by a pin button … optional, if you want to save its location do this, if you want also
 * don't do this. And also make optional to add the responsible person's phone number. And of course,
 * when he captured the location, the location is then cleaned and separated into area, brick,
 * government."
 *
 * Two things live here:
 *
 *   - `PharmacyExtras` — the pin button and the phone box, used by Add a pharmacy (where both are
 *     optional extras under the name) and by this screen (where they are the whole point);
 *   - `PharmacyDetailsScreen` — setting, correcting or clearing them on a pharmacy already on his
 *     list, opened from the pharmacy's own page and from the Pharmacy visit picker.
 *
 * 🔴 THE PIN IS A RECORD, NEVER A CHECK. A pharmacy needs no validation (owner, 2026-10-03), so
 * there is no photo, no second reading and nothing measured: no visit is compared with this point, no
 * approval waits on it and no KPI reads it. The rep is shown WHERE it is — the governorate, the area
 * and the brick the server read off his pin — and never how good his reading was (Golden Rule #1).
 */

import { useState } from "react";
import { MapPin } from "lucide-react";

import { crmPost, messageOf } from "@/components/phoenix-crm/api";
import { CaptureLocation, type CapturedPin } from "@/components/phoenix-crm/capture-location";
import { CustomerPhoneField } from "@/components/phoenix-crm/customer-phone";
import { CrmBackBar, CrmBlock, CrmButton, CrmFacts, CrmNote, CrmPanel } from "@/components/phoenix-crm/ui";
import { useBrowserNamed } from "@/components/phoenix-crm/use-browser-name";

/** What a pinned pharmacy reads as, on every screen that shows one. */
export type PharmacyPinRead = {
  address: string | null;
  governorate: string | null;
  areaName: string | null;
  brickName: string | null;
};

/** The pharmacy this screen is about, as both the List and the visit picker can describe it. */
export type PharmacyDetailsTarget = {
  customerId: string;
  name: string;
  phone: string | null;
  pin: PharmacyPinRead | null;
};

/** What the server answered. */
export type PharmacyDetailsSaved = { customerId: string; customerName: string; phone: string | null; pinned: boolean };

/**
 * The pharmacy's location, as it stands — the governorate, the area and the brick the server resolved
 * from the pin, and the clean address under them. Nothing when it has never been pinned.
 *
 * A fact is listed only when it HAS a value: a pin in the desert really has no Phoenix brick, and an
 * empty "Brick" box beside a filled governorate reads as a fault in the system rather than as the
 * honest answer. The address sits last because it is the courtesy, not the record.
 */
export function PharmacyLocationFacts({ pin }: { pin: PharmacyPinRead | null }) {
  if (!pin) return null;
  const facts = [
    { label: "Governorate", value: pin.governorate },
    { label: "Area", value: pin.areaName },
    { label: "Brick", value: pin.brickName },
    { label: "Address", value: pin.address },
  ].filter((fact): fact is { label: string; value: string } => Boolean(fact.value));
  if (facts.length === 0) return null;
  return <CrmFacts facts={facts} />;
}

/** One quiet line: the pharmacy's place in words, for a card that has no room for a fact grid. */
export function pharmacyWhereLine(pin: PharmacyPinRead | null): string | null {
  if (!pin) return null;
  const parts = [pin.governorate, pin.areaName, pin.brickName].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : pin.address;
}

/**
 * The pin button and the phone box, as every pharmacy screen asks for them.
 *
 * `saved` is what is already on file, so a rep who opens this to correct the phone sees the location
 * he pinned last week rather than an empty button that looks like it was never done.
 */
export function PharmacyExtras({
  disabled,
  idPrefix,
  onPhone,
  onPin,
  phone,
  pin,
  saved,
}: {
  disabled: boolean;
  idPrefix: string;
  onPhone: (next: string) => void;
  onPin: (next: CapturedPin | null) => void;
  phone: string;
  /** What he has captured on THIS screen; null until he presses the button. */
  pin: CapturedPin | null;
  saved: PharmacyPinRead | null;
}) {
  return (
    <div className="grid min-w-0 gap-3">
      {saved && !pin ? (
        <div className="grid min-w-0 gap-2">
          <p className="flex min-w-0 items-start gap-2 text-sm font-bold text-slate-700">
            <MapPin aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
            <span className="min-w-0 break-words">Its location is saved.</span>
          </p>
          <PharmacyLocationFacts pin={saved} />
        </div>
      ) : null}
      <CaptureLocation disabled={disabled} onChange={onPin} value={pin} where="pharmacy" />
      <CustomerPhoneField
        disabled={disabled}
        hint="Optional. Empty the box to remove it."
        id={`${idPrefix}-phone`}
        label="Responsible person's phone"
        onChange={onPhone}
        value={phone}
      />
    </div>
  );
}

export function PharmacyDetailsScreen({
  backLabel,
  onBack,
  onSaved,
  pharmacy,
  seatId,
  test,
}: {
  backLabel: string;
  onBack: () => void;
  onSaved: (saved: PharmacyDetailsSaved) => void;
  pharmacy: PharmacyDetailsTarget;
  seatId: string;
  test: boolean;
}) {
  const browserNamed = useBrowserNamed();
  const [phone, setPhone] = useState(pharmacy.phone ?? "");
  const [pin, setPin] = useState<CapturedPin | null>(null);
  // Pressed "Remove the saved location": the pin key is then sent as null, which is how it is cleared.
  const [removing, setRemoving] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function save() {
    if (saving) return;
    setSaving(true);
    setProblem(null);
    try {
      const saved = await crmPost<PharmacyDetailsSaved>(
        "/api/phoenix-crm/list/pharmacy-details",
        {
          seatId,
          test,
          customerId: pharmacy.customerId,
          // The phone is always named, so emptying the box clears it.
          phone,
          // The pin is named only when he changed it: a screen that sends `pin: null` because he did
          // not press the button would wipe the location he saved yesterday.
          ...(pin ? { pin } : removing ? { pin: null } : {}),
        },
        "result",
      );
      onSaved(saved);
    } catch (error) {
      setProblem(messageOf(error));
      setSaving(false);
    }
  }

  const savedPin = removing ? null : pharmacy.pin;

  return (
    <CrmPanel>
      <CrmBackBar backLabel={backLabel} onBack={onBack} title="Where it is, and who to call" />
      <CrmBlock>
        <p className="min-w-0 break-words text-base font-black text-slate-900" dir="auto">
          {pharmacy.name}
        </p>
        <CrmNote className="mt-3" title="Both are optional" tone="info">
          Save the pharmacy&apos;s location only if you want to. Stand in the pharmacy and press Capture location, and Phoenix works out its
          governorate, area and brick by itself. There is no photo and no approval here.
        </CrmNote>
      </CrmBlock>
      <CrmBlock className="border-t border-slate-100" title="Its location and phone">
        <PharmacyExtras
          disabled={saving}
          idPrefix="phoenix-crm-pharmacy-details"
          onPhone={(next) => {
            setPhone(next);
            setProblem(null);
          }}
          onPin={(next) => {
            setPin(next);
            if (next) setRemoving(false);
            setProblem(null);
          }}
          phone={phone}
          pin={pin}
          saved={savedPin}
        />
        {savedPin || removing ? (
          <div className="mt-3 grid gap-2 sm:flex sm:flex-wrap">
            {savedPin ? (
              <CrmButton disabled={saving} onClick={() => setRemoving(true)} size="sm">
                Remove the saved location
              </CrmButton>
            ) : (
              <p className="text-sm font-medium leading-6 text-slate-600">
                Its saved location will be removed when you save. Press Capture location to put a new one instead.
              </p>
            )}
          </div>
        ) : null}
      </CrmBlock>
      <CrmBlock className="border-t border-slate-100">
        {problem ? (
          <CrmNote className="mb-3" tone="bad">
            {browserNamed(problem)}
          </CrmNote>
        ) : null}
        <div className="grid gap-2 sm:flex sm:flex-wrap">
          <CrmButton busy={saving} onClick={() => void save()} variant="primary">
            Save
          </CrmButton>
          <CrmButton disabled={saving} onClick={onBack}>
            Cancel
          </CrmButton>
        </div>
      </CrmBlock>
    </CrmPanel>
  );
}
