import { notFound, redirect } from "next/navigation";

import { CustomerIdentityProfile } from "@/components/customer-identity/customer-identity-profile";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { loadIdentityProfile } from "@/lib/customer-identity/server/profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Customer 360 for one confirmed identity.
 *
 * Gated on `customer_identity:read`, the same permission as the review screen it hangs off — the
 * matrix grants it to the Super Admin alone (owner, 2026-09-30). The gate is repeated here rather
 * than inherited: this page reads rows from all four systems for one person, with no scope
 * narrowing of its own, and a page that trusts its parent's gate is a page one route change from
 * having none.
 *
 * A master id that does not exist is a 404, not an empty page: nothing in the app produces one,
 * so a request for it is a mistyped or a stale link and should say so.
 */
export default async function CustomerIdentityProfilePage({ params }: { params: Promise<{ masterId: string }> }) {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");
  if (!(await canAccess(access, "customer_identity", "read"))) {
    redirect(resolveLandingPathForRole(access.role));
  }

  // 🔴 THE SHAPE IS CHECKED BEFORE THE READ, OR A MISTYPED LINK IS A CRASH. `master_id` is a uuid
  // column, so Postgres answers anything else with `invalid input syntax for type uuid` and the
  // loader throws — which the browser shows as an application error rather than a missing page.
  // Caught by walking a bad URL on the preview before this shipped.
  const masterId = decodeURIComponent((await params).masterId);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(masterId)) notFound();

  const profile = await loadIdentityProfile(masterId);
  if (!profile) notFound();

  return <CustomerIdentityProfile profile={profile} />;
}
