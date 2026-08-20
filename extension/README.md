# Ray · Message Capture (browser extension)

Chrome (Manifest V3) extension that captures DM threads from Instagram,
Tinder, Bumble, Fetlife, TikTok, and X and pushes them into Ray's private
dashboard.

## What it does today (v0.1)

- **Popup capture**: click the extension icon on any DM page → paste the
  thread text into the popup → hit **Capture** → messages land in your
  dashboard with the right contact created or matched by handle.
- **Source auto-detect** from the current tab's URL.
- **Handle auto-fill** where the platform puts the handle in the URL
  (IG profile pages, X, TikTok — Tinder/Bumble/Fetlife DM URLs don't
  expose the handle, so you type it in).
- **Idempotent**: recapture the same thread and it's a no-op — dedup by
  content hash on the server.

## What's *not* yet in v0.1

- Per-platform DOM auto-scrape (you paste for now). Coming in v0.2 —
  starting with Instagram since it has the most stable DM structure.
- Timestamp capture (all messages currently import with `sent_at = null`).

## Install (Chrome / Brave / Edge / any Chromium browser)

1. Download this `extension/` folder to your machine.
   - Easiest: on the [repo page](https://github.com/Raydar14/RayPlayz),
     click **Code** → **Download ZIP**, extract, then find the
     `extension` folder inside.
2. Open your browser and go to `chrome://extensions/`.
3. Toggle **Developer mode** on (top right).
4. Click **Load unpacked** (top left).
5. Select the `extension` folder from step 1.
6. Pin the extension so its icon is always visible: click the puzzle
   piece in the toolbar → click the pin next to **Ray · Message Capture**.

## First-time setup (2 minutes)

1. Open your dashboard, click the **⚙** gear icon in the top bar → **Generate new token**.
2. Copy the token that appears (starts with `rpx_…`). **It's shown once.**
3. Click the extension icon → click the **⚙** in the popup (or open
   `chrome://extensions/` → find Ray Capture → **Details** → **Extension options**).
4. Paste the token. Confirm the **Dashboard URL** matches yours
   (default is the `*.workers.dev` URL; change to `rayplayz.online`
   once your custom domain is live).
5. Click **Test connection** → should say *Connected. Token accepted.*
6. Click **Save**.

## Using it (per thread)

1. Open a DM thread on IG / Tinder / Bumble / Fetlife / TikTok / X.
2. Select the whole visible thread text and **Copy** (Ctrl+C / Cmd+C).
3. Click the Ray Capture icon in the toolbar.
4. Confirm the source dropdown auto-picked the right platform, and that
   his handle is filled in (type it if not).
5. Paste into the transcript textarea.
6. Pick a **parse mode**:
   - **Prefix mode** (default): lines starting with `>` are from him,
     everything else is from you. Recommended — most flexible.
   - **Alternating**: pick who sent the first message; every subsequent
     line alternates.
7. Click **Capture**. Success message shows how many messages landed and
   a link to open the contact in your dashboard.

## Parse mode examples

**Prefix mode** — most reliable:
```
> hey saw you like hiking, know any trails near tamarindo?
haha depends what kind — sunrise or all-day?
> sunrise ideally
noted. i'm testing you though, tell me one thing you're actively
working on that has nothing to do with a partner
> fair. building a boat with my brother. been at it 3 years
that answers the question. what's the boat for?
```
Six messages total, three from him, three from you.

**Alternating mode** — quickest when the transcript is clean:
```
hey saw you like hiking, know any trails near tamarindo?
haha depends what kind — sunrise or all-day?
sunrise ideally
noted. i'm testing you though, tell me one thing you're actively working on that has nothing to do with a partner
```
With **alt · his message first** picked: lines 1,3 are from him, 2,4 from you.

## Troubleshooting

- **"Not configured"** in the popup: hit ⚙ and paste your token.
- **"Token is invalid or revoked"**: generate a new token in the
  dashboard and paste the new one into the extension.
- **Nothing captured but no error**: check the parse mode. Prefix mode
  needs `>` prefixes for his messages.
- **Duplicated contact**: match happens on the platform handle. If you
  captured under one handle then changed it, they become two contacts
  in the dashboard. Just delete the wrong one.

## Development

Pure vanilla — no build step. Edit files under `extension/`, reload
the extension in `chrome://extensions/` (click the refresh icon on the
extension card), and the changes are live.

For a permanent install (Chrome Web Store), the extension needs an
identity — this v0.1 is a developer-mode load. That's fine for one
user; we'd package it later if needed.
