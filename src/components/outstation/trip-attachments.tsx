"use client";

import { FileText, ImageOff, Loader2, MapPin, Paperclip, Route, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
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
import type { ApproverTripPhoto } from "@/lib/outstation/trip-evidence-photos";

type Ticket = { contentType: string; name: string; url: string };
/** A chained journey's stops and drives (owner rule, 2026-10-18 — chained-journey.ts). */
type ApproverJourney = {
  flagReasons: string[];
  fuelAmount: number | null;
  legs: Array<{ distanceKm: number | null; from: string; paid: boolean; reason: string; to: string }>;
  modeReason: string | null;
  singleDestinationFuelAmount: number | null;
  stops: Array<{
    accuracyMeters: number | null;
    /** Set when a system administrator added the stop: no photo, his reason. */
    addedByAdmin?: { by: string; reason: string } | null;
    capturedAt: string;
    governorate: string | null;
    locationLabel: string | null;
    stopNumber: number;
    url: string | null;
  }>;
};
/** Present when the claim may still take a stop the employee missed (2026-11-03). */
type MissedStopOffer = { nextStopNumber: number; revision: string; tripEndDate: string; tripStartDate: string };
type AttachmentsData = {
  employeeName: string | null;
  found: boolean;
  journey?: ApproverJourney | null;
  missedStop?: MissedStopOffer | null;
  photos: ApproverTripPhoto[];
  tickets: Ticket[];
};

const LEG_REASON: Record<string, string> = {
  different_governorates: "another governorate, over 40 km",
  distance_unknown: "no road distance",
  governorate_unknown: "governorate unknown",
  same_governorate: "same governorate",
  under_minimum_km: "40 km or less",
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

/** Every drive of the journey, the flags, and each stop's own live photo. */
function TripJourney({ journey }: { journey: ApproverJourney }) {
  return (
    <div className="border border-phx-line bg-white p-3">
      <p className="flex items-center gap-1.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">
        <Route className="h-3.5 w-3.5" /> Journey with {journey.stops.length} added{" "}
        {journey.stops.length === 1 ? "stop" : "stops"}
      </p>
      {journey.modeReason ? <p className="mt-2 text-xs leading-relaxed text-slate-700">{journey.modeReason}</p> : null}
      <ul className="mt-2 space-y-1 text-xs text-slate-600">
        {journey.legs.map((leg, index) => (
          <li className="flex flex-wrap justify-between gap-x-3" key={`${index}-${leg.from}`}>
            <span className="min-w-0 break-words">
              {leg.from} → {leg.to}
              {leg.distanceKm !== null ? ` · ${leg.distanceKm} km` : ""}
            </span>
            <span className={`font-bold ${leg.paid ? "text-emerald-700" : "text-slate-500"}`}>
              {leg.paid ? "Paid" : `Not paid · ${LEG_REASON[leg.reason] ?? leg.reason}`}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-slate-600">
        Fuel {egp(journey.fuelAmount)} · home to first destination and back would be{" "}
        {egp(journey.singleDestinationFuelAmount)}
      </p>
      {journey.flagReasons.map((reason) => (
        <p className="mt-1.5 flex items-start gap-2 text-xs leading-relaxed text-amber-800" key={reason}>
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {reason}
        </p>
      ))}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {journey.stops.map((stop) => {
          const caption = `Stop ${stop.stopNumber}${stop.governorate ? ` · ${stop.governorate}` : ""}`;
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
              ) : (
                <p className="flex h-24 items-center justify-center gap-2 bg-slate-50 text-xs text-slate-500">
                  <ImageOff className="h-3.5 w-3.5" /> The photo could not be opened right now.
                </p>
              )}
              <figcaption className="mt-1 break-words text-xs text-slate-600">
                <span className="font-bold text-slate-900">{caption}</span>
                {` · ${cairoDateTime(stop.capturedAt)}`}
                {stop.locationLabel ? ` · ${stop.locationLabel}` : ""}
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

function isPdf(ticket: Ticket): boolean {
  return /pdf/i.test(ticket.contentType) || /\.pdf(\?|$)/i.test(ticket.url);
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
export function TripAttachments({ tripId }: { tripId: string }) {
  const requestId = parseRequestId(tripId);
  const [reloadKey, setReloadKey] = useState(0);
  // Kept here, not in the form: adding a stop reloads this panel, which unmounts the form.
  const [stopNotice, setStopNotice] = useState<string | null>(null);
  const [state, setState] = useState<{
    status: "idle" | "loading" | "done" | "error";
    data?: AttachmentsData;
    error?: string;
  }>({ status: "idle" });

  useEffect(() => {
    let cancelled = false;
    async function run() {
      await Promise.resolve();
      if (cancelled || !requestId) return;
      setState({ status: "loading" });
      try {
        const response = await fetch(`/api/admin/outstation/${requestId}/attachments`, {
          headers: { accept: "application/json" },
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload?.message || `Request failed (${response.status})`);
        if (!cancelled) setState({ data: payload as AttachmentsData, status: "done" });
      } catch (error) {
        if (!cancelled) {
          setState({ error: error instanceof Error ? error.message : "Failed to load attachments.", status: "error" });
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
  const items = data.tickets.map((ticket, index) => ({
    isPdf: isPdf(ticket),
    key: `ticket-${index}`,
    label: ticket.name || `Ticket ${index + 1}`,
    url: ticket.url,
  }));

  return (
    <div className="space-y-4">
      {photos.length > 0 ? <TripEvidencePhotos photos={photos} subject={data.employeeName} /> : null}
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
      {items.length > 0 ? (
        <div>
          <p className="mb-2 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">Tickets and receipts</p>
          <div className="flex flex-wrap gap-3">
            {items.map((item) => (
              <a
                className="group block w-40 overflow-hidden border border-phx-line bg-white transition-colors hover:border-orange-400"
                href={item.url}
                key={item.key}
                rel="noopener noreferrer"
                target="_blank"
                title={`${item.label} — open in a new tab`}
              >
                {item.isPdf ? (
                  <div className="flex h-28 flex-col items-center justify-center gap-1 bg-slate-50 text-slate-500">
                    <FileText className="h-7 w-7" />
                    <span className="text-phx-2xs font-bold uppercase tracking-wide">PDF</span>
                  </div>
                ) : (
                  // The tile crops the receipt to a 112px strip, so tapping the image opens the full
                  // photo rather than following the anchor — the amount on a receipt cannot be read at
                  // this size. The label beneath still opens the file in a new tab.
                  <ZoomablePhoto alt={item.label} caption={item.label} className="h-28 w-full object-cover" src={item.url} />
                )}
                <p className="break-words px-2 py-1.5 text-phx-xs font-semibold text-slate-700 group-hover:text-orange-700">
                  {item.label}
                </p>
              </a>
            ))}
          </div>
        </div>
      ) : null}
      {photos.length === 0 && items.length === 0 ? (
        <p className="flex items-center gap-2 text-xs text-slate-400">
          <ImageOff className="h-3.5 w-3.5" />
          No attachment on this submission.
        </p>
      ) : null}
    </div>
  );
}
