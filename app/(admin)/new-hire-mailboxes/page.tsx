import { redirect } from "next/navigation";

import { NewHireMailboxPanel } from "@/components/new-hire-mailbox/new-hire-mailbox-panel";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { canReadInitialPassword } from "@/lib/new-hire-mailbox/initial-password-store";
import { getNewHireMailboxQueue, type NewHireMailboxQueue } from "@/lib/new-hire-mailbox/service";

export const dynamic = "force-dynamic";

/**
 * New Hire Mailboxes. Read on `mailbox_offboarding:read`, act on `:update` — the grant Mailbox
 * Revocation uses, since a joiner's mailbox and a leaver's are one job. The page check is UX; the
 * route asserts the same permission again.
 */
export default async function NewHireMailboxesPage({
  searchParams,
}: {
  searchParams: Promise<{ hrId?: string | string[] }>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "mailbox_offboarding", "read"))) {
    redirect("/employee-portals");
  }
  const canConnect = await canAccess(access, "mailbox_offboarding", "update");
  // Adoption RESETS a working employee's mailbox, so it is the System Administrator's alone — the
  // same audience that can read the hand-over password afterwards, because whoever locks somebody
  // out has to be able to let them back in. This only hides the card; the route decides.
  const canAdopt = canReadInitialPassword(access.role);
  const params = await searchParams;
  const spotlight = Array.isArray(params.hrId) ? params.hrId[0] : params.hrId;

  let queue: NewHireMailboxQueue = { pending: [], recentlyResolved: [], schemaMissing: false };
  let loadError: string | null = null;
  try {
    queue = await getNewHireMailboxQueue();
  } catch (error) {
    loadError = clientSafeErrorMessage(error, "The new hire mailbox queue could not be loaded.");
  }

  return (
    <NewHireMailboxPanel
      canAdopt={canAdopt}
      canConnect={canConnect}
      loadError={loadError}
      pending={queue.pending}
      recentlyResolved={queue.recentlyResolved}
      schemaMissing={queue.schemaMissing}
      spotlightHrId={spotlight?.trim() || null}
    />
  );
}
