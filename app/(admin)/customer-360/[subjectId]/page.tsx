import Link from "next/link";
import { ArrowLeft, Building2 } from "lucide-react";
import { redirect } from "next/navigation";

import { Customer360View } from "@/components/customer-360/customer-360-view";
import { Card } from "@/components/ui/card";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { filterCustomerSubjectsForViewer } from "@/lib/customer-360/access";
import {
  getCustomer360Profile,
  listCustomerSubjects,
  resolveCustomerSubjectRef,
} from "@/lib/customer-360/service";
import {
  customerRegisterLabel,
  decodeCustomerSubjectId,
  encodeCustomerSubjectId,
} from "@/lib/customer-360/subject";
import { resolveSalesAccessScope } from "@/lib/sales/access-scope";

export const dynamic = "force-dynamic";

function NotFound({ message }: { message: string }) {
  return (
    <div className="mx-auto max-w-3xl p-6">
      <Card className="rounded-none border-slate-200/80 bg-white p-6 text-center shadow-[0_10px_30px_rgba(15,23,42,0.05)]">
        <span className="mx-auto flex h-12 w-12 items-center justify-center bg-slate-100 text-slate-400">
          <Building2 className="h-5 w-5" />
        </span>
        <h1 className="mt-3 text-lg font-black text-slate-900">Customer not found</h1>
        <p className="mt-1 break-words text-sm text-slate-500">{message}</p>
        <Link
          href="/customer-360"
          className="mt-4 inline-flex items-center gap-1.5 text-sm font-bold text-orange-600 hover:underline"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Customer 360
        </Link>
      </Card>
    </div>
  );
}

export default async function Customer360DetailPage({
  params,
}: {
  params: Promise<{ subjectId: string }>;
}) {
  const { subjectId } = await params;
  const access = await resolveAuthenticatedPageAccess();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals/source-of-sales");
  }
  await assertPermission(access, "sales", "read");

  const requested = decodeCustomerSubjectId(subjectId);
  if (!requested) return <NotFound message="That customer link is not one this page recognises." />;

  // A merged record IS the record it was merged into, so an old link canonicalises to the survivor
  // instead of dying on the picker's merged-row exclusion. This is not a rare path: a validated
  // Source of Sales batch stores the Phoenix code a pharmacy had when its order was injected and is
  // never rewritten, so the August 2026 batch will point at DOP-000034 for good. Redirecting rather
  // than rendering the survivor under the old URL keeps the promise the picker makes — one URL per
  // pharmacy — and lets a bookmark heal itself.
  const ref = await resolveCustomerSubjectRef(requested);
  const canonicalId = encodeCustomerSubjectId(ref);
  if (canonicalId !== subjectId) redirect(`/customer-360/${canonicalId}`);

  // Gate on the SAME scope the list is filtered by, so a typed URL cannot reach a customer the
  // picker would never have offered.
  const scope = await resolveSalesAccessScope(access);
  const visibility = {
    allowedAreaCodes: scope.allowedAreaCodes,
    allowedLineNames: scope.allowedLineNames,
    allowedRegionNames: scope.allowedRegionNames,
    canViewAllSales: scope.canViewAllSales,
  };
  const subjects = await listCustomerSubjects();
  const subject = subjects.find((entry) => entry.id === canonicalId);
  if (!subject) return <NotFound message="No customer record matches that link." />;
  if (filterCustomerSubjectsForViewer([subject], visibility).length === 0) {
    redirect("/customer-360");
  }

  // The "also known as" note crosses territories by its nature, so it is offered on the SAME
  // company-scope bound the picker uses for its widest tier — never to an area- or region-bounded
  // viewer, who would otherwise read the name of a pharmacy this page would never have offered him.
  const profile = await getCustomer360Profile(ref, access.role, visibility.canViewAllSales);
  if (!profile) return <NotFound message="No customer record matches that link." />;

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
      <Link
        href="/customer-360"
        className="inline-flex items-center gap-1.5 text-[13px] font-bold text-orange-600 hover:underline"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Customer 360
      </Link>

      <header className="border border-slate-200 bg-white p-5 shadow-sm">
        <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">
          {customerRegisterLabel(profile.register)}
        </p>
        {/* A customer name is free text and is frequently Arabic — "(مصر)حازم" is a real one.
            It is SINGLE-language, which is the case block-level dir="auto" is house style for; the
            composed territory line below it is our own English vocabulary and must NOT take one. */}
        <h1 dir="auto" className="mt-1 break-words text-2xl font-black tracking-tight text-slate-950">
          {profile.displayName}
        </h1>
        <p className="mt-1 break-words text-[13px] font-semibold text-slate-500">
          {[profile.areaName, profile.regionName, profile.lineName].filter(Boolean).join(" · ") ||
            "No territory recorded"}
        </p>
      </header>

      <Customer360View profile={profile} />
    </div>
  );
}
