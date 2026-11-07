"use client";

import { CameraOff, FileText, ImageOff, Loader2, MapPin, Paperclip, Route, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { JourneyRouteLine, type JourneyRouteLeg } from "@/components/outstation/journey-route-line";
import {
  phxButtonGhostClassName,
  phxButtonPrimaryClassName,
  phxFieldClassName,
  phxFieldGridTwoClassName,
  phxFormErrorClassName,
  phxHintClassName,
  phxLabelClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import { TripEvidencePhotos } from "@/components/outstation/trip-evidence-photos";
import { ZoomablePhoto } from "@/components/ui/zoomable-photo";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";
import { classifyPhotoFrame, measureImageFrame } from "@/lib/outstation/photo-frame";
import { type TicketTileKind, ticketTileKind, ticketTileLabel } from "@/lib/outstation/ticket-tile";
import type { ApproverTripPhoto } from "@/lib/outstation/trip-evidence-photos";
import type { ApproverTripRoute } from "@/lib/outstation/day-route-line";
import { cn } from "@/lib/utils";

type Ticket = { contentType: string; name: string; url: string };
/** A chained journey's stops and drives (owner rule, 2026-10-18 — chained-journey.ts). */
export type ApproverJourneyStop = {
  accuracyMeters: number | null;
  /** Set when a system administrator added the stop: no photo, his reason. */
  addedByAdmin?: { by: string; reason: string } | null;
  capturedAt: string;
  evidence: "live_photo" | "location" | "location_ticket";
  governorate: string | null;
  /** Where the stop was recorded — optional so a payload from a server built before 2026-11-07
   * still renders, with no pin. */
  latitude?: number | null;
  locationLabel: string | null;
  longitude?: number | null;
  stopNumber: number;
  ticketAmount: number;
  url: string | null;
};
export type ApproverJourney = {
  flagReasons: string[];
  fuelAmount: number | null;
  legs: JourneyRouteLeg[];
  mode: "chained" | "single_destination" | "ticket_journey" | null;
  modeReason: string | null;
  singleDestinationFuelAmount: number | null;
  stops: ApproverJourneyStop[];
};
/** Present when the claim may still take a stop the employee missed (2026-11-03). */
type MissedStopOffer = { nextStopNumber: number; revision: string; tripEndDate: string; tripStartDate: string };
export type AttachmentsData = {
  employeeName: string | null;
  found: boolean;
  journey?: ApproverJourney | null;
  missedStop?: MissedStopOffer | null;
  photos: ApproverTripPhoto[];
  tickets: Ticket[];
  /** Optional so a payload from a server built before 2026-11-07 still renders, with no route. */
  tripRoute?: ApproverTripRoute | null;
};

function egp(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "—" : `EGP ${value.toFixed(2)}`;
}

const STOP_TIME = stableEnGbFormatter({
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  month: "short",
  timeZone: "Africa/Cairo",
});

function cairoDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return STOP_TIME.format(date);
}

/** Every drive of the journey, the flags, and each place's own evidence. */
function TripJourney({ journey }: { journey: ApproverJourney }) {
  return (
    <div className="border border-phx-line bg-white p-3">
      <p className="flex items-center gap-1.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">
        <Route className="h-3.5 w-3.5" /> Journey with {journey.stops.length} added{" "}
        {journey.stops.length === 1 ? "stop" : "stops"}
      </p>
      {journey.modeReason ? <p className="mt-2 text-xs leading-relaxed text-slate-700">{journey.modeReason}</p> : null}
      <div className="mt-2">
        <JourneyRouteLine legs={journey.legs} />
      </div>
      {journey.mode === "ticket_journey" ? (
        <p className="mt-2 text-xs text-slate-600">No fuel: this trip was made by ticket. The tickets are listed below.</p>
      ) : (
        <p className="mt-2 text-xs text-slate-600">
          Fuel {egp(journey.fuelAmount)} · home to the first place and back would be{" "}
          {egp(journey.singleDestinationFuelAmount)}
        </p>
      )}
      {journey.flagReasons.map((reason) => (
        <p className="mt-1.5 flex items-start gap-2 text-xs leading-relaxed text-amber-800" key={reason}>
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {reason}
        </p>
      ))}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {journey.stops.map((stop) => {
          const caption = stop.governorate ?? "Next place";
          return (
            <figure className="min-w-0" key={stop.stopNumber}>
              {stop.addedByAdmin ? (
                <p className="flex min-h-24 items-center gap-2 bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-600">
                  <MapPin className="h-3.5 w-3.5 shrink-0" />
                  <span className="break-words">
                    Added by a system administrator ({stop.addedByAdmin.by}), with no photo: {stop.addedByAdmin.reason}
                  </span>
                </p>
              ) : stop.url ? (
                <ZoomablePhoto alt={caption} caption={caption} className="h-48 w-full bg-slate-100 object-contain" src={stop.url} />
              ) : stop.evidence === "live_photo" ? (
                <p className="flex h-24 items-center justify-center gap-2 bg-slate-50 text-xs text-slate-500">
                  <ImageOff className="h-3.5 w-3.5" /> The photo could not be opened right now.
                </p>
              ) : (
                <p className="text-xs font-bold text-slate-700">
                  {stop.evidence === "location_ticket"
                    ? `Location and ticket, ${egp(stop.ticketAmount)}. No photo is owed.`
                    : "Location only. No photo is owed."}
                </p>
              )}
              <figcaption className="mt-1 break-words text-xs text-slate-600">
                <span className="font-bold text-slate-900">
                  Stop {stop.stopNumber} · {caption}
                </span>
                {` · ${cairoDateTime(stop.capturedAt)}`}
                {stop.locationLabel ? ` · ${stop.locationLabel}` : ""}
                {typeof stop.latitude === "number" && typeof stop.longitude === "number"
                  ? ` · ${stop.latitude.toFixed(5)}, ${stop.longitude.toFixed(5)}`
                  : ""}
                {stop.addedByAdmin
                  ? ""
                  : stop.accuracyMeters !== null
                    ? ` · GPS ±${Math.round(stop.accuracyMeters)} m`
                    : " · GPS accuracy not reported"}
              </figcaption>
            </figure>
          );
        })}
      </div>
    </div>
  );
}

/**
 * A system administrator adds a stop the employee missed (2026-11-03): the employee's own Add stop
 * closes at the end of the trip's last day. The server (addOutstationJourneyStopAsAdmin) re-checks
 * everything, prices the stop exactly like the employee's, marks it as his with the reason, and
 * refuses it if the claim moved since this screen loaded it.
 */
function MissedStopForm({
  offer,
  onAdded,
  requestId,
}: {
  offer: MissedStopOffer;
  onAdded: (notice: string) => void;
  requestId: string;
}) {
  const [open, setOpen] = useState(false);
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [stoppedAtCairo, setStoppedAtCairo] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <div>
        <button className={phxButtonGhostClassName} onClick={() => setOpen(true)} type="button">
          <MapPin className="h-4 w-4" /> Add a missed stop
        </button>
      </div>
    );
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/outstation/${requestId}/journey-stop`, {
        body: JSON.stringify({
          expectedRevision: offer.revision,
          latitude,
          longitude,
          reason,
          stoppedAtCairo,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.message || `The stop could not be added (${response.status}).`);
      const place = typeof payload?.stopGovernorate === "string" ? ` in ${payload.stopGovernorate}` : "";
      onAdded(`Stop ${payload?.stopNumber ?? offer.nextStopNumber}${place} added. ${payload?.modeReason ?? ""}`.trim());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The stop could not be added.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="border border-slate-200 bg-white p-4">
      <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">
        Add stop {offer.nextStopNumber}, missed by the employee
      </p>
      <p className="mt-1 text-xs leading-relaxed text-slate-600">
        For a stop the employee made but could not record before the trip closed. Enter where and
        when it happened, from something you checked. It is priced like the employee&apos;s own stop,
        marked as added by you with your reason, and shown to whoever decides the claim.
      </p>
      <div className={`mt-3 ${phxFieldGridTwoClassName}`}>
        <label>
          <span className={phxLabelClassName}>Latitude</span>
          <input className={phxFieldClassName} inputMode="decimal" onChange={(event) => setLatitude(event.target.value)} placeholder="27.1809" value={latitude} />
        </label>
        <label>
          <span className={phxLabelClassName}>Longitude</span>
          <input className={phxFieldClassName} inputMode="decimal" onChange={(event) => setLongitude(event.target.value)} placeholder="31.1837" value={longitude} />
        </label>
        <label>
          <span className={phxLabelClassName}>Date and time (Cairo)</span>
          <input
            className={phxFieldClassName}
            max={`${offer.tripEndDate}T23:59`}
            min={`${offer.tripStartDate}T00:00`}
            onChange={(event) => setStoppedAtCairo(event.target.value)}
            type="datetime-local"
            value={stoppedAtCairo}
          />
          <span className={phxHintClassName}>
            Inside the trip&apos;s own days, {offer.tripStartDate}
            {offer.tripEndDate !== offer.tripStartDate ? ` to ${offer.tripEndDate}` : ""}.
          </span>
        </label>
        <label>
          <span className={phxLabelClassName}>Reason</span>
          <textarea
            className={phxTextareaClassName}
            onChange={(event) => setReason(event.target.value)}
            placeholder="What you checked, e.g. the CRM visits in Assiut that afternoon"
            rows={2}
            value={reason}
          />
        </label>
      </div>
      {error ? <p className={`mt-3 ${phxFormErrorClassName}`}>{error}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          className={phxButtonPrimaryClassName}
          disabled={saving || !latitude.trim() || !longitude.trim() || !stoppedAtCairo || !reason.trim()}
          onClick={() => void save()}
          type="button"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <MapPin className="h-4 w-4" />}
          {saving ? "Adding…" : "Add the stop"}
        </button>
        <button className={phxButtonGhostClassName} disabled={saving} onClick={() => setOpen(false)} type="button">
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Bulk-xlsx trips use `TRP-*`; only Phoenix-submitted rows are `OUTSTATION-<requestId>`. */
function parseRequestId(tripId: string): string | null {
  const match = /^OUTSTATION-(\d+)$/i.exec(tripId.trim());
  return match ? match[1] : null;
}

/**
 * One ticket or receipt. A thumbnail that fails to load says so and offers the file; a frame with
 * no picture in it says "Blank image" (the same luminance read as the arrival and departure photos,
 * photo-frame.ts); a file the browser cannot draw is a file tile (ticket-tile.ts).
 */
function TicketTile({ kind, label, large, name, url }: { kind: TicketTileKind; label: string; large: boolean; name: string; url: string }) {
  const [failed, setFailed] = useState(false);
  const [frame, setFrame] = useState<{ maxLuminance: number | null; meanLuminance: number | null }>({
    maxLuminance: null,
    meanLuminance: null,
  });
  const blank = classifyPhotoFrame(frame).verdict === "no-image";
  const title = `${name || label} — open in a new tab`;
  return (
    <div
      className={cn(
        "group block overflow-hidden border border-phx-line bg-white transition-colors hover:border-orange-400",
        large ? "min-w-0" : "w-40",
      )}
      data-ticket-tile={kind}
    >
      {kind === "image" && !failed ? (
        // The tile crops the receipt to a 112px strip, so tapping the image opens the full photo
        // rather than following a link — the amount on a receipt cannot be read at this size. The
        // label beneath opens the file in a new tab.
        <ZoomablePhoto
          alt={label}
          caption={name ? `${label} · ${name}` : label}
          // Large: the whole picture, uncropped, on a dark ground like the trip photos — the amount
          // on a receipt must be readable without a click (owner, 2026-11-07: "the photos uploaded
          // from managers I cannot see"). Compact: the 112px strip on the field-work view.
          className={large ? "h-72 w-full bg-slate-900 object-contain" : "h-28 w-full object-cover"}
          onError={() => setFailed(true)}
          onLoad={(event) => setFrame(measureImageFrame(event.currentTarget))}
          src={url}
        />
      ) : (
        <a
          className={cn("flex flex-col items-center justify-center gap-1 bg-slate-50 px-2 text-center text-slate-500", large ? "h-40" : "h-28")}
          href={url}
          rel="noopener noreferrer"
          target="_blank"
          title={title}
        >
          {failed ? <ImageOff className="h-7 w-7" /> : <FileText className="h-7 w-7" />}
          <span className="text-phx-2xs font-bold uppercase tracking-wide">
            {failed ? "Could not load — open the file" : kind === "pdf" ? "PDF" : "File · open it"}
          </span>
        </a>
      )}
      {blank && !failed ? (
        <p className="flex items-center gap-1 border-t border-amber-200 bg-amber-50 px-2 py-1 text-phx-2xs font-bold text-amber-900" data-ticket-blank>
          <ImageOff className="h-3 w-3 shrink-0" />
          Blank image
        </p>
      ) : null}
      <a
        className="block break-words px-2 py-1.5 text-phx-xs font-semibold text-slate-700 group-hover:text-orange-700"
        href={url}
        rel="noopener noreferrer"
        target="_blank"
        title={title}
      >
        {label}
      </a>
    </div>
  );
}

/**
 * Every picture, ticket and receipt the employee uploaded with the claim, numbered "Ticket N".
 * `large` shows each one whole, two to a row; compact is a strip of 160px tiles for the field-work
 * view, where a tap opens the full picture.
 */
export function UploadedPictures({ large, tickets }: { large: boolean; tickets: Ticket[] }) {
  if (tickets.length === 0) return null;
  return (
    <div data-uploaded-pictures={large ? "large" : "compact"}>
      <p className="mb-2 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">
        Uploaded with this claim{" "}
        <span className="tabular-nums text-slate-400">
          · {tickets.length} {tickets.length === 1 ? "picture or file" : "pictures and files"}
        </span>
      </p>
      <div className={large ? "grid gap-3 sm:grid-cols-2 [&>*]:min-w-0" : "flex flex-wrap gap-3"}>
        {tickets.map((ticket, index) => (
          <TicketTile
            key={`ticket-${index}`}
            kind={ticketTileKind(ticket)}
            label={ticketTileLabel(index)}
            large={large}
            name={ticket.name}
            url={ticket.url}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * The arrival and departure photos, then the ticket/receipt pictures & PDFs, for a
 * Phoenix-submitted expense. Bulk-xlsx trips (or trips whose source request was deleted) degrade
 * to a quiet note.
 *
 * The photos used to be one 160px cropped tile labelled "Car evidence", the arrival photo alone:
 * the departure photo was never sent here, and the Super Admin who approves these could not see
 * it (owner, 2026-09-18). Both now render full width through TripEvidencePhotos.
 */
export function TripAttachments({
  onLoaded,
  tripId,
}: {
  /** The payload, once it lands (null on a failure or for a sheet-imported trip) — so the caller
   * can pin the photos and stops on its own map and word its verdict (2026-11-07). */
  onLoaded?: (data: AttachmentsData | null) => void;
  tripId: string;
}) {
  const requestId = parseRequestId(tripId);
  const [reloadKey, setReloadKey] = useState(0);
  // Kept here, not in the form: adding a stop reloads this panel, which unmounts the form.
  const [stopNotice, setStopNotice] = useState<string | null>(null);
  const [state, setState] = useState<{
    status: "idle" | "loading" | "done" | "error";
    data?: AttachmentsData;
    error?: string;
  }>({ status: "idle" });
  const onLoadedRef = useRef(onLoaded);
  useEffect(() => {
    onLoadedRef.current = onLoaded;
  });

  useEffect(() => {
    let cancelled = false;
    async function run() {
      await Promise.resolve();
      if (cancelled) return;
      if (!requestId) {
        onLoadedRef.current?.(null);
        return;
      }
      setState({ status: "loading" });
      try {
        const response = await fetch(`/api/admin/outstation/${requestId}/attachments`, {
          headers: { accept: "application/json" },
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload?.message || `Request failed (${response.status})`);
        if (!cancelled) {
          setState({ data: payload as AttachmentsData, status: "done" });
          onLoadedRef.current?.(payload as AttachmentsData);
        }
      } catch (error) {
        if (!cancelled) {
          setState({ error: error instanceof Error ? error.message : "Failed to load attachments.", status: "error" });
          onLoadedRef.current?.(null);
        }
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [requestId, reloadKey]);

  if (!requestId) {
    return (
      <p className="flex items-center gap-2 text-xs text-slate-400">
        <Paperclip className="h-3.5 w-3.5" /> Uploaded from sheet — no attachment.
      </p>
    );
  }
  if (state.status === "loading" || state.status === "idle") {
    return (
      <p className="flex items-center gap-2 text-xs text-slate-500">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading attachments…
      </p>
    );
  }
  if (state.status === "error" || !state.data) {
    return <p className="text-xs text-rose-600">Couldn&apos;t load attachments: {state.error}</p>;
  }

  const { data } = state;
  if (!data.found) {
    return (
      <p className="flex items-center gap-2 text-xs text-slate-400">
        <ImageOff className="h-3.5 w-3.5" />
        Source request is no longer available.
      </p>
    );
  }

  const photos = Array.isArray(data.photos) ? data.photos : [];
  const tickets = Array.isArray(data.tickets) ? data.tickets : [];
  // A manager who owes no trip photo (evidence-waiver.ts) used to open on two empty "Not required"
  // boxes, with the pictures they DID upload cropped to 112px strips underneath — read as "I cannot
  // see the photos" (owner, 2026-11-07). The pair is now one line, and with no live photo on file the
  // uploads come first, each shown whole.
  const notOwed = photos.length > 0 && photos.every((photo) => !photo.url && Boolean(photo.missingNote?.startsWith("Not required")));
  const anyLivePhoto = photos.some((photo) => Boolean(photo.url));
  const uploads = tickets.length > 0 ? <UploadedPictures large tickets={tickets} /> : null;

  return (
    <div className="space-y-4">
      {anyLivePhoto ? null : uploads}
      {notOwed ? (
        <p className="flex items-start gap-2 text-xs font-semibold text-slate-500" data-photos-not-owed>
          <CameraOff aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0">Arrival and departure photos · {photos[0]?.missingNote}</span>
        </p>
      ) : photos.length > 0 ? (
        <TripEvidencePhotos photos={photos} subject={data.employeeName} />
      ) : null}
      {data.journey ? <TripJourney journey={data.journey} /> : null}
      {stopNotice ? (
        <p className="text-xs leading-relaxed text-emerald-700">
          {stopNotice} Refresh the page before deciding this claim: its figures changed.
        </p>
      ) : null}
      {data.missedStop ? (
        <MissedStopForm
          offer={data.missedStop}
          onAdded={(notice) => {
            setStopNotice(notice);
            setReloadKey((key) => key + 1);
          }}
          requestId={requestId}
        />
      ) : null}
      {anyLivePhoto ? uploads : null}
      {photos.length === 0 && tickets.length === 0 ? (
        <p className="flex items-center gap-2 text-xs text-slate-400">
          <ImageOff className="h-3.5 w-3.5" />
          No attachment on this submission.
        </p>
      ) : null}
    </div>
  );
}
