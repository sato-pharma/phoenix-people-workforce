import { OutstationPolicyAdmin } from "@/components/outstation/outstation-policy-admin";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { getOutstationPolicies } from "@/lib/outstation/service";

export const dynamic = "force-dynamic";

export default async function AdminOutstationPolicyPage() {
  const access = await resolveAuthenticatedPageAccess();
  await assertPermission(access, "outstation", "update");
  const policies = await getOutstationPolicies();

  return <OutstationPolicyAdmin initialPolicies={policies} />;
}
