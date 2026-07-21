# GoTo Connect call recording + transcription pipeline

Listens for GoTo Connect call recording notifications, fetches each call's transcript
directly from GoTo (via the Advanced Reporting & Analytics add-on - no third-party
transcription service involved), archives the recording audio to Google Drive, and
groups multi-leg calls (parks/transfers) into a single logical interaction using GoTo's
Call History `originatorId`.

```
GoTo Connect call ends
        │
        ▼
GoTo webhook notification  ──►  this service
                                     │
                    ┌────────────────┼─────────────────────┐
                    ▼                                       ▼
      fetch transcript from GoTo               fetch recording bytes from GoTo
      (Advanced Reporting & Analytics)                      │
                    │                                        ▼
                    │                      archive to Joshua's Google Drive
                    │                      ("Call Recordings" folder)
                    └────────────────┬─────────────────────┘
                                     ▼
                    src/interactions.js groups legs into one
                    interaction (originatorId), attaches transcript(s)
                    + Drive link(s), and finalizes after a quiet period
                                     │
                                     ▼
                    (next) OpenAI summary → posted to Heymarket
```

## Status

- Done: GoTo webhook receiving call-state, recording, transcript, Call History, and
-   Call Parking events.
-   - Done: transcripts fetched directly from GoTo - this pipeline does not use Fireflies
    -   or any other third-party transcription service.
    -   - Done: recordings archived to Google Drive (`src/driveClient.js`), with the resulting
        -   link attached to the interaction.
        -   - Done: multi-leg call grouping (parks/transfers) via Call History `originatorId`.
            - - Not started: OpenAI summarization of the grouped interaction.
              - - Not started: posting that summary (+ Drive link) to Heymarket as a private note.
               
                - ## Environment variables
               
                - See `.env.example`. Required: `GOTO_CLIENT_ID`, `GOTO_CLIENT_SECRET`, `GOTO_PAT`,
                - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`,
                - `GOOGLE_DRIVE_FOLDER_ID`, `PUBLIC_BASE_URL`. `GOTO_ACCOUNT_KEY` is optional (auto-
                - discovered if left blank) and `OPENAI_API_KEY` is reserved for the summarization step.
               
                - ## Setup
               
                - 1. Deploy this service somewhere with a public HTTPS URL (see Hosting below).
                  2. 2. Set `PUBLIC_BASE_URL` in the environment to that URL.
                     3. 3. Run `npm install && npm run setup` **once, after deploying** - it creates the GoTo
                        4.    notification channel and subscribes it to call-state and recording notifications.
                        5.4. Call History and Call Parking subscriptions can be (re)registered on that same
                             channel, without duplicating the others, via the one-off
                             `/admin/register-new-subscriptions` route (see the comment above it in
                             `src/server.js` for why it's separate from `npm run setup`).
                          5. Make a test call - including a park and a transfer - and check the logs for
                          6.    `INTERACTION READY FOR SUMMARY`.
                       
                          7.## Hosting

                        Currently deployed on [Render.com](https://render.com) (free web service, Docker
                        runtime). The included `Dockerfile` also works unmodified on Fly.io, Railway, or any
                        other container host that gives you a public HTTPS URL.

                        ## Google Drive archival

                        `src/driveClient.js` uploads each recording to a "Call Recordings" folder in
                        jsimington@budgetblinds.com's personal Google Drive, using a pre-authorized OAuth2
                        refresh token with the minimal `drive.file` scope (this app can only see/manage files
                        it creates itself - it cannot browse the rest of the Drive). That folder can be moved
                        anywhere in Drive (e.g. under "Budget Blinds Company File Center") without breaking
                        this app's access, since `drive.file` grants are tied to the file's resource id, not
                        its location in the folder hierarchy.

                        ## Known unverified areas

                        - Whether the Call History subscription, given only `{ accountKey, channelId }` with
                        -   no `userKeys`, covers the whole account rather than just the calling principal's own
                        -     calls. If `src/interactions.js` logs show Call History events for only one user,
                        -   `userKeys` (or per-extension `extensions`) needs to be added explicitly - see the
                        -     comment above `subscribeCallHistoryEvents` in `src/gotoClient.js`.
                        - - The exact payload shape of Call Parking events (`handleCallParkingEvent` in
                          -   `src/interactions.js` currently just logs the raw payload). Not fatal either way -
                          -     Call History correlation still catches parks, just without the instant signal.
                          - - Which physical transcript channel (0 or 1) maps to the CSR vs. the customer - see the
                            -   comment above `fetchTranscript` in `src/gotoClient.js`.
                           
                            -   ## Local development
                           
                            -   ```
                                npm install
                                cp .env.example .env   # then fill in real values
                                npm start               # runs the webhook server
                                # in another terminal, once PUBLIC_BASE_URL is a real reachable URL:
                                npm run setup
                                ```
                                
