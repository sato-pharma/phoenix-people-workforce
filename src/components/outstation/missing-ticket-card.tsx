"use client";

import { CheckCircle2, Loader2, Ticket, TriangleAlert, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { prepareTicketAttachment } from "@/components/outstation/prepare-ticket-attachment";
import { TICKET_FILE_ACCEPT } from "@/components/outstation/ticket-upload-card";
import {
  scanTrainTicket,
  TicketScanNotices,
  TicketScanReading,
  type ScannedTrainTicket,
} from "@/components/outstation/train-ticket-scan";
import { phxButtonPrimaryClassName } from "@/components/ui/form-tokens";
import { formatPhoenixLongDate } from "@/lib/i18n/format";
import { checkTicketAttachmentFile } from "@/lib/outstation/ticket-attachment-limits";
import { judgeTrainTicket, type TicketVerdict } from "@/lib/outstation/ticket-scan-rules";
import { cn } from "@/lib/utils";

/** One undecided train or bus claim that reached Phoenix with no ticket (missing-ticket.ts). */
export type MissingTicketRequest = {
  destination: string;
  id: number;
  transportationType: string;
  tripEndDate: string;
  tripStartDate: string;
};

type AttachState =
  | { kind: "idle" }
  | { kind: "reading" }
  | { kind: "saving" }
  | { kind: "done" }
  | { kind: "error"; message: string };

/**
 * Attach the ticket a train or bus claim arrived WITHOUT (owner, 2026-10-22: "fix … the offline
 * ticket gap in outstation"). A claim saved with no signal is replayed later without its files, and
 * until now the only ticket tool on the claim was "Add tickets", which adds a paid leg — never the
 * proof for the ticket already claimed. This is evidence only: no amount is typed and none moves.
 *
 * The route refuses anything the rule does not allow (a decided claim, a car trip, a claim that
 * already has its ticket), so the card is offered only where getOwnOutstationRequestsMissingTicket
 * found the same rule satisfied.
 */
export function MissingTicketCard({ requests }: { requests: MissingTicketRequest[] }) {
  if (requests.length === 0) return null;

  return (
    <section aria-label="Ticket missing" className="border border-orange-200 bg-orange-50/60 p-4 sm:p-5">
      <div className="flex items-center gap-2">
        <Ticket aria-hidden className="h-4 w-4 text-orange-600" />
        <span className="bg-orange-100 px-2 py-1 text-phx-2xs font-bold uppercase tracking-wider text-orange-700">
          Ticket missing
        </span>
      </div>
      <p className="mt-2 max-w-3xl text-phx-md leading-relaxed text-orange-900">
        {requests.length === 1
          ? "One train or bus claim reached Phoenix without its ticket."
          : `${requests.length} train or bus claims reached Phoenix without their tickets.`}{" "}
        Attach a photo or PDF of the ticket here. The claim stays held for review until it has one. No amount
        changes. A train ticket is read when you choose it, and its travel date must match your arrival or
        departure photo.
      </p>
      <div className="mt-4 space-y-3">
        {requests.map((request) => (
          <MissingTicketRow key={request.id} request={request} />
        ))}
      </div>
    </section>
  );
}

/** A train ticket's verdict: the server's, against this claim's own arrival and departure photos. */
function verdictOf(ticket: ScannedTrainTicket): TicketVerdict {
  return ticket.verdict ?? judgeTrainTicket(ticket.scan, { arrivalAt: null, departureAt: null, tripEndDate: "", tripStartDate: "" });
}

function MissingTicketRow({ request }: { request: MissingTicketRequest }) {
  const router = useRouter();
  const [files, setFiles] = useState<File[]>([]);
  // A train ticket is read the moment it is picked (owner, 2026-11-07; ticket-scan-rules.ts): only the
  // ones whose travel date was read and matches this trip's photos are kept; the rest say why.
  const [scanned, setScanned] = useState<ScannedTrainTicket[]>([]);
  const [state, setState] = useState<AttachState>({ kind: "idle" });
  const transport = request.transportationType === "bus" ? "bus" : "train";
  const isTrain = transport === "train";
  const judged = scanned.map((ticket) => ({ ticket, verdict: verdictOf(ticket) }));
  const acceptedTickets = judged.flatMap((entry) => (entry.verdict.accepted ? [{ ticket: entry.ticket, verdict: entry.verdict }] : []));
  const refusedTickets = judged.flatMap((entry) => (entry.verdict.accepted ? [] : [{ ticket: entry.ticket, verdict: entry.verdict }]));
  const readyCount = isTrain ? acceptedTickets.length : files.length;

  async function pick(list: FileList | null) {
    const picked = Array.from(list ?? []);
    for (const file of picked) {
      const verdict = checkTicketAttachmentFile(file);
      if (!verdict.ok) {
        setFiles([]);
        setScanned([]);
        setState({ kind: "error", message: verdict.message });
        return;
      }
    }
    setFiles(picked);
    setScanned([]);
    if (!isTrain || picked.length === 0) {
      setState({ kind: "idle" });
      return;
    }
    setState({ kind: "reading" });
    try {
      const prepared = await Promise.all(picked.map(prepareTicketAttachment));
      const results: ScannedTrainTicket[] = [];
      for (const ticket of prepared) results.push(await scanTrainTicket(ticket, { requestId: request.id }));
      setScanned(results);
      setState({ kind: "idle" });
    } catch (error) {
      setFiles([]);
      setState({ kind: "error", message: error instanceof Error ? error.message : "The ticket could not be read." });
    }
  }

  async function attach() {
    if (readyCount === 0) {
      setState({
        kind: "error",
        message:
          isTrain && refusedTickets.length > 0
            ? "None of the chosen tickets could be accepted. Take the photo again as described above."
            : `Take a photo of the ${transport} ticket or choose the file first.`,
      });
      return;
    }
    setState({ kind: "saving" });
    try {
      // A train ticket goes as the exact bytes that were read, with the signed note of that read.
      const tickets = isTrain
        ? acceptedTickets.map(({ ticket }) => ({ dataUrl: ticket.dataUrl, name: ticket.name, scanToken: ticket.scanToken ?? undefined }))
        : await Promise.all(files.map(prepareTicketAttachment));
      const response = await fetch(`/api/outstation/${request.id}/ticket`, {
        body: JSON.stringify({ tickets }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as { message?: string } | null;
      if (!response.ok) throw new Error(payload?.message || `Upload failed (${response.status})`);
      setState({ kind: "done" });
      // The server page re-reads what is still owed, so this row leaves the list on its own.
      router.refresh();
    } catch (error) {
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : "The ticket could not be attached.",
      });
    }
  }

  const saving = state.kind === "saving" || state.kind === "reading";

  return (
    <div className="border border-orange-200 bg-white p-3 sm:p-4">
      <div className="min-w-0">
        <p className="text-sm font-bold text-slate-900">{request.destination}</p>
        <p className="mt-0.5 text-xs font-semibold text-slate-500">
          {transport === "bus" ? "Bus" : "Train"} · {formatPhoenixLongDate(request.tripStartDate)} –{" "}
          {formatPhoenixLongDate(request.tripEndDate)}
        </p>
      </div>

      {state.kind === "done" ? (
        <p className="mt-3 flex items-start gap-2 text-phx-md leading-relaxed text-emerald-700">
          <CheckCircle2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          Ticket attached. Your approver now sees it on the claim.
        </p>
      ) : (
        <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-center">
          <label className="flex min-h-11 cursor-pointer items-center justify-center gap-2 border border-dashed border-orange-400 bg-orange-50 px-3 py-2 text-sm font-bold text-orange-800 transition hover:bg-orange-100">
            <Upload aria-hidden className="h-4 w-4" />
            {files.length > 0
              ? `${files.length} file${files.length === 1 ? "" : "s"} chosen — tap to change`
              : `Take a photo of the ${transport} ticket or choose a file`}
            <input
              accept={TICKET_FILE_ACCEPT}
              className="hidden"
              disabled={saving}
              multiple
              onChange={(event) => void pick(event.target.files)}
              type="file"
            />
          </label>
          <button
            className={cn(phxButtonPrimaryClassName, "min-h-11 justify-center")}
            disabled={saving || readyCount === 0}
            onClick={() => void attach()}
            type="button"
          >
            {saving ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <Ticket aria-hidden className="h-4 w-4" />}
            {state.kind === "reading" ? "Reading the ticket" : state.kind === "saving" ? "Attaching the ticket" : "Attach the ticket"}
          </button>
        </div>
      )}

      {isTrain && state.kind !== "done" ? (
        <div className="mt-3 grid gap-2">
          {state.kind === "reading" ? <TicketScanReading count={files.length} /> : null}
          <TicketScanNotices accepted={acceptedTickets} refused={refusedTickets} />
        </div>
      ) : null}

      {state.kind === "error" ? (
        <p className="mt-2 flex items-start gap-2 text-phx-md leading-relaxed text-rose-700" role="alert">
          <TriangleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
