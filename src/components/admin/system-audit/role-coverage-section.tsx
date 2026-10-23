import { RoleCoverageAuditView } from "@/components/admin/role-coverage-audit";
import { Card } from "@/components/ui/card";
import { getRoleCoverageAudit } from "@/lib/admin/role-coverage/audit";

/**
 * The Role coverage section of the System Audit page — moved here INTACT from the retired
 * /admin/data-health page on 23 Oct 2026 (owner rule: "Role coverage is part of the Super Admin
 * deep audit", .claude/rules/platform.md).
 *
 * An async server component, so the page mounts it inside its own <Suspense>: it calls every
 * registered module's own people list, and one slow module must never hold the sections around it.
 */
export async function RoleCoverageSection() {
  // Data fetch and JSX stay separated (react-hooks/error-boundaries: no JSX inside try/catch).
  let audit: Awaited<ReturnType<typeof getRoleCoverageAudit>> | null = null;
  let loadError: string | null = null;
  try {
    audit = await getRoleCoverageAudit();
  } catch (error) {
    console.error("Failed to load the Role Coverage audit:", error);
    loadError = error instanceof Error ? error.message : "Unknown error occurred";
  }

  if (!audit) {
    return (
      <Card className="border border-rose-200 bg-white p-6">
        <h2 className="text-lg font-black tracking-tight text-rose-900">Role Coverage could not be measured</h2>
        <p className="mt-1 break-words text-sm text-rose-700">{loadError ?? "Unknown error occurred"}</p>
      </Card>
    );
  }
  return <RoleCoverageAuditView audit={audit} />;
}
