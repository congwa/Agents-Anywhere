import { mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import { z } from 'zod'
import { Methods, DialogResult, InteractionResponse, SyncBatch, SyncRequest } from '../src/contracts/protocol.js'

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)), 'contracts/pi-bridge/1.0')
await mkdir(join(root, 'schemas'), { recursive: true })
const artifacts: { name: string; path: string; sha256: string }[] = []
for (const [name, schema] of Object.entries({ ...Methods, DialogResult, InteractionResponse, SyncBatch, SyncRequest })) {
  const path = `schemas/${name}.schema.json`
  const data = JSON.stringify(z.toJSONSchema(schema), null, 2) + '\n'
  await writeFile(join(root, path), data)
  artifacts.push({ name, path, sha256: createHash('sha256').update(data).digest('hex') })
}
await writeFile(join(root, 'manifest.json'), JSON.stringify({ protocolVersion: '1.0', artifacts }, null, 2) + '\n')
