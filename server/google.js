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