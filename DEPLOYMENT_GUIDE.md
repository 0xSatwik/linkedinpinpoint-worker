# Deployment Instructions for Gemini API Integration

## Prerequisites
- You must have the Gemini API key: AIzaSyBhzHOlrufD879-cVV4R8w03o70zbZmNvA
- Wrangler CLI must be installed and authenticated

## Step 1: Run Database Migration

First, add the explanation column to your existing D1 database:

```bash
cd linkedinpinpoint

# Apply migration to add explanation column
npx wrangler d1 execute pinpoint-database --remote --file=migration_add_explanation.sql
```

## Step 2: Add Gemini API Key to Cloudflare Secrets

Add the Gemini API key as a secret:

```bash
npx wrangler secret put GEMINI_API_KEY
# When prompted, paste: AIzaSyBhzHOlrufD879-cVV4R8w03o70zbZmNvA
```

## Step 3: Deploy the Worker

Deploy the updated worker with Gemini integration:

```bash
npx wrangler deploy
```

## Step 4: Test the Integration

Test the /add endpoint with your secret key to verify Gemini is working:

```bash
# Replace YOUR_SECRET_KEY with your actual secret key
curl "https://linkedin-pinpoint-worker.gdgdughdshf.workers.dev/add/607/YOUR_SECRET_KEY"
```

Check that the response includes the `explanation` field with AI-generated content.

## Step 5: Verify Frontend

Once the worker is deployed:
1. The Next.js app will automatically fetch explanations through the API
2. Visit your site and reveal an answer to see the new "Detailed Explanation" section
3. Verify explanations display correctly on /today, /archive, and guide pages

## Troubleshooting

### If explanation is null or missing:
1. Check Cloudflare Worker logs for Gemini API errors
2. Verify GEMINI_API_KEY secret is set correctly
3. Check that you have available quota for Gemini API calls

### To view worker logs:
```bash
npx wrangler tail
```

## Next Steps

After deployment, all existing pinpoints can be updated with explanations by calling the /add endpoint for each number.
