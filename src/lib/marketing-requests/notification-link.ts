import type { NavigationMode } from "@/lib/auth/permissions";

/**
 * Where a marketing-request notification link should actually land.
 *
 * A notification's `actionUrl` is stored ONCE per event and shared by every recipient
 * (createSystemNotification fans out per recipient but never rewrites the URL), so no hardcoded
 * path can be correct for everyone: the approver chain mixes admin-shell roles (Super Admin, SFE
 * Manager, Marketing Manager) with portal roles (National Sales Manager, District Manager), and
 * each shell's guard redirects the other shell's users away.
 *
 * The stored link is therefore shell-neutral (`/marketing-requests/<id>`) and this resolves it at
 * click time from the viewer's own navigation mode.
 *
 * The previous link pointed at `/admin/approvals-hub`, which excludes marketing BY DESIGN —
 * see the comment in src/lib/action-center/service.ts: "Marketing is intentionally excluded
 * everywhere — it keeps its own dedicated inbox." Every marketing notification therefore deep-linked
 * to a page that could never show the item.
 */
export const MARKETING_REQUEST_LINK_BASE = "/marketing-requests";

/** Shell-neutral link to store on a notification. Resolved per viewer by the route below it. */
export function marketingRequestNotificationUrl(requestId: string, decision?: "approve" | "reject" | "return") {
  const base = `${MARKETING_REQUEST_LINK_BASE}/${encodeURIComponent(requestId)}`;
  return decision ? `${base}?decision=${decision}` : base;
}

/**
 * Resolve the shell-neutral link to a real page for one viewer.
 *
 * Without a decision the viewer lands in the marketing **inbox** for their shell — the owner's
 * rule (2026-08-03): the inbox is the hub for marketing requests. With a decision (the Telegram
 * approve/reject/return buttons) they land on that request's decision page, since the button
 * already expresses the intent and the inbox would be a detour.
 */
export function resolveMarketingRequestDestination(params: {
  decision?: string | null;
  navigationMode: NavigationMode;
  requestId: string;
}): string {
  const isAdminShell = params.navigationMode === "admin";
  const id = encodeURIComponent(params.requestId);
  const decision = normalizeDecision(params.decision);

  if (decision) {
    return isAdminShell
      ? `/workspace/marketing-requests/decision/${id}?decision=${decision}`
      : `/employee-portals/marketing-requests/decision/${id}?decision=${decision}`;
  }

  // `request` is carried through so support can tie a notification back to its request, and so a
  // future highlight in the inbox has the id already in the URL.
  return isAdminShell
    ? `/admin/marketing-requests/inbox?request=${id}`
    : `/employee-portals/marketing-requests/inbox?request=${id}`;
}

/** Anything outside the three real decisions is dropped rather than reflected into a URL. */
function normalizeDecision(value: string | null | undefined): "approve" | "reject" | "return" | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "approve" || normalized === "reject" || normalized === "return" ? normalized : null;
}
