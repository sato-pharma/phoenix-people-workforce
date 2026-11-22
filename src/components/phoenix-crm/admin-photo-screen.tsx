"use client";

/**
 * Phoenix CRM — the Super Admin validates a customer for a rep with a photo HE uploads: his screen alone.
 *
 * Owner, 2026-11-20: "the system administrator can validate for someone and upload a photo manually instead of
 * the live", then "make a button for me to press on watch the rep while capturing location. And then while this
 * button is on, the rep will capture the location. You will capture his location and put it here."
 *
 * Three steps on one screen: choose the photo; "Watch the rep" (the photo is uploaded and the watch switched on —
 * he phones the rep, who presses Capture location on his List); the rep's reading arrives here with the brick and
 * area it falls in, and "Validate" writes the place. While the watch is on and no reading has come, the screen
 * asks again every `ADMIN_PHOTO_POLL_SECONDS` and stops the moment one arrives. The customer's page offers it only
 * where `view.canPlaceOnTrustedPoint` (the same Super Admin gate), this screen refuses to draw for anyone else, and
 * the server refuses everyone but the Super Admin (server/admin-photo.ts). Golden rule #1: none of it is the rep's.
 *
 * A PHOENIX CAMERA FILE (owner, 20 Nov 2026: the separate camera app for a clinic with no network) is sent as it is
 * — never shrunk, because re-drawing it would break its seal — and the server judges the seal and takes the
 * location from it: no watch, no rep pressing anything. The rep sends it as a WhatsApp Document so it arrives whole.
 */

import { useEffect, useRef, useState, type ChangeEvent } from "react";

import { hasSealTrailer } from "@/lib/phoenix-crm/field-camera/seal-format";

import { crmPost, crmUrl, messageOf, useCrmGet } from "@/components/phoenix-crm/api";
import { customerMetaText } from "@/components/phoenix-crm/labels";
import { ListGone, type ListNotice, type ListScreenBase } from "@/components/phoenix-crm/list-screens";
import { CrmPhotoThumb } from "@/components/phoenix-crm/photo";
import { CrmBackBar, CrmBlock, CrmButton, CrmFacts, CrmLoading, CrmNote, CrmPanel } from "@/components/phoenix-crm/ui";
import { ADMIN_PHOTO_POLL_SECONDS, ADMIN_PHOTO_WATCH_MINUTES } from "@/lib/phoenix-crm/admin-photo-rules";
import { formatDistance } from "@/lib/phoenix-crm/geo";
import type { AdminPhotoApplied, AdminPhotoState } from "@/lib/phoenix-crm/view-types";

const GONE_NOT_ADMIN = "Only the Super Admin validates a customer with an uploaded photo.";
const TITLE = "Validate with my photo";
const ADMIN_PHOTO_URL = "/api/phoenix-crm/list/places/admin-photo";

/** The server refuses a photo over 2 MB; the browser shrinks it below that first. */
const PHOTO_MAX_BYTES = 1_900_000;
const PHOTO_MAX_EDGE = 1600;

function dataUrlBytes(dataUrl: string): number {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return Math.floor((base64.length * 3) / 4);
}

/** Any picture the browser can open, as a JPEG data URL under the server's ceiling. */
async function photoAsJpeg(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("This file is not a picture Phoenix can open. Choose a JPEG or PNG photo."));
      element.src = url;
    });
    let edge = Math.min(PHOTO_MAX_EDGE, Math.max(image.naturalWidth, image.naturalHeight));
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const scale = edge / Math.max(image.naturalWidth, image.naturalHeight);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("This browser cannot prepare the photo. Try Chrome.");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
      if (dataUrlBytes(dataUrl) <= PHOTO_MAX_BYTES) return dataUrl;
      edge = Math.round(edge * 0.8);
    }
    throw new Error("This photo is too large even when shrunk. Choose a smaller one.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

type ChosenPhoto = { dataUrl: string; previewUrl: string; sealed: boolean };

/** A Phoenix Camera file, byte for byte, as a JPEG data URL; null when it carries no seal. */
async function sealedPhotoAsDataUrl(file: File): Promise<string | null> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!hasSealTrailer(bytes)) return null;
  if (bytes.length > PHOTO_MAX_BYTES) throw new Error("This Phoenix Camera photo is larger than Phoenix accepts. Ask the rep to take it again.");
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return `data:image/jpeg;base64,${btoa(binary)}`;
}

export function AdminPhotoScreen(
  props: ListScreenBase & {
    customerId: string;
    onBack: () => void;
    onDone: (notice: ListNotice) => void;
  },
) {
  const { onBack, refreshing, view } = props;
  if (!view.canPlaceOnTrustedPoint) {
    return <ListGone backLabel="Customer" message={GONE_NOT_ADMIN} onBack={onBack} refreshing={refreshing} title={TITLE} />;
  }
  return <AdminPhotoForm {...props} />;
}

function AdminPhotoForm({
  customerId,
  onBack,
  onDone,
  reload,
  view,
}: ListScreenBase & {
  customerId: string;
  onBack: () => void;
  onDone: (notice: ListNotice) => void;
}) {
  const customer = view.customers.find((entry) => entry.customerId === customerId) ?? null;
  const resource = useCrmGet<AdminPhotoState>(crmUrl(ADMIN_PHOTO_URL, { customerId }), "state");
  const [photo, setPhoto] = useState<ChosenPhoto | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const state = resource.data;
  const watch = state?.watch ?? null;
  const waiting = Boolean(watch && watch.status === "watching" && watch.open);
  const { reload: reloadState, replace } = resource;

  // While the watch is on and no reading has come, ask again every few seconds; stop the moment one arrives.
  useEffect(() => {
    if (!waiting) return undefined;
    const timer = window.setInterval(reloadState, ADMIN_PHOTO_POLL_SECONDS * 1000);
    return () => window.clearInterval(timer);
  }, [waiting, reloadState]);

  async function choose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setProblem(null);
    try {
      const sealed = await sealedPhotoAsDataUrl(file);
      if (sealed) {
        setPhoto({ dataUrl: sealed, previewUrl: sealed, sealed: true });
      } else {
        const shrunk = await photoAsJpeg(file);
        setPhoto({ dataUrl: shrunk, previewUrl: shrunk, sealed: false });
      }
    } catch (error) {
      setProblem(messageOf(error));
    }
  }

  async function step(action: "arm" | "rewatch" | "cancel", payload: Record<string, unknown>) {
    if (busy) return;
    setBusy(action);
    setProblem(null);
    try {
      replace(await crmPost<AdminPhotoState>(ADMIN_PHOTO_URL, { action, ...payload }, "state"));
      if (action === "arm") setPhoto(null);
    } catch (error) {
      setProblem(messageOf(error));
      reloadState();
    } finally {
      setBusy(null);
    }
  }

  async function validate() {
    if (busy || !watch) return;
    setBusy("apply");
    setProblem(null);
    try {
      const applied = await crmPost<AdminPhotoApplied>(ADMIN_PHOTO_URL, { action: "apply", validationId: watch.validationId }, "applied");
      const where = [applied.location.brickName ? `Brick ${applied.location.brickName}` : null, applied.location.areaName]
        .filter((part): part is string => Boolean(part))
        .join(" · ");
      onDone({
        tone: "good",
        title: `Validated with your photo: ${applied.customerName}`,
        message: `${where ? `${where}. ` : ""}The place is your photo and the rep's own location. Visits to this customer are measured from it from now on.`,
      });
    } catch (error) {
      setProblem(messageOf(error));
      setBusy(null);
      reload();
      reloadState();
    }
  }

  const reading = watch?.reading ?? null;
  const seal = reading?.seal ?? null;
  const facts = reading
    ? [
        ...(seal
          ? [
              { label: "Location from", value: seal.source },
              { label: "Photo taken", value: seal.takenAtText },
              { label: "Satellites", value: seal.satellites },
              { label: "Phone", value: `${seal.phone} · key ${seal.phoneKey}` },
            ]
          : []),
        { label: seal ? "Sealed by" : "Captured by", value: reading.repName },
        ...(seal ? [] : [{ label: "Captured at", value: reading.capturedAtText }]),
        { label: "Accuracy", value: reading.accuracyMeters === null ? "Not given" : `within ${formatDistance(reading.accuracyMeters)}` },
        { label: "Point", value: `${reading.lat.toFixed(6)}, ${reading.lon.toFixed(6)}` },
        { label: "Brick", value: reading.location.brickName ?? "No Phoenix brick near this point" },
        { label: "Area", value: [reading.location.areaName, reading.location.regionName].filter(Boolean).join(" · ") || "Not resolved" },
        { label: "Address", value: reading.location.address ?? "No address read" },
      ]
    : [];

  return (
    <CrmPanel>
      <CrmBackBar backLabel="Customer" onBack={onBack} title={TITLE} />
      <CrmBlock>
        <p className="break-words text-base font-black text-slate-950" dir="auto">
          {customer?.name ?? state?.customerName ?? "Customer"}
        </p>
        {customer ? <p className="mt-0.5 break-words text-xs font-semibold text-slate-500">{customerMetaText(customer)}</p> : null}
        <CrmNote className="mt-3" tone="info">
          You upload the photo of the place, then press Watch the rep and phone the rep. While the watch is on, the rep opens their List
          and presses Capture location standing at the clinic. Their live location arrives here with its brick and area, and Validate saves
          the place as your photo and their location. Nothing is validated without both.
        </CrmNote>
        <CrmNote className="mt-2" tone="info">
          A photo from the Phoenix Camera app carries its own sealed location and time. Phoenix checks the seal and takes the location from
          it, so the rep does not need to press anything. The rep sends it to you on WhatsApp as a Document, not as a photo, so the seal
          arrives whole.
        </CrmNote>
      </CrmBlock>

      <CrmBlock className="border-t border-slate-100">
        {resource.error ? (
          <CrmNote tone="bad">{resource.error}</CrmNote>
        ) : !state ? (
          <CrmLoading label="Reading this customer" />
        ) : state.blockedReason ? (
          <CrmNote tone="warn">{state.blockedReason}</CrmNote>
        ) : !watch ? (
          <div className="grid min-w-0 gap-3">
            <p className="break-words text-phx-sm font-black uppercase tracking-[0.12em] text-slate-500">1 · The photo</p>
            <input accept="image/*,.jpg,.jpeg" className="hidden" onChange={(event) => void choose(event)} ref={fileInput} type="file" />
            {photo ? (
              // eslint-disable-next-line @next/next/no-img-element -- a local preview of the file just chosen, never a stored photo
              <img alt="The photo you chose" className="max-h-72 w-full border border-slate-200 bg-slate-50 object-contain" src={photo.previewUrl} />
            ) : (
              <p className="break-words text-sm font-medium leading-6 text-slate-600">Choose the photo of the clinic or its signboard.</p>
            )}
            <div className="grid gap-2 sm:flex sm:flex-wrap">
              <CrmButton disabled={Boolean(busy)} onClick={() => fileInput.current?.click()} variant={photo ? "secondary" : "primary"}>
                {photo ? "Choose another photo" : "Choose the photo"}
              </CrmButton>
              {photo ? (
                <CrmButton busy={busy === "arm"} onClick={() => void step("arm", { customerId, imageDataUrl: photo.dataUrl })} variant="primary">
                  {photo.sealed ? "Check the seal and use its location" : "Watch the rep"}
                </CrmButton>
              ) : null}
            </div>
            {photo?.sealed ? (
              <CrmNote tone="info">This photo carries a Phoenix Camera seal. Its location and time are checked when you press the button.</CrmNote>
            ) : null}
            <p className="break-words text-xs font-semibold leading-5 text-slate-500">
              The watch stays on for {ADMIN_PHOTO_WATCH_MINUTES} minutes. Only a location within 250 m of accuracy is accepted from the rep.
            </p>
          </div>
        ) : (
          <div className="grid min-w-0 gap-3">
            <div className="flex min-w-0 items-start gap-3">
              <CrmPhotoThumb alt="Your uploaded photo" path={watch.photoPath} />
              <div className="grid min-w-0 gap-1">
                <p className="break-words text-sm font-black text-slate-950">{seal ? "The sealed photo is uploaded" : "Your photo is uploaded"}</p>
                <p className="break-words text-xs font-semibold leading-5 text-slate-500">
                  {seal
                    ? `Seal checked ${watch.armedAtText}`
                    : `Watch pressed ${watch.armedAtText} · ${watch.open ? `on until ${watch.watchUntilText}` : `ended ${watch.watchUntilText}`}`}
                </p>
              </div>
            </div>
            {reading ? (
              <>
                <p className="break-words text-phx-sm font-black uppercase tracking-[0.12em] text-slate-500">
                  {seal ? "The sealed location" : "The rep’s location"}
                </p>
                <CrmFacts facts={facts} />
                {seal && seal.warnings.length > 0 ? (
                  <CrmNote tone="warn">
                    <span className="grid gap-1">
                      {seal.warnings.map((warning) => (
                        <span className="block break-words" key={warning}>
                          {warning}
                        </span>
                      ))}
                    </span>
                  </CrmNote>
                ) : null}
              </>
            ) : watch.open ? (
              <CrmLoading label="Watching the rep — waiting for their location" />
            ) : (
              <CrmNote tone="warn">The watch ended before the rep&apos;s location came. Press Watch again and phone the rep.</CrmNote>
            )}
            <div className="grid gap-2 sm:flex sm:flex-wrap">
              {reading ? (
                <CrmButton busy={busy === "apply"} disabled={Boolean(busy) && busy !== "apply"} onClick={() => void validate()} variant="primary">
                  Validate
                </CrmButton>
              ) : null}
              {!seal && (reading || !watch.open) ? (
                <CrmButton busy={busy === "rewatch"} disabled={Boolean(busy) && busy !== "rewatch"} onClick={() => void step("rewatch", { validationId: watch.validationId })}>
                  {reading ? "Ask for the location again" : "Watch again"}
                </CrmButton>
              ) : null}
              <CrmButton busy={busy === "cancel"} disabled={Boolean(busy) && busy !== "cancel"} onClick={() => void step("cancel", { validationId: watch.validationId })} variant="ghost">
                Stop watching
              </CrmButton>
            </div>
          </div>
        )}
        {problem ? (
          <CrmNote className="mt-3" tone="bad">
            {problem}
          </CrmNote>
        ) : null}
      </CrmBlock>
    </CrmPanel>
  );
}
