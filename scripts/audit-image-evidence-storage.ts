import fs from "node:fs";
import postgres from "postgres";

type ReportSection = {
  error?: string;
  name: string;
  rows?: unknown[];
};

function loadLocalEnv(path = ".env.local") {
  const env: Record<string, string> = {};
  const content = fs.readFileSync(path, "utf8");

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const equalsIndex = line.indexOf("=");
    if (equalsIndex < 0) continue;

    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }

  return env;
}

async function main() {
  const env = loadLocalEnv();
  const databaseUrl = env.SUPABASE_DB_URL;
  if (!databaseUrl) {
    throw new Error("SUPABASE_DB_URL is missing from .env.local.");
  }

  const sql = postgres(databaseUrl, {
    connect_timeout: 15,
    max: 1,
    ssl: "require",
  });

  const sections: ReportSection[] = [];

  async function section(name: string, query: () => PromiseLike<unknown>) {
    try {
      const rows = await query();
      sections.push({
        name,
        rows: Array.isArray(rows) ? rows : Array.from(rows as Iterable<unknown>),
      });
    } catch (error) {
      sections.push({
        error: error instanceof Error ? error.message : String(error),
        name,
      });
    }
  }

  const evidenceBuckets = [
    "leave-attachments",
    "marketing-evidence",
    "marketing-finance-evidence",
    "outstation-evidence",
  ];

  await section("storage_buckets", () => sql`
    select
      id,
      public,
      file_size_limit,
      allowed_mime_types
    from storage.buckets
    where id = any(${evidenceBuckets})
    order by id
  `);

  await section("storage_objects_by_bucket", () => sql`
    select
      bucket_id,
      count(*)::int as object_count,
      coalesce(
        sum(
          case
            when metadata ? 'size' and metadata->>'size' ~ '^[0-9]+$'
              then (metadata->>'size')::bigint
            else 0
          end
        ),
        0
      )::bigint as total_bytes,
      min(created_at) as first_created_at,
      max(created_at) as last_created_at
    from storage.objects
    where bucket_id = any(${evidenceBuckets})
    group by bucket_id
    order by bucket_id
  `);

  await section("storage_objects_by_prefix", () => sql`
    select
      bucket_id,
      split_part(name, '/', 1) as prefix,
      count(*)::int as object_count,
      coalesce(
        sum(
          case
            when metadata ? 'size' and metadata->>'size' ~ '^[0-9]+$'
              then (metadata->>'size')::bigint
            else 0
          end
        ),
        0
      )::bigint as total_bytes
    from storage.objects
    where bucket_id = any(${evidenceBuckets})
    group by bucket_id, split_part(name, '/', 1)
    order by bucket_id, prefix
  `);

  await section("v2_vacation_requests_evidence", () => sql`
    select
      count(*)::int as total_requests,
      count(*) filter (where vacation_type = 'compensatory')::int as compensatory_requests,
      count(compensatory_attachment_object_path)::int as compensatory_photos,
      count(sick_attachment_object_path)::int as sick_attachments
    from public.v2_vacation_requests
  `);

  await section("outstation_evidence", () => sql`
    select
      count(*)::int as total_requests,
      count(car_evidence_image_path)::int as car_evidence_images,
      count(*) filter (
        where jsonb_array_length(coalesce(ticket_attachment_paths, '[]'::jsonb)) > 0
      )::int as requests_with_ticket_attachments
    from public.outstation_expense_requests
  `);

  await section("marketing_customer_photo_metadata", () => sql`
    select
      count(*)::int as total_customers,
      count(evidence_photo_name)::int as customers_with_photo_name,
      count(*) filter (where evidence_status = 'complete')::int as complete_evidence,
      count(*) filter (where evidence_status = 'pending')::int as pending_evidence,
      count(*) filter (where evidence_status = 'missing')::int as missing_evidence
    from public.marketing_customers
  `);

  await section("marketing_pharmacy_photo_metadata", () => sql`
    select
      count(*)::int as total_pharmacies,
      count(evidence_photo_name)::int as pharmacies_with_photo_name,
      count(*) filter (where evidence_status = 'complete')::int as complete_evidence,
      count(*) filter (where evidence_status = 'pending')::int as pending_evidence,
      count(*) filter (where evidence_status = 'missing')::int as missing_evidence
    from public.marketing_pharmacies
  `);

  await section("marketing_evidence_files", () => sql`
    select
      storage_bucket,
      entity_type,
      evidence_type,
      count(*)::int as file_count
    from public.marketing_evidence_files
    group by storage_bucket, entity_type, evidence_type
    order by storage_bucket, entity_type, evidence_type
  `);

  await section("marketing_finance_evidence", () => sql`
    select
      count(*)::int as total_rows,
      count(money_transfer_proof_storage_path)::int as money_transfer_proofs,
      count(invoice_storage_path)::int as invoices
    from public.marketing_request_finance_requirements
  `);

  await sql.end();
  console.log(JSON.stringify(sections, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
