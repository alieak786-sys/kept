// Pairing codes: the glasses show a short code, the user types it on the /pair web page.
import { randomInt } from 'node:crypto'
import { getDb } from './db.js'

// No 0/O or 1/I, so the code is easy to read on the glasses
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_TTL_MS = 10 * 60 * 1000

export function isValidDeviceId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{16,64}$/.test(id)
}

function makeCode() {
  let code = ''
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return code
}

// Old codes delete themselves after they expire
export async function ensureIndexes() {
  const db = await getDb()
  await db.collection('pairings').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
}

export async function getPairedUserId(deviceId) {
  const db = await getDb()
  const device = await db.collection('devices').findOne({ _id: deviceId })
  return device?.userId || null
}

export async function startPairing(deviceId) {
  const db = await getDb()

  if (await getPairedUserId(deviceId)) return { paired: true }

  const pairings = db.collection('pairings')

  // Reuse the code if this device already has one that is still valid
  const existing = await pairings.findOne({ deviceId, expiresAt: { $gt: new Date() } })
  if (existing) return { paired: false, code: existing._id, expiresAt: existing.expiresAt }

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = makeCode()
    const expiresAt = new Date(Date.now() + CODE_TTL_MS)
    try {
      await pairings.insertOne({ _id: code, deviceId, createdAt: new Date(), expiresAt })
      await db.collection('devices').updateOne(
        { _id: deviceId },
        { $setOnInsert: { createdAt: new Date(), userId: null } },
        { upsert: true },
      )
      return { paired: false, code, expiresAt }
    } catch (err) {
      if (err.code !== 11000) throw err // 11000 = code already used, try another
    }
  }
  throw new Error('Could not create a pairing code')
}