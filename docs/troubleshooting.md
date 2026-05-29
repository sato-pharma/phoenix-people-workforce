# Troubleshooting

## Common Issues

### `npm run test` fails with syntax errors

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
npm run typecheck
```

### Playwright tests fail to start

Install Playwright browsers:

```bash
npx playwright install --with-deps chromium
```

### Dev auth not working

Dev auth only works in development mode (`NODE_ENV=development`). Ensure you are running `npm run dev`, not a production build. The endpoint is:

```
GET /api/dev-auth?role=Super%20Admin
```

### Build fails but typecheck passes

The build may catch errors that typecheck alone misses (e.g., route type generation). Run `npx next typegen` before `npm run build`.

### Permission denied errors in API routes

Server-side permission checks use `assertPermission()`. If you get 403 errors, check that your dev-auth role has the required permission in the `defaultPermissionMatrix` (`src/lib/auth/permissions.ts`).

### Excel import failures

Excel imports (payroll, employees, sales) require specific column formats. Check the relevant domain service in `src/lib/<domain>/` for expected column names and data types.

### Vercel preview not updating

Ensure you pushed to `codex/work-from-production`. Check the Vercel dashboard for build errors. The preview URL may change after each push -- use the branch alias, not the deployment-specific URL.

### Cron jobs not firing

Vercel Hobby allows only 2 daily cron jobs. Both are configured in `vercel.json`. Sub-daily crons are not supported without a plan upgrade. See [docs/deployment.md](deployment.md).

## Getting Help

- Check existing documentation in [docs/](.)
- Review the architecture reference documentation in the repository root
- Check the CI workflow in `.github/workflows/ci.yml` for expected behavior
