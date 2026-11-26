import { google } from 'googleapis'

export function createGoogleOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  const redirectUri = process.env.GOOGLE_REDIRECT_URI

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('Google OAuth environment variables are missing')
  }

  return new google.auth.OAuth2(
    clientId,
    clientSecret,
    redirectUri,
  )
}

export function getGoogleAuthorizationUrl() {
  const oauth2Client = createGoogleOAuthClient()

  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    scope: [
      'https://www.googleapis.com/auth/calendar.events',
    ],
  })
}

export async function createCalendarDeadline(tokens, { task, person, due }) {
  if (!tokens?.refresh_token) {
    throw new Error('Google Calendar is not connected')
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(due || '')) {
    throw new Error('A valid due date is required')
  }

  const startDate = new Date(`${due}T00:00:00.000Z`)

  if (
    Number.isNaN(startDate.getTime()) ||
    startDate.toISOString().slice(0, 10) !== due
  ) {
    throw new Error('Invalid calendar date')
  }

  const endDate = new Date(startDate)
  endDate.setUTCDate(endDate.getUTCDate() + 1)

  const oauth2Client = createGoogleOAuthClient()
  oauth2Client.setCredentials(tokens)

  const calendar = google.calendar({
    version: 'v3',
    auth: oauth2Client,
  })

  const description = person
    ? `For: ${person}\nCreated by Kept`
    : 'Created by Kept'

  const response = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary: task,
      description,
      start: { date: due },
      end: { date: endDate.toISOString().slice(0, 10) },
    },
  })

  return {
    id: response.data.id,
    url: response.data.htmlLink,
  }
}

// Tells Google to cancel the access Kept was given (best effort)
export async function revokeGoogleAccess(tokens) {
  const token = tokens?.refresh_token || tokens?.access_token
  if (!token) return

  const oauth2Client = createGoogleOAuthClient()
  await oauth2Client.revokeToken(token)
}


function encodeHeader(text) {
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`
}

function formatDueForEmail(due) {
  const date = new Date(`${due}T12:00:00Z`)
  return date.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  })
}

// Creates a Gmail DRAFT only. Nothing is ever sent: the user reviews and sends it.
export async function createGmailDraft(tokens, { task, person, due }) {
  if (!tokens?.refresh_token) {
    throw new Error('Google is not connected')
  }

  const oauth2Client = createGoogleOAuthClient()
  oauth2Client.setCredentials(tokens)
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client })

  const subject = `Follow-up: ${task}`
  const dueText = due ? ` by ${formatDueForEmail(due)}` : ''
  const body = [
    `Hi ${person || 'there'},`,
    '',
    `Quick note to confirm: I will ${task}${dueText}.`,
    '',
    'I will keep you posted.',
    '',
    'Best regards',
    '',
    '(Draft created by Kept. Please review before sending.)',
  ].join('\r\n')

  const message = [
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    `Subject: ${encodeHeader(subject)}`,
    '',
    body,
  ].join('\r\n')

  const raw = Buffer.from(message, 'utf8').toString('base64url')

  const response = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message: { raw } },
  })

  return { id: response.data.id, url: 'https://mail.google.com/mail/#drafts' }
}