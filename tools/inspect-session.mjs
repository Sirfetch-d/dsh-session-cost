/** Dev-only: dump one session log's event structure without message content. */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const file = process.argv[2]
const data = readFileSync(file)
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const offsets = []
for (let at = data.indexOf(magic); at !== -1; at = data.indexOf(magic, at + 1)) offsets.push(at)
const rows = []
for (let index = 0; index < offsets.length; index += 1) {
  const start = offsets[index]
  const end = index + 1 < offsets.length ? offsets[index + 1] : data.length
  let text
  try { text = zstdDecompressSync(data.subarray(start, end)).toString('utf8') } catch { continue }
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try { rows.push(JSON.parse(line)) } catch { rows.push({ type: '<unparsable>' }) }
  }
}
console.log('frames:', offsets.length, 'rows:', rows.length)
const counts = new Map()
const samples = new Map()
for (const row of rows) {
  const type = row.type ?? '<none>'
  counts.set(type, (counts.get(type) ?? 0) + 1)
  if (!samples.has(type)) samples.set(type, row)
}
console.log([...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} x${v}`).join('\n'))
const am = samples.get('assistant/message')
if (am !== undefined) {
  const data0 = am.data ?? {}
  console.log('--- assistant/message ---')
  console.log('row keys:', Object.keys(am), '| data keys:', Object.keys(data0))
  console.log('message keys:', data0.message === undefined ? '(none)' : Object.keys(data0.message))
  console.log('source:', JSON.stringify(data0.message?.source))
  const stream = data0.stream
  console.log('stream:', Array.isArray(stream) ? `array(${stream.length}) types=${JSON.stringify(stream.map(c => c.type))}` : typeof stream)
  if (Array.isArray(stream)) {
    const usage = stream.filter(c => c.type === 'usage')
    console.log('usage chunks:', JSON.stringify(usage))
  }
}
console.log('--- first 3 row types with keys ---')
for (const row of rows.slice(0, 3)) console.log(row.type, JSON.stringify(row).slice(0, 300))
