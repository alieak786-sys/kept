import express from 'express'
import cors from 'cors'
import { transcribe, isSilent } from './stt.js'
import { extractCommitments } from './extract.js'
import { createNotionTask } from './notion.js'
import {
  createGoogleOAuthClient,
  createCalendarDeadline,
  revokeGoogleAccess,
} from './google.js'
import { randomBytes } from 'node:crypto'
import { saveGoogleTokens, loadGoogleTokens } from './store.js'
import {
  ensureIndexes,
  isValidDeviceId,
  startPairing,
  getPairedUserId,
  findValidPairing,
  completePairing,
  deleteDeviceData,
} from './pairing.js'
import { pairPage, pairedPage } from './pages.js'
const app = express()

// OAuth "state" values live in memory for 10 minutes (fine to lose on restart).
const googleOAuthStates = new Map()

// Until pairing is added, one fixed user is used.
const DEMO_USER_ID = 'demo'


// Which pairing code started which Google login (state -> code)
const pairingByState = new Map()

app.use(cors())
app.use(express.json())

app.get('/api/health', (req, res) => {
  res.json({ ok: true, app: 'kept', time: new Date().toISOString() })
})

// The glasses ask for a pairing code to show on screen
app.post('/api/pair/start', async (req, res) => {
  const { deviceId } = req.body || {}
  if (!isValidDeviceId(deviceId)) {
    return res.status(400).json({ ok: false, error: 'Invalid device id' })
  }
  try {
    const result = await startPairing(deviceId)
    res.json({ ok: true, ...result })
  } catch (err) {
    console.error('Pair start failed:', err.message)
    res.status(500).json({ ok: false, error: 'Could not start pairing' })
  }
})

// The glasses ask whether the user has finished pairing
app.get('/api/pair/status', async (req, res) => {
  const { deviceId } = req.query
  if (!isValidDeviceId(deviceId)) {
    return res.status(400).json({ ok: false, error: 'Invalid device id' })
  }
  try {
    res.json({ ok: true, paired: Boolean(await getPairedUserId(deviceId)) })
  } catch (err) {
    console.error('Pair status failed:', err.message)
    res.status(500).json({ ok: false, error: 'Could not check pairing' })
  }
})

// Page where the user types the code shown on the glasses
app.get('/pair', (req, res) => {
  res.send(pairPage())
})

// Starts Google login for a valid pairing code
app.get('/pair/connect', async (req, res) => {
  const code = String(req.query.code || '').trim().toUpperCase()

  if (!/^[A-Z0-9]{6}$/.test(code)) {
    return res.status(400).send(pairPage('That code does not look right. It has 6 letters or numbers.'))
  }

  try {
    const pairing = await findValidPairing(code)
    if (!pairing) {
      return res.status(400).send(pairPage('Code not found or expired. Check your glasses for a fresh code.'))
    }

    // Forget finished or expired logins
    for (const savedState of pairingByState.keys()) {
      if (!googleOAuthStates.has(savedState)) pairingByState.delete(savedState)
    }

    const state = randomBytes(32).toString('hex')
    googleOAuthStates.set(state, Date.now() + 10 * 60 * 1000)
    pairingByState.set(state, code)

    const url = createGoogleOAuthClient().generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: true,
      scope: ['https://www.googleapis.com/auth/calendar.events'],
      state,
    })
    res.redirect(url)
  } catch (err) {
    console.error('Pair connect failed:', err.message)
    res.status(500).send(pairPage('Something went wrong. Please try again.'))
  }
})


// "Delete my data": removes the saved Google login and unlinks these glasses
app.post('/api/data/delete', async (req, res) => {
  const { deviceId } = req.body || {}
  if (!isValidDeviceId(deviceId)) {
    return res.status(400).json({ ok: false, error: 'Invalid device id' })
  }

  try {
    const { tokens } = await deleteDeviceData(deviceId)

    if (tokens) {
      try {
        await revokeGoogleAccess(tokens)
      } catch (err) {
        console.error('Google revoke failed:', err.message)
      }
    }

    console.log('User data deleted for one device')
    res.json({ ok: true })
  } catch (err) {
    console.error('Data delete failed:', err.message)
    res.status(500).json({ ok: false, error: 'Could not delete data' })
  }
})
// Called when the user taps "add" on a promise card
app.post('/api/cards/approve', async (req, res) => {
  const { task, person, due, deviceId } = req.body || {}
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
      // Find the user these glasses are paired with, then that user's Google tokens
      let googleTokens = null
      try {
        const userId = isValidDeviceId(deviceId) ? await getPairedUserId(deviceId) : null
        if (userId) googleTokens = await loadGoogleTokens(userId)
      } catch (err) {
        console.error('Token load failed:', err.message)
      }
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

  

    console.log(
      'Google OAuth connected. Refresh token received:',
      Boolean(tokens.refresh_token),
    )

    if (!tokens.refresh_token) {
      return res.status(200).send(
        'Google authorization succeeded, but no refresh token was returned. Check the Google account permissions and try reconnecting if needed.',
      )
    }

          // Login that started from the /pair page: link these tokens to the glasses
    const pairingCode = pairingByState.get(state)
    pairingByState.delete(state)
    if (pairingCode) {
      const userId = await completePairing(pairingCode, tokens)
      if (!userId) {
        return res.status(400).send(pairPage('This code expired. Get a fresh code on your glasses and try again.'))
      }
      console.log('Pairing completed for a new user')
      return res.status(200).send(pairedPage())
    }

    await saveGoogleTokens(DEMO_USER_ID, tokens)
    console.log('Google tokens saved (encrypted) in MongoDB')

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

ensureIndexes().catch((err) => console.error('Index setup failed:', err.message))

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Kept server running on http://localhost:${PORT}`)
})