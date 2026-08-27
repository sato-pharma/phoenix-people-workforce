import {
  isOfferSchemaMissing,
  listOfferJobTitles,
  listOfferTemplates,
  listOffers,
  offerErrorMessage,
} from "@/lib/offers/service";
import { resolveOfferSender } from "@/lib/offers/identity";
import type { OfferJobTitle, OfferRecord, OfferTemplate } from "@/lib/offers/types";

export type OffersWorkspace = {
  error: string | null;
  jobTitles: OfferJobTitle[];
  offers: OfferRecord[];
  sender: { from: string; isConfigured: boolean; replyTo: string };
  templates: OfferTemplate[];
};

/**
 * Everything the offers screen needs, loaded once.
 *
 * Shared by the admin page and its portal twin so the two cannot drift — they are the same screen
 * shown in two shells, and the only reason both exist is that `app/(admin)/layout.tsx` redirects
 * portal-shell roles (Talent Acquisition, the role that actually issues offers) out of the entire
 * admin route group before any page in it renders.
 */
export async function loadOffersWorkspace(): Promise<OffersWorkspace> {
  const sender = resolveOfferSender();
  const senderInfo = { from: sender.from, isConfigured: sender.isConfigured, replyTo: sender.replyTo };

  try {
    const [offers, templates, jobTitles] = await Promise.all([
      listOffers(),
      listOfferTemplates(),
      listOfferJobTitles(),
    ]);
    return { error: null, jobTitles, offers, sender: senderInfo, templates };
  } catch (error) {
    // The migration being absent gets its own sentence — the raw PostgREST message names a table
    // and tells HR nothing they can act on.
    return {
      error: isOfferSchemaMissing(error)
        ? "The job-offer module is not set up in this environment yet. Its database migration has not been applied."
        : offerErrorMessage(error),
      jobTitles: [],
      offers: [],
      sender: senderInfo,
      templates: [],
    };
  }
}
