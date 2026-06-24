# Analytics Role Security

## Access control layers

Phoenix has two independent security layers for analytics:

### 1. Phoenix application layer (primary)
All analytics pages enforce `assertPermission(access, "sales", "read")` server-side.
Role-based page visibility is configured in `system-navigation.ts`.

| Role | Accessible pages |
|------|-----------------|
| Super Admin | All analytics pages |
| CEO | All analytics pages |
| National Sales Manager | SoS, Weekly, Closing, Exec Comparison |
| Product Manager / GPM | SoS, Weekly |
| SFE Manager | SoS, Closing |
| Others | No analytics pages |

### 2. Database layer (secondary — for Metabase)
`analytics_readonly` role has SELECT only on `analytics` schema views.
It cannot read `source_of_sales_import_rows`, `sales_records`, or `weekly_sales_rows` directly.

## Confidential products (LA003, LA004, SS001)

- Excluded from all standard `analytics.*` views
- Only `analytics.sos_fact_all` and `analytics.dim_products_all` include them
- In Metabase: only connect with CEO/admin credentials to use `_all` views
- In Phoenix pages: `canViewRestrictedProducts(role)` gates access — checked in `service.ts`

## Metabase embedding (future)

When embedding Metabase iframes in Phoenix:
- Use server-side signed JWT embed tokens (never expose `METABASE_EMBED_SECRET` to frontend)
- Set question-level row filters by role in the embed token payload
- Phoenix generates the signed URL in a server component or API route

## What analytics_readonly CANNOT do

- Cannot read any `public.*` tables directly
- Cannot call Phoenix internal RPCs (`phx_exec_*`, `phx_monthly_closing_*`, `phx_si_*`)
- Cannot write to any table
- Cannot read `analytics.sos_fact_all` or `analytics.dim_products_all` unless explicitly granted
