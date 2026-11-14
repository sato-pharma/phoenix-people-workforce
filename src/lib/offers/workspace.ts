import {
  isOfferSchemaMissing,
  listOfferJobTitles,
  listOfferTemplates,
  listOffers,
  offerErrorMessage,
} from "@/lib/offers/service";
import { resolveOfferSender } from "@/lib/offers/identity";
import { readOfferVacancies } from "@/lib/offers/vacancies";
import { loadOfferPeopleNames } from "@/lib/offers/people";
import { EMPTY_OFFER_COPY_DIRECTORY, type OfferCopyDirectory } from "@/lib/offers/copy-directory";
import { loadOfferCopyDirectory } from "@/lib/offers/copy-directory-loader";
import type { OfferJobTitle, OfferRecord, OfferTemplate, OfferVacancyOption } from "@/lib/offers/types";

export type OffersWorkspace = {
  /** Who CC and BCC can be picked from: Line → Region → Area managers, and the HR team. Empty when unread. */
  copyDirectory: OfferCopyDirectory;
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
  /**
   * The open seats could not be read (REC-034, 14 Nov 2026). Then `vacancies` is empty because of the
   * fault, not because every seat is filled — and the list must not call any seat "no longer open".
   */
  vacanciesUnread: boolean;
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

  // OUTSIDE the try, and never throwing: `readOfferVacancies` says when it could not read. The seats
  // come from a different table in a different module; a vacancy read that fails is a picker with
  // nothing in it, never an Offers screen that will not load.
  // The CC/BCC picker's lists the same way: they never stop the screen loading, and typing still works.
  const [vacancyRead, copyDirectory] = await Promise.all([
    readOfferVacancies(),
    loadOfferCopyDirectory().catch(() => EMPTY_OFFER_COPY_DIRECTORY),
  ]);
  const vacancies = vacancyRead.ok ? vacancyRead.options : [];
  const vacanciesUnread = !vacancyRead.ok;

  try {
    const [offers, templates, jobTitles] = await Promise.all([
      listOffers(),
      listOfferTemplates(),
      listOfferJobTitles(),
    ]);
    // The viewer is named too, so an offer they send in this sitting shows their name without a reload.
    const people = await loadOfferPeopleNames(offers, [options.viewerHrId]);
    return { copyDirectory, error: null, jobTitles, offers, people, sender: senderInfo, templates, vacancies, vacanciesUnread };
  } catch (error) {
    // The migration being absent gets its own sentence — the raw PostgREST message names a table
    // and tells HR nothing they can act on.
    return {
      copyDirectory,
      error: isOfferSchemaMissing(error)
        ? "The job-offer module is not set up in this environment yet. Its database migration has not been applied."
        : offerErrorMessage(error),
      jobTitles: [],
      offers: [],
      people: {},
      sender: senderInfo,
      templates: [],
      vacancies,
      vacanciesUnread,
    };
  }
}
