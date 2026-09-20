"use client";

import { createContext, useContext, type ReactNode } from "react";
import { Eye } from "lucide-react";

import { cairoDateTime } from "@/lib/format/cairo-datetime";
import {
  candidateOpenersHeadline,
  openerReopened,
  type CandidateOpener,
  type CandidateOpeners,
} from "@/lib/recruitment/candidate-openers";

// "Who has already opened this CV" — the banner every candidate card wears.
//
// The owner, 2026-09-20: a big, clear mark saying that a colleague, by name and title, opened this
// CV at that date and time. It matters most between district managers, because one applicant is
// filed under the same area on CNS, Anti-infective and Pedia and lands in three managers' folders.
// The data and its rules are in src/lib/recruitment/candidate-openers.ts.
//
// A CONTEXT, NOT A PROP. The card renders in four places — the sent-to-you list, the open-position
// list, the district folders and the team screen — and the folders and the shelf take a
// `renderCandidate` callback, so the list would have to be threaded through five components that
// never look at it. `callClaims` did travel that way and it is why adding a field to it touched a
// dozen files. Here the page provides the map once and each card reads its own row.
//
// NO PROVIDER, NO BANNER. A card rendered outside a provider — a test, a future screen that has not
// been wired — reads an empty map and shows nothing, which is the screen as it was yesterday.

const EMPTY: CandidateOpeners = {};

const OpenersContext = createContext<CandidateOpeners>(EMPTY);

export function CandidateOpenersProvider({
  children,
  openers,
}: {
  children: ReactNode;
  openers: CandidateOpeners;
}) {
  return <OpenersContext.Provider value={openers}>{children}</OpenersContext.Provider>;
}

function OpenerLine({ opener }: { opener: CandidateOpener }) {
  return (
    <li className="text-sm text-sky-950">
      <span className="font-bold" dir="auto">
        {opener.name}
      </span>
      {opener.title ? <span className="text-sky-800"> · {opener.title}</span> : null}
      <span className="block text-sky-900 sm:inline">
        <span className="hidden sm:inline"> — </span>
        opened <span className="font-semibold">{cairoDateTime(opener.firstOpenedAt)}</span>
        {openerReopened(opener) ? (
          <>
            , again <span className="font-semibold">{cairoDateTime(opener.lastOpenedAt)}</span>
          </>
        ) : null}
      </span>
    </li>
  );
}

/**
 * Sits at the top of a card, under "will call". Renders nothing when nobody else has opened the CV.
 *
 * Square-edged and text at full size on purpose: the owner asked for a mark a manager cannot pass
 * by, and the names and times wrap rather than being cut short or scrolled, on a phone as on a desktop.
 */
export function CandidateOpenedNotice({ candidateId }: { candidateId: string }) {
  const openers = useContext(OpenersContext)[candidateId];
  if (!openers || openers.length === 0) return null;

  return (
    <div className="border-l-4 border-sky-600 bg-sky-50 px-3 py-2.5" data-candidate-opened-notice role="note">
      <p className="flex items-center gap-2 text-base font-bold text-sky-950">
        <Eye aria-hidden className="h-5 w-5 shrink-0 text-sky-700" />
        {candidateOpenersHeadline(openers)}
      </p>
      <ul className="mt-1.5 space-y-1.5">
        {openers.map((opener, index) => (
          <OpenerLine key={`${opener.name}-${opener.firstOpenedAt}-${index}`} opener={opener} />
        ))}
      </ul>
    </div>
  );
}
