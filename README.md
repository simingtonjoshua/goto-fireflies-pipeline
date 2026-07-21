# GoTo Connect call recording + transcription pipeline

Listens for GoTo Connect call recording notifications, fetches each call's transcript
directly from GoTo (via the Advanced Reporting & Analytics add-on - no third-party
transcription service involved), archives the recording audio to Google Drive, groups
multi-leg calls (parks/transfers) into a single logical interaction using GoTo's Call
History `originatorId`, summarizes that interaction with OpenAI, and posts the summary
to Heymarket as a private note on the customer's conversation.

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
                    src/openaiClient.js summarizes the interaction
                                     │
                                     ▼
                    src/heymarketClient.js posts the summary + Drive
                    link as a private note on the customer's conversation
```

## Status

- Done: GoTo webhook receiving call-state, recording, transcript, Call History, and
-   Call Parking events.
-   - Done: transcripts fetched directly from GoTo - this pipeline does not use Fireflies
    -   or any other third-party transcription service.
    -   - Done: recordings archived to Google Drive (`src/driveClient.js`), with the resulting
        -   link attached to the interaction.
        -   - Done: multi-leg call grouping (parks/transfers) via Call History `originatorId`.
            - - Done: OpenAI summarization of the grouped interaction (`src/openaiClient.js`).
              - - Done: posting that summary (+ Drive link) to Heymarket as a private note
                -   (`src/heymarketClient.js`).
                -   - Not yet verified: none of the above has been exercised against a real live call yet
                    -   (see "Known unverified areas" below) - that's the next step before trusting this in
                    -     production.
                 
                    - ## Environment variables
                 
                    - See `.env.example`. Required: `GOTO_CLIENT_ID`, `GOTO_CLIENT_SECRET`, `GOTO_PAT`,
                    - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`,
                    - `GOOGLE_DRIVE_FOLDER_ID`, `OPENAI_API_KEY`, `HEYMARKET_API_SECRET_ID`,
                    - `HEYMARKET_API_SECRET_KEY`, `HEYMARKET_INBOX_ID`, `HEYMARKET_CREATOR_ID`,
                    - `PUBLIC_BASE_URL`. `GOTO_ACCOUNT_KEY` and `OPENAI_MODEL` are optional.
                 
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
                              6.    `INTERACTION READY FOR SUMMARY`, then confirm a private note shows up on the
                              7.   customer's Heymarket conversation.
                           
                              8.   ## Hosting
                           
                              9.   Currently deployed on [Render.com](https://render.com) (free web service, Docker
                              10.   runtime). The included `Dockerfile` also works unmodified on Fly.io, Railway, or any
                              11.   other container host that gives you a public HTTPS URL.
                           
                              12.   ## Google Drive archival
                           
                              13.   `src/driveClient.js` uploads each recording to a "Call Recordings" folder in
                              14.   jsimington@budgetblinds.com's personal Google Drive, using a pre-authorized OAuth2
                              15.   refresh token with the minimal `drive.file` scope (this app can only see/manage files
                              16.   it creates itself - it cannot browse the rest of the Drive). That folder can be moved
                              17.   anywhere in Drive (e.g. under "Budget Blinds Company File Center") without breaking
                              18.   this app's access, since `drive.file` grants are tied to the file's resource id, not
                              19.   its location in the folder hierarchy.
                           
                              20.   ## OpenAI summarization
                           
                              21.   `src/openaiClient.js` concatenates every leg's transcript (chronologically, across
                              22.   parks/transfers) into one plain-text conversation, and asks OpenAI (`gpt-4o-mini` by
                              23.   default) for a short factual summary covering why the customer called, what was
                              24.   discussed or resolved, and any follow-up needed. Transcript lines are labeled by raw
                              25.   channel number rather than a guessed CSR/customer role - see "Known unverified areas"
                              26.   below.
                           
                              27.   ## Heymarket private notes
                           
                              28.   `src/heymarketClient.js` posts the OpenAI summary + Drive link to the customer's
                              29.   Heymarket conversation as a private note (visible only to the team, not the customer),
                              30.   via `POST /v1/message/send` with `private: true`. Authenticates with a short-lived JWT
                              31.   signed from a Heymarket API Secret ID/Key (not the simpler long-lived team API key) -
                              32.   see the comment at the top of that file for the exact signing scheme.
                           
                              33.   ## Known unverified areas
                           
                              34.   None of the following has been checked against a real live call yet - the next step is
                              35.   making one (including a park and a transfer) and confirming each of these:
                           
                              36.   - Whether the Call History subscription, given only `{ accountKey, channelId }` with
                                    -   no `userKeys`, covers the whole account rather than just the calling principal's own
                                    -     calls. If `src/interactions.js` logs show Call History events for only one user,
                                    -   `userKeys` (or per-extension `extensions`) needs to be added explicitly - see the
                                    -     comment above `subscribeCallHistoryEvents` in `src/gotoClient.js`.
                                    - - The exact payload shape of Call Parking events (`handleCallParkingEvent` in
                                      -   `src/interactions.js` currently just logs the raw payload). Not fatal either way -
                                      -     Call History correlation still catches parks, just without the instant signal.
                                      - - The exact shape of the transcript JSON returned by GoTo's Transcriptions endpoint,
                                        -   and which physical channel (0 or 1) maps to the CSR vs. the customer - see the
                                        -     comments in `src/gotoClient.js` (`fetchTranscript`) and `src/openaiClient.js`
                                        -   (`normalizeTranscript`/`buildConversationText`).
                                        -   - Whether Heymarket's private-message send actually resolves the right conversation
                                            -   from `phone_number` alone the way its own docs example implies, for a number that
                                            -     already has message history under this team's inbox.
                                         
                                            - ## Local development
                                         
                                            - ```
                                              npm install
                                              cp .env.example .env   # then fill in real values
                                              npm start               # runs the webhook server
                                              # in another terminal, once PUBLIC_BASE_URL is a real reachable URL:
                                              npm run setup
                                              ```
                                              
