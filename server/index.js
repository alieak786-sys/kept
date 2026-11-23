import express from 'express'
import cors from 'cors'

const app = express()

app.use(cors()) // lets the glasses app (another port) call this server
app.use(express.json())

app.get('/api/health', (req, res) => {
  res.json({ ok: true, app: 'kept', time: new Date().toISOString() })
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Kept server running on http://localhost:${PORT}`)
})