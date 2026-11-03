"use client";

import { Camera, CheckCircle2, Loader2, MapPin, TriangleAlert, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  drawEvidenceWatermark,
  getCompressedEvidenceCanvasSize,
  resolveEvidenceLocationStamp,
} from "@/components/outstation/evidence-watermark";
import { JourneyRouteLine, type JourneyRouteLeg } from "@/components/outstation/journey-route-line";
import { prepareTicketAttachment } from "@/components/outstation/prepare-ticket-attachment";
import { TICKET_FILE_ACCEPT } from "@/components/outstation/ticket-upload-card";
import { Input } from "@/components/ui/input";
import {
  phxButtonAccentClassName,
  phxHintClassName,
  phxLabelClassName,
} from "@/components/ui/form-tokens";
import { JOURNEY_STOP_LOCATION_REQUIRED_MESSAGE } from "@/lib/outstation/journey-stop-location";
import { journeyStopEvidenceRefusal, type JourneyStopRule } from "@/lib/outstation/journey-stop-rules";
import { checkTicketAttachmentFile } from "@/lib/outstation/ticket-attachment-limits";
import { usablePosition } from "@/lib/outstation/captured-coordinates";
import { cn } from "@/lib/utils";

/** What the card hands its saver: the fix, and whatever evidence the rule asked for with it. */
export type JourneyStopCapture = {
  accuracyMeters: number | null;
  /** The live photo; null when the rule asks for none. */
  imageDataUrl: string | null;
  latitude: number;
  locationLabel: string | null;
  longitude: number;
  ticketAmount: number;
  /** The ticket's files as they are; only a real stop reads them, a rehearsal sends the count. */
  ticketFiles: File[];
};

/** What a saver reports back: the line to show, the route, and what the employee should know. */
export type JourneyStopSaveResult = {
  flagged: boolean;
  legs?: JourneyRouteLeg[];
  message: string;
  /** False when an accepted claim's payroll figure did not follow the stop. */
  payrollSynced?: boolean | null;
};

/** The real save: the stop joins the employee's own trip (POST /api/outstation/[id]/journey-stop). */
async function saveStopToTrip(
  requestId: number,
  capture: JourneyStopCapture,
  captureKey: string,
): Promise<JourneyStopSaveResult> {
  const tickets = await Promise.all(capture.ticketFiles.map(prepareTicketAttachment));
  const response = await fetch(`/api/outstation/${requestId}/journey-stop`, {
    body: JSON.stringify({
      accuracyMeters: capture.accuracyMeters,
      captureKey,
      imageDataUrl: capture.imageDataUrl,
      latitude: capture.latitude,
      locationLabel: capture.locationLabel,
      longitude: capture.longitude,
      ticketAmount: capture.ticketAmount,
      tickets,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message || `This place could not be saved. Check your connection and try again.`);
  const place = typeof payload?.stopGovernorate === "string" ? payload.stopGovernorate : "The next place";
  return {
    flagged: payload?.flagged === true,
    legs: Array.isArray(payload?.legs) ? (payload.legs as JourneyRouteLeg[]) : undefined,
    message: `${place} is on your journey. ${typeof payload?.modeReason === "string" ? payload.modeReason : ""}`.trim(),
    payrollSynced: typeof payload?.payrollSynced === "boolean" ? payload.payrollSynced : null,
  };
}

/** The one sentence that says what this person does here and what it pays. */
function ruleSentence(rule: JourneyStopRule): string {
  if (rule.photo) {
    return "When you get there, take one live photo. A drive into another governorate over 40 km is paid one way, and so is the drive home from your last place. A place in the same governorate is recorded and changes nothing.";
  }
  if (rule.paysFuel) {
    return "When you get there, capture your location. No photo is needed for your role. A drive into another governorate over 40 km is paid one way, and so is the drive home from your last place.";
  }
  if (rule.ticket === "required") {
    return "When you get there, attach the ticket for this leg and capture your location. The ticket is paid. No fuel is paid on a trip without a car.";
  }
  if (rule.ticket === "none") {
    return "When you get there, capture your location. No photo is needed for your role. Your claim is already accepted, so send this leg's ticket to HR, who add it to the trip. No fuel is paid on a trip without a car.";
  }
  return "When you get there, capture your location. No photo is needed for your role. Attach this leg's ticket if you have one: it is paid when attached. No fuel is paid on a trip without a car.";
}

type CaptureState =
  | { kind: "idle" }
  | { kind: "opening" }
  | { kind: "live" }
  | { kind: "saving" }
  | { kind: "done"; result: JourneyStopSaveResult }
  | { kind: "error"; message: string };

/**
 * The next place of a trip (owner, 2026-11-03: "rebuild the stop from scratch"). One card, and the
 * rule decides what it asks (journey-stop-rules.ts): a live photo, the location alone, or the location
 * and that leg's ticket. The server enforces every one of those again — this card is the usability
 * layer, never the security boundary. The place, its governorate and every distance come from the
 * position on the server; only a ticket's amount is typed.
 *
 * The camera is the departure photo's, deliberately: camera only, no file picker, a fresh GPS fix taken
 * at the shutter (`maximumAge: 0`), the watermark burnt in, and nothing sent without a position.
 */
export function JourneyStopCard({
  acceptedClaim = false,
  employeeHrId,
  onSaved,
  rehearsal,
  requestId,
  rule,
}: {
  /** The claim was accepted when it was submitted, so a stop changes the accepted figure. */
  acceptedClaim?: boolean;
  employeeHrId: string;
  onSaved?: (requestId: number) => void;
  /**
   * A test account's rehearsal (owner, 2026-11-03): the same capture and the same rule, but the stop
   * goes to this saver instead of a trip — its claim was never saved, so there is none.
   */
  rehearsal?: { save: (capture: JourneyStopCapture) => Promise<JourneyStopSaveResult> };
  /** The trip the stop joins; null only for a rehearsal. */
  requestId: number | null;
  rule: JourneyStopRule;
}) {
  const [state, setState] = useState<CaptureState>({ kind: "idle" });
  const [ticketFiles, setTicketFiles] = useState<File[]>([]);
  const [ticketAmount, setTicketAmount] = useState("");
  // One key for one capture, kept through every retry, so a save whose answer was lost finds the stop
  // it already made instead of paying its ticket again. A new one only after a save is confirmed.
  const captureKeyRef = useRef<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // The shutter stays dead until the preview produces frames — a tap before that draws a black
  // 1280x720 JPEG that would upload as valid evidence (the departure card's 2026-08 lesson).
  const [videoReady, setVideoReady] = useState(false);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setVideoReady(false);
  }, []);

  useEffect(() => stopCamera, [stopCamera]);

  // The <video> exists only while live, so the stream is attached after it mounts, never before.
  useEffect(() => {
    if (state.kind !== "live") return;
    const video = videoRef.current;
    const stream = streamRef.current;
    if (!video || !stream) return;
    if (video.srcObject !== stream) video.srcObject = stream;
    void video.play().catch(() => undefined);
  }, [state]);

  const openCamera = useCallback(async () => {
    setVideoReady(false);
    setState({ kind: "opening" });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
      });
      streamRef.current = stream;
      setState({ kind: "live" });
    } catch {
      setState({
        kind: "error",
        message:
          "Camera access was declined. Allow the camera for this website in your browser settings, reload, and try again.",
      });
    }
  }, []);

  const readFix = useCallback(async () => {
    // No location, no stop: the place and every distance come from this position.
    const position = await new Promise<GeolocationPosition | null>((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (value) => resolve(value),
        () => resolve(null),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 12_000 },
      );
    });
    const fix = usablePosition(position?.coords.latitude, position?.coords.longitude);
    if (!fix) throw new Error(JOURNEY_STOP_LOCATION_REQUIRED_MESSAGE);
    const accuracyMeters = position?.coords.accuracy ?? null;
    const location = await resolveEvidenceLocationStamp(
      "/api/outstation/reverse-geocode",
      fix.latitude,
      fix.longitude,
      accuracyMeters,
    );
    return { accuracyMeters, latitude: fix.latitude, location, longitude: fix.longitude };
  }, []);

  const save = useCallback(
    async (capture: JourneyStopCapture) => {
      let result: JourneyStopSaveResult;
      if (rehearsal) {
        result = await rehearsal.save(capture);
      } else if (requestId != null) {
        captureKeyRef.current ??= crypto.randomUUID();
        result = await saveStopToTrip(requestId, capture, captureKeyRef.current);
        captureKeyRef.current = null;
      } else {
        throw new Error("This place has no trip to join.");
      }
      stopCamera();
      setState({ kind: "done", result });
      if (requestId != null) onSaved?.(requestId);
    },
    [onSaved, rehearsal, requestId, stopCamera],
  );

  const takePhoto = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    if (!video.videoWidth || !video.videoHeight) {
      setState({
        kind: "error",
        message: "The camera has not started yet: the preview is still blank. Wait for the picture to appear, then take the photo.",
      });
      return;
    }
    setState({ kind: "saving" });
    try {
      const { height, width } = getCompressedEvidenceCanvasSize(video);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("This browser could not prepare the photo.");
      context.drawImage(video, 0, 0, width, height);
      const { accuracyMeters, latitude, location, longitude } = await readFix();
      await drawEvidenceWatermark(context, canvas, {
        capturedAt: new Date().toISOString(),
        employeeHrId,
        label: "Next place",
        locationLines: location.lines,
        reference: requestId != null ? `Request: ${requestId}` : "Test claim — not saved",
      });
      await save({
        accuracyMeters,
        imageDataUrl: canvas.toDataURL("image/jpeg", 0.74),
        latitude,
        locationLabel: location.label,
        longitude,
        ticketAmount: 0,
        ticketFiles: [],
      });
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : "This place could not be saved." });
    }
  }, [employeeHrId, readFix, requestId, save]);

  const amount = Number(ticketAmount) || 0;
  const ticketProblem = rule.photo
    ? null
    : journeyStopEvidenceRefusal({ hasPhoto: true, rule, ticketAmount: amount, ticketFileCount: ticketFiles.length });

  const captureLocation = useCallback(async () => {
    setState({ kind: "saving" });
    try {
      const { accuracyMeters, latitude, location, longitude } = await readFix();
      await save({
        accuracyMeters,
        imageDataUrl: null,
        latitude,
        locationLabel: location.label,
        longitude,
        ticketAmount: amount,
        ticketFiles,
      });
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : "This place could not be saved." });
    }
  }, [amount, readFix, save, ticketFiles]);

  function pickTicket(list: FileList | null) {
    const picked = Array.from(list ?? []);
    for (const file of picked) {
      const verdict = checkTicketAttachmentFile(file);
      if (!verdict.ok) {
        setTicketFiles([]);
        setState({ kind: "error", message: verdict.message });
        return;
      }
    }
    setTicketFiles(picked);
    setState({ kind: "idle" });
  }

  const busy = state.kind === "opening" || state.kind === "saving";

  if (state.kind === "done") {
    const { result } = state;
    return (
      <section aria-label="The next place" className="border border-slate-200 bg-white p-4 sm:p-5">
        <p className="flex items-start gap-2 text-phx-md font-semibold leading-relaxed text-emerald-700">
          <CheckCircle2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          {result.message}
        </p>
        {result.legs && result.legs.length > 0 ? (
          <div className="mt-3">
            <JourneyRouteLine legs={result.legs} />
          </div>
        ) : null}
        {result.flagged ? (
          <p className="mt-3 flex items-start gap-2 text-phx-md leading-relaxed text-amber-800">
            <TriangleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
            {rehearsal
              ? "On a real trip, the approver would review this journey before it is paid. The reasons are below."
              : acceptedClaim
                ? "This journey is marked on your claim for HR to read."
                : "Your approver will review this journey before it is paid."}
          </p>
        ) : null}
        {result.payrollSynced === false ? (
          <p className="mt-3 flex items-start gap-2 text-phx-md leading-relaxed text-amber-800" role="alert">
            <TriangleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
            Your stop is saved, but the payroll figure did not move with it. Ask HR to check this claim.
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <section aria-label="The next place" className="border border-slate-200 bg-white p-4 sm:p-5">
      <p className="flex flex-wrap items-center gap-2 text-phx-2xs font-black uppercase tracking-[0.18em] text-orange-600">
        <MapPin aria-hidden className="h-3.5 w-3.5" />
        The next place
        {rehearsal ? <span className="text-slate-500">Test account · not saved</span> : null}
      </p>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-700">{ruleSentence(rule)}</p>
      {acceptedClaim && rule.paysFuel ? (
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-700">
          Your claim was accepted when you submitted it, so this changes the amount on it.
        </p>
      ) : null}

      {rule.ticket !== "none" ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="min-w-0">
            <span className={phxLabelClassName}>
              This leg&apos;s ticket{rule.ticket === "optional" ? " (if you have one)" : ""}
            </span>
            <label className="flex min-h-11 cursor-pointer items-center justify-center gap-2 border border-dashed border-orange-400 bg-orange-50 px-3 py-2 text-center text-sm font-bold text-orange-800 transition hover:bg-orange-100">
              <Upload aria-hidden className="h-4 w-4 shrink-0" />
              {ticketFiles.length > 0
                ? `${ticketFiles.length} file${ticketFiles.length === 1 ? "" : "s"} chosen, tap to change`
                : "Take a photo of the ticket or choose a file"}
              <input
                accept={TICKET_FILE_ACCEPT}
                className="hidden"
                disabled={busy}
                multiple
                onChange={(event) => pickTicket(event.target.files)}
                type="file"
              />
            </label>
          </div>
          <div className="min-w-0">
            <label className={phxLabelClassName} htmlFor="journey-stop-ticket-amount">
              What it cost (EGP)
            </label>
            <Input
              disabled={busy}
              id="journey-stop-ticket-amount"
              inputMode="decimal"
              min="0"
              onChange={(event) => setTicketAmount(event.target.value)}
              step="0.01"
              type="number"
              value={ticketAmount}
            />
          </div>
        </div>
      ) : null}

      {rule.photo ? (
        <button
          className={cn(phxButtonAccentClassName, "mt-4 min-h-12 w-full justify-center sm:w-auto")}
          disabled={busy || (state.kind === "live" && !videoReady)}
          onClick={() => {
            if (state.kind === "live") void takePhoto();
            else void openCamera();
          }}
          type="button"
        >
          {busy ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <Camera aria-hidden className="h-4 w-4" />}
          {state.kind === "live"
            ? videoReady
              ? "Take the photo"
              : "Starting the camera…"
            : state.kind === "saving"
              ? "Saving…"
              : state.kind === "opening"
                ? "Opening camera…"
                : "Open camera"}
        </button>
      ) : (
        <button
          className={cn(phxButtonAccentClassName, "mt-4 min-h-12 w-full justify-center sm:w-auto")}
          disabled={busy || ticketProblem !== null}
          onClick={() => void captureLocation()}
          type="button"
        >
          {busy ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <MapPin aria-hidden className="h-4 w-4" />}
          {state.kind === "saving" ? "Saving…" : "Capture my location"}
        </button>
      )}

      {state.kind === "live" ? (
        <div className="mt-3 border border-slate-200 bg-black">
          <video
            className="max-h-[320px] w-full object-contain"
            muted
            onCanPlay={() => setVideoReady(true)}
            onLoadedMetadata={() => setVideoReady(true)}
            onPlaying={() => setVideoReady(true)}
            playsInline
            ref={videoRef}
          />
          {!videoReady ? (
            <p className="bg-slate-900 px-3 py-2 text-center text-phx-xs font-bold text-white">Starting the camera…</p>
          ) : null}
        </div>
      ) : null}

      {state.kind === "error" ? (
        <p className="mt-3 flex items-start gap-2 text-phx-md leading-relaxed text-rose-700" role="alert">
          <TriangleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          {state.message}
        </p>
      ) : null}

      {state.kind === "idle" ? (
        <p className={phxHintClassName}>
          {ticketProblem && ticketFiles.length + amount > 0
            ? ticketProblem
            : "Your location is read where you stand. Without it, the place cannot be saved."}
        </p>
      ) : null}
    </section>
  );
}
