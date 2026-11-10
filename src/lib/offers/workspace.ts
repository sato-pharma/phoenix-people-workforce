import {
  isOfferSchemaMissing,
  listOfferJobTitles,
  listOfferTemplates,
  listOffers,
  offerErrorMessage,
} from "@/lib/offers/service";
import { resolveOfferSender } from "@/lib/offers/identity";
import { loadOfferVacancyOptions } from "@/lib/offers/vacancies";
import { loadOfferPeopleNames } from "@/lib/offers/people";
import type { OfferJobTitle, OfferRecord, OfferTemplate, OfferVacancyOption } from "@/lib/offers/types";

export type OffersWorkspace = {
  error: string | null;
  jobTitles: OfferJobTitle[];
  offers: OfferRecord[];
  /**
   * Display names of everybody who drafted, sent or approved an offer on screen, and of the viewer, keyed
   * by lower-case HR id (owner, 2026-11-10: the Offers list's "Sent by" column). Empty when unread.
   */
  people: Record<string, string>;
  sender: {
    allowedFrom: readonly string[];
    from: string;
    isConfigured: boolean;
    /** Set when `JOB_OFFER_EMAIL_FROM` names a mailbox the owner's rule refuses. */
    refusedFrom: string | null;
    replyTo: string;
  };
  templates: OfferTemplate[];
  /** The open seats an offer can be written against. An empty list is a state, not a failure. */
  vacancies: OfferVacancyOption[];
};

/**
 * Everything the offers screen needs, loaded once.
 *
 * Shared by the admin page and its portal twin so the two cannot drift — they are the same screen
 * shown in two shells, and the only reason both exist is that `app/(admin)/layout.tsx` redirects
 * portal-shell roles (Talent Acquisition, the role that actually issues offers) out of the entire
 * admin route group before any page in it renders.
 */
export async function loadOffersWorkspace(options: { viewerHrId?: string | null } = {}): Promise<OffersWorkspace> {
  const sender = resolveOfferSender();
  const senderInfo = {
    allowedFrom: sender.allowedFrom,
    from: sender.from,
    isConfigured: sender.isConfigured,
    refusedFrom: sender.refusedFrom,
    replyTo: sender.replyTo,
  };

  // OUTSIDE the try, and swallowing its own failures inside `loadOfferVacancyOptions`. The seats
  // come from a different table in a different module; a vacancy read that fails is a picker with
  // nothing in it, never an Offers screen that will not load.
  const vacancies = await loadOfferVacancyOptions();

  try {
    const [offers, templates, jobTitles] = await Promise.all([
      listOffers(),
      listOfferTemplates(),
      listOfferJobTitles(),
    ]);
    // The viewer is named too, so an offer they send in this sitting shows their name without a reload.
    const people = await loadOfferPeopleNames(offers, [options.viewerHrId]);
    return { error: null, jobTitles, offers, people, sender: senderInfo, templates, vacancies };
  } catch (error) {
    // The migration being absent gets its own sentence — the raw PostgREST message names a table
    // and tells HR nothing they can act on.
    return {
      error: isOfferSchemaMissing(error)
        ? "The job-offer module is not set up in this environment yet. Its database migration has not been applied."
        : offerErrorMessage(error),
      jobTitles: [],
      offers: [],
      people: {},
      sender: senderInfo,
      templates: [],
      vacancies,
    };
  }
}
