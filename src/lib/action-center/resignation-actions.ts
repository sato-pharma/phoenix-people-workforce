export type ResignationAction = {
  key: "mark_review" | "approve" | "reject";
  label: string;
  variant: "approve" | "reject" | "neutral";
};

/**
 * The buttons the Other Approvals inbox offers on a resignation, decided from the STORED status
 * (`submitted`, `under_review`) and never from the words printed on screen.
 *
 * From 2026-10-29 (#6658) the printed label became "Submitted" / "Under review", while this choice
 * kept comparing against the lower-case code with underscores, so every resignation showed "No
 * workflow actions available." — no Approve, no Reject, no Mark Under Review. The code is carried
 * on the item (`ResignationDetail.status`) for exactly this reason.
 */
export function resolveResignationActions(status: string | null | undefined): ResignationAction[] {
  const code = String(status ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (code === "submitted") {
    return [
      { key: "mark_review", label: "Mark Under Review", variant: "neutral" },
      { key: "reject", label: "Reject", variant: "reject" },
    ];
  }
  if (code === "under_review") {
    return [
      { key: "approve", label: "Approve", variant: "approve" },
      { key: "reject", label: "Reject", variant: "reject" },
    ];
  }
  return [];
}
