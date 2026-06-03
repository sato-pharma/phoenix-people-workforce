import { revalidatePath } from "next/cache.js";

export type ExecutiveDashboardModule =
  | "employees"
  | "vacancies"
  | "payroll"
  | "sales"
  | "expenses"
  | "contracts"
  | "probation"
  | "offers"
  | "recruitment"
  | "resignations"
  | "leave"
  | "operations";

export function invalidateExecutiveDashboardCache(
  reason: string,
  modules: ExecutiveDashboardModule[] = [],
) {
  const uniqueModules = Array.from(new Set(modules));
  try {
    revalidatePath("/admin/ceo-command-center");
    revalidatePath("/admin");
    revalidatePath("/overview");
  } catch (error) {
    console.warn("Executive dashboard route revalidation failed.", {
      error: error instanceof Error ? error.message : String(error),
      modules: uniqueModules,
      reason,
    });
  }
}
