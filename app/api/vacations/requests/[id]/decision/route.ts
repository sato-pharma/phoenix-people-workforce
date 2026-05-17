import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  decideVacationRequest,
  decideVacationRequestByToken,
  isVacationSchemaMissing,
  parseVacationDecision,
  vacationErrorMessage,
} from "@/lib/vacation/service";

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

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const access = await resolveAccessContext(request);
    const body = await request.json();
    const decision = parseVacationDecision(body.decision);
    if (!decision) {
      return NextResponse.json({ error: "invalid_decision", message: "Vacation decision is invalid.", success: false }, { status: 400 });
    }

    const result = await decideVacationRequest(access, {
      decision,
      decisionComment: body.decisionComment,
      requestId: id,
    });

    return NextResponse.json({ request: result, success: true });
  } catch (error) {
    const message = vacationErrorMessage(error) || "Unable to decide vacation request.";
    if (isForbiddenError(error) || message.toLowerCase().startsWith("forbidden:")) {
      return NextResponse.json({ error: "forbidden", message, success: false }, { status: 403 });
    }
    if (isVacationSchemaMissing(error)) {
      return NextResponse.json({ error: "vacation_schema_missing", message, success: false }, { status: 409 });
    }
    return NextResponse.json({ error: "vacation_decision_failed", message, success: false }, { status: 400 });
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const url = new URL(request.url);
    const decision = parseVacationDecision(url.searchParams.get("decision"));
    const token = url.searchParams.get("token");

    if (!decision || !token) {
      return new Response(
        resultHtml({
          message: "This vacation approval link is missing required data.",
          success: false,
          title: "Vacation Decision Failed",
        }),
        { headers: { "Content-Type": "text/html; charset=utf-8" }, status: 400 },
      );
    }

    await decideVacationRequestByToken({ decision, requestId: id, token });

    return new Response(
      resultHtml({
        message: `Vacation request ${decision === "approve" ? "approved" : "rejected"} successfully.`,
        success: true,
        title: "Vacation Decision Completed",
      }),
      { headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  } catch (error) {
    return new Response(
      resultHtml({
        message: vacationErrorMessage(error) || "Unable to decide vacation request.",
        success: false,
        title: "Vacation Decision Failed",
      }),
      { headers: { "Content-Type": "text/html; charset=utf-8" }, status: 400 },
    );
  }
}
