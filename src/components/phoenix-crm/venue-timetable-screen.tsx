"use client";

/**
 * Phoenix CRM — photographing a polyclinic's timetable on its own (owner, 2026-10-10).
 *
 * A customer the Super Admin moved into a polyclinic is counted on his visits and held out of the KPIs
 * "until the timetable of the doctor in the polyclinic is updated" — so the rep, standing in the
 * building, photographs the board here, once for the whole building, and every customer seated in it is
 * then read against it. It is also the door for "the timetable changed". Without it a building whose
 * customers were all moved in by the Super Admin would have nobody left to seat and never get a board.
 *
 * 🔴 A BOARD ON FILE IS ADDED TO OR REPLACED, HIS CHOICE (owner, 25 Nov 2026: "The timetable uploaded is
 * already correct. I don't want to replace it ... replace the current timetable or ... add to what
 * exists"). `mode: "add"` keeps every photo on file and adds the new ones after them.
 */

import { useState } from "react";

import { crmPost, crmUrl, messageOf, useCrmGet } from "@/components/phoenix-crm/api";
import { releaseCapturedPhoto } from "@/components/phoenix-crm/captured-photo";
import type { ListNotice, ListScreenBase } from "@/components/phoenix-crm/list-screens";
import { LivePhotoCapture, type CapturedPhoto } from "@/components/phoenix-crm/live-photo-capture";
import type { SharedPlaceChoice } from "@/components/phoenix-crm/shared-place-screens";
import {
  releaseTimetableExtras,
  TimetableExtraPhotos,
  timetableExtraPaths,
  type TimetableExtraSlots,
} from "@/components/phoenix-crm/timetable-extra-photos";
import { CrmBackBar, CrmBlock, CrmButton, CrmNote, CrmPanel } from "@/components/phoenix-crm/ui";
import { useBrowserNamed } from "@/components/phoenix-crm/use-browser-name";
import {
  TIMETABLE_ADD_TO_ON_FILE,
  TIMETABLE_ADD_TO_ON_FILE_NOTE,
  TIMETABLE_FULL,
  timetablePhotosLeft,
} from "@/lib/phoenix-crm/timetable-pages-rules";
import type { AddedVenueTimetable, AddedVenueTimetablePages } from "@/lib/phoenix-crm/view-types";

export function VenueTimetableScreen({
  mode = "replace",
  onBack,
  onDone,
  seatId,
  sharedPlaceId,
  test,
}: ListScreenBase & {
  /** "add": new photos after the ones on file. "replace": a fresh timetable, or the first one. */
  mode?: "add" | "replace";
  onBack: () => void;
  onDone: (notice: ListNotice) => void;
  sharedPlaceId: string;
}) {
  const browserNamed = useBrowserNamed();
  const venues = useCrmGet<SharedPlaceChoice[]>(crmUrl("/api/phoenix-crm/shared-places", { seatId, test }), "sharedPlaces");
  const venue = venues.data?.find((entry) => entry.sharedPlaceId === sharedPlaceId) ?? null;
  const [photo, setPhoto] = useState<CapturedPhoto | null>(null);
  // Its other photos, when the board does not fit one (owner, 25 Nov 2026).
  const [extras, setExtras] = useState<TimetableExtraSlots>([]);
  // The photos ADDED to the board on file; the first camera is open from the start.
  const [added, setAdded] = useState<TimetableExtraSlots>([null]);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Adding needs a board on file; a building with none is photographed whole whatever was pressed.
  const adding = mode === "add" && Boolean(venue?.schedulePhotoPath);
  const photosOnFile = Math.max(1, venue?.timetablePhotos ?? 1);
  const photosLeft = timetablePhotosLeft(photosOnFile);
  const addedPaths = timetableExtraPaths(added);

  async function saveAdded() {
    if (saving || !venue || addedPaths.length === 0) return;
    setSaving(true);
    setProblem(null);
    try {
      const result = await crmPost<AddedVenueTimetablePages>(
        "/api/phoenix-crm/shared-places",
        { action: "timetable_pages", seatId, test, sharedPlaceId, addedPhotoPaths: addedPaths },
        "timetablePages",
      );
      releaseTimetableExtras(added);
      onDone({
        tone: "good",
        title: `Added to the timetable: ${venue.name}`,
        message:
          result.validated > 0
            ? `${result.validated === 1 ? "1 customer was" : `${result.validated} customers were`} named on it and now count in the KPIs.`
            : "The photos on file stay. The system is reading the timetable against each customer still waiting in the building.",
      });
    } catch (error) {
      setProblem(messageOf(error));
      setSaving(false);
    }
  }

  async function save() {
    if (adding) return saveAdded();
    if (saving || !photo || !venue) return;
    setSaving(true);
    setProblem(null);
    try {
      const result = await crmPost<AddedVenueTimetable>(
        "/api/phoenix-crm/shared-places",
        { action: "timetable", seatId, test, sharedPlaceId, photoPath: photo.path, extraPhotoPaths: timetableExtraPaths(extras) },
        "timetable",
      );
      releaseCapturedPhoto(photo);
      releaseTimetableExtras(extras);
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
      <CrmBackBar backLabel="Customer" onBack={onBack} title={adding ? TIMETABLE_ADD_TO_ON_FILE : "Photograph the timetable"} />
      <CrmBlock>
        {venues.error ? (
          <CrmNote tone="bad">{venues.error}</CrmNote>
        ) : !venue ? (
          <p className="text-sm font-medium leading-6 text-slate-600">{venues.loading ? "Loading the building." : "This polyclinic or centre is no longer there."}</p>
        ) : adding ? (
          <>
            <p className="break-words text-base font-black text-slate-950">{venue.name}</p>
            <p className="mt-0.5 break-words text-xs font-semibold text-slate-600">{TIMETABLE_ADD_TO_ON_FILE_NOTE}</p>
            {photosLeft === 0 ? (
              <CrmNote className="mt-3" tone="info">
                {TIMETABLE_FULL}
              </CrmNote>
            ) : (
              <TimetableExtraPhotos
                disabled={saving}
                max={photosLeft}
                onChange={setAdded}
                seatId={seatId}
                startAt={photosOnFile + 1}
                test={test}
                title={`Phoenix CRM polyclinic: ${venue.name}`}
                value={added}
              />
            )}
          </>
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
              {photo ? (
                <TimetableExtraPhotos
                  disabled={saving}
                  onChange={setExtras}
                  seatId={seatId}
                  test={test}
                  title={`Phoenix CRM polyclinic: ${venue.name}`}
                  value={extras}
                />
              ) : null}
            </div>
          </>
        )}
        {problem ? (
          <CrmNote className="mt-3" tone="bad">
            {browserNamed(problem)}
          </CrmNote>
        ) : null}
        <div className="mt-3 grid gap-2 sm:flex sm:flex-wrap">
          <CrmButton busy={saving} disabled={!venue || (adding ? addedPaths.length === 0 : !photo)} onClick={() => void save()} variant="primary">
            {adding ? "Add to the timetable" : "Save the timetable"}
          </CrmButton>
          <CrmButton disabled={saving} onClick={onBack}>
            Cancel
          </CrmButton>
        </div>
      </CrmBlock>
    </CrmPanel>
  );
}
