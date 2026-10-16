"use client";

import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  callClaimNotice,
  isViewersOwnClaim,
  type CandidateCallClaim,
} from "@/lib/recruitment/candidate-call-claims";

/**
 * What the card learns back when a press lands. The phone arrives with the claim, in the same
 * response, because the reveal has to be immediate — a manager who has just committed to phoning
 * somebody should not be asked to reload the page to find the number.
 */
export type CandidateCallChange = {
  claim: CandidateCallClaim | null;
  phone: string | null;
  whatsapp: string | null;
  /**
   * The press did not land at all.
   *
   * THE FALLBACK THIS EXISTS FOR. Reserving is what makes the follow-up answer appear on a CV a
   * recruiter sent — "I want to interview" shows once the manager has taken the call. If reserving
   * is impossible (the table not applied yet, a dropped connection), that answer would be
   * unreachable and the recruiter would simply stop hearing back, silently. So a failed press tells
   * the card, and the card puts the full answer back. Degrading towards MORE ability, never less.
   */
  unavailable?: boolean;
};

/**
 * "I will call" — and, where the card owns it, "Skip".
 *
 * The owner, 2026-09-09: *"have 2 buttons on every cv, I will call and skip ... if pressed I will
 * call then every other manager receiving this CV when open the same CV shows that Ahmed will call
 * this CV, or reserved."*
 *
 * ONE CONTROL, THREE PLACES, THREE SHAPES — and the differences are all rules, not taste:
 *
 *   • A CV a recruiter SENT him. `canAct`, and NO `skip` prop: Skip there is not a pass, it is the
 *     answer the recruiter asked for, so it goes through the existing decision route with the note
 *     she needs to read. The card renders that button itself, beside this one.
 *   • A CV in one of his OWN area folders. `canAct` and `skip`: nobody asked him anything, so
 *     skipping is his own pass and clears the CV from his folder alone.
 *   • A CV sitting with a manager BELOW him, on the team screen. Neither: he reads who reserved it
 *     and nothing else. The owner's rule since 2026-08-30 is that the answer belongs to the manager
 *     the CV was sent to, and a manager above taking the call is that overwrite in a new shape.
 *
 * THE NOTICE IS THE POINT, not the button. A manager opening a CV somebody else has taken must be
 * told so before he reads a word of it, which is why this sits above the CV rather than under it.
 */
export function CandidateCallControl({
  candidateId,
  canAct,
  children,
  claim,
  hideReservation = false,
  onChanged,
  skip,
  viewerHrId,
}: {
  candidateId: string;
  /** False on a read-only card: nothing is rendered. The notice is a separate component. */
  canAct: boolean;
  /** Buttons this card owns, rendered in the SAME row so the pair reads as a pair. */
  children?: ReactNode;
  claim: CandidateCallClaim | null;
  /**
   * Leave out "I will call" and its undo. True on a CV a person sent to this reader, where the number
   * is his without reserving it (owner, 2026-10-16); the buttons this card owns still render.
   */
  hideReservation?: boolean;
  onChanged: (change: CandidateCallChange) => void;
  /** Passed only by a card whose Skip is the manager's own pass — see the three shapes above. */
  skip?: { onSkipped: (candidateId: string) => void };
  viewerHrId: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mine = isViewersOwnClaim(claim, viewerHrId);
  const takenByOther = Boolean(claim) && !mine;

  const send = async (action: "will_call" | "release" | "skip") => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/recruitment/hiring-manager/candidates/${candidateId}/call`, {
        body: JSON.stringify({ action }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;

      if (!res.ok) {
        const message =
          typeof data.message === "string" ? data.message : "That could not be recorded just now.";
        setError(message);
        // A 409 carries the claim that WON, so a losing press turns straight into "Ahmed will call
        // this candidate" rather than an error the manager has to dismiss and then wonder about.
        // That IS a recorded answer, so it must not also open the unavailable fallback below.
        if (data.claim) {
          onChanged({ claim: data.claim as CandidateCallClaim, phone: null, whatsapp: null });
        } else if (action === "will_call") {
          onChanged({ claim, phone: null, unavailable: true, whatsapp: null });
        }
        return;
      }

      onChanged({
        claim: (data.claim as CandidateCallClaim | null) ?? null,
        phone: typeof data.phone === "string" ? data.phone : null,
        whatsapp: typeof data.whatsapp === "string" ? data.whatsapp : null,
      });
      if (action === "skip") skip?.onSkipped(candidateId);
    } catch (caught) {
      // The request never completed — a dropped connection, not an answer from the server.
      setError(caught instanceof Error ? caught.message : "That could not be recorded just now.");
      if (action === "will_call") onChanged({ claim, phone: null, unavailable: true, whatsapp: null });
    } finally {
      setBusy(false);
    }
  };

  if (!canAct) return error ? <p className="text-xs text-rose-600">{error}</p> : null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {/* "I will call" is offered only while the CV is free. A manager cannot take one somebody
            else holds — that is the whole reservation — so on a taken CV there is no button at all
            rather than a disabled one, which invites a press and explains nothing. The notice at the
            top of the card says who has it. */}
        {!claim && !hideReservation ? (
          <Button disabled={busy} onClick={() => void send("will_call")} size="sm">
            I will call
          </Button>
        ) : null}
        {/* Whatever else this card wants standing beside them — the Skip that answers a recruiter,
            and the "I want to interview" that appears once he has made the call. They are passed IN
            rather than rendered in their own row so the owner's two buttons read as a pair, which is
            how he asked for them. */}
        {children}
        {skip ? (
          <Button
            disabled={busy}
            onClick={() => void send("skip")}
            size="sm"
            variant={takenByOther ? "secondary" : "destructive"}
          >
            Skip
          </Button>
        ) : null}
        {mine && !hideReservation ? (
          <Button disabled={busy} onClick={() => void send("release")} size="sm" variant="secondary">
            I won&apos;t call after all
          </Button>
        ) : null}
      </div>

      {error ? <p className="text-xs text-rose-600">{error}</p> : null}
    </div>
  );
}

/**
 * "Ahmed Gawish will call this candidate."
 *
 * ITS OWN COMPONENT, AND IT GOES AT THE TOP OF THE CARD. A manager opening a CV somebody else has
 * taken has to be told before he reads a word of it — under the buttons, at the foot of a long card,
 * is where he finds out after forming an opinion. It is also the ONLY part of this feature a
 * read-only reader gets, so it must not be welded to a control that renders nothing for him.
 *
 * Renders nothing at all when the CV is free, which is most of them.
 */
export function CandidateCallNotice({
  claim,
  viewerHrId,
}: {
  claim: CandidateCallClaim | null;
  viewerHrId: string | null;
}) {
  if (!claim) return null;
  const mine = isViewersOwnClaim(claim, viewerHrId);
  return (
    <div
      className={`border-l-2 px-3 py-2 text-xs ${
        mine ? "border-emerald-500 bg-emerald-50 text-emerald-900" : "border-amber-500 bg-amber-50 text-amber-900"
      }`}
    >
      <p className="font-semibold" dir="auto">
        {callClaimNotice(claim, viewerHrId)}
      </p>
      <p className={`mt-0.5 ${mine ? "text-emerald-800" : "text-amber-800"}`}>
        {mine
          ? "The phone number is on this card, for you only."
          : "Nobody else can see the phone number while it is theirs to call."}
      </p>
    </div>
  );
}

/**
 * One card's live view of who holds this CV and whether its phone number may be printed.
 *
 * WHY EVERY CARD OWNS THIS RATHER THAN THE PAGE. A claim changes exactly one card, and the number it
 * reveals arrives in the response to that one press. Threading it back up to the page and down again
 * would re-render every other card on a screen that already renders a hundred of them, and would put
 * a candidate's phone number into a shared bag for no reason at all.
 *
 * `phone` and `whatsapp` come back NULL for anybody but the holder even after a press, because the
 * server redacted them out of the list before it left — so the only way either is ever populated is
 * the response to the caller's OWN successful claim. Releasing hides them again the moment `mine`
 * turns false, without waiting for a reload.
 */
export function useCandidateCall(
  candidate: { phone: string | null; whatsapp: string | null },
  initialClaim: CandidateCallClaim | null,
  viewerHrId: string | null,
  /**
   * TRUE for a CV a person sent to this reader (owner, 2026-10-16: once it reaches him there is "no
   * restriction"). The number then belongs to him without pressing anything, and the server no longer
   * strips it from his lists. False everywhere else, where the "I will call" reservation still rules.
   */
  unrestricted = false,
) {
  const [claim, setClaim] = useState(initialClaim);
  const [phone, setPhone] = useState(candidate.phone);
  const [whatsapp, setWhatsapp] = useState(candidate.whatsapp);
  const [unavailable, setUnavailable] = useState(false);

  const apply = (change: CandidateCallChange) => {
    if (change.unavailable) {
      setUnavailable(true);
      return;
    }
    setClaim(change.claim);
    if (change.phone !== null) setPhone(change.phone);
    if (change.whatsapp !== null) setWhatsapp(change.whatsapp);
  };

  const mine = unrestricted || isViewersOwnClaim(claim, viewerHrId);
  return {
    apply,
    claim,
    mine,
    phone: mine ? phone : null,
    /** True when a reservation could not be recorded at all — see CandidateCallChange.unavailable. */
    unavailable,
    whatsapp: mine ? whatsapp : null,
  };
}

/**
 * What a card prints where the phone number used to be.
 *
 * Never an empty dash. "—" is what the card shows for a field the candidate genuinely never gave,
 * and a manager reading it on a hidden phone concludes the CV has no number and stops looking for
 * one — which is how a working reservation reads as a data fault.
 */
export function hiddenPhoneText(canAct: boolean): string {
  return canAct ? "Hidden — press I will call to see it" : "Hidden";
}
