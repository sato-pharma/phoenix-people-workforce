# Security Remediation: Exposed Credentials

**Priority: CRITICAL — act before the next deployment.**

Production secrets were committed to git history. Even though `.env.local` is now
gitignored, the plaintext values remain readable in every historical commit. Assume
all listed credentials are compromised.

---

## Credentials to rotate immediately

| Secret | Service | Where to rotate |
|--------|---------|----------------|
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase | Project Settings → API → Regenerate service_role key |
| `SUPABASE_DB_URL` (contains DB password) | Supabase | Project Settings → Database → Reset database password |
| `RESEND_API_KEY` | Resend | Dashboard → API Keys → delete old key, create new one |
| `GOOGLE_MAPS_SERVER_KEY` | Google Cloud | Console → APIs → Credentials → delete key, create new one with HTTP referrer restriction |
| `ADMIN_PASSWORD` | Phoenix app | Admin panel → reset password, or update in `app_auth_users` directly |
| `CRON_SECRET` | Phoenix app | Generate new value: `openssl rand -hex 32` |
| `PHOENIX_AUTH_SECRET` (JWT signing key) | Phoenix app | Generate new value: `openssl rand -hex 64`. **This invalidates all active sessions.** |

---

## Step-by-step process

### 1. Rotate Supabase keys

```bash
# After regenerating, update Vercel:
vercel env rm SUPABASE_SERVICE_ROLE_KEY production
vercel env add SUPABASE_SERVICE_ROLE_KEY production --value "<new-value>" --yes
vercel env rm SUPABASE_SERVICE_ROLE_KEY preview
vercel env add SUPABASE_SERVICE_ROLE_KEY preview "" --value "<new-value>" --yes

# Same for SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL if changed
```

### 2. Rotate PHOENIX_AUTH_SECRET

```powershell
# Generate a new 64-byte hex secret
$newSecret = -join ((0..63) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })
```

Update in Vercel and redeploy. All users will be signed out on the next request.

### 3. Rotate CRON_SECRET

```bash
openssl rand -hex 32
```

Update the Vercel env var and the cron job provider (if using Vercel Cron, it re-sends the
header automatically after re-deploy).

### 4. Scrub git history (optional, time-permitting)

Git history cannot be modified without force-pushing all branches. Consider whether the
effort is worth it given you've already rotated all keys. If the repo is private and access
is restricted, rotating keys is sufficient mitigation.

If you do want to scrub history:
```bash
# Use git-filter-repo (preferred over BFG or filter-branch)
pip install git-filter-repo
git filter-repo --replace-text <(echo "OLD_SECRET==>REDACTED")
```

This rewrites history. All collaborators must re-clone. Only do this if explicitly required
by a security audit or compliance requirement.

### 5. Add gitleaks to CI

Create `.gitleaks.toml` at the repo root and add a pre-commit hook or GitHub Action to
scan for secrets before each push:

```toml
title = "gitleaks config"

[allowlist]
  description = "test/docs files"
  paths = [
    "docs/SECURITY_REMEDIATION.md",
  ]
```

---

## After rotating all keys

- [ ] Update `.env.local` with new values locally
- [ ] Re-deploy to Vercel (the new env vars take effect on the next deployment)
- [ ] Verify app boots correctly (Supabase health check, auth flow, cron endpoint)
- [ ] Confirm old Supabase service_role key is revoked (test that it returns 401)
- [ ] Mark this document as completed and remove the production secret table above
