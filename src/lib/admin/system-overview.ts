import type { AccessContext } from "@/lib/auth/permissions";
import { getCeoCommandCenterData, type CeoCommandCenterData } from "@/lib/ceo/command-center";
import { getFinanceCommandCenterData, type FinanceCommandCenterView } from "@/lib/finance/command-center";
import { logError } from "@/lib/observability/log";

/**
 * The System Administrator Overview's data.
 *
 * The Super Admin's landing page used to be the generic Admin Command Center — a link farm with a
 * handful of counters bolted on. It is now the CEO's own overview, plus the part of the Finance
 * Manager's page that answers whether the company's money is moving. The Super Admin can action
 * strictly more than either of them, so the correct shape of his landing page is the union of
 * theirs, not a reduced version of one.
 *
 * The two sources are loaded independently and the Finance half is optional. That asymmetry is
 * deliberate: the CEO half IS the page — without it there is nothing to render, so it throws and
 * the caller shows an error. The Finance half is an addition, so a failure there drops three bands
 * and leaves the rest of the page working. Never let one degrade into zeros: a confident `EGP 0`
 * on net payroll is worse than a band that is honestly absent.
 */
export type SystemAdminOverviewData = {
  ceo: CeoCommandCenterData;
  /** Null when the finance aggregates did not answer. The Finance bands are omitted, not zeroed. */
  finance: FinanceCommandCenterView | null;
};

export async function getSystemAdminOverviewData(access: AccessContext): Promise<SystemAdminOverviewData> {
  // Both start together — the finance RPC is the slower of the two and there is no reason to
  // serialize them. `allSettled` rather than `all` so a finance failure cannot reject the pair.
  const [ceoResult, financeResult] = await Promise.allSettled([
    getCeoCommandCenterData(access),
    getFinanceCommandCenterData(access),
  ]);

  if (ceoResult.status === "rejected") {
    // Rethrown, not swallowed. The page renders its error card from this; a half-page that
    // silently omits every executive band would read as "nothing needs your attention".
    throw ceoResult.reason instanceof Error ? ceoResult.reason : new Error(String(ceoResult.reason));
  }

  let finance: FinanceCommandCenterView | null = null;
  if (financeResult.status === "fulfilled") {
    finance = financeResult.value;
  } else {
    logError("System administrator overview: finance bands unavailable", {
      error: financeResult.reason,
      labels: { event: "system_admin_overview_finance_failed" },
    });
  }

  return { ceo: ceoResult.value, finance };
}
