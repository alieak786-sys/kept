// Encrypts/decrypts small JSON values (Google tokens) with AES-256-GCM.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

function getKey() {
  const hex = process.env.TOKEN_ENCRYPTION_KEY
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be 64 hex characters')
  }
  return Buffer.from(hex, 'hex')
}

export function encryptJson(value) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv)
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, data]).toString('base64')
}

export function decryptJson(payload) {
  const raw = Buffer.from(payload, 'base64')
  const iv = raw.subarray(0, 12)
  const tag = raw.subarray(12, 28)
  const data = raw.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', getKey(), iv)
  decipher.setAuthTag(tag)
  const text = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
  return JSON.parse(text)
}