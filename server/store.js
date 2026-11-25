// Saves and loads each user's Google tokens (encrypted) in MongoDB.
import { getDb } from './db.js'
import { encryptJson, decryptJson } from './crypto.js'

export async function saveGoogleTokens(userId, tokens) {
  const db = await getDb()
  await db.collection('users').updateOne(
    { _id: userId },
    {
      $set: { googleTokens: encryptJson(tokens), updatedAt: new Date() },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true },
  )
}

export async function loadGoogleTokens(userId) {
  const db = await getDb()
  const user = await db.collection('users').findOne({ _id: userId })
  if (!user?.googleTokens) return null
  try {
    return decryptJson(user.googleTokens)
  } catch {
    console.error('Could not decrypt Google tokens (wrong key?)')
    return null
  }
}