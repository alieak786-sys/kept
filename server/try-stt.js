import { transcribe } from './stt.js'

// 2 seconds of silence: the call should work and return an empty text
const silence = Buffer.alloc(32000 * 2)
console.log('Transcript:', JSON.stringify(await transcribe(silence)))