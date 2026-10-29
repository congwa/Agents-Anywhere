import { mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { aaAcpSchema } from '../lib/src/interfaces/contracts.js'

const directory = new URL('../../contracts/acp-runtime/1.1/', import.meta.url)
await mkdir(directory, { recursive: true })
const content = JSON.stringify(aaAcpSchema, null, 2) + '\n'
await writeFile(new URL('schema.json', directory), content)
await writeFile(new URL('manifest.json', directory), JSON.stringify({ artifacts: [
  { path: 'schema.json', sha256: createHash('sha256').update(content).digest('hex') },
] }, null, 2) + '\n')
