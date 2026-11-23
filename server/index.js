import express from 'express'
import cors from 'cors'
import { transcribe, isSilent } from './stt.js'
import { extractCommitments } from './extract.js'

const app = express()

app.use(cors())
app.use(express.json())

app.get('/api/health', (req, res) => {
  res.json({ ok: true, app: 'kept', time: new Date().toISOString() })
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