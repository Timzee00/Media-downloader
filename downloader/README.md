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
  720 hours / 30 days) are removed automatically, hourly, while their history metadata stays available for up to 90 days. Missing files can be downloaded again from the original URL if the source is still available.

Set these in Render under your service's **Environment** tab:

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `ACCESS_PASSWORD` | Recommended | (none — open access) | Password to unlock the app |
| `MAX_AGE_HOURS` | Optional | `720` | File retention (30 days); set an explicit 720 in Render if you previously configured 24. Applies only while files remain on persistent storage. |
| `HISTORY_MAX_AGE_DAYS` | Optional | `90` | How long the server keeps completed-job metadata (minimum 31 days). |

This is still a single shared-password tool, not a multi-user system — fine
for you linking it from SwissKit for personal use, not intended for public
sign-up traffic.

## About page

The website includes a public **About** page at \`/about\`. It explains the
downloader, formats, supported sources, usage rights, history retention,
common questions and temporary storage limitations. Its basic status display
checks \`/health\` without exposing authentication or downloader history.

## Availability pings

A GitHub Actions workflow at \`.github/workflows/media-downloader-uptime.yml\`
is scheduled to GET
\`https://media-downloader-docker.onrender.com/health\` every 10 minutes,
and also supports manual workflow dispatch. It checks that the server returns
HTTP 200 and \`{"ok":true}\`.

**Important:** GitHub schedules run only from the repository's default branch
and are best-effort. GitHub can delay, disable or fail to start Actions jobs.
Confirm successful job runs in the **Actions** tab; if jobs cannot start,
this workflow is not an operational keep-alive. A separate external HTTP
monitor is preferable when reliability matters.

Render's Free services spin down after roughly 15 minutes without inbound
requests, can restart unexpectedly, and have an ephemeral filesystem.
Periodic pings might reduce idle sleeps but cannot ensure 24/7 uptime,
preserve uploaded files or overcome free instance hour limits.
The \`/health\` endpoint verifies the web process, not every video provider.

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

## Download history and recovery

- Download history caches up to 1,000 items in this browser, including the original
  source URL and quality. When you press **Save**, the downloader first tries the
  stored file. If that file has disappeared, it starts a new server-side download
  from the original link, then offers the newly generated file.
- New server records keep the source metadata for 90 days by default even when
  the actual file has expired after 30 days. Old browser history items created
  before this patch might lack a source URL; those cannot be recovered unless
  you still have the original link. Links to private, deleted, or unavailable
  media cannot be recovered either.
- **Important on Render Free:** Render deletes local container files (including
  `/data/jobs.json` and media files) when the service sleeps, restarts, or
  redeploys. Changing retention settings cannot prevent that. Browser history
  on the same device can preserve source URLs for re-downloads, but true
  30-day guaranteed storage and server-side history persistence require
  persistent storage (a paid Render disk, external object storage and a
  persistent database, or equivalent). A disk mounted at `/data` preserves
  both files and the server history.
- If an older Render environment contains `MAX_AGE_HOURS=24`, update it to
  `720` for the intended 30-day retention. Store only media you have the
  right to download and retain. Larger disks may be required for high volume.


## Reliability upgrade (October 2026)

The Docker build now applies `patch-reliability.js` as the **last** compatibility patch,
before syntax checks and tests. Download behavior no longer relies on a guessed file
extension or a successful process exit alone.

- yt-dlp reports its final output path using `after_move:filepath`. The server
  cross-checks that path against files belonging to the same job.
- The You-Get fallback receives a **literal** sanitized filename prefix, never
  a yt-dlp `%(ext)s` template.
- FFprobe confirms that completed media contains an actual audio or video
  stream. Audio that is not MP3 is transcoded by FFmpeg, verified and saved as
  MP3. Failed/missing/corrupted output does not reach 100% completion.
- The page displays transferred bytes, download speed and ETA when yt-dlp
  exposes those values. If the source does not report them, the UI says
  *unknown* instead of inventing metrics.
- Non-TikTok links bypass the TikTok photo-page detector entirely.
- The default engine timeout is 15 minutes (customizable with
  `DOWNLOADER_ENGINE_TIMEOUT_MS`), although free hosting may terminate long
  jobs independently.
- Completed output is limited by `MAX_DOWNLOAD_SIZE_MB` (default 1024).
  Job errors are logged with their job ID and safe artifact filenames.
- A build-time test suite checks output selection, missing/corrupt files,
  FFmpeg MP3 conversion, extensionless fallback inputs and video validation.

### Validate without GitHub Actions or billing

```sh
# From the repository root; Docker and internet access are required:
docker build -t timzee-media-downloader -f Dockerfile .
docker run --rm -p 3000:3000 timzee-media-downloader

# Or run the isolated reliability tests with Node 22+ and local FFmpeg/FFprobe:
cd downloader
node --test reliability-core.test.js
```

For optional fallback video providers, set `CURIOUSAPI_ENABLED=true` to
opt in to the existing CuriousAPI service; keep it unset/false for privacy.
Set `VIDKRAKEN_ENABLED=true` with your own `VIDKRAKEN_API_KEY` only if you
have reviewed that provider's terms and pricing. These options apply only to
video jobs after the local engines fail. The external result is still
validated before it can be marked complete.

**About free provider APIs:** No third-party API key is required for yt-dlp,
FFmpeg or You-Get. Optional external services can fail, impose limits, collect
links or charge later. Treat them as opt-in supplements, not guaranteed
replacements for locally maintained extractors. Download only media you own,
are authorized to save or that the source allows.

**Limitations:** These tests use generated media and fake/edge-case files.
They do **not** verify live access to every site or guarantee that a
particular Audiomack URL works. Run a live test against media you are
authorized to download on the actual Render deployment before merging.
Render Free has cold starts and an ephemeral disk; completed files and server
history can be lost on restart. Do not advertise permanent storage or
always-on reliability on that plan.

## Local testing

```bash
docker build -t media-downloader .
docker run -p 3000:3000 media-downloader
```

Then open http://localhost:3000
