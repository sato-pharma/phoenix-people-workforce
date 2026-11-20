"use client";

import { useRouter } from "next/navigation";

import { LandingTitle } from "@/components/employee-portal/landing-kit";
import {
  DeparturePhotoCard,
  type DeparturePhotoPendingRequest,
} from "@/components/outstation/departure-photo-card";
import { MissingTicketCard, type MissingTicketRequest } from "@/components/outstation/missing-ticket-card";

/**
 * What the employee must still do on claims already submitted — the first thing on Submit Expense
 * and the Expense Dashboard (owner, 2026-10-22: "in every step, show him what should he do in this
 * step and the next").
 *
 * WHY IT LEADS THE PAGE. Osama Mohamed El-said took his arrival photo in Assiut on Submit Expense,
 * and when the trip ended he came back to the same screen for the departure photo and found nothing
 * there: its card lived only on the Expense Dashboard and inside a collapsed row of Expense
 * Submissions. Whatever is owed now sits on top of the screen people actually return to.
 *
 * Data in, nothing else: the server page reads getOwnOutstationPendingActions and passes plain rows,
 * and a capture or an attach refreshes that page so a finished item leaves the list.
 */
export function OutstationPendingActions({
  departurePhotoDue,
  employeeHrId,
  missingTicket,
}: {
  departurePhotoDue: DeparturePhotoPendingRequest[];
  employeeHrId: string;
  missingTicket: MissingTicketRequest[];
}) {
  const router = useRouter();
  const count = departurePhotoDue.length + missingTicket.length;
  if (count === 0) return null;

  return (
    <section aria-label="Needs you now" className="grid gap-3">
      {/* The heading alone: the tick, then what is owed and how many — no sentence under it. */}
      <LandingTitle>
        Needs you now · <span className="tabular-nums">{count === 1 ? "1 item" : `${count} items`}</span>
      </LandingTitle>
      <DeparturePhotoCard
        employeeHrId={employeeHrId}
        onCaptured={() => router.refresh()}
        requests={departurePhotoDue}
      />
      <MissingTicketCard requests={missingTicket} />
    </section>
  );
}
