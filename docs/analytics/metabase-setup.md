# Metabase Open Source — Setup Guide

## Overview

Metabase connects to the `analytics` schema in Supabase via the `analytics_readonly` role.
Phoenix remains the system of record and the primary access-control layer.
Metabase provides flexible ad-hoc querying, charts, and dashboards on top of the analytics views.

## Prerequisites

- Docker Desktop installed and running
- Access to the staging Supabase project
- The `20260625120000_analytics_schema_views.sql` migration applied to staging

## Local setup

```bash
# 1. Copy the env example
cp .env.analytics.example .env.analytics

# 2. Fill in the values (see .env.analytics.example for guidance)
#    Use the analytics_readonly credentials, NOT the service role key

# 3. Start Metabase
docker compose -f docker-compose.analytics.yml --env-file .env.analytics up -d

# 4. Open http://localhost:3030 and complete the setup wizard
```

## Connecting Metabase to Supabase

In the Metabase setup wizard (or Settings → Databases → Add database):

| Field             | Value                                              |
|-------------------|----------------------------------------------------|
| Database type     | PostgreSQL                                         |
| Host              | `db.<your-staging-ref>.supabase.co`                |
| Port              | `5432`                                             |
| Database name     | `postgres`                                         |
| Username          | `analytics_readonly`                               |
| Password          | (the password you set for analytics_readonly)      |
| Schema            | `analytics`                                        |

**Important:** Use `analytics_readonly` credentials only. Never enter the service role key in Metabase.

## Creating the analytics_readonly user

Apply this SQL in Supabase Studio → SQL Editor (using the service role):

```sql
-- Create a login user for analytics_readonly
create user analytics_readonly_login
  with password 'REPLACE_WITH_STRONG_PASSWORD'
  inherit;

-- Grant the role
grant analytics_readonly to analytics_readonly_login;

-- Allow login to the database
alter user analytics_readonly_login connection limit 5;
```

Then use `analytics_readonly_login` as the Metabase username.

## What Metabase can see

| View | Description |
|------|-------------|
| `analytics.dim_periods` | Available SoS periods |
| `analytics.dim_weeks` | Available weekly batches |
| `analytics.dim_products` | Products (confidential excluded) |
| `analytics.dim_distributors` | Distributors |
| `analytics.dim_areas` | Region → Area hierarchy |
| `analytics.sos_fact` | SoS fact at full grain (confidential excluded) |
| `analytics.sos_by_period` | SoS monthly trend |
| `analytics.sos_by_distributor` | SoS by distributor |
| `analytics.sos_by_line` | SoS by line |
| `analytics.sos_by_area` | SoS by region/area |
| `analytics.sos_by_brick` | SoS at brick level |
| `analytics.sos_by_product` | SoS by product |
| `analytics.sos_by_family` | SoS by family |
| `analytics.sos_by_customer` | Customer presence by period/region |
| `analytics.closing_fact` | Monthly closing fact (approved only) |
| `analytics.closing_by_employee` | Closing by employee |
| `analytics.closing_by_product` | Closing by product |
| `analytics.closing_by_line` | Closing by line |
| `analytics.weekly_fact` | Weekly sell-out at full grain |
| `analytics.weekly_by_distributor` | Weekly by distributor |
| `analytics.weekly_by_product` | Weekly by product |
| `analytics.weekly_by_region` | Weekly by region |
| `analytics.cross_source_period_line` | SoS vs Closing vs Weekly comparison |

**CEO/admin only** (requires role change in Metabase connection settings):
- `analytics.sos_fact_all` — includes LA003, LA004, SS001
- `analytics.dim_products_all` — includes confidential products

## Suggested Metabase dashboards

1. **Source of Sales Overview** — filters: period, line, distributor, region. Charts: trend line, distributor bar, product pie. Table: sos_by_product with search.
2. **Monthly Closing Performance** — filters: period, line, employee. Charts: achievement gauge, team bar. Table: closing_by_employee with sort by achievement_pct.
3. **Weekly Sell-Out Tracker** — filters: week, distributor, region. Charts: weekly trend, branch heatmap. Table: weekly_fact.
4. **Executive KPI Board** — filters: periodFrom/To, line. Charts: KPI cards from cross_source_period_line. Table: reconciliation with gap column.
5. **Product Contribution** — filters: period, line. Charts: donut (family share), ranked bar (product). Table: sos_by_product sorted by value desc.
