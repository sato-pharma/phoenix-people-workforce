import { notFound, redirect } from "next/navigation";
import { UserCog } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { DevPreviewPicker } from "@/components/admin/dev-preview-picker";
import { listDevPreviewCandidates } from "@/lib/auth/dev-preview-picker";
import { phoenixRoles, type PhoenixRole } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

function resolveInitialRole(value: string | undefined): PhoenixRole {
  return (phoenixRoles as readonly string[]).includes(value ?? "") ? (value as PhoenixRole) : phoenixRoles[0];
}

export default async function DevPreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ area?: string; error?: string; line?: string; region?: string; role?: string }>;
}) {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }

  const access = await resolveAccessContextFromPage();
  if (access.role !== "Super Admin") {
    redirect("/admin/admin-tools");
  }

  const params = await searchParams;
  const initialRole = resolveInitialRole(params.role);
  const initialCandidates = await listDevPreviewCandidates(initialRole);

  return (
    <div className="space-y-6">
      <AdminPageHero
        description="Pick a role, then narrow by line, region, and area (District Manager territory) — or pick an exact person by name. Leave any level on auto-pick and the app selects a real, active employee for you. Local development only; it switches you out of your own session."
        eyebrow="System · Local dev only"
        icon={<UserCog className="h-3.5 w-3.5" />}
        title="Dev Preview (Real Data)"
      />
      <DevPreviewPicker
        error={params.error ?? null}
        initialArea={params.area ?? null}
        initialCandidates={initialCandidates}
        initialLine={params.line ?? null}
        initialRegion={params.region ?? null}
        initialRole={initialRole}
        roles={phoenixRoles}
      />
    </div>
  );
}
