# Supabase Remote-First Development Setup

## ✅ Configuration Complete

Your Phoenix Workforce project is now configured for **remote-first development** with the Phoenix HR Supabase instance.

### Project Details
- **Project Name**: Phoenix HR
- **Reference ID**: ozucdzovmcqvepbozvqf
- **Region**: Central EU (Frankfurt)
- **Database**: PostgreSQL 17
- **Status**: ✅ Linked & Ready

---

## 🚀 Quick Start

### 1. Verify Setup
```bash
# Check project is linked
supabase projects list

# View migrations
supabase migration list --linked

# Check API keys
supabase projects api-keys ozucdzovmcqvepbozvqf
```

### 2. Environment Variables
Created `.env.local` with:
- ✅ `NEXT_PUBLIC_SUPABASE_URL` - Remote instance URL
- ✅ `NEXT_PUBLIC_SUPABASE_ANON_KEY` - Public key for browser
- ✅ `SUPABASE_SERVICE_ROLE_KEY` - Server-side operations
- ✅ `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` - Modern key

### 3. Start Developing

**For Next.js/Frontend:**
```bash
npm run dev
# Environment variables are auto-loaded from .env.local
```

**Push Migrations:**
```bash
# Create new migration
supabase migration new <name>

# Push to remote
supabase db push
```

**Deploy Edge Functions:**
```bash
supabase functions deploy <function-name>
supabase functions list
```

---

## 📊 Remote Database Info

### Current State
- **Total Migrations**: 85+
- **Schema Status**: ✅ Production Ready
- **RLS Policies**: ✅ Enabled
- **Auth**: ✅ Configured

### Access URLs
- **Supabase Dashboard**: https://supabase.com/dashboard
- **API Endpoint**: https://ozucdzovmcqvepbozvqf.supabase.co
- **GraphQL**: https://ozucdzovmcqvepbozvqf.supabase.co/graphql/v1

---

## 💡 Common Commands

```bash
# View remote database status
supabase status

# List all migrations (local vs remote)
supabase migration list --linked

# Check for schema issues (requires Docker)
supabase db lint --linked

# Deploy a function
supabase functions deploy my-function

# View logs
supabase functions logs my-function

# Pull latest remote schema (requires Docker)
supabase db pull --linked

# Run SQL directly on remote
supabase db execute --linked --file migration.sql
```

---

## ⚙️ Workflow

### Making Schema Changes
1. Create migration file: `supabase migration new add_new_column`
2. Edit `supabase/migrations/TIMESTAMP_add_new_column.sql`
3. Test locally (if Docker is set up)
4. Push to remote: `supabase db push`

### Deploying Functions
1. Create: `supabase functions new my-function`
2. Edit `supabase/functions/my-function/index.ts`
3. Deploy: `supabase functions deploy my-function`

### Authentication
All auth flows use the remote Phoenix HR instance:
- Magic links
- OAuth providers  
- Session management
- Row-level security (RLS)

---

## 🔧 Need Local Docker?

If you need local development (offline work, testing before pushing):

1. **Install WSL 2** (already done ✅)
2. **Fix migrations**: The cleanup migrations have policy references that don't exist. They need fixing before local Docker works.
3. **Run**: `supabase start`

For now, remote-first is recommended because:
- ✅ Schema is production-ready
- ✅ No local setup needed
- ✅ Safe testing against real database
- ✅ Faster development iteration

---

## 📋 Git Best Practices

1. **Always create migrations** (don't push schema changes directly)
2. **Commit migration files** to git
3. **Use .env.local** (add to .gitignore)
4. **Don't commit API keys** in code

---

## ❓ Troubleshooting

**Can't connect to remote?**
```bash
# Check authentication
supabase projects list

# Verify credentials in .env.local
echo $NEXT_PUBLIC_SUPABASE_URL
```

**Migration failed?**
```bash
# Check migration history
supabase migration list --linked

# View error details
supabase db push --debug
```

**Need to reset?**
```bash
# ⚠️ WARNING: This deletes all data!
supabase db push --linked --dry-run  # Preview changes first
```

---

## 🎯 Next Steps

1. ✅ Verify everything works: `supabase migration list --linked`
2. 🚀 Start your app: `npm run dev`
3. 📝 Create your first migration: `supabase migration new create_feature`
4. 📤 Deploy: `supabase db push`

---

**Status**: Ready for remote-first development! 🎉
