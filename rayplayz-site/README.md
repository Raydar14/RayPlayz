# Ray Playz — website

Static site (neon-noir splash / link hub). No build step.

## Files
- `index.html` — the whole site (self-contained; logo is inline SVG)
- `rayplayz-favicon.png` — favicon

## Before you go live
1. In `index.html`, replace `YOUR_ID` in the Formspree form action with your form ID.
2. Fill the 6 link cards — search for `href="#" data-note="..."` and drop in your real URLs (OnlyFans, Fansly, X, Reddit, tip/wishlist, VIP).

## Deploy (GitHub Pages)
1. Push these files to the repo root of a new repo.
2. Settings → Pages → Source: `main` / root.
3. For a custom domain: add a file named `CNAME` containing just your domain (e.g. `rayplayz.com`), then point the domain's DNS at GitHub Pages in GoDaddy.
