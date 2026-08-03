import { redirect } from "next/navigation";

import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { resolveMarketingRequestDestination } from "@/lib/marketing-requests/notification-link";

export const dynamic = "force-dynamic";

/**
 * Shell resolver for marketing-request notification links.
 *
 * Notifications store ONE actionUrl shared by every recipient, but the marketing approver chain
 * spans both shells — admin (Super Admin, SFE Manager, Marketing Manager) and portal (National
 * Sales Manager, District Manager) — and each shell's guard redirects the other's users away.
 * This page owns no UI; it reads the viewer's own navigation mode and forwards them to the
 * marketing inbox (or decision page) that will actually render for them.
 *
 * No access check of its own on purpose: it only redirects, and every destination enforces its
 * own guard server-side. Adding a second gate here would just produce a different dead end for
 * the roles this route exists to rescue.
 */
export default async function MarketingRequestLinkResolver({
  params,
  searchParams,
}: {
  params: Promise<{ requestId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ requestId }, query] = await Promise.all([params, searchParams]);
  const access = await resolveAccessContextFromPage();
  const rawDecision = query?.decision;

  redirect(
    resolveMarketingRequestDestination({
      decision: Array.isArray(rawDecision) ? rawDecision[0] : rawDecision,
      navigationMode: resolveNavigationMode(access),
      requestId,
    }),
  );
}
