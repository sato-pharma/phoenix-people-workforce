import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import {
  decideExcuseRequestAsManager,
  decideExcuseRequestByToken,
  excuseErrorMessage,
  isExcusesSchemaMissing,
  parseExcuseDecision,
} from "@/lib/excuses/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function resultHtml(input: { message: string; success: boolean; title: string }) {
  const color = input.success ? "#047857" : "#be123c";
  const background = input.success ? "#ecfdf5" : "#fff1f2";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${input.title}</title>
  </head>
  <body style="margin:0;background:#f8fafc;color:#0f172a;font-family:Arial,Helvetica,sans-serif">
    <main style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px">
      <section style="width:100%;max-width:560px;border:1px solid #dbe3ee;border-radius:18px;background:white;padding:28px;box-shadow:0 18px 45px rgba(15,23,42,.12)">
        <p style="margin:0 0 10px;color:#f97316;font-size:11px;font-weight:900;letter-spacing:.2em;text-transform:uppercase">Phoenix Workforce</p>
        <h1 style="margin:0;color:#0f172a;font-size:24px;line-height:1.2">${input.title}</h1>
        <p style="margin:16px 0 0;border:1px solid ${color};border-radius:12px;background:${background};padding:14px;color:${color};font-size:14px;font-weight:700;line-height:1.6">${input.message}</p>
      </section>
    </main>
  </body>
</html>`;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const url = new URL(request.url);
    const decision = parseExcuseDecision(url.searchParams.get("decision"));
    const token = url.searchParams.get("token");

    if (!decision || !token) {
      return new Response(
        resultHtml({
          message: "This excuse approval link is missing required data.",
          success: false,
          title: "Excuse Decision Failed",
        }),
        { headers: { "Content-Type": "text/html; charset=utf-8" }, status: 400 },
      );
    }

    const result = await decideExcuseRequestByToken({ decision, requestId: id, token });

    return new Response(
      resultHtml({
        message: result.status === "approved"
          ? "Manager review was recorded as approved. This 2-hour excuse will appear on the employee private calendar."
          : `Manager review was recorded as ${result.status}.`,
        success: true,
        title: "Excuse Review Recorded",
      }),
      { headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  } catch (error) {
    const message = isExcusesSchemaMissing(error)
      ? "Excuse database tables are not deployed yet."
      : excuseErrorMessage(error) || "Unable to decide excuse request.";
    return new Response(
      resultHtml({
        message,
        success: false,
        title: "Excuse Decision Failed",
      }),
      { headers: { "Content-Type": "text/html; charset=utf-8" }, status: 400 },
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const access = await resolveAccessContext(request);
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const decision = parseExcuseDecision(body.decision);
    if (!decision) {
      return NextResponse.json(
        { error: "invalid_decision", message: "Decision must be 'approve' or 'reject'.", success: false },
        { status: 400 },
      );
    }
    const comment = typeof body.comment === "string" ? body.comment.trim() || null : null;
    const result = await decideExcuseRequestAsManager(access, { requestId: id, decision, comment });
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    const message = isExcusesSchemaMissing(error)
      ? "Excuse database tables are not deployed yet."
      : excuseErrorMessage(error) || "Unable to decide excuse request.";
    const isForbidden = message.startsWith("Forbidden") || message.includes("not the assigned manager");
    return NextResponse.json(
      { error: "decision_failed", message, success: false },
      { status: isForbidden ? 403 : 400 },
    );
  }
}
