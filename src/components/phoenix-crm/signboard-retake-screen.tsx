"use client";

/**
 * Phoenix CRM — "Retake the signboard photo" for a place the system sent back to its rep (2026-10-18).
 *
 * The audit of the places filed "Not readable" found photos that do not show the customer's name at
 * all — a hospital front, a bare door, a blurred street — and only a new photo of that door can fix
 * one. The rep reads WHY on the place (`signboardRetake`), photographs the nameplate here, and the new
 * photo is read on the spot by the same scanner a new place meets: a photo with no readable name is
 * refused with what to fix, and the third is saved for the Super Admin. The location never moves.
 */

import { useState } from "react";

import { crmPost, errorCodeOf, messageOf } from "@/components/phoenix-crm/api";
import { releaseCapturedPhoto } from "@/components/phoenix-crm/captured-photo";
import type { ListNotice, ListScreenBase } from "@/components/phoenix-crm/list-screens";
import { LivePhotoCapture, type CapturedPhoto } from "@/components/phoenix-crm/live-photo-capture";
import { CrmBackBar, CrmBlock, CrmButton, CrmNote, CrmPanel } from "@/components/phoenix-crm/ui";
import { NAMEPLATE_FRAME_NOTE } from "@/lib/phoenix-crm/entry-rules";

type RetakeSaved = { placeId: string; customerId: string; confirmed: boolean; message: string };

export function SignboardRetakeScreen({
  customerId,
  onBack,
  onDone,
  placeId,
  refreshing,
  seatId,
  test,
  view,
}: ListScreenBase & {
  customerId: string;
  onBack: () => void;
  onDone: (notice: ListNotice) => void;
  placeId: string;
}) {
  const customer = view.customers.find((entry) => entry.customerId === customerId) ?? null;
  const place = customer?.places.find((entry) => entry.placeId === placeId) ?? null;
  const [photo, setPhoto] = useState<CapturedPhoto | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function save() {
    if (saving || !photo || !place) return;
    setSaving(true);
    setProblem(null);
    try {
      const saved = await crmPost<RetakeSaved>(
        "/api/phoenix-crm/list/places/signboard",
        {
          placeId,
          seatId,
          test,
          photoPath: photo.path,
          shutterLat: photo.shutterLat,
          shutterLon: photo.shutterLon,
          shutterAccuracyMeters: photo.shutterAccuracyMeters,
          shutterCapturedAt: photo.shutterCapturedAt,
        },
        "place",
      );
      releaseCapturedPhoto(photo);
      onDone({ tone: saved.confirmed ? "good" : "info", title: `New signboard photo saved: ${customer?.name ?? "customer"}`, message: saved.message });
    } catch (error) {
      // A photo the scanner refused (or a slot that cannot be used again) is spent: the rep reads why,
      // and the camera opens again for the next try.
      if ((errorCodeOf(error) ?? "").startsWith("phoenix_crm_photo_")) {
        releaseCapturedPhoto(photo);
        setPhoto(null);
      }
      setProblem(messageOf(error));
      setSaving(false);
    }
  }

  if (!customer || !place || !place.signboardRetake || !view.canEdit) {
    return (
      <CrmPanel>
        <CrmBackBar backLabel="Customer" onBack={onBack} title="Retake the signboard photo" />
        <CrmBlock>
          <p className="text-sm font-medium leading-6 text-slate-600">
            {refreshing ? "Loading the list." : "This place is not waiting for a new signboard photo."}
          </p>
        </CrmBlock>
      </CrmPanel>
    );
  }

  return (
    <CrmPanel>
      <CrmBackBar backLabel="Customer" onBack={onBack} title="Retake the signboard photo" />
      <CrmBlock>
        <p className="break-words text-base font-black text-slate-950">
          <span dir="auto">{customer.name}</span>
        </p>
        {place.address ? <p className="mt-0.5 break-words text-xs font-semibold text-slate-600">{place.address}</p> : null}
        <CrmNote className="mt-3" title="Why a new photo is needed" tone="warn">
          {place.signboardRetake}
        </CrmNote>
        <div className="mt-3">
          <LivePhotoCapture
            disabled={saving}
            frameGuide={{ note: NAMEPLATE_FRAME_NOTE }}
            hint="Stand at this place's own door and photograph the customer's nameplate, close enough that the name fills the box. The location stays as it was validated."
            onChange={(next) => {
              setPhoto(next);
              setProblem(null);
            }}
            purpose="place"
            seatId={seatId}
            test={test}
            title={`Phoenix CRM customer: ${customer.name}`}
            value={photo}
          />
        </div>
        {problem ? (
          <CrmNote className="mt-3" tone="bad">
            {problem}
          </CrmNote>
        ) : null}
        <div className="mt-3 grid gap-2 sm:flex sm:flex-wrap">
          <CrmButton busy={saving} disabled={!photo} onClick={() => void save()} variant="primary">
            Save the new photo
          </CrmButton>
          <CrmButton disabled={saving} onClick={onBack}>
            Cancel
          </CrmButton>
        </div>
      </CrmBlock>
    </CrmPanel>
  );
}
