import { MyMapSnapshotView, type MyMapCardFrame } from "@/components/phoenix-crm/my-map/my-map-snapshot-card";
import { canAccess, type AccessContext } from "@/lib/auth/permissions";
import { getBrowserKey } from "@/lib/google-maps/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadMyMapSnapshot } from "@/lib/phoenix-crm/server/my-map";

/**
 * My map's card on the four overview landing pages — the rep's, the district manager's, the regional and the
 * national sales manager's. It reads the reader's own snapshot and hands it to the card (`MyMapSnapshotView`),
 * with the Google Maps browser key read here for each request, the way the full map's page reads it; each landing
 * page streams it under its own `<Suspense>` and never waits for it.
 *
 * The read lives here, beside the command centres, and not with the drawing: nothing under
 * `components/phoenix-crm` may import server code (`tests/phoenix-crm-boundary.test.ts`). Anyone the CRM
 * does not admit, or whose map holds nothing to read, gets no card at all.
 */
export async function MyMapSnapshotCard({ access, frame = "manager" }: { access: AccessContext; frame?: MyMapCardFrame }) {
  if (!(await canAccess(access, "phoenix_crm", "read"))) return null;
  const viewer = await resolvePhoenixCrmViewer(access).catch(() => null);
  if (!viewer) return null;
  const snapshot = await loadMyMapSnapshot(viewer);
  if (!snapshot) return null;
  return <MyMapSnapshotView browserKey={getBrowserKey()} frame={frame} snapshot={snapshot} />;
}
