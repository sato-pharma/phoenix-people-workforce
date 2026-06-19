import { WorkspacePlansPage } from "@/components/workspace/admin-shell-employee-pages";

export const dynamic = "force-dynamic";

export default async function WorkspacePlansRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <WorkspacePlansPage searchParams={await searchParams} />;
}
