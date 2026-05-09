import { AppShell } from "@/components/layout/app-shell";
import { OfferLifecycleDashboard } from "@/components/offers/offer-lifecycle-dashboard";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  getOfferDashboard,
  getOfferLookups,
  isOfferEnvMissing,
  isOfferPublicUrlMissing,
  isOfferSchemaMissing,
  isOfferTimeout,
  offerErrorMessage,
} from "@/lib/offers/service";

export const dynamic = "force-dynamic";

function pageError(error: unknown) {
  if (isOfferTimeout(error)) return "Supabase request timed out. Check your connection and try again.";
  if (isOfferPublicUrlMissing(error)) return "Offer public URL is missing. Add APP_URL or NEXT_PUBLIC_APP_URL before sending offers.";
  if (isOfferEnvMissing(error)) return "Supabase environment variables are missing.";
  if (isOfferSchemaMissing(error)) return "Supabase schema is not ready. Run supabase/phoenix-offer-lifecycle.sql in Supabase SQL editor.";
  return offerErrorMessage(error);
}

export default async function OffersPage() {
  const access = await resolveAccessContextFromPage();
  await assertPermission(access, "offers", "read");
  let initialData = null;
  let initialError: string | null = null;
  let lookups = null;

  try {
    [initialData, lookups] = await Promise.all([
      getOfferDashboard(),
      getOfferLookups(),
    ]);
  } catch (error) {
    initialError = pageError(error);
  }

  return (
    <AppShell>
      <OfferLifecycleDashboard
        initialData={initialData}
        initialError={initialError}
        lookups={lookups}
      />
    </AppShell>
  );
}
