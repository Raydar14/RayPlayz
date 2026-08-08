# Deploying to Cloudflare — Ray's step-by-step

This is written for **you**, Ray. No developer knowledge assumed. It should take about 20 minutes total, mostly waiting on Cloudflare to finish things.

At the end of this you'll have:
- Your public site running on Cloudflare (identical to what's live now)
- The private `/dashboard` route working, password-protected, only you can get in

Your existing site at `rayplayzz.com` will **not go down** during this. We put Cloudflare in front of it, test on a `*.workers.dev` URL first, and only flip the DNS over when it's proven.

---

## Part 1 — Verify Cloudflare has your domain

1. Log in to Cloudflare: **[dash.cloudflare.com](https://dash.cloudflare.com)**
2. Look for `rayplayzz.com` in your account's site list.
3. Click it.
4. Look at the top of the page. Does it say **Active** in green?

- **Yes, Active:** great, jump to Part 2.
- **No, or the domain isn't in your list:** you're not done with Cloudflare setup. Cloudflare will walk you through it — click **Add a site** on the home dashboard, type `rayplayzz.com`, pick the Free plan, and follow the nameserver instructions. You'll need to log in to wherever you bought the domain (GoDaddy, Namecheap, wherever) and paste in two nameservers that Cloudflare gives you. It takes 5–30 minutes to activate after that. Come back to Part 2 when you see **Active**.

---

## Part 2 — Connect the GitHub repo so Cloudflare auto-deploys

1. In Cloudflare, in the left sidebar, click **Workers & Pages**.
2. Click **Create application** → **Workers** tab → **Connect to Git**.
3. Cloudflare will ask permission to see your GitHub. Click **Connect GitHub** and authorize Cloudflare's app for the `Raydar14/RayPlayz` repo (you can limit access to just this repo).
4. Back in Cloudflare, pick the `Raydar14/RayPlayz` repo from the list.
5. Configuration screen:
   - **Project name:** `rayplayz-dashboard` (or whatever you want)
   - **Production branch:** `main`
   - **Preview branches:** `claude/*` (this way my working branch gets its own preview URL so you can test before merging)
   - **Root directory:** click **Advanced** and set it to `worker`
   - **Build command:** leave blank
   - **Deploy command:** `npx wrangler deploy`
6. Click **Save and Deploy**.
7. First deploy runs in ~1–2 minutes. When it's done Cloudflare gives you a URL like `https://rayplayz-dashboard.<yoursubdomain>.workers.dev` — write this down.

---

## Part 3 — Set your three secrets

The dashboard won't work until you set these. They live in Cloudflare's encrypted secret store, never in the code, never in GitHub.

1. In the Worker you just created, click **Settings** → **Variables and Secrets**.
2. Click **Add** and set these three, one at a time. For each: type is **Secret** (not "Text").

| Name | Value |
|---|---|
| `DASHBOARD_PASSWORD` | The password you'll use to log in. **Make it long — 20+ characters, unique, not one you use elsewhere.** Save it in your password manager. |
| `SESSION_SECRET` | A long random string (40+ characters). Just mash the keyboard, or use your password manager to generate one. You never need to remember this. |
| `ANTHROPIC_API_KEY` | The `sk-ant-…` key from console.anthropic.com. Paste it in exactly. |

3. Click **Deploy** after adding all three so the Worker picks them up.

---

## Part 4 — Test on the workers.dev URL

1. Open the `rayplayz-dashboard.<yoursubdomain>.workers.dev` URL from Part 2.
2. You should see your existing marketing site, identical to what's on `rayplayzz.com` today. ← this proves the public site still works.
3. Now go to `<that URL>/dashboard`. You should see a **Ray · Dashboard** login card. Enter your `DASHBOARD_PASSWORD`.
4. If you get in and see the "You're in" page with the phase list — everything is working.

If something is broken, take a screenshot and tell me — I'll fix it before we do the DNS flip.

---

## Part 5 — Point the real domain at Cloudflare (only after Part 4 works)

1. Back in the Worker → **Settings** → **Triggers** → **Custom Domains** → **Add Custom Domain**.
2. Add `rayplayzz.com` and `www.rayplayzz.com`.
3. Cloudflare will auto-configure DNS since it already manages your domain.
4. Wait ~1 minute. Reload `rayplayzz.com`. It should now be served from Cloudflare, identical to what you saw at the workers.dev URL, and `rayplayzz.com/dashboard` should show the login.

That's it. Every future push I make to the branch will auto-deploy in 1–2 minutes. When you want to promote a preview to live, merge the PR to `main`.

---

## If anything goes wrong

- **Login says "Wrong password" no matter what you type:** you probably didn't hit **Deploy** after adding the secret. Go back to Part 3 step 3.
- **Dashboard URL just shows the marketing site:** the Worker deployed but isn't routing right. Ping me with the workers.dev URL and I'll look at the deploy logs.
- **`rayplayzz.com` shows a Cloudflare error page:** roll back — in the Worker, remove the custom domain and the site will go back to GitHub Pages within a couple of minutes.

You can always revert to GitHub Pages by removing the custom domain from the Worker. Nothing here is one-way.
