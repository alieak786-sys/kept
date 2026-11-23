import { extractCommitments } from './extract.js'

const text = process.argv.slice(2).join(' ')
console.log(await extractCommitments(text))