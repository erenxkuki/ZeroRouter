# Quick Fix for Vercel Database Connection Issue

## Problem
The production deployment on Vercel is hanging because it's using the **Transaction pooler** (port 6543), which has network connectivity issues on Vercel's platform. The connection times out after ~15 seconds, leaving the `/healthz` and `/admin/session` endpoints stuck.

## Solution
Change the `ZEROROUTER_DATABASE_URL` environment variable in Vercel from the **Transaction pooler (6543)** to the **Session pooler (5432)**.

## Why This Works
- **Session pooler (5432)**: Works reliably on Vercel and in production environments
- **Transaction pooler (6543)**: Known to hang on Vercel's network, even though it's documented as the recommended option for serverless functions

## Steps

### 1. Update Vercel Environment Variables
1. Go to your Vercel project dashboard
2. Navigate to **Project Settings → Environments → Production**
3. Find `ZEROROUTER_DATABASE_URL`
4. Change the port from `6543` to `5432`:

   ```
   OLD: postgresql://postgres.najfapatxydfoffrwqgm:blox2012kuki@aws-0-ap-south-1.pooler.supabase.com:6543/postgres
   NEW: postgresql://postgres.najfapatxydfoffrwqgm:blox2012kuki@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
   ```

5. Save the changes

### 2. Redeploy Production
- Push any commit to `main` (if auto-deploy is enabled)
- OR go to **Deployments → Production** and click **Redeploy**

## Expected Results
After this fix:
- `/healthz` will respond instantly with a `booting: true` status
- The DB connection will complete in ~2 seconds (same as local testing)
- `/admin/session` will work normally
- No more 504 timeouts

## Alternative: Update Documentation (Immediate Fix)
If you need to make the fix right away but want to proceed more carefully:

I've updated the repository documentation to reflect this change:
- `.env.example` - Added notes about using port 5432 for Vercel
- `docs/vercel-deploy.md` - Updated the database URL recommendation

These changes will help future users understand the correct configuration for Vercel deployments.

## Need Help?
If you have trouble with the Vercel dashboard, let me know exactly what you see on the screen, and I can provide more specific guidance.