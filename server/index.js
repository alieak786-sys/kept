import express from 'express'
import cors from 'cors'
import { transcribe, isSilent } from './stt.js'
import { extractCommitments } from './extract.js'
import { createNotionTask } from './notion.js'
import {
  createGoogleOAuthClient,
  createCalendarDeadline,
} from './google.js'
import { randomBytes } from 'node:crypto'

const app = express()

// Temporary OAuth storage for local testing.
// Persistent token storage will be added with MongoDB.
const googleOAuthStates = new Map()
let googleTokens = null


app.use(cors())
app.use(express.json())

app.get('/api/health', (req, res) => {
  res.json({ ok: true, app: 'kept', time: new Date().toISOString() })
})


// Called when the user taps "add" on a promise card
app.post('/api/cards/approve', async (req, res) => {
  const { task, person, due } = req.body || {}

  if (typeof task !== 'string' || !task.trim()) {
    return res.status(400).json({
      ok: false,
      error: 'Task is required',
    })
  }

  const cleanTask = task.trim().slice(0, 200)

  const cleanPerson =
    typeof person === 'string' && person.trim()
      ? person.trim().slice(0, 100)
      : null

  const cleanDue = /^\d{4}-\d{2}-\d{2}$/.test(due || '')
    ? due
    : null

  try {
    // First save the task to Notion.
    const page = await createNotionTask({
      task: cleanTask,
      person: cleanPerson,
      due: cleanDue,
    })

    console.log('Notion task created:', page.url)

    // Then attempt to create a Google Calendar event.
    let calendar = {
      created: false,
      status: 'skipped',
    }

    if (cleanDue) {
      if (!googleTokens?.refresh_token) {
        calendar.status = 'not_connected'
        console.log('Calendar event skipped: Google not connected')
      } else {
        try {
          const event = await createCalendarDeadline(googleTokens, {
            task: cleanTask,
            person: cleanPerson,
            due: cleanDue,
          })

          calendar = {
            created: true,
            status: 'created',
            url: event.url,
          }

          console.log('Google Calendar event created:', event.url)
        } catch (calendarError) {
          calendar.status = 'failed'
          console.error(
            'Google Calendar event failed:',
            calendarError.message,
          )
        }
      }
    }

    // Notion success remains success even if Calendar fails.
    res.json({
      ok: true,
      url: page.url,
      calendar,
    })
  } catch (err) {
    console.error(err.message)

    res.status(502).json({
      ok: false,
      error: 'Notion save failed',
    })
  }
})

// Start Google OAuth
app.get('/auth/google', (req, res) => {
  try {
    // Clean expired states
    for (const [savedState, expiresAt] of googleOAuthStates) {
      if (expiresAt < Date.now()) {
        googleOAuthStates.delete(savedState)
      }
    }

    const state = randomBytes(32).toString('hex')
    googleOAuthStates.set(state, Date.now() + 10 * 60 * 1000)

    const oauth2Client = createGoogleOAuthClient()

    const authorizationUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: true,
      scope: [
        'https://www.googleapis.com/auth/calendar.events',
      ],
      state,
    })

    res.redirect(authorizationUrl)
  } catch (err) {
    console.error('Google OAuth start failed:', err.message)
    res.status(500).send('Could not start Google authorization.')
  }
})

// Google OAuth callback
app.get('/auth/google/callback', async (req, res) => {
  const { code, state, error } = req.query

  if (error) {
    return res.status(400).send('Google authorization was cancelled or denied.')
  }

  if (typeof code !== 'string' || typeof state !== 'string') {
    return res.status(400).send('Invalid Google OAuth response.')
  }

  const expiresAt = googleOAuthStates.get(state)
  googleOAuthStates.delete(state)

  if (!expiresAt || expiresAt < Date.now()) {
    return res.status(400).send('OAuth state is invalid or expired. Try again.')
  }

  try {
    const oauth2Client = createGoogleOAuthClient()

    const { tokens } = await oauth2Client.getToken(code)

    oauth2Client.setCredentials(tokens)

    // Temporary storage for this server session only.
    googleTokens = tokens

    console.log(
      'Google OAuth connected. Refresh token received:',
      Boolean(tokens.refresh_token),
    )

    if (!tokens.refresh_token) {
      return res.status(200).send(
        'Google authorization succeeded, but no refresh token was returned. Check the Google account permissions and try reconnecting if needed.',
      )
    }

    res.status(200).send(
      'Google Calendar connected successfully! You can close this page.',
    )
  } catch (err) {
    console.error('Google OAuth callback failed:', err.message)
    res.status(502).send('Google authorization failed. Please try again.')
  }
})

// Raw 16 kHz mono 16-bit PCM, about 10 seconds per chunk


app.post(
  '/api/audio',
  express.raw({ type: 'application/octet-stream', limit: '2mb' }),
  async (req, res) => {
    const pcm = req.body
    if (!Buffer.isBuffer(pcm) || pcm.length === 0) {
      return res.status(400).json({ ok: false, error: 'No audio received' })
    }
    console.log(`Audio received: ${pcm.length} bytes`)

    if (isSilent(pcm)) {
      console.log('Silent chunk, skipped')
      return res.json({ ok: true, received: pcm.length, text: '', commitments: [] })
    }

    try {
      const text = await transcribe(pcm)
      console.log('Transcript:', text)

      let commitments = []
      if (text) {
        try {
          commitments = await extractCommitments(text)
          console.log('Commitments:', JSON.stringify(commitments))
        } catch (err) {
          console.error('Extraction failed:', err.message)
        }
      }
      res.json({ ok: true, received: pcm.length, text, commitments })
    } catch (err) {
      console.error(err.message)
      res.status(502).json({ ok: false, error: 'Transcription failed' })
    }
  },
)

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Kept server running on http://localhost:${PORT}`)
})