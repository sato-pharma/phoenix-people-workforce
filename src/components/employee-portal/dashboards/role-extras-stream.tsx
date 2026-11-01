import type { PortalHomeRoleExtras, PortalHomeSnapshot } from "@/lib/employee-portal/home-snapshot";

/**
 * The manager's slow landing reads — the team, region or national figures, the rankings, the CRM
 * first-visit board, the marketing inbox — as ONE promise, whether the snapshot streamed them or not.
 *
 * The landing page asks for `streamRoleExtras`, so for a District, Regional or National Sales Manager
 * and the Marketing Manager they arrive on `snapshot.roleCards` STILL RUNNING and each section fills
 * under its own Suspense; the identity band, pending actions and dashboards grid paint without them.
 * Every other caller hands over a whole snapshot, and this resolves at once to the same six fields.
 * `getRoleSpecificExtras` never rejects, so no boundary needs an error fallback.
 */
export function roleExtrasOf(snapshot: PortalHomeSnapshot): Promise<PortalHomeRoleExtras> {
  if (snapshot.roleCards) return snapshot.roleCards;
  return Promise.resolve({
    pmMarketing: snapshot.pmMarketing,
    mmOverview: snapshot.mmOverview,
    dsmTeam: snapshot.dsmTeam,
    nsmNational: snapshot.nsmNational,
    nsmBoard: snapshot.nsmBoard,
    rmRegional: snapshot.rmRegional,
  });
}

/**
 * Waits for one card's own read and draws the card — always inside its own Suspense. On the landing the
 * value is still running; on the Training Manager's page, which reads the whole snapshot, it is already in.
 */
export async function AwaitCard<V>({ value, children }: { value: V; children: (resolved: Awaited<V>) => React.ReactNode }) {
  return <>{children(await value)}</>;
}

/** Waits for the role extras and draws one section from them — always inside its own Suspense. */
export async function AwaitRoleExtras({
  extras,
  children,
}: {
  extras: Promise<PortalHomeRoleExtras>;
  children: (extras: PortalHomeRoleExtras) => React.ReactNode;
}) {
  return <>{children(await extras)}</>;
}
