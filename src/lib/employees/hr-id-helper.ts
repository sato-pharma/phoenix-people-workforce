function getRequiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

const databaseQueryTimeoutMs = 8000;

async function supabaseRest<T>(path: string, init: RequestInit = {}): Promise<{ data: T }> {
  const url = getRequiredEnv("NEXT_PUBLIC_SUPABASE_URL").replace(/\/+$/g, "");
  const serviceRoleKey = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), databaseQueryTimeoutMs);

  try {
    const response = await fetch(`${url}/rest/v1/${path}`, {
      ...init,
      cache: "no-store",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;

    if (!response.ok) {
      throw new Error(
        typeof payload?.message === "string"
          ? payload.message
          : `Supabase request failed with ${response.status}.`,
      );
    }

    return { data: payload as T };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Supabase request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function generateNextHrIdForLine(
  lineId: number | null
) {
  let prefix = "PH";

  if (lineId) {
    try {
      const { data: lines } = await supabaseRest<Array<{ name: string; code: string | null }>>(
        "lines?id=eq." + lineId + "&select=name,code"
      );
      const line = lines[0];
      if (line) {
        const searchStr = `${line.name} ${line.code || ""}`.toLowerCase();
        if (searchStr.includes("anti")) prefix = "AI";
        else if (searchStr.includes("pedia")) prefix = "PD";
        else if (searchStr.includes("cns")) prefix = "CN";
        else if (searchStr.includes("office")) prefix = "OF";
      }
    } catch (error) {
      console.error("Failed to fetch line for HR_ID generation:", error);
      // Fallback to PH prefix if line fetch fails
    }
  }

  const retryLimit = 5;
  for (let attempt = 0; attempt < retryLimit; attempt++) {
    // Find the current highest numeric suffix for this prefix
    const params = new URLSearchParams();
    params.append("hr_id", "like." + prefix + "-%");
    params.append("select", "hr_id");
    params.append("order", "hr_id.desc");
    params.append("limit", "50");

    const searchParams = params.toString();
    const restPath = "employees?" + searchParams;
    const response = await supabaseRest<Array<{ hr_id: string }>>(restPath);
    const employees = response.data || [];

    let maxNum = 0;
    const pattern = "^" + prefix + "-(\\d+)$";
    const regex = new RegExp(pattern);

    for (const row of employees) {
      const hrId = row.hr_id;
      const match = hrId.match(regex);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > maxNum) {
          maxNum = num;
        }
      }
    }

    const nextNum = maxNum + 1 + attempt;
    const nextHrId = prefix + "-" + String(nextNum).padStart(4, "0");

    // Double check uniqueness to handle race conditions
    const checkPath = "employees?hr_id=eq." + nextHrId + "&select=hr_id";
    const checkResponse = await supabaseRest<Array<{ hr_id: string }>>(checkPath);
    const existing = checkResponse.data || [];

    if (existing.length === 0) {
      return nextHrId;
    }
  }

  throw new Error("Failed to generate a unique HR_ID for prefix " + prefix + " after " + retryLimit + " attempts.");
}
