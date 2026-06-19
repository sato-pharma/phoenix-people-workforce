import { WorkspaceDeductionsPage } from "@/components/workspace/admin-shell-employee-pages";

export const dynamic = "force-dynamic";

export default async function WorkspaceDeductionsRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <WorkspaceDeductionsPage searchParams={await searchParams} />;
}
