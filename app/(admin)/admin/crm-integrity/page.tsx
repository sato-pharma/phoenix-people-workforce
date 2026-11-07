// RETIRED 2026-11-07, WITH iREPORTS360.
//
// CRM Integrity matched each iReports360 visit against the vendor's own GPS check-ins — exact
// contact first, same-day time second — and flagged save-lag and impossible travel. iReports360 was
// retired on 6 November 2026 (crm_cutover.vendor_sync_retired_at) and Phoenix CRM is the one source
// of field work, so the page could only ever compare a frozen archive with itself. A Phoenix visit is
// its own check-in: its position, its photograph and the trip from the visit before are judged as it
// is saved, on Location Integrity, and the housekeeping boards sit beside it.
//
// Every link is withdrawn — the CRM hub card and its band row (src/config/system-navigation.ts), the
// button on the CRM workspace (/admin/crm) and the SFE Manager's quick navigation. Its server code
// went with it: the old service, correlation and types modules under src/lib/crm-integrity/ and the
// workspace component under src/components/crm-integrity/. The rest of those two folders is Location
// Integrity's and stays.
//
// THIS PAGE STAYS, as a pointer for a bookmark, behind the same gate it always had (Super Admin and
// SFE Manager — the two people every screen below admits). The links are written out rather than read
// from the hub cards on purpose: importing a `*PageItems` list makes a page a hub in the navigation
// tests' eyes, and this is not a page of modules. tests/crm-switch-off-safety.test.ts checks each
// href below is still a live CRM hub card, so a moved screen fails there instead of here.
//
// DO NOT rebuild the vendor comparison here.
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, CopyCheck, MapPinned, MapPinOff, ShieldAlert } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canUseAdminCrmWorkspace } from "@/lib/crm/admin-access";

export const dynamic = "force-dynamic";

/** Phoenix CRM's own integrity screens, in the order a reader of the old page needs them. */
const PHOENIX_INTEGRITY_HREFS = [
  "/admin/phoenix-crm/integrity",
  "/admin/phoenix-crm/refused-readings",
  "/admin/phoenix-crm/duplicates",
] as const;

const SCREENS: Record<(typeof PHOENIX_INTEGRITY_HREFS)[number], { description: string; icon: typeof MapPinned; label: string }> = {
  "/admin/phoenix-crm/integrity": {
    description: "Visits and places that do not hold up — the position, the photograph and the trip from the visit before.",
    icon: ShieldAlert,
    label: "Location Integrity",
  },
  "/admin/phoenix-crm/refused-readings": {
    description: "Reps whose phone was turned away for a missing or rough location, and whether each got through afterwards.",
    icon: MapPinOff,
    label: "Refused Readings",
  },
  "/admin/phoenix-crm/duplicates": {
    description: "Where one rep's own list holds the same doctor twice.",
    icon: CopyCheck,
    label: "Duplicate Customers",
  },
};

export default async function CrmIntegrityPage() {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");
  // The same gate as /admin/crm and /admin/double-visit-data-integrity: Super Admin and SFE Manager.
  if (!canUseAdminCrmWorkspace(access)) {
    redirect(resolveLandingPathForRole(access.role));
  }

  return (
    <div className="space-y-6">
      <AdminPageHero
        description="This page compared the old CRM's visits with the old CRM's own check-ins. iReports360 was retired on 6 November 2026, and Phoenix CRM now checks every visit's position, photograph and travel itself as it is saved."
        eyebrow="CRM"
        icon={<MapPinned className="h-3.5 w-3.5" />}
        title="CRM Integrity has moved to Phoenix CRM"
      />

      <ul className="divide-y divide-slate-200 border border-slate-200 bg-white">
        {PHOENIX_INTEGRITY_HREFS.map((href) => {
          const screen = SCREENS[href];
          const Icon = screen.icon;
          return (
            <li key={href}>
              <Link
                className="group flex items-start gap-3 px-5 py-4 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-orange-500"
                href={href}
              >
                <Icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-orange-700" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-bold text-slate-950">{screen.label}</span>
                  <span className="mt-1 block text-xs leading-5 text-slate-500">{screen.description}</span>
                </span>
                <ArrowRight
                  aria-hidden="true"
                  className="mt-0.5 h-4 w-4 shrink-0 text-slate-400 transition group-hover:text-orange-700"
                />
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
