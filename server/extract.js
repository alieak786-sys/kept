// Asks an OpenRouter model to find promises ("commitments") in a transcript.
// Nothing is saved; the text only goes to the model.

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const TIMEZONE = 'Asia/Karachi'
const MIN_CONFIDENCE = 0.7

function todayInfo() {
  const now = new Date()
  return {
    date: now.toLocaleDateString('en-CA', { timeZone: TIMEZONE }), // YYYY-MM-DD
    weekday: now.toLocaleDateString('en-US', { timeZone: TIMEZONE, weekday: 'long' }),
  }
}

function buildMessages(transcript) {
  const { date, weekday } = todayInfo()
  const system = `You find promises in meeting speech.
A promise is something the SPEAKER says they will do, like "I will send...", "I'll email...", "let me share...".
Ignore questions, things already done in the past, tasks of other people, and vague talk.
Today is ${weekday}, ${date}.
Convert deadlines to YYYY-MM-DD ("Friday" means the next upcoming Friday, "tomorrow" means tomorrow). If there is no deadline use null.
Reply with JSON only, no explanation, in exactly this shape:
{"commitments":[{"task":"short action phrase","person":"who it is for, or null","due":"YYYY-MM-DD or null","confidence":0.0}]}
confidence is a number from 0 to 1. If there are no promises reply {"commitments":[]}.`
  return [
    { role: 'system', content: system },
    { role: 'user', content: transcript },
  ]
}

// Models sometimes add extra words or code fences around the JSON
function parseJson(raw) {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('No JSON in model reply')
  return JSON.parse(raw.slice(start, end + 1))
}

async function callModel(model, messages) {
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages, temperature: 0 }),
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`)
  const data = await res.json()
  const content = data.choices?.[0]?.message?.content
  if (!content) throw new Error('Empty reply from model')
  return content
}

export async function extractCommitments(transcript) {
  const messages = buildMessages(transcript)
  const models = [process.env.OPENROUTER_MODEL, process.env.OPENROUTER_MODEL_BACKUP].filter(Boolean)

  let lastError
  for (const model of models) {
    try {
      const raw = await callModel(model, messages)
      const parsed = parseJson(raw)
      const list = Array.isArray(parsed.commitments) ? parsed.commitments : []
      return list
        .filter((c) => c && typeof c.task === 'string' && c.task.trim())
        .map((c) => ({
          task: c.task.trim(),
          person: c.person || null,
          due: c.due || null,
          confidence: Number(c.confidence) || 0,
        }))
        .filter((c) => c.confidence >= MIN_CONFIDENCE)
    } catch (err) {
      console.error(`Model ${model} failed: ${err.message}`)
      lastError = err
    }
  }
  throw lastError || new Error('No OpenRouter model configured')
}