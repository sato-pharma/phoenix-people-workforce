import { AppShell } from "@/components/layout/app-shell";
import { OutstationPolicyAdmin } from "@/components/outstation/outstation-policy-admin";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getOutstationPolicies } from "@/lib/outstation/service";

export const dynamic = "force-dynamic";

export default async function AdminOutstationPolicyPage() {
  const access = await resolveAccessContextFromPage();
  await assertPermission(access, "outstation", "update");
  const policies = await getOutstationPolicies();

  return (
    <AppShell navigationMode="admin">
      <OutstationPolicyAdmin initialPolicies={policies} />
    </AppShell>
  );
}
