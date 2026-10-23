import { heartbeatResponse, runSessionHeartbeat } from "@/lib/auth/session-heartbeat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The session keep-alive. Everything it does lives in `runSessionHeartbeat`
 * (src/lib/auth/session-heartbeat.ts) so /api/auth/pulse — the folded poll that carries this
 * heartbeat together with the sidebar badges and the notification list — runs the same code rather
 * than a second copy of it. This path is unchanged in what it answers.
 */
export async function POST(request: Request) {
  return heartbeatResponse(await runSessionHeartbeat(request));
}
