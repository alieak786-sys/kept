const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from',
  'will', 'would', 'could', 'should', 'have', 'has',
  'are', 'was', 'were', 'you', 'your', 'our', 'their',
  'about', 'into', 'then', 'them', 'they', 'meeting',
])

function getWords(value) {
  return new Set(
    String(value || '')
      .toLowerCase()
      .match(/[a-z0-9]+/g)
      ?.filter((word) => word.length > 2 && !STOP_WORDS.has(word)) || [],
  )
}

function calculateSimilarity(first, second) {
  const a = getWords(first)
  const b = getWords(second)

  if (!a.size || !b.size) return 0

  const intersection = [...a].filter((word) => b.has(word)).length
  const union = new Set([...a, ...b]).size

  return union ? intersection / union : 0
}

function parseModelJson(content) {
  if (typeof content !== 'string') {
    throw new Error('The comparison model returned no text')
  }

  const start = content.indexOf('{')
  const end = content.lastIndexOf('}')

  if (start === -1 || end <= start) {
    throw new Error('The comparison model did not return JSON')
  }

  return JSON.parse(content.slice(start, end + 1))
}

function fallbackComparison(task, events) {
  let bestIndex = -1
  let bestScore = 0

  events.forEach((event, index) => {
    const score = calculateSimilarity(task, event.title)

    if (score > bestScore) {
      bestScore = score
      bestIndex = index
    }
  })

  const isDuplicate = bestScore >= 0.6

  return {
    isDuplicate,
    matchingEventIndex: isDuplicate ? bestIndex : null,
    confidence: Number(bestScore.toFixed(2)),
    reason: isDuplicate
      ? 'The task has strong wording overlap with an existing event.'
      : 'No strong wording match was found.',
    method: 'fallback',
  }
}

export async function comparePromiseWithCalendar(task, events) {
  if (!Array.isArray(events) || events.length === 0) {
    return {
      isDuplicate: false,
      matchingEventIndex: null,
      confidence: 0,
      reason: 'There are no existing events on this date.',
      method: 'none',
    }
  }

  const apiKey = process.env.OPENROUTER_API_KEY

  if (!apiKey) {
    return fallbackComparison(task, events)
  }

  const models = [
    process.env.OPENROUTER_MODEL,
    process.env.OPENROUTER_MODEL_BACKUP,
  ].filter(Boolean)

  for (const model of [...new Set(models)]) {
    try {
      const response = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 250,
          messages: [
            {
              role: 'system',
              content: `
You compare a newly detected promise with existing calendar events.

A duplicate means the existing event represents substantially the same
obligation, deliverable, or commitment.

Do not call two events duplicates merely because they are on the same day
or concern the same general subject.

Return ONLY valid JSON in this exact structure:
{
  "isDuplicate": false,
  "matchingEventIndex": null,
  "confidence": 0,
  "reason": "Short explanation"
}

matchingEventIndex must be the zero-based index of the matching event,
or null when there is no match.
confidence must be a number between 0 and 1.
              `.trim(),
            },
            {
              role: 'user',
              content: JSON.stringify({
                newPromise: task,
                existingCalendarEvents: events.map((event, index) => ({
                  index,
                  title: event.title,
                  start: event.start,
                  allDay: event.allDay,
                })),
              }),
            },
          ],
        }),
        signal: AbortSignal.timeout(9000),
      })

      if (!response.ok) {
        throw new Error(`OpenRouter HTTP ${response.status}`)
      }

      const result = await response.json()
      const content = result.choices?.[0]?.message?.content
      const parsed = parseModelJson(content)

      const index = parsed.matchingEventIndex
      const validIndex =
        Number.isInteger(index) &&
        index >= 0 &&
        index < events.length

      const isDuplicate =
        parsed.isDuplicate === true && validIndex

      return {
        isDuplicate,
        matchingEventIndex: isDuplicate ? index : null,
        confidence: Math.max(
          0,
          Math.min(1, Number(parsed.confidence) || 0),
        ),
        reason: String(parsed.reason || '').slice(0, 150),
        method: 'llm',
      }
    } catch (error) {
      console.error(
        `Calendar comparison failed with ${model}:`,
        error.message,
      )
    }
  }

  // If the LLM is unavailable, use a conservative local comparison.
  return fallbackComparison(task, events)
}