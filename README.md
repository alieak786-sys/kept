# VowGlass: Promise Keeper for Even G2

> Never forget what you promised in a meeting. VowGlass listens through your Even G2 glasses, catches promises you say out loud, and with one tap turns them into a Notion task, a Google Calendar deadline and a Gmail follow-up draft.

**Heads Up: Even Realities Hackathon, Track 04**

- Demo video: [DEMO VIDEO LINK]
- Live backend health check: https://kept-production-9765f151.up.railway.app/api/health

## The problem

In meetings we say things like "I'll send you the report by Friday" and then forget them. Taking notes while talking is awkward. VowGlass captures the promise at the moment you say it and shows a small card on the glasses, so you stay in the conversation.

## What it does

1. Start a meeting with a tap. The glasses listen through the G2 microphone.
2. Every 5 seconds the last 10 seconds of audio are sent to the backend (overlapping windows, so a sentence is never cut in half).
3. The backend turns speech into text (Groq Whisper) and asks an AI model (OpenRouter) whether you made a promise.
4. A card appears on the glasses, for example:

        ! Promise caught
        Send the budget to Sara
        Due: Fri 27 Nov
        Tap = add
        Swipe down = skip

5. Tap to approve. VowGlass then creates:
   - a **Notion** task (title, due date, who it is for),
   - a **Google Calendar** all-day deadline,
   - a **Gmail draft** follow-up when the promise names a person. It is only a draft; nothing is ever sent.
6. At the end of the meeting a summary shows how many promises were caught, added and skipped.

## Gestures

| Gesture | Action |
|---|---|
| Tap | Start meeting / add the promise / check the last 30 seconds |
| Swipe down | Skip a card |
| Swipe up | Pause or resume listening (on the start screen: delete my data) |
| Long press | End the meeting and show the summary |
| Double tap | Exit the app (platform rule) |

## Features

- Live promise detection from speech, with relative dates resolved ("Friday", "tomorrow") to real dates
- Read and write on real accounts: Notion, Google Calendar, Gmail drafts
- Account linking by pairing code: the glasses show a short code, you open the pairing page on your phone and sign in with Google (Google sign-in does not work inside the glasses WebView)
- Manual "check the last 30 seconds" tap as a fallback if the AI missed something
- Duplicate protection (the same promise is not shown twice within a minute)
- End-of-meeting summary
- "Delete my data" on the glasses: erases the stored login and revokes Google access
- Retries and timeouts around the speech and AI services, with a backup AI model

## Privacy and safety

- **Audio is never stored.** It is processed in memory while a request is handled and then discarded.
- **Transcripts are never stored.** In production the server does not write them to its logs either.
- The database holds only: a pairing code (deleted after use or after 10 minutes), a device id, a user id and the user's Google tokens, **encrypted with AES-256-GCM**.
- Only promises the user explicitly approves are written to Notion, Calendar or Gmail.
- Gmail: VowGlass requests the `gmail.compose` permission. Google describes this permission as "manage drafts and send emails". The code only ever creates drafts and never calls the send endpoint.
- Google tokens can be deleted at any time from the glasses ("delete my data"). Tasks and events already created stay in the user's own Notion and Calendar.
- No money, wallets or financial actions are involved.
- Free AI models on OpenRouter may retain prompts depending on the provider. For that reason the demo uses scripted conversations only, and real meetings should only be used with the consent of everyone present.

## Architecture

```
Even G2 glasses (Even App WebView: Vite + plain JavaScript + Even Hub SDK)
        |  HTTPS, 10 s PCM windows every 5 s
        v
Node.js / Express backend (Railway)
   |-- Groq Whisper (speech to text)
   |-- OpenRouter (promise extraction as JSON)
   |-- Notion API (task)
   |-- Google Calendar API (deadline)
   |-- Gmail API (draft)
   '-- MongoDB Atlas (devices, pairing codes, encrypted Google tokens)
```

## Tech stack and services

- Glasses app: Vite, plain JavaScript, `@evenrealities/even_hub_sdk`
- Backend: Node.js, Express, `googleapis`, `mongodb`
- Speech to text: Groq (`whisper-large-v3`), a supporting tool confirmed as allowed by the organizers
- AI: OpenRouter (`nvidia/nemotron-3-ultra-550b-a55b:free` with `openrouter/free` as backup)
- Track 04 apps used as core integrations: **OpenRouter, Notion, Google Workspace (Calendar, Gmail)**
- Hosting: Railway (backend), MongoDB Atlas (database)

## What existed before the hackathon

- The official Even Hub SDK, CLI and simulator (used as dependencies)
- The official minimal template, used only as a reference to learn the SDK (not part of this repository)
- The standard Vite vanilla JavaScript scaffold (the unused `src/counter.js` and default styles come from it)

Everything else in this repository was written between 23 and 29 November 2026.

## AI assistance disclosure

This project was built with the help of AI coding assistants (Claude and ChatGPT). The AI assistants wrote most of the code step by step; the developer set the idea and requirements, created and configured all accounts and API keys, ran and tested every step in the simulator and with real Notion, Google and Gmail accounts, and fixed the problems found.

## Try it

There is no physical G2 here, so everything was tested with the official simulator.

1. Clone the repository.
2. Backend (optional, a deployed backend is already configured in the glasses app):
   ```
   cd server
   npm install
   cp .env.example .env     # then fill in your own keys
   npm run dev
   ```
3. Glasses app:
   ```
   cd glasses
   npm install
   npm run dev
   ```
4. In another terminal start the simulator:
   ```
   evenhub-simulator http://localhost:5173
   ```
5. Tap "Click" in the simulator, then say, for example: "I will send the budget to Sara by Friday."

The backend address is set in `glasses/src/api.js`, `glasses/src/main.js` and the network whitelist in `glasses/app.json`. To run everything locally, change those to `http://localhost:3000`.

Note: the Google app is in "Testing" mode, so only accounts added as test users can sign in. Please watch the demo video or contact the author for access.

## Environment variables (`server/.env.example`)

```
OPENROUTER_API_KEY=
OPENROUTER_MODEL=nvidia/nemotron-3-ultra-550b-a55b:free
OPENROUTER_MODEL_BACKUP=openrouter/free
GROQ_API_KEY=
GROQ_MODEL=whisper-large-v3
NOTION_API_KEY=
NOTION_DATABASE_ID=
MONGODB_URI=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=
TOKEN_ENCRYPTION_KEY=   # 64 hex characters
NODE_ENV=production     # keeps transcripts out of the logs
```

The Notion database needs three columns: `Name` (title), `Due` (date) and `For` (text).

## Project structure

```
glasses/   Even G2 app (screens, gestures, microphone capture, cards)
server/    Express backend
  index.js     routes
  stt.js       speech to text (Groq)
  extract.js   promise extraction (OpenRouter)
  notion.js    Notion tasks
  google.js    Google OAuth, Calendar events, Gmail drafts
  pairing.js   pairing codes and device linking
  store.js     encrypted token storage
  crypto.js    AES-256-GCM helpers
  db.js        MongoDB connection
  pages.js     pairing web pages
```

## API

| Route | Purpose |
|---|---|
| `GET /api/health` | Health check |
| `POST /api/audio` | Raw PCM in, transcript and detected promises out |
| `POST /api/cards/approve` | Create Notion task, Calendar event and Gmail draft |
| `POST /api/pair/start`, `GET /api/pair/status` | Pairing code for the glasses |
| `GET /pair`, `GET /pair/connect` | Pairing page and Google sign-in |
| `GET /auth/google/callback` | Google OAuth callback |
| `POST /api/data/delete` | Delete a user's stored data and revoke Google access |

## Known limitations

- Listening works only while the app is in the foreground ("meeting mode").
- Notion uses one workspace integration set up by the developer; per-user Notion sign-in is not built.
- The free AI model is sometimes slow, so a card can take 10 to 20 seconds to appear.
- Hosting uses a trial plan, so the backend may stop after the trial ends.
- Tested with the simulator, not on physical glasses.

## Feedback for the Even Hub API (feature requests)

1. Built-in account linking (OAuth or QR sign-in) for apps running in the WebView.
2. A documented persistent storage API for device ids and settings.
3. Microphone capture that continues when the display is off, with a clear privacy indicator.
4. Text styling in text containers (font size, bold, alignment).
5. A way to feed an audio file to the simulator as microphone input for repeatable tests.