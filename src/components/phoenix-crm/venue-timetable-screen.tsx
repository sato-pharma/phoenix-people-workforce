"use client";

/**
 * Phoenix CRM — photographing a polyclinic's timetable on its own (owner, 2026-10-10).
 *
 * A customer the Super Admin moved into a polyclinic is counted on his visits and held out of the KPIs
 * "until the timetable of the doctor in the polyclinic is updated" — so the rep, standing in the
 * building, photographs the board here, once for the whole building, and every customer seated in it is
 * then read against it. It is also the door for "the timetable changed". Without it a building whose
 * customers were all moved in by the Super Admin would have nobody left to seat and never get a board.
 */

import { useState } from "react";

import { crmPost, crmUrl, messageOf, useCrmGet } from "@/components/phoenix-crm/api";
import { releaseCapturedPhoto } from "@/components/phoenix-crm/captured-photo";
import type { ListNotice, ListScreenBase } from "@/components/phoenix-crm/list-screens";
import { LivePhotoCapture, type CapturedPhoto } from "@/components/phoenix-crm/live-photo-capture";
import type { SharedPlaceChoice } from "@/components/phoenix-crm/shared-place-screens";
import { CrmBackBar, CrmBlock, CrmButton, CrmNote, CrmPanel } from "@/components/phoenix-crm/ui";
import { useBrowserNamed } from "@/components/phoenix-crm/use-browser-name";
import type { AddedVenueTimetable } from "@/lib/phoenix-crm/view-types";

export function VenueTimetableScreen({
  onBack,
  onDone,
  seatId,
  sharedPlaceId,
  test,
}: ListScreenBase & {
  onBack: () => void;
  onDone: (notice: ListNotice) => void;
  sharedPlaceId: string;
}) {
  const browserNamed = useBrowserNamed();
  const venues = useCrmGet<SharedPlaceChoice[]>(crmUrl("/api/phoenix-crm/shared-places", { seatId, test }), "sharedPlaces");
  const venue = venues.data?.find((entry) => entry.sharedPlaceId === sharedPlaceId) ?? null;
  const [photo, setPhoto] = useState<CapturedPhoto | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function save() {
    if (saving || !photo || !venue) return;
    setSaving(true);
    setProblem(null);
    try {
      const result = await crmPost<AddedVenueTimetable>(
        "/api/phoenix-crm/shared-places",
        { action: "timetable", seatId, test, sharedPlaceId, photoPath: photo.path },
        "timetable",
      );
      releaseCapturedPhoto(photo);
      onDone({
        tone: "good",
        title: `Timetable saved: ${venue.name}`,
        message:
          result.validated > 0
            ? `${result.validated === 1 ? "1 customer was" : `${result.validated} customers were`} named on it and now count in the KPIs.`
            : "The system is reading it against each customer in the building. A customer it names counts in the KPIs.",
      });
    } catch (error) {
      setProblem(messageOf(error));
      setSaving(false);
    }
  }

  return (
    <CrmPanel>
      <CrmBackBar backLabel="Customer" onBack={onBack} title="Photograph the timetable" />
      <CrmBlock>
        {venues.error ? (
          <CrmNote tone="bad">{venues.error}</CrmNote>
        ) : !venue ? (
          <p className="text-sm font-medium leading-6 text-slate-600">{venues.loading ? "Loading the building." : "This polyclinic or centre is no longer there."}</p>
        ) : (
          <>
            <p className="break-words text-base font-black text-slate-950">{venue.name}</p>
            <p className="mt-0.5 break-words text-xs font-semibold text-slate-600">
              {venue.schedulePhotoPath
                ? `A timetable is on file (${venue.schedulePhotoCapturedAtText ?? "photographed"}). The photo you take now replaces it, for everybody in this building.`
                : "No timetable is on file yet. One photo of the board on the wall serves everybody seated in this building."}
            </p>
            <div className="mt-3">
              <LivePhotoCapture
                disabled={saving}
                hint="Stand in the building and photograph the timetable so every name on it can be read."
                onChange={setPhoto}
                purpose="place"
                seatId={seatId}
                test={test}
                title={`Phoenix CRM polyclinic: ${venue.name}`}
                value={photo}
              />
            </div>
          </>
        )}
        {problem ? (
          <CrmNote className="mt-3" tone="bad">
            {browserNamed(problem)}
          </CrmNote>
        ) : null}
        <div className="mt-3 grid gap-2 sm:flex sm:flex-wrap">
          <CrmButton busy={saving} disabled={!photo || !venue} onClick={() => void save()} variant="primary">
            Save the timetable
          </CrmButton>
          <CrmButton disabled={saving} onClick={onBack}>
            Cancel
          </CrmButton>
        </div>
      </CrmBlock>
    </CrmPanel>
  );
}
