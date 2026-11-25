// Converts raw PCM audio to WAV in memory and sends it to Groq Whisper.
// Nothing is saved to disk.

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions'

// Only chunks that are practically dead are skipped by loudness
const SILENCE_LEVEL = 100
// Whisper's own "this part has no speech" score (0 to 1)
const NO_SPEECH_LIMIT = 0.6

const PROMPT = 'Meeting. Report, invoice, email, deadline, Friday.'
const PROMPT_WORDS = new Set(
  PROMPT.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean),
)

// Phrases Whisper makes up when there is no real speech
const HALLUCINATIONS = [
  'thank you',
  'thank you.',
  'thanks for watching',
  'thanks for watching.',
  'you',
  'bye',
  'bye.',
  'продолжение следует...',
]

// 16 kHz, mono, 16-bit PCM -> add a 44-byte WAV header
export function pcmToWav(pcm, sampleRate = 16000) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16) // fmt chunk size
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28) // byte rate
  header.writeUInt16LE(2, 32) // block align
  header.writeUInt16LE(16, 34) // bits per sample
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

// Returns { dc, level }: constant offset, and loudness after removing that offset
function measure(pcm) {
  const n = Math.floor(pcm.length / 2)
  if (n === 0) return { dc: 0, level: 0 }
  let sum = 0
  for (let i = 0; i < n; i++) sum += pcm.readInt16LE(i * 2)
  const dc = sum / n
  let sq = 0
  for (let i = 0; i < n; i++) {
    const d = pcm.readInt16LE(i * 2) - dc
    sq += d * d
  }
  return { dc, level: Math.sqrt(sq / n) }
}

export function isSilent(pcm) {
  const { dc, level } = measure(pcm)
  console.log(`Level: ${Math.round(level)} (offset ${Math.round(dc)})`)
  return level < SILENCE_LEVEL
}

// True if the text is just the prompt words repeated back
function isPromptEcho(text) {
  const words = text.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const hits = words.filter((w) => PROMPT_WORDS.has(w)).length
  return hits / words.length >= 0.8
}

// Calls Groq, retrying on network errors, rate limits (429) and server errors (5xx)
async function postToGroq(form) {
  const attempts = 3
  let lastError

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(GROQ_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
        body: form,
        signal: AbortSignal.timeout(20000),
      })
      if (res.ok) return await res.json()

      const body = await res.text()
      const error = new Error(`Groq error ${res.status}: ${body}`)
      // Wrong key / bad request will not get better by retrying
      if (res.status !== 429 && res.status < 500) {
        error.noRetry = true
        throw error
      }
      lastError = error
    } catch (err) {
      if (err.noRetry) throw err
      lastError = err
    }

    if (attempt < attempts) {
      console.log(`Groq attempt ${attempt} failed (${lastError.message}), retrying...`)
      await new Promise((resolve) => setTimeout(resolve, 700 * attempt))
    }
  }
  throw lastError
}

export async function transcribe(pcm) {
  const form = new FormData()
  form.append('file', new Blob([pcmToWav(pcm)], { type: 'audio/wav' }), 'chunk.wav')
  form.append('model', process.env.GROQ_MODEL || 'whisper-large-v3-turbo')
  form.append('language', 'en')
//   form.append('prompt', PROMPT)
  form.append('response_format', 'verbose_json')
  form.append('temperature', '0')

    const data = await postToGroq(form)

  let text
  if (Array.isArray(data.segments)) {
    const scores = data.segments.map((s) => Number(s.no_speech_prob).toFixed(2)).join(', ')
    console.log(`no_speech_prob: [${scores}]`)
    text = data.segments
      .filter((s) => s.no_speech_prob < NO_SPEECH_LIMIT)
      .map((s) => s.text)
      .join(' ')
      .trim()
  } else {
    text = (data.text || '').trim()
  }

  if (HALLUCINATIONS.includes(text.toLowerCase())) return ''
  if (text && isPromptEcho(text)) return ''
  return text
}