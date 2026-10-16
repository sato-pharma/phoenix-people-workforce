"use client";

/**
 * Phoenix CRM — the live photo of a clinic's sign or door, with the location taken on the spot.
 *
 * The owner's rule for a customer (2026-09-16): a live photo, the location captured at the place,
 * and the timings. The same capture serves every visit. So there is no gallery button — only the
 * camera — and Open the camera reads the location with it, because a photo without a location
 * proves nothing about a place.
 *
 * Same evidence as every other Phoenix live photo (direct-order storefronts, marketing captures):
 * the time, the street address, the Phoenix brick, area and region and the coordinates are burned
 * into the picture, worded by the shared stamp helpers.
 *
 * The upload slot is asked for when the photo is taken, and the phone's clock is read at that same
 * moment, so the server compares two clocks read seconds apart: a photo taken in a basement with no
 * signal and uploaded twenty minutes later is not marked "phone clock off". A failed upload keeps the
 * photo on the phone and sends it again to the same slot.
 *
 * THE PHOTO'S OWN LOCATION, NEVER SHOWN AS A MEASUREMENT (owner, 2026-09-29, 2026-09-30). The camera
 * reads its own location while it is open, and the shutter reads it again fresh; the photo carries
 * that reading (`shutter*`), burned into the picture too. The Capture-location pin is NOT taken here:
 * it is its own button (capture-location.tsx), so the place is read twice, once by the photo and
 * once by GPS. The server keeps both and fixes the place on the photo's. The rep reads that the
 * photo's location is found and nothing else — no accuracy, no "rough signal", nothing that says a
 * reading is judged (Golden Rule #1). The measurements are the Super Admin's and the SFE Manager's,
 * on the place-move screen.
 */

import type { ReactNode } from "react";
import { BROWSER_PLACEHOLDER } from "@/lib/phoenix-crm/browser-name";
import { readShutterFix, type ShutterFix } from "@/lib/evidence/read-shutter-fix";
import { useEffect, useRef, useState } from "react";
import { Camera, LoaderCircle, LocateFixed, RotateCcw, UploadCloud, X } from "lucide-react";

import { crmPost, messageOf } from "@/components/phoenix-crm/api";
import { noteReading } from "@/components/phoenix-crm/location-reader";
import { reportBlockedPermission } from "@/components/phoenix-crm/report-blocked-permission";
import { CrmButton, CrmNote } from "@/components/phoenix-crm/ui";
import { useBrowserNamed } from "@/components/phoenix-crm/use-browser-name";
import {
  buildEvidenceStampLines,
  fetchEvidenceLocation,
  getCompressedEvidenceCanvasSize,
  readEvidenceLocationStamp,
  wrapWatermarkText,
} from "@/components/outstation/evidence-watermark";
import { ZoomablePhoto } from "@/components/ui/zoomable-photo";
import type { PhotoSlot } from "@/lib/phoenix-crm/view-types";
import { cn } from "@/lib/utils";

/** The bucket takes 2 MB; a 1280-pixel JPEG is usually a few hundred KB. */
const MAX_UPLOAD_BYTES = 1_900_000;
const LOCATION_ENDPOINT = "/api/phoenix-crm/location";
/** A newer reading replaces a sharper one once the sharper one is this old (the person may have moved). */
const FIX_STALE_MS = 15_000;

// ── The guide box ───────────────────────────────────────────────────────────────────────────────
//
// 🔴 THE BOTTOM EDGE IS LOAD-BEARING, NOT A LOOK. The server reads the signboard out of the stored
// photo, and before it can it must crop off `drawStamp`'s caption box — which carries the customer's
// own name, burned in below, and would otherwise be read as the sign. The band's height is
// `stampBandFraction` in src/lib/phoenix-crm/signboard-rules.ts, measured against the two canvas
// shapes `getCompressedEvidenceCanvasSize` produces:
//
//   portrait  720 x 1280 -> 0.18 of the height is stamp, so 0.82 survives
//   landscape 1280 x 720 -> 0.49 of the height is stamp, so 0.51 survives
//
// so a box ending at 0.44 clears the crop in BOTH, with 38 points of room in portrait and 7 in
// landscape. Moving it down silently crops signboards away and reports them as unreadable.
// tests/phoenix-crm-signboard-check.test.ts asserts the clearance for both shapes.
const SIGNBOARD_FRAME_TOP = 0.06;
const SIGNBOARD_FRAME_BOTTOM = 0.44;
const SIGNBOARD_FRAME_SIDE = 0.1;

export type CapturedPhoto = {
  path: string;
  previewUrl: string;
  /** The photo's own reading — the one burned into it. Never the Capture-location pin. */
  lat: number;
  lon: number;
  accuracyMeters: number | null;
  /** The phone's clock when the photo was sent, compared by the server with its own. */
  deviceCapturedAt: string;
  /** The street address the location resolved to, when it resolved. */
  address: string | null;
  /** The part of town the address names (e.g. "Faisal"), offered as the place's zone. */
  zone: string | null;
  locationLabel: string;
  /**
   * The PHOTO’s own position, as the server reads it: a fresh reading taken as the shutter fires,
   * else the camera's own running reading from the moment before (the one stamped on the picture).
   * Both belong to the photo — neither is the Capture-location pin, which is its own button.
   *
   * The fresh read NEVER holds the capture up and never refuses it: capped at 8 s, and when it
   * does not come the camera's own reading stands. Added 2026-09-29 at the owner’s instruction; the
   * camera's reading became the fallback on 2026-09-30, when the pin moved to its own button.
   */
  shutterLat: number | null;
  shutterLon: number | null;
  shutterAccuracyMeters: number | null;
  shutterCapturedAt: string | null;
};

// `releaseCapturedPhoto` lives in captured-photo.ts, a leaf module, so the app shell can free a
// preview without pulling this whole camera into the chunk every Phoenix CRM page loads.

type Fix = { lat: number; lon: number; accuracyMeters: number | null; at: string };

type Shot = {
  blob: Blob;
  previewUrl: string;
  fix: Fix;
  address: string | null;
  zone: string | null;
  locationLabel: string;
  slot: PhotoSlot | null;
  deviceClock: string | null;
  /**
   * The photo's own reading (the fresh shutter read, else the camera's), set in takePhoto and read
   * again in upload.
   *
   * It rides on the Shot rather than in component state because a retake replaces the whole Shot:
   * state would let a fix from the discarded photo attach itself to the new one.
   */
  shutterFix: ShutterFix;
  /** When that reading was taken. */
  shutterCapturedAt: string | null;
};

type Stage = "idle" | "starting" | "live" | "stamping" | "uploading" | "failed";

/** A shutter reading that came back with a position. */
function hasPosition(fix: ShutterFix): fix is ShutterFix & { latitude: number; longitude: number } {
  return fix.latitude !== null && fix.longitude !== null;
}

function canvasJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality));
}

async function jpegUnder(canvas: HTMLCanvasElement, maxBytes: number): Promise<Blob | null> {
  for (const quality of [0.86, 0.74, 0.6]) {
    const blob = await canvasJpeg(canvas, quality);
    if (blob && blob.size <= maxBytes) return blob;
  }
  return null;
}

/** The caption panel, drawn the way the direct-order and marketing captures draw theirs. */
function drawStamp(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement, captions: string[]) {
  const fontSize = Math.max(16, Math.round(canvas.width * 0.022));
  const lineHeight = Math.round(fontSize * 1.38);
  const pad = Math.round(fontSize * 0.75);
  context.font = `${fontSize}px Arial, Helvetica, sans-serif`;
  // Wrapped, never cut: a long street address is the caption most worth reading.
  const lines = captions.flatMap((caption) => wrapWatermarkText(context, caption, canvas.width - pad * 2));
  const boxHeight = lines.length * lineHeight + pad * 2;
  context.fillStyle = "rgba(15,23,42,0.72)";
  context.fillRect(0, canvas.height - boxHeight, canvas.width, boxHeight);
  context.fillStyle = "#ffffff";
  lines.forEach((line, index) => {
    context.fillText(line, pad, canvas.height - boxHeight + pad + lineHeight * (index + 1) - Math.round(lineHeight * 0.28));
  });
}

function textField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** What the rep reads once the location is in: that it is captured, and where — never how well. */
export function capturedLocationText(address: string | null): string {
  return address ? `Location captured · ${address}` : "Location captured";
}

/** Under the photo just taken: that it carries its location, and where — never how well. */
export function photoLocationText(address: string | null): string {
  return address ? `Photo location · ${address}` : "Photo location found";
}

async function sendToSlot(slot: PhotoSlot, blob: Blob): Promise<void> {
  let response: Response;
  try {
    response = await fetch(slot.signedUrl, {
      body: blob,
      headers: { "content-type": "image/jpeg", "x-upsert": "false" },
      method: "PUT",
    });
  } catch {
    throw new Error("No connection. The photo is kept on this phone. Press Upload again when you have internet.");
  }
  if (response.ok) return;
  // An earlier try that arrived but whose answer was lost: the slot already holds this photo.
  const body = await response.text().catch(() => "");
  if (response.status === 409 || /already exists|duplicate/i.test(body)) return;
  throw new Error("The photo did not upload. Press Upload again.");
}

export function LivePhotoCapture({
  disabled = false,
  frameGuide,
  hint,
  onChange,
  purpose,
  seatId,
  test,
  title,
  value,
}: {
  disabled?: boolean;
  /**
   * A guide box drawn over the live camera, with the one line it has to satisfy. Absent means no box.
   *
   * 🔴 IT GUIDES AND NEVER CROPS. `takePhoto` still draws the whole video frame, byte for byte. A crop
   * in the browser is forgeable so it buys no safety; it throws away pixels a Super Admin reading the
   * stored photo may need, because a sign half outside the box is still evidence; and it would change
   * the stored aspect ratio that `getCompressedEvidenceCanvasSize` derives from the source. The box's
   * job is to get the signboard big and HIGH in the frame, which is what the server's reading of it
   * depends on — see SIGNBOARD_FRAME_BOTTOM.
   *
   * A prop rather than a constant inside this component, although Phoenix CRM's place capture is its
   * only caller today: the frame states a REQUIREMENT, and it must not silently become the look of a
   * camera that has no such requirement.
   */
  frameGuide?: { note: string };
  hint?: ReactNode;
  onChange: (photo: CapturedPhoto | null) => void;
  purpose: "place" | "visit";
  seatId: string;
  test: boolean;
  /** The first line burned into the photo, e.g. "Phoenix CRM visit: Dr Ahmed Samir". */
  title: string;
  value: CapturedPhoto | null;
  /**
   * Accepted and ignored since 2026-09-29. It drove the "location is rough" line, which told the rep
   * his reading was being judged (Golden Rule #1). Kept optional so every caller still compiles.
   */
  weakGpsMeters?: number;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const watchRef = useRef<number | null>(null);

  const [stage, setStage] = useState<Stage>("idle");
  const [cameraReady, setCameraReady] = useState(false);
  const [fix, setFix] = useState<Fix | null>(null);
  const [locationNote, setLocationNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shot, setShot] = useState<Shot | null>(null);
  /**
   * The camera's own width/height, read once the stream has metadata.
   *
   * 🔴 WITHOUT IT A PERCENTAGE OVERLAY WOULD NOT MAP TO A PERCENTAGE OF THE CAPTURED FRAME. The video
   * is `object-contain`, so whenever the element's ratio differs from the camera's, the picture is
   * letterboxed inside the element and "44% down the box" is not 44% down the photo — which is
   * precisely the number the server's crop clearance is measured against. Giving the wrapper the
   * camera's own ratio removes the letterbox, so the two agree by construction instead of by luck.
   */
  const [camAspect, setCamAspect] = useState<number | null>(null);
  /**
   * The camera raises its own location and camera refusals, so it names the browser itself — the
   * screens around it name only the SERVER's (use-browser-name.ts). Named at the RENDER rather than
   * at each `setError`, so a message added here later is named too; one without the placeholder
   * passes through untouched.
   */
  const browserNamed = useBrowserNamed();

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      if (watchRef.current !== null && typeof navigator !== "undefined") navigator.geolocation?.clearWatch(watchRef.current);
    };
  }, []);

  function stopCamera() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraReady(false);
  }

  function stopLocation() {
    if (watchRef.current !== null) navigator.geolocation?.clearWatch(watchRef.current);
    watchRef.current = null;
  }

  function startLocation(): boolean {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setError("This phone cannot give a location, so the photo cannot be taken here. Open Phoenix in Chrome or Safari.");
      return false;
    }
    stopLocation();
    setFix(null);
    setLocationNote("Finding your location");
    watchRef.current = navigator.geolocation.watchPosition(
      (position) => {
        noteReading(position);
        const reading: Fix = {
          lat: position.coords.latitude,
          lon: position.coords.longitude,
          accuracyMeters: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
          at: new Date(position.timestamp || Date.now()).toISOString(),
        };
        setLocationNote(null);
        setFix((current) => {
          if (!current || current.accuracyMeters === null) return reading;
          if (reading.accuracyMeters !== null && reading.accuracyMeters <= current.accuracyMeters) return reading;
          return Date.parse(reading.at) - Date.parse(current.at) > FIX_STALE_MS ? reading : current;
        });
      },
      (positionError) => {
        if (positionError.code === positionError.PERMISSION_DENIED) {
          stopLocation();
          stopCamera();
          setStage("idle");
          setLocationNote(null);
          setError(`Location is blocked for ${BROWSER_PLACEHOLDER}. Allow location for this site in its settings, then press Open the camera again.`);
          // After the message and never awaited (report-blocked-permission.ts): the capture ended in
          // the browser, so this row is the only way it reaches the refused-readings board.
          reportBlockedPermission({ permission: "location", seatId, subjectKind: purpose, test });
          return;
        }
        setLocationNote("Still finding your location. Stand outside or near a window");
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 },
    );
    return true;
  }

  async function startCamera() {
    try {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      if (!navigator.mediaDevices?.getUserMedia) throw new DOMException("No camera", "NotSupportedError");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" }, height: { ideal: 1080 }, width: { ideal: 1920 } },
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play();
      }
      setCameraReady(true);
      setStage("live");
    } catch (cameraError) {
      stopCamera();
      stopLocation();
      setStage("idle");
      setLocationNote(null);
      const name = cameraError instanceof DOMException ? cameraError.name : "";
      const blocked = name === "NotAllowedError" || name === "PermissionDeniedError";
      setError(
        blocked
          ? `The camera is blocked for ${BROWSER_PLACEHOLDER}. Allow the camera for this site in its settings, then press Open the camera again.`
          : name === "NotFoundError" || name === "OverconstrainedError"
            ? "No camera was found on this phone."
            : name === "NotSupportedError"
              ? "This browser cannot open the camera. Open Phoenix in Chrome or Safari."
              : "The camera could not start. Close any other app using it, then press Open the camera again.",
      );
      // The camera's own refusal, reported the same way and for the same reason: a blocked camera
      // ends the capture in the browser and reached no board before this line.
      if (blocked) reportBlockedPermission({ permission: "camera", seatId, subjectKind: purpose, test });
    }
  }

  async function start() {
    setError(null);
    if (!startLocation()) return;
    setStage("starting");
    // Opened from the foot of a long form, the camera would otherwise open below the fold. Bring its
    // top up under the page header once the video has taken its place.
    requestAnimationFrame(() => rootRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    await startCamera();
  }

  function cancel() {
    stopCamera();
    stopLocation();
    setLocationNote(null);
    setStage("idle");
  }

  async function upload(current: Shot) {
    setStage("uploading");
    setError(null);
    let working = current;
    try {
      if (!working.slot) {
        const deviceClock = new Date().toISOString();
        const slot = await crmPost<PhotoSlot>("/api/phoenix-crm/photos/upload-slot", { purpose, seatId, test }, "slot");
        working = { ...working, deviceClock, slot };
        setShot(working);
      }
      await sendToSlot(working.slot as PhotoSlot, working.blob);
      setStage("idle");
      setShot(null);
      onChange({
        path: (working.slot as PhotoSlot).path,
        previewUrl: working.previewUrl,
        lat: working.fix.lat,
        lon: working.fix.lon,
        accuracyMeters: working.fix.accuracyMeters,
        deviceCapturedAt: working.deviceClock ?? new Date().toISOString(),
        address: working.address,
        zone: working.zone,
        locationLabel: working.locationLabel,
        shutterAccuracyMeters: working.shutterFix.accuracy,
        shutterCapturedAt: working.shutterCapturedAt,
        shutterLat: working.shutterFix.latitude,
        shutterLon: working.shutterFix.longitude,
      });
    } catch (uploadError) {
      setStage("failed");
      setError(messageOf(uploadError));
    }
  }

  async function takePhoto() {
    const video = videoRef.current;
    if (!cameraReady || !video || video.videoWidth === 0) {
      setError("Wait until the camera shows the picture, then take the photo.");
      return;
    }
    if (!fix) {
      setError("Wait until your location is found, then take the photo.");
      return;
    }
    setError(null);
    const takenAt = new Date().toISOString();
    const usedFix = fix;
    const size = getCompressedEvidenceCanvasSize(video);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) {
      setError("This phone could not prepare the photo. Take it again.");
      return;
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    stopCamera();
    // NOT stopLocation() yet: the watch is what the shutter fix reads from, and killing it first
    // would guarantee a null on every capture.
    setStage("stamping");

    // The stamp's place name is looked up from the CAMERA's running reading (below), never from the
    // shutter's, so the lookup starts NOW and runs while the shutter reading is taken (Phoenix CRM
    // performance audit, 2026-10-16) — the two waits used to stack, up to 8 s and then the lookup.
    // `fetchEvidenceLocation` never throws, so starting it early cannot leave a rejection unhandled.
    const stampLookup = fetchEvidenceLocation(LOCATION_ENDPOINT, usedFix.lat, usedFix.lon, null);

    // The photo’s OWN reading, taken now rather than reused from the watch. Awaited, unlike the
    // marketing camera, because this path already waits for the place-name lookup started above - so
    // it adds no wait the rep can perceive. Capped at 8s by the shared reader and never throwing: a
    // refusal or a timeout leaves it null and the visit saves exactly as before.
    const shutterFix = await readShutterFix();
    stopLocation();
    // The photo's reading: the fresh one when it came, else the camera's own from a moment before.
    // Either is the PHOTO's — the Capture-location pin is a separate button (owner, 2026-09-30).
    // The SHARPER of the two: a one-shot read can come back approximate (iPhone Safari) while the
    // running watch already holds a precise one, and the worse of them must not become the photo's.
    const shutterIsSharper =
      hasPosition(shutterFix) &&
      (usedFix.accuracyMeters === null || (shutterFix.accuracy !== null && shutterFix.accuracy <= usedFix.accuracyMeters));
    const photoFix: Fix = hasPosition(shutterFix) && shutterIsSharper
      ? { lat: shutterFix.latitude, lon: shutterFix.longitude, accuracyMeters: shutterFix.accuracy, at: takenAt }
      : usedFix;

    // The stamp burned into the photo is read by the REP in the preview, so it names the place and the
    // coordinates but never the accuracy (Golden Rule #1 — accuracy is a signal only the Super Admin
    // and the SFE Manager read). The accuracy itself still travels in the saved place, untouched.
    // It burns the CAMERA's running reading with that reading's OWN time beside the shutter time, so
    // the gap between them is legible on the image itself (pinned by capture-trust).
    const payload = await stampLookup;
    const stamp = readEvidenceLocationStamp(payload, usedFix.lat, usedFix.lon, null);
    const detail = payload?.location && typeof payload.location === "object" ? (payload.location as Record<string, unknown>) : null;
    const components = detail?.components && typeof detail.components === "object" ? (detail.components as Record<string, unknown>) : null;

    drawStamp(
      context,
      canvas,
      buildEvidenceStampLines({ capturedAt: takenAt, locationCapturedAt: usedFix.at, locationLines: stamp.lines, title }),
    );
    const blob = await jpegUnder(canvas, MAX_UPLOAD_BYTES);
    if (!blob) {
      setStage("idle");
      setError("This phone could not save the photo. Press Open the camera and take it again.");
      return;
    }
    if (shot) URL.revokeObjectURL(shot.previewUrl);
    const next: Shot = {
      blob,
      previewUrl: URL.createObjectURL(blob),
      fix: usedFix,
      address: textField(detail, "address"),
      zone: textField(components, "area"),
      locationLabel: stamp.label,
      slot: null,
      deviceClock: null,
      shutterFix: { latitude: photoFix.lat, longitude: photoFix.lon, accuracy: photoFix.accuracyMeters },
      shutterCapturedAt: photoFix.at,
    };
    setShot(next);
    await upload(next);
  }

  function retake() {
    if (value) URL.revokeObjectURL(value.previewUrl);
    if (shot) URL.revokeObjectURL(shot.previewUrl);
    setShot(null);
    onChange(null);
    void start();
  }

  const showVideo = !value && (stage === "starting" || stage === "live");
  const previewUrl = value?.previewUrl ?? shot?.previewUrl ?? null;

  // A flex column rather than a grid: the shutter row below is sticky, and a sticky box travels within
  // its container — a flex column is unambiguously that, where a grid row can pin it to its own cell.
  return (
    <div className="flex min-w-0 scroll-mt-20 flex-col gap-3" ref={rootRef}>
      {hint && !value ? <p className="text-sm font-medium leading-6 text-slate-600">{hint}</p> : null}

      {/* The video leaves room under it for the shutter row, the page header and the bottom bar.
          `svh` is the height with a phone browser's toolbars showing, so it never grows under them.

          With a frame guide the HEIGHT BUDGET MOVES from the video's own max-height onto the wrapper's
          max-width, so the wrapper can carry the camera's aspect ratio and lose the letterbox the
          overlay would otherwise be measured against. `mx-auto` keeps it centred and `w-full` plus
          `overflow-hidden` keep it inside the column at 375 px — no horizontal scroll either way. */}
      <div
        className={cn(
          "relative min-w-0 overflow-hidden rounded-none border border-slate-200 bg-slate-950",
          showVideo ? "block" : "hidden",
          frameGuide && camAspect ? "mx-auto w-full" : null,
        )}
        style={
          frameGuide && camAspect
            ? { aspectRatio: String(camAspect), maxWidth: `calc((100svh - 15rem) * ${camAspect})` }
            : undefined
        }
      >
        <video
          autoPlay
          className={cn(
            "block w-full object-contain",
            frameGuide && camAspect ? "h-full" : "max-h-[calc(100svh-15rem)]",
          )}
          muted
          onLoadedMetadata={(event) => {
            const element = event.currentTarget;
            if (element.videoWidth > 0 && element.videoHeight > 0) {
              setCamAspect(element.videoWidth / element.videoHeight);
            }
          }}
          playsInline
          ref={videoRef}
        />
        {/* The requirement, stated where he is looking. Square corners, no pointer target, and a
            single box-shadow for the scrim so the overlay stays one element. */}
        {showVideo && cameraReady && frameGuide ? (
          <div aria-hidden className="pointer-events-none absolute inset-0">
            <div
              className="absolute rounded-none border-2 border-white/90"
              style={{
                bottom: `${(1 - SIGNBOARD_FRAME_BOTTOM) * 100}%`,
                boxShadow: "0 0 0 9999px rgba(2,6,23,0.45)",
                left: `${SIGNBOARD_FRAME_SIDE * 100}%`,
                right: `${SIGNBOARD_FRAME_SIDE * 100}%`,
                top: `${SIGNBOARD_FRAME_TOP * 100}%`,
              }}
            />
            <p
              className="absolute bg-slate-950/75 px-2 py-1 text-center text-xs font-bold leading-5 text-white"
              style={{
                left: `${SIGNBOARD_FRAME_SIDE * 100}%`,
                right: `${SIGNBOARD_FRAME_SIDE * 100}%`,
                top: `calc(${SIGNBOARD_FRAME_BOTTOM * 100}% + 0.5rem)`,
              }}
            >
              {frameGuide.note}
            </p>
          </div>
        ) : null}
        {!cameraReady ? (
          <div className="absolute inset-0 flex items-center justify-center text-sm font-bold text-white/80">
            <LoaderCircle aria-hidden className="mr-2 h-4 w-4 animate-spin" />
            Opening the camera
          </div>
        ) : null}
      </div>

      {showVideo ? (
        // Held on screen while the camera is open: sticky to the bottom, above the portal's bottom
        // navigation on a phone (the app sets --crm-sticky-bottom to its height), so the shutter is
        // always within reach however far down the form the camera was opened.
        <div className="sticky bottom-[var(--crm-sticky-bottom,0px)] z-20 grid gap-2 bg-white py-2 lg:bottom-0">
          {fix ? (
            <p className="flex min-w-0 items-start gap-2 text-sm font-bold text-emerald-700">
              <LocateFixed aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="min-w-0 break-words">Photo location found</span>
            </p>
          ) : (
            <p className="flex min-w-0 items-start gap-2 text-sm font-bold text-slate-600">
              <LoaderCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
              <span className="min-w-0 break-words">{locationNote ?? "Finding your location"}</span>
            </p>
          )}
          {fix && locationNote ? <p className="text-xs font-semibold text-amber-800">{locationNote}</p> : null}
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <CrmButton disabled={disabled || !cameraReady || !fix} onClick={() => void takePhoto()} variant="primary">
              <Camera aria-hidden className="h-4 w-4" />
              Take the photo
            </CrmButton>
            <CrmButton aria-label="Close the camera" onClick={cancel} variant="secondary">
              <X aria-hidden className="h-4 w-4" />
            </CrmButton>
          </div>
        </div>
      ) : null}

      {!value && stage === "idle" ? (
        <CrmButton disabled={disabled} onClick={() => void start()} variant="primary">
          <Camera aria-hidden className="h-4 w-4" />
          Open the camera
        </CrmButton>
      ) : null}

      {!value && (stage === "stamping" || stage === "uploading" || stage === "failed") ? (
        <div className="grid gap-2">
          {previewUrl ? (
            <span className="block w-full overflow-hidden rounded-none border border-slate-200 bg-slate-950">
              <ZoomablePhoto alt="The photo just taken" className="block max-h-[50svh] w-full object-contain" src={previewUrl} />
            </span>
          ) : null}
          {stage === "failed" ? (
            <div className="grid grid-cols-2 gap-2">
              <CrmButton disabled={disabled} onClick={() => shot && void upload(shot)} variant="primary">
                <UploadCloud aria-hidden className="h-4 w-4" />
                Upload again
              </CrmButton>
              <CrmButton disabled={disabled} onClick={retake} variant="secondary">
                <RotateCcw aria-hidden className="h-4 w-4" />
                Take it again
              </CrmButton>
            </div>
          ) : (
            <p className="flex items-center gap-2 text-sm font-bold text-slate-600">
              <LoaderCircle aria-hidden className="h-4 w-4 animate-spin" />
              {stage === "stamping" ? "Adding the place and time to the photo" : "Uploading the photo"}
            </p>
          )}
        </div>
      ) : null}

      {value ? (
        <div className="grid gap-2">
          <span className="block w-full overflow-hidden rounded-none border border-slate-200 bg-slate-950">
            <ZoomablePhoto alt="The live photo" className="block max-h-[50svh] w-full object-contain" src={value.previewUrl} />
          </span>
          <p className="break-words text-xs font-semibold leading-5 text-slate-600">{photoLocationText(value.address)}</p>
          <CrmButton disabled={disabled} onClick={retake} size="sm" variant="secondary">
            <RotateCcw aria-hidden className="h-4 w-4" />
            Take the photo again
          </CrmButton>
        </div>
      ) : null}

      {error ? <CrmNote tone="bad">{browserNamed(error)}</CrmNote> : null}
    </div>
  );
}
