import { NextResponse } from "next/server";

import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { buildHrCalendarEvents } from "@/lib/hr-calendar/calendar-logic";
import { isBirthdayEligibleEmployee } from "@/lib/notifications/birthday-eligibility";
import { createSystemNotification } from "@/lib/notifications/system";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { bearerSecretMatches } from "@/lib/security/constant-time";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type BirthdayEmployeeRow = {
  birth_date: string | null;
  employment_status: string | null;
  full_name: string;
  hr_id: string;
  nickname: string | null;
};

function cairoMonthDay() {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Africa/Cairo",
  }).formatToParts(new Date());
  const month = parts.find((part) => part.type === "month")?.value ?? "";
  const day = parts.find((part) => part.type === "day")?.value ?? "";
  return `${month}-${day}`;
}

function cairoYear() {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(new Date());
}

function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  // An unset CRON_SECRET may ONLY be bypassed on a real developer machine. Anything less
  // would leave this route callable unauthenticated wherever CRON_SECRET is unset —
  // including staging, which is a 1:1 clone of production data.
  if (!secret) return process.env.NODE_ENV === "development";
  return bearerSecretMatches(request.headers.get("authorization"), secret);
}

export async function runBirthdayNotifications(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized", message: "Birthday notification run is not authorized." }, { status: 401 });
  }

  const today = cairoMonthDay();
  const year = cairoYear();
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("employees")
    .select("hr_id,full_name,nickname,birth_date,employment_status")
    .not("birth_date", "is", null);

  if (error) throw error;

  const activeEmployees = ((data ?? []) as BirthdayEmployeeRow[]).filter(isBirthdayEligibleEmployee);
  const [monthText, dayText] = today.split("-");
  const birthdayEvents = buildHrCalendarEvents(
    activeEmployees.map((employee) => ({
      areaName: "",
      birthDate: employee.birth_date ?? "",
      fullName: resolveEmployeeDisplayName(employee.full_name, employee.nickname),
      hireDate: "",
      hrId: employee.hr_id,
      jobTitle: "",
      lineName: "",
      managerName: "",
      workEmail: null,
    })),
    Number(monthText),
    Number(year),
  ).filter((event) => event.eventType === "birthday" && event.date.slice(5, 10) === `${monthText}-${dayText}`);
  const results = [];

  for (const event of birthdayEvents) {
    const employee = event.employee;
    // Isolated per employee: one bad send (e.g. a transient email/network error) must not abort
    // the loop and skip every remaining employee's birthday notification for today.
    try {
      const result = await createSystemNotification({
        actorId: "system",
        email: {
          employeeHrId: employee.hrId,
          metrics: [
            { label: "Employee", value: `${employee.fullName} (${employee.hrId})` },
            { label: "Birthday", value: today },
            { label: "Year", value: year },
          ],
          notificationType: "birthday",
          recipientMode: "employee",
          subject: `Happy Birthday, ${employee.fullName}`,
          summary: `Happy birthday wishes for ${employee.fullName}.`,
          title: "Happy Birthday",
          tone: "neutral",
        },
        eventType: "birthday_today",
        message: `Happy birthday wishes for ${employee.fullName}.`,
        metadata: {
          employeeHrId: employee.hrId,
          idempotencyKey: `birthday:${employee.hrId}:${year}`,
        },
        module: "birthday",
        priority: "normal",
        recipientHrId: employee.hrId,
        subjectHrId: employee.hrId,
        title: "Happy Birthday",
      });
      results.push({ employeeHrId: employee.hrId, result });
    } catch (error) {
      console.error(error, { tags: { cron: "birthday-notifications", employeeHrId: employee.hrId } });
      results.push({
        employeeHrId: employee.hrId,
        result: { error: error instanceof Error ? error.message : String(error), sent: false },
      });
    }
  }

  return NextResponse.json({
    matched: birthdayEvents.length,
    results,
    today,
  });
}

export async function GET(request: Request) {
  // Only authorized cron runs are monitored, so unrelated pings don't record check-ins.
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized", message: "Birthday notification run is not authorized." }, { status: 401 });
  }
  try {
    return await runBirthdayNotifications(request);
  } catch (error) {
    console.error(error, { tags: { cron: "birthday-notifications" } });
    const message = clientSafeErrorMessage(error, "Birthday notification run failed.");
    return NextResponse.json({ error: "birthday_notifications_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
