import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function checkEnvVar(name: string): { name: string; present: boolean } {
  return { name, present: Boolean(process.env[name]?.trim()) };
}

export async function GET() {
  const checks = [
    checkEnvVar("RESEND_API_KEY"),
    checkEnvVar("EMAIL_NOTIFICATIONS_ENABLED"),
    checkEnvVar("NOTIFICATION_EMAIL_FROM"),
    checkEnvVar("RESEND_WEBHOOK_SECRET"),
    checkEnvVar("CRON_SECRET"),
  ];

  const allPresent = checks.every((check) => check.present);

  return NextResponse.json({
    checks,
    status: allPresent ? "healthy" : "degraded",
    timestamp: new Date().toISOString(),
  }, { status: allPresent ? 200 : 503 });
}
