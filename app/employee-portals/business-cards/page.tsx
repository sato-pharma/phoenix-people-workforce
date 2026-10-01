import { redirect } from "next/navigation";

import { EmployeeBusinessCard } from "@/components/business-cards/employee-business-card";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import type { BusinessCardRequestRow, OwnBusinessCard } from "@/lib/business-cards/request-types";
import {
  getOwnBusinessCard,
  listBusinessCardRequestsForViewer,
} from "@/lib/business-cards/request-service";

export const dynamic = "force-dynamic";

export default async function EmployeeBusinessCardsPage() {
  const access = await resolveAuthenticatedPageAccess();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }
  await assertPermission(access, "business_card_requests", "create");

  let card: OwnBusinessCard | null = null;
  let myRequests: BusinessCardRequestRow[] = [];
  try {
    // READ TOGETHER (2026-10-01, "slow to transfer between page and page"): the card and the caller's
    // own requests are two independent reads. Either failing still shows the "not ready" state, as
    // the one-after-the-other reads did.
    [card, myRequests] = await Promise.all([getOwnBusinessCard(access), listBusinessCardRequestsForViewer(access)]);
  } catch {
    card = null;
  }

  return (
    <EmployeePortalPageShell
      badge="Business Cards"
      description="Check your business card, correct your name or number, and ask HR to print it."
      title="My Business Card"
    >
      {card ? (
        <EmployeeBusinessCard card={card} initialRequests={myRequests} />
      ) : (
        <EmployeePortalEmptyState
          message="We could not find your details to prepare a card right now. Please try again in a moment, or contact HR if this continues."
          title="Your card isn't ready yet"
        />
      )}
    </EmployeePortalPageShell>
  );
}
