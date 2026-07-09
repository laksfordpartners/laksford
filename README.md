# Command Center — Deploy Guide (Netlify, free)

A password-gated dashboard with **live Walmart Marketplace GMV** for Laksford Partners, plus your agent roster and an Arvani Shopify snapshot.

Your Walmart credentials live **only** in Netlify's environment variables — never in this code, never in the browser, never in chat.

---

## What's in this folder
```
index.html                     ← the dashboard (frontend)
netlify.toml                   ← Netlify config
netlify/functions/walmart.js   ← serverless backend that calls Walmart
README.md                      ← this file
```

## Deploy in ~5 minutes

1. **Go to** https://app.netlify.com → log in (free account).
2. **Add new site → Deploy manually.** Drag this whole `laksford-command-center` folder onto the drop zone. (Drag the *folder*, not just index.html — the backend must come with it.)
3. Wait for the deploy to finish. You'll get a URL like `https://your-name.netlify.app`.

## Add your secrets (required — the Walmart tiles stay blank until you do this)

4. In your new site: **Site configuration → Environment variables → Add a variable.** Add these three:

   | Key | Value |
   |-----|-------|
   | `WALMART_CLIENT_ID` | `9f950c4a-de3d-478a-b585-06704dacfa5d` |
   | `WALMART_CLIENT_SECRET` | *(your Walmart Client Secret — paste it here, only here)* |
   | `DASHBOARD_PASSWORD` | *(any passcode you want to unlock the dashboard)* |

5. **Trigger a redeploy** so the function picks up the variables: **Deploys → Trigger deploy → Deploy site.**

6. Open your URL, enter your `DASHBOARD_PASSWORD`, and the Walmart section goes live.

## Set a custom free domain (optional)
- **Domain management → Options → Edit site name** to change `your-name.netlify.app` to something cleaner, or add a custom domain you own.

---

## How the password works
The passcode is checked **on the server** inside the function. The dashboard sends the entered code to the backend; if it doesn't match `DASHBOARD_PASSWORD`, the server returns 401 and no Walmart data is released. The code is **not** stored in the HTML, so it can't be read by viewing source. Treat it as solid-but-simple protection — anyone you give the passcode to can see the data, and there's no per-user login or rate limiting.

## Notes & likely tweaks
- The function computes **GMV as the sum of PRODUCT charges** across all orders since Jan 1 (year-to-date), and the monthly figures from the 1st of the current month.
- Walmart's Marketplace API field names occasionally differ by account/version. If the tiles show an error after you add credentials, the dashboard will display the raw Walmart error text under **Last Sync** — send me that message and I'll adjust the parser.
- Free Netlify functions are plenty for a personal dashboard (125k calls/month). Each dashboard open = 1 call.

## Security reminders
- **Rotate the Client Secret** if it was ever pasted anywhere public.
- Don't commit your secret to any Git repo — env vars only.
- This dashboard exposes real revenue figures; only share the URL + passcode with people who should see them.
