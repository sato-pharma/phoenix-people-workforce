"use client";

import { FileText, ImageOff, Loader2, Paperclip } from "lucide-react";
import { useEffect, useState } from "react";
import { TripEvidencePhotos } from "@/components/outstation/trip-evidence-photos";
import { ZoomablePhoto } from "@/components/ui/zoomable-photo";
import type { ApproverTripPhoto } from "@/lib/outstation/trip-evidence-photos";

type Ticket = { contentType: string; name: string; url: string };
type AttachmentsData = {
  employeeName: string | null;
  found: boolean;
  photos: ApproverTripPhoto[];
  tickets: Ticket[];
};

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
  }, [requestId]);

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
