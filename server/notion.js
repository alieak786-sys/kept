// Creates a task row in the "Kept Tasks" Notion database.

const NOTION_URL = 'https://api.notion.com/v1/pages'

function capitalise(text) {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export async function createNotionTask({ task, person, due }) {
  const properties = {
    Name: { title: [{ text: { content: capitalise(task) } }] },
  }
  if (due) properties.Due = { date: { start: due } }
  if (person) properties.For = { rich_text: [{ text: { content: person } }] }

  const res = await fetch(NOTION_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.NOTION_API_KEY}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      parent: { database_id: process.env.NOTION_DATABASE_ID },
      properties,
    }),
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`Notion ${res.status}: ${await res.text()}`)
  const page = await res.json()
  return { id: page.id, url: page.url }
}