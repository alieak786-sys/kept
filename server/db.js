// One shared MongoDB connection for the whole server.
import { MongoClient } from 'mongodb'

let client
let db

export async function getDb() {
  if (db) return db
  client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 })
  await client.connect()
  db = client.db(process.env.MONGODB_DB || 'kept')
  return db
}

export async function closeDb() {
  if (client) await client.close()
  client = undefined
  db = undefined
}