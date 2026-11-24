import { getDb, closeDb } from './db.js'

const db = await getDb()
await db.command({ ping: 1 })
console.log('MongoDB connected, database:', db.databaseName)

// Small write/read/delete check
const test = db.collection('connection_test')
await test.insertOne({ at: new Date() })
console.log('Test documents:', await test.countDocuments())
await test.drop()

await closeDb()