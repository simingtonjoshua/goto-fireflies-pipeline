# GoTo Connect → Fireflies recording pipeline

Listens for GoTo Connect call recording notifications and automatically sends each
recording to Fireflies.ai for transcription.

```
GoTo Connect call ends
        │
        ▼
GoTo webhook notification  ──►  this service  ──►  fetch recording bytes from GoTo
                                                              │
                                                              ▼
                                          stage recording at a public URL (local or S3)
                                                              │
                                                              ▼
                                          Fireflies.ai uploadAudio (transcription starts)
```

## What's already done

- GoTo Connect OAuth client (`GoToConnect Zapier Recording I`, id `9fee6460-aae5-40a8-bc0c-6234f6c7ca0e`)
  already has every scope this needs: `call-events.v1.events.read`,
  `call-events.v1.notifications.manage`, `recording.v1.read`,
  `recording.v1.notifications.manage`, plus the Personal Access Token grant type.
- A new client secret and a new Personal Access Token were generated for this
  integration and saved to `.env.secrets` (not committed, not shown in chat).
- A Fireflies API key was pulled from Settings → MCP & Dev Tools and saved the same way.

Copy the values from `.env.secrets` into `.env` (based on `.env.example`) wherever you
deploy this.

## What you still need to do

1. **Deploy this service somewhere with a public HTTPS URL** (see Hosting below).
2. Set `PUBLIC_BASE_URL` in `.env` to that URL.
3. Run `npm install && npm run setup` **once, after deploying** — it creates the GoTo
   notification channel and subscribes it to call events + recording notifications.
4. Make a test call, check the logs, and confirm a transcript shows up in Fireflies.

## Hosting recommendation

This service needs to be **always-on** and **reachable from the public internet over
HTTPS**, because GoTo pushes webhook events to it in real time. A few good, low-effort
options, roughly in order of simplicity:

- **[Render.com](https://render.com)** — connect this folder as a GitHub repo, create a
  "Web Service," it builds from the included `Dockerfile` (or just `npm start` with a
  Node environment) and gives you a permanent `https://your-app.onrender.com` URL for
  free/cheap. Easiest option if you don't already have cloud infrastructure.
- **[Fly.io](https://fly.io)** — `fly launch` picks up the Dockerfile automatically,
  similarly cheap, slightly more CLI-driven.
- **Railway.app** — similar to Render, git-push deploys.
- **An existing AWS/Azure/GCP account** — if Budget Blinds already has one, this runs
  fine as a small container on ECS Fargate / App Service / Cloud Run. Use
  `STORAGE_BACKEND=s3` in that case since S3 is already in reach.

Whichever you pick, set the environment variables from `.env.example` in that
platform's dashboard/secrets manager — don't commit `.env` or `.env.secrets`.

## Storage backend

Fireflies' `uploadAudio` API requires a public HTTPS URL to the audio file, not raw
bytes, so this service stages each recording somewhere downloadable first:

- `STORAGE_BACKEND=local` (default) — serves the file from this same service at a
  random, one-time URL that expires after an hour. Zero extra setup.
- `STORAGE_BACKEND=s3` — uploads to an S3 bucket and hands Fireflies a presigned URL.
  Requires `npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner` and the
  `AWS_*` / `S3_BUCKET` variables in `.env`.

## One thing to verify after first real call

GoTo's Recording API notification payload shape wasn't confirmed against a live
example while building this (this environment couldn't reach GoTo's API directly to
test — see below). `src/server.js`'s `extractRecordingId()` guesses at a few common
field names. After the first real call:

1. Check the service logs for `GoTo notification received: {...}` — that's the raw
   payload GoTo sent.
2. Confirm the recording ID field name matches what `extractRecordingId()` expects; if
   not, add the correct path.
3. Also sanity-check `subscribeRecordingEvents()` in `src/gotoClient.js` — the
   `/recording/v1/subscriptions` endpoint was inferred from the Call Events API's
   documented pattern (both are described as going through the same Notification
   Channel API), not confirmed against GoTo's interactive API explorer at
   https://developer.goto.com/GoToConnect. If `npm run setup` errors on that step,
   check the explorer for the exact path/body.

## Why this wasn't fully tested end-to-end here

This was built and the GoTo/Fireflies credentials were provisioned from inside a
sandboxed environment whose outbound network is allowlisted — it couldn't reach
`authentication.logmeininc.com`, `api.goto.com`, or `api.fireflies.ai` to run a live
test. Everything here is built directly from GoTo's and Fireflies' published API docs
plus the credentials collected in the browser, but the first real deploy should be
treated as the actual integration test.

## Local development

```
npm install
cp .env.example .env   # then fill in values from .env.secrets
npm start               # runs the webhook server
# in another terminal, once PUBLIC_BASE_URL is a real reachable URL:
npm run setup
```
