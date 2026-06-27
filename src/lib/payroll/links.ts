export type PayrollBatchLinkAudience = "operational" | "executive";

function encodedBatchId(batchId: string | number) {
  return encodeURIComponent(String(batchId));
}

export function payrollBatchHref(batchId: string | number, audience: PayrollBatchLinkAudience = "operational") {
  const query = `batchId=${encodedBatchId(batchId)}`;
  return audience === "executive" ? `/admin/m-payroll?${query}` : `/payroll?${query}`;
}

export function payrollBatchRoleHrefs(batchId: string | number) {
  return {
    CEO: payrollBatchHref(batchId, "executive"),
  };
}

export function payrollBatchNotificationMetadata(batchId: string | number) {
  return {
    batchId: String(batchId),
    roleHrefs: payrollBatchRoleHrefs(batchId),
  };
}
