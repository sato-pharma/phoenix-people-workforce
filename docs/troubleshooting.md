# Troubleshooting

## Common Issues

### `pnpm run test` fails with syntax errors

Tests require Node.js 22+ for `--experimental-strip-types` support.

```bash
node --version   # Must be >= 22.0.0
```

### Missing environment variables on startup

If the dev server crashes, ensure you have copied `.env.example` to `.env.local` and filled in the required Supabase variables. See [docs/environment.md](environment.md).

### Supabase connection errors

Verify your Supabase project is active and the URL/keys in `.env.local` are correct. The anon key and service role key are found in your Supabase project settings under **API**.

### TypeScript errors after pulling changes

Regenerate Next.js route types, then typecheck:

```bash
npx next typegen
pnpm run typecheck
```

### Playwright tests fail to start

Install Playwright browsers:

```bash
npx playwright install --with-deps chromium
```

### Dev auth not working

Dev auth only works in development mode (`NODE_ENV=development`). Ensure you are running `pnpm run dev`, not a production build. The endpoint is:

```
GET /api/dev-auth?role=Super%20Admin
```

### Build fails but typecheck passes

The build may catch errors that typecheck alone misses (e.g., route type generation). Run `pnpm exec next typegen` before `pnpm run build`.

### Permission denied errors in API routes

Server-side permission checks use `assertPermission()`. If you get 403 errors, check that your dev-auth role has the required permission in the `defaultPermissionMatrix` (`src/lib/auth/permissions.ts`).

### Excel import failures

Excel imports (payroll, employees, sales) require specific column formats. Check the relevant domain service in `src/lib/<domain>/` for expected column names and data types.

### Change not showing up after push

There is no per-branch preview deployment (that was a retired Vercel-era model).
Verify locally, check that CI's `preview-smoke` job passed (it runs a Playwright
smoke test inside the CI runner against staging Supabase, not a deployed URL), and
after merge, check the staging Cloud Run service for a live look against staging
data. If production itself looks stale after a merge, check
`.github/workflows/deploy-cloud-run.yml`'s run for that commit.

### Cron jobs not firing

Crons run on Google Cloud Scheduler (five jobs, Africa/Cairo time — see
`scripts/setup-gcp-cron.sh`), not `vercel.json`. Check
`gcloud scheduler jobs list --location=us-central1 --project=phoenix-workforce-498619`
or the in-app `/admin/cron-control` dashboard for job status and last-run result,
and confirm `CRON_SECRET` on the Cloud Run service matches what the scheduler job
sends. See [docs/deployment.md](deployment.md).

## Getting Help

- Check existing documentation in [docs/](.)
- Review the architecture reference documentation in the repository root
- Check the CI workflow in `.github/workflows/ci.yml` for expected behavior
