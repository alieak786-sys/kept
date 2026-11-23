import express from 'express'
import cors from 'cors'

const app = express()

app.use(cors()) // lets the glasses app (another port) call this server
app.use(express.json())

app.get('/api/health', (req, res) => {
  res.json({ ok: true, app: 'kept', time: new Date().toISOString() })
})
app.post(
  '/api/audio',
  express.raw({
    type: 'application/octet-stream',
    limit: '1mb',
  }),
  (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'No audio data received',
      })
    }

    console.log('Audio received:', req.body.length, 'bytes')

    res.json({
      ok: true,
      receivedBytes: req.body.length,
    })
  },
)

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Kept server running on http://localhost:${PORT}`)
})