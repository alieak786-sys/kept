import { createNotionTask } from './notion.js'

const page = await createNotionTask({
  task: 'send the report to Sara',
  person: 'Sara',
  due: '2026-11-27',
})
console.log('Created:', page.url)