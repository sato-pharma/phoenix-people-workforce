import { WorkspaceVacationReportPage } from "@/components/workspace/admin-shell-employee-pages";

export const dynamic = "force-dynamic";

export default async function WorkspaceVacationReportRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <WorkspaceVacationReportPage searchParams={await searchParams} />;
}
