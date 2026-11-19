/**
 * The Phoenix CRM customer lists as a named workbook, for the owner and the CEO (`TABLE_TOOL_ROLES`).
 *
 * `phoenix_export_table` copies a table as it is stored, so a doctor's row carries a seat id and a line
 * code. ChatGPT cannot put the names back: it cannot open the file (the link needs a Phoenix sign-in) and
 * nineteen thousand rows do not fit in a conversation. So this tool does the join on the server —
 * seat → its holder's name, the district manager above it, the line, area and region names — the way the
 * owner's own export of 17 Nov 2026 did ("export every doctor with names instead of codes via ChatGPT").
 *
 * Read-only: three paged reads (`fetchAllRows`, stable order) through the service client, never a write.
 * Test rows (`is_test`) are always left out.
 */
import ExcelJS from "exceljs";
import { z } from "zod";

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { storeConnectorFile } from "@/lib/chatgpt-connector/files";
import { TABLE_TOOL_ROLES } from "@/lib/chatgpt-connector/tools/table-guard";
import { addPhoenixTableSheet, type ExportColumn, type ExportRow } from "@/lib/export/table-workbook";
import { cairoDateTimeSortable } from "@/lib/format/cairo-datetime";
import { defineTool } from "@/lib/chatgpt-connector/types";

export type CustomerListKind = "doctors" | "pharmacies" | "all";

/** Which `list_type` values each kind reads: AM and PM are doctors and accounts, Pharmacy the pharmacies. */
export const CUSTOMER_LIST_TYPES: Record<CustomerListKind, readonly string[]> = {
  doctors: ["AM", "PM"],
  pharmacies: ["Pharmacy"],
  all: ["AM", "PM", "Pharmacy"],
};

/** The words the Visit Report already uses for a customer's status (visit-report-values.ts). */
export const CUSTOMER_STATUS_LABELS: Record<string, string> = {
  active: "Active",
  pending: "Waiting to be validated",
  outside: "Outside the list",
  dropped: "Dropped",
};

export type CustomerRow = {
  id: string;
  seat_id: string;
  line_code: string;
  list_type: string;
  name: string;
  full_name_held: string | null;
  speciality: string | null;
  grade: string | null;
  potential_grade: string | null;
  status: string;
  origin: string | null;
  phone: string | null;
  primary_pharmacy_name: string | null;
  pharmacy_pin_address: string | null;
  pharmacy_pin_governorate: string | null;
  pharmacy_pin_area_name: string | null;
  pharmacy_pin_brick_name: string | null;
  validated_at: string | null;
  dropped_reason: string | null;
  dropped_note: string | null;
  created_at: string | null;
  status_changed_at: string | null;
};

export type SeatRow = {
  seat_id: string;
  parent_seat_id: string | null;
  occupant_hr_id: string | null;
  line_name: string | null;
  area_name: string | null;
  region_name: string | null;
};

export type PersonRow = { hr_id: string; full_name: string | null };

const CUSTOMER_COLUMNS =
  "id, seat_id, line_code, list_type, name, full_name_held, speciality, grade, potential_grade, status, origin, phone, primary_pharmacy_name, " +
  "pharmacy_pin_address, pharmacy_pin_governorate, pharmacy_pin_area_name, pharmacy_pin_brick_name, validated_at, dropped_reason, dropped_note, created_at, status_changed_at";

export const CUSTOMER_LIST_COLUMNS: ExportColumn[] = [
  { key: "name", label: "Name", width: 34 },
  { key: "full_name_held", label: "Full name held", width: 30 },
  { key: "speciality", label: "Speciality", width: 20 },
  { key: "grade", label: "Grade", width: 8 },
  { key: "potential_grade", label: "Potential", width: 10 },
  { key: "list", label: "List", width: 10 },
  { key: "status", label: "Status", width: 22 },
  { key: "line", label: "Line", width: 16 },
  { key: "region", label: "Region", width: 16 },
  { key: "area", label: "Area", width: 22 },
  { key: "rep", label: "Medical rep", width: 28 },
  { key: "manager", label: "District manager", width: 28 },
  { key: "phone", label: "Phone", width: 16, text: true },
  { key: "primary_pharmacy", label: "Primary pharmacy", width: 28 },
  { key: "pin_governorate", label: "Pharmacy governorate", width: 16 },
  { key: "pin_area", label: "Pharmacy area", width: 18 },
  { key: "pin_brick", label: "Pharmacy brick", width: 20 },
  { key: "pin_address", label: "Pharmacy address", width: 40 },
  { key: "origin", label: "Origin", width: 12 },
  { key: "added_on", label: "Added on", width: 13 },
  { key: "validated_on", label: "Validated on", width: 13 },
  { key: "status_since", label: "Status since", width: 13 },
  { key: "dropped_reason", label: "Dropped reason", width: 24 },
  { key: "dropped_note", label: "Dropped note", width: 30 },
];

/** A day in Cairo, "17 Nov 2026"; empty for no date. */
export function cairoDay(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", day: "2-digit", month: "short", year: "numeric" }).format(date);
}

/**
 * Turns the stored rows into named rows. A seat with two rows (a handover) names both holders; a seat with
 * no holder reads "Vacant"; an unknown HR id reads "Unknown employee", never the id itself.
 */
export function nameCustomerRows(customers: readonly CustomerRow[], seats: readonly SeatRow[], people: readonly PersonRow[]) {
  const nameOf = new Map(people.map((person) => [String(person.hr_id).trim().toUpperCase(), person.full_name?.trim() || "Unknown employee"]));
  const bySeat = new Map<string, SeatRow & { holders: string[] }>();
  for (const seat of seats) {
    const entry = bySeat.get(seat.seat_id) ?? { ...seat, holders: [] };
    const hrId = seat.occupant_hr_id?.trim().toUpperCase();
    if (hrId) entry.holders.push(nameOf.get(hrId) ?? "Unknown employee");
    bySeat.set(seat.seat_id, entry);
  }
  const holders = (seatId: string | null | undefined): string => {
    if (!seatId) return "";
    const seat = bySeat.get(seatId);
    if (!seat) return "";
    return seat.holders.length > 0 ? [...new Set(seat.holders)].join(" / ") : "Vacant";
  };

  const rows = customers.map((customer) => {
    const seat = bySeat.get(customer.seat_id);
    const row: ExportRow = {
      name: customer.name,
      full_name_held: customer.full_name_held ?? "",
      speciality: customer.speciality ?? "",
      grade: customer.grade ?? "",
      potential_grade: customer.potential_grade ?? "",
      list: customer.list_type,
      status: CUSTOMER_STATUS_LABELS[customer.status] ?? customer.status,
      line: seat?.line_name ?? "",
      region: seat?.region_name ?? "",
      area: seat?.area_name ?? "",
      rep: holders(customer.seat_id),
      manager: holders(seat?.parent_seat_id),
      phone: customer.phone ?? "",
      primary_pharmacy: customer.primary_pharmacy_name ?? "",
      pin_governorate: customer.pharmacy_pin_governorate ?? "",
      pin_area: customer.pharmacy_pin_area_name ?? "",
      pin_brick: customer.pharmacy_pin_brick_name ?? "",
      pin_address: customer.pharmacy_pin_address ?? "",
      origin: customer.origin ?? "",
      added_on: cairoDay(customer.created_at),
      validated_on: cairoDay(customer.validated_at),
      status_since: cairoDay(customer.status_changed_at),
      dropped_reason: customer.dropped_reason ?? "",
      dropped_note: customer.dropped_note ?? "",
    };
    return { row, onList: customer.status !== "dropped", seatKnown: Boolean(seat) };
  });
  const sortKey = (row: ExportRow) => [row.line, row.region, row.area, row.name].map((part) => String(part ?? "")).join("\u0000");
  rows.sort((a, b) => sortKey(a.row).localeCompare(sortKey(b.row)));
  return rows;
}

const n = (value: number) => value.toLocaleString("en-US");

export const exportCustomerListTool = defineTool({
  name: "phoenix_export_customer_list",
  title: "Export the CRM customer lists with names",
  description:
    "Owner and CEO. Every doctor and/or pharmacy on the Phoenix CRM customer lists as one Excel workbook with NAMES, not codes: " +
    "the medical rep and district manager by name, the line, region and area names, the status in words, dates in Cairo time. " +
    "Use it whenever the person wants the customer list, the doctors or the pharmacies as a file — prefer it over phoenix_export_table, which copies raw ids and codes. " +
    "Test rows are always left out. Dropped customers go on their own sheet unless status narrows it.",
  roles: TABLE_TOOL_ROLES,
  input: {
    kind: z.enum(["doctors", "pharmacies", "all"]).optional().describe("doctors = the AM and PM lists (the default), pharmacies = the pharmacy lists, all = both."),
    status: z.enum(["on_list", "dropped", "all"]).optional().describe("on_list = active, waiting and outside the list; dropped = the Archive; all = both, on two sheets (the default)."),
    line: z.string().max(60).optional().describe("Only this line, by name (Pedia, CNS, Anti Infective). Default: every line."),
    vacantOnly: z.boolean().optional().describe("Only customers whose territory has no medical rep right now."),
    title: z.string().max(150).optional().describe("The workbook's title."),
  },
  async run(ctx, input) {
    const kind: CustomerListKind = input.kind ?? "doctors";
    const status = input.status ?? "all";
    const db = getSupabaseAdmin();
    const [customers, seats, people] = await Promise.all([
      fetchAllRows<CustomerRow>(
        // A "Campaign visit N" holder carries imported visit history only and is never a customer: Phoenix's own list
        // leaves it out (phoenix-crm/server/list.ts), and so does this one.
        () =>
          db
            .from("phoenix_crm_customers")
            .select(CUSTOMER_COLUMNS)
            .eq("is_test", false)
            .eq("campaign_visit_holder", false)
            .in("list_type", [...CUSTOMER_LIST_TYPES[kind]]),
        "id",
      ),
      fetchAllRows<SeatRow>(
        () => db.from("au_v_org_tree").select("seat_id, parent_seat_id, occupant_hr_id, line_name, area_name, region_name").order("seat_id", { ascending: true }),
        "occupant_hr_id",
      ),
      fetchAllRows<PersonRow>(() => db.from("employees").select("hr_id, full_name"), "hr_id"),
    ]);

    const wantedLine = input.line?.trim().toLowerCase() ?? "";
    const named = nameCustomerRows(customers, seats, people).filter(
      (entry) =>
        (!wantedLine || String(entry.row.line ?? "").toLowerCase() === wantedLine) &&
        (!input.vacantOnly || entry.row.rep === "Vacant"),
    );
    const onList = status === "dropped" ? [] : named.filter((entry) => entry.onList).map((entry) => entry.row);
    const dropped = status === "on_list" ? [] : named.filter((entry) => !entry.onList).map((entry) => entry.row);
    const what = kind === "doctors" ? "doctors" : kind === "pharmacies" ? "pharmacies" : "doctors and pharmacies";
    if (onList.length + dropped.length === 0) {
      return { summary: `No ${what} on the customer lists match that; no file was made.`, data: { rows: 0 } };
    }

    const title = (input.title ?? "").trim() || `Phoenix CRM ${what} — every one on the customer lists${input.line ? ` — ${input.line.trim()}` : ""}`;
    const built = `built ${cairoDateTimeSortable(new Date().toISOString())} Cairo · test rows left out`;
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Phoenix Workforce";
    workbook.created = new Date();
    if (onList.length > 0 || status !== "dropped") {
      addPhoenixTableSheet(workbook, { title, subtitle: `On the lists · ${n(onList.length)} · ${built}`, sheetName: "On the lists", columns: CUSTOMER_LIST_COLUMNS, rows: onList, theme: "house" });
    }
    if (status !== "on_list") {
      addPhoenixTableSheet(workbook, { title, subtitle: `Dropped · ${n(dropped.length)} · ${built}`, sheetName: "Dropped", columns: CUSTOMER_LIST_COLUMNS, rows: dropped, theme: "house" });
    }
    const body = Buffer.from(await workbook.xlsx.writeBuffer());
    const file = await storeConnectorFile(ctx, { kind: "xlsx", title, body });
    const vacant = onList.filter((row) => row.rep === "Vacant").length;
    return {
      summary:
        `The sheet is ready: ${file.fileName} — ${n(onList.length)} ${what} on the lists` +
        (status !== "on_list" ? ` and ${n(dropped.length)} dropped on a second sheet` : "") +
        `, with the medical rep, district manager, line, region and area by name` +
        (vacant > 0 ? ` (${n(vacant)} on the lists sit in a territory with no rep right now and read "Vacant")` : "") +
        `. Download it here (it opens for you only, while you are signed in to Phoenix, until ${cairoDateTimeSortable(file.expiresAt)} Cairo): ${file.url}`,
      data: {
        download_url: file.url,
        file_name: file.fileName,
        on_lists: onList.length,
        dropped: dropped.length,
        vacant_on_lists: vacant,
        size_bytes: file.sizeBytes,
        expires_at: file.expiresAt,
      },
    };
  },
});
