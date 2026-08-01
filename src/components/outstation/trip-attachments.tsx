"use client";

import { FileText, ImageOff, Loader2, Paperclip } from "lucide-react";
import { useEffect, useState } from "react";

type Ticket = { contentType: string; name: string; url: string };
type AttachmentsData = { carEvidenceImageUrl: string | null; found: boolean; tickets: Ticket[] };

/** Bulk-xlsx trips use `TRP-*`; only Phoenix-submitted rows are `OUTSTATION-<requestId>`. */
function parseRequestId(tripId: string): string | null {
  const match = /^OUTSTATION-(\d+)$/i.exec(tripId.trim());
  return match ? match[1] : null;
}

function isPdf(ticket: Ticket): boolean {
  return /pdf/i.test(ticket.contentType) || /\.pdf(\?|$)/i.test(ticket.url);
}

/**
 * Ticket/receipt pictures & PDFs and the car-evidence photo for a Phoenix-submitted expense.
 * Bulk-xlsx trips (or trips whose source request was deleted) degrade to a quiet note.
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
  const items: Array<{ isPdf: boolean; key: string; label: string; url: string }> = [];
  if (data.carEvidenceImageUrl) {
    items.push({ isPdf: false, key: "car", label: "Car evidence", url: data.carEvidenceImageUrl });
  }
  data.tickets.forEach((ticket, index) => {
    items.push({ isPdf: isPdf(ticket), key: `ticket-${index}`, label: ticket.name || `Ticket ${index + 1}`, url: ticket.url });
  });

  if (!data.found || items.length === 0) {
    return (
      <p className="flex items-center gap-2 text-xs text-slate-400">
        <ImageOff className="h-3.5 w-3.5" />
        {data.found ? "No attachment on this submission." : "Source request is no longer available."}
      </p>
    );
  }

  return (
    <div className="flex flex-wrap gap-3">
      {items.map((item) => (
        <a
          className="group block w-40 overflow-hidden rounded-lg border border-[#e4e9ec] bg-white transition-colors hover:border-orange-400"
          href={item.url}
          key={item.key}
          rel="noopener noreferrer"
          target="_blank"
          title={`${item.label} — open in a new tab`}
        >
          {item.isPdf ? (
            <div className="flex h-28 flex-col items-center justify-center gap-1 bg-slate-50 text-slate-500">
              <FileText className="h-7 w-7" />
              <span className="text-[10px] font-bold uppercase tracking-wide">PDF</span>
            </div>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- Private signed Supabase URLs are not configured for Next image optimization.
            <img alt={item.label} className="h-28 w-full object-cover" src={item.url} />
          )}
          <p className="truncate px-2 py-1.5 text-[11px] font-semibold text-slate-700 group-hover:text-orange-700">
            {item.label}
          </p>
        </a>
      ))}
    </div>
  );
}
