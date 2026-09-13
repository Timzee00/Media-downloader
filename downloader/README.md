# Media Downloader

A standalone video + audio downloader (yt-dlp under the hood), built to run as its own
service on Render — separate from SwissKit, which stays on InfinityFree.

## What it does

- Paste a link (YouTube, TikTok, Instagram, Twitter/X, Facebook, SoundCloud,
  YouTube Music, Audiomack, and anything else yt-dlp supports)
- Choose **Video (with sound)** or **Sound only (MP3)**
- Pick a quality (up to 4K where the source supports it)
- Download history side panel — thumbnail, title, platform, file size, re-download or delete

Not supported: Spotify (DRM-protected, out of scope on purpose).

## Security notes

This runs as a public URL, so it ships with baseline protections:

- **Password gate** — set the `ACCESS_PASSWORD` environment variable in
  Render and the whole app is locked behind a single shared password (no
  password set = open access, useful for local testing only).
- **Rate limiting** — 15 requests per 15 minutes per IP on `/api/info` and
  `/api/download`.
- **Concurrency cap** — at most 2 downloads processing at once; extra
  requests get a "server is busy" response instead of piling up.
- **SSRF protection** — rejects links that resolve to private/internal IP
  ranges (so the service can't be pointed at its own internal network).
- **Auto-cleanup** — finished downloads older than `MAX_AGE_HOURS` (default
  24) are deleted automatically, hourly, so disk usage doesn't grow forever.

Set these in Render under your service's **Environment** tab:

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `ACCESS_PASSWORD` | Recommended | (none — open access) | Password to unlock the app |
| `MAX_AGE_HOURS` | Optional | `24` | How long finished downloads stick around before auto-delete |

This is still a single shared-password tool, not a multi-user system — fine
for you linking it from SwissKit for personal use, not intended for public
sign-up traffic.

## Deploying to Render

1. Push this folder to a new GitHub repo.
2. In Render: **New → Web Service** → connect the repo.
3. Render will detect the `Dockerfile` automatically — no build/start command needed.
4. Instance type: the free tier works for testing. For real usage, pick a paid
   plan — downloads can be memory/CPU heavy and the free tier spins down after
   ~15 minutes of inactivity (first request after that will be slow).
5. **Persistent storage (optional but recommended):** by default, downloaded
   files and history live at `/data` inside the container, which is wiped on
   every redeploy/restart. To keep history across deploys, add a Render Disk:
   - Render dashboard → your service → **Disks** → Add Disk
   - Mount path: `/data`
   - Size: start with 1–5 GB (each video eats into this — see cleanup note below)
6. Deploy. Your service gets a URL like `https://your-app.onrender.com`.

## Linking it from SwissKit

Since this runs as its own site, just add a link/button in SwissKit
(e.g. in the nav or Tools section) pointing at the Render URL:

```html
<a href="https://your-app.onrender.com" target="_blank">Media Downloader</a>
```

Or embed it in an iframe on a SwissKit page if you want it to feel native:

```html
<iframe src="https://your-app.onrender.com" style="width:100%;height:100vh;border:0;"></iframe>
```

(iframe embedding works out of the box here since the app doesn't set any
frame-blocking headers — no changes needed on either side.)

## Storage cleanup

Nothing auto-deletes old files yet. For a public-facing tool, add a scheduled
job (Render Cron Job, or a simple `setInterval` in `server.js`) that deletes
files older than N days and prunes their history entries — otherwise your disk
fills up over time. Ask me to add this whenever you're ready.

## Local testing

```bash
docker build -t media-downloader .
docker run -p 3000:3000 media-downloader
```

Then open http://localhost:3000
