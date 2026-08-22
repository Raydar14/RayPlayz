# Ray · Message Capture (browser extension)

Chrome (Manifest V3) extension that captures DM threads from Instagram,
Tinder, Bumble, Fetlife, TikTok, X, and WhatsApp into Ray's private
dashboard.

## What it does today (v0.2)

Two capture modes in one popup:

**📷 Screenshot (auto-extract)** — the fast one:
- Drop a DM screenshot into the popup (drag & drop, click to select, or
  paste an image with Ctrl+V).
- Claude Vision reads the header for the contact identity + every
  visible message with the correct direction (his vs yours).
- Everything lands in the dashboard. Zero typing.
- Works on all 7 platforms uniformly, including WhatsApp — which has no
  scrapeable URL and blocks other automation.
- Cost: ~$0.005 per screenshot on Sonnet 5.

**Paste text** — the free fallback:
- Copy the visible thread text on any DM page.
- Paste into the popup textarea.
- Pick parse mode (prefix / alternating), hit Capture.

Both modes:
- **Source auto-detect** from the current tab's URL (screenshot mode
  can override from the image).
- **Handle auto-fill** for platforms that expose it in the URL.
- **Idempotent**: recapture the same thread and it's a no-op — dedup
  by content hash on the server.

## What's *not* yet in v0.2

- Per-platform in-page auto-scrape (nothing to click on the page
  itself — you still have to open the popup and drop a shot / paste).
  Coming in v0.3 if it earns its complexity.
- Timestamp capture from screenshots (Vision returns readable
  timestamps but we don't yet parse them into UTC).

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

## Using it — Screenshot mode (recommended)

1. Open a DM thread on any platform (IG / Tinder / Bumble / Fetlife /
   TikTok / X / WhatsApp Web).
2. Take a screenshot of the visible conversation (macOS: Cmd+Shift+4
   and select the DM area · Windows: Snipping Tool · or use your
   browser's built-in screenshot). Copy it to clipboard OR save the file.
3. Click the Ray Capture icon.
4. Screenshot tab is the default. Either:
   - **Paste** the screenshot from clipboard (Ctrl+V while the popup
     is focused), or
   - **Drop** the image file onto the drop-zone, or
   - **Click** the drop-zone to browse and select.
5. (Optional) Set a source hint or Bucket. Auto-detection usually gets
   it right from the image.
6. Click **Extract & capture**. Takes 3–8 seconds. Success message
   shows what was detected + how many messages landed.

## Using it — Paste-text mode (fallback)

1. Open a DM thread. Select the visible thread text and **Copy**.
2. Click the Ray Capture icon. Switch to the **Paste text** tab.
3. Confirm source + his handle (type it if the URL doesn't expose it).
4. Paste into the transcript textarea.
5. Pick **parse mode**:
   - **Prefix mode** (default): lines starting with `>` are from him.
   - **Alternating**: pick who sent first; every line alternates.
6. Click **Capture**.

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
