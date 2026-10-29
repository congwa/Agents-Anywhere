import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { cp, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PiHost } from '../lib/src/application/host.js'
import { JsonStore } from '../lib/src/infrastructure/storage.js'

const root = await mkdtemp(join(tmpdir(), 'aa-pi-admission-'))
const agentDir = join(root, 'agent'), cwd = join(root, 'project')
await mkdir(agentDir); await mkdir(cwd)
let requests = 0
const endpoint = createServer((req, res) => {
  req.resume(); req.on('end', () => {
    requests++
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', model: 'physical-a', choices: [{ index: 0, delta: { content: 'accepted' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
})
await new Promise(resolve => endpoint.listen(0, '127.0.0.1', resolve))
await writeFile(join(agentDir, 'models.json'), JSON.stringify({ providers: { 'aa-admission': {
  api: 'openai-completions', baseUrl: `http://127.0.0.1:${endpoint.address().port}`, apiKey: 'local-fixture',
  models: [{ id: 'physical-a', name: 'physical-a', reasoning: false, input: ['text'], contextWindow: 4096, maxTokens: 64, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
} } }))
await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off' }))
const config = { runtimeId: 'pi', sessionNamespace: 'admission', agentDir, storageRoot: join(root, 'state'),
  python: fileURLToPath(new URL('../../connector/.venv/bin/python', import.meta.url)), maxWorkers: 2, maxConcurrentRuns: 2, maxRunMs: 10000, preparationTtlMs: 30000 }
const host = new PiHost(config), scope = { runtimeId: config.runtimeId, sessionNamespace: config.sessionNamespace }
const call = (method, values = {}) => host.request(method, { ...scope, ...values })
async function until(read, ready) {
  for (let i = 0; i < 300; i++) { const value = await read(); if (ready(value)) return value; assert.notEqual(value.phase, 'failed', JSON.stringify(value)); await new Promise(resolve => setTimeout(resolve, 25)) }
  throw new Error('admission check timed out')
}
let release = () => undefined
try {
  await host.restore()
  await call('prepareWorkspace', { preparationId: 'prep', clientPreparationId: 'prep-client', cwd })
  const prep = await until(() => call('getPreparation', { preparationId: 'prep' }), value => value.phase === 'ready')
  const selections = { model: prep.catalog.models.find(x => x.id.endsWith('/physical-a')).selectionId, permission: 'ask' }
  await call('reservePreparation', { preparationId: 'prep', createOperationId: 'create', platformSessionId: 'session', expectedRevision: prep.revision, catalogRevision: prep.catalogRevision, selections })
  // Pause the Host immediately before its acceptance write. Snapshot only durable
  // files while the actual SDK has persisted its own acceptance receipt.
  let entered
  const reached = new Promise(resolve => entered = resolve), gate = new Promise(resolve => release = resolve)
  const write = host.creationStore.write.bind(host.creationStore)
  host.creationStore.write = async (key, value) => {
    if (value.phase === 'accepted' && value.messageAccepted === true) { entered(); await gate }
    return write(key, value)
  }
  await call('beginCreateAndStartSession', { preparationId: 'prep', createOperationId: 'create', sessionId: 'session', selections, content: 'first', clientMessageId: 'message' })
  let deadline
  try { await Promise.race([reached, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Host acceptance gate timed out')), 10000) })]) }
  finally { clearTimeout(deadline) }
  await until(() => call('getSessionCapabilities', { sessionId: 'session' }), value => value.capabilitySet.capabilities.some(x => x.capabilityId === 'session.send_message' && x.available))
  await host.eventDrains.get('session')?.()
  const crash = join(root, 'crash'); await cp(config.storageRoot, crash, { recursive: true })
  const key = 'admission:session:message', accepted = await new JsonStore(join(crash, 'worker-state')).read(key)
  assert.equal(accepted.receipt.messageAccepted, true)
  const scenarios = ['accepted', 'wrong-fingerprint', 'wrong-message', 'wrong-native', 'prepared-only', 'late-receipt']
  for (const scenario of scenarios) {
    const storageRoot = join(root, scenario); await cp(crash, storageRoot, { recursive: true })
    const store = new JsonStore(join(storageRoot, 'worker-state'))
    if (scenario === 'wrong-fingerprint') await store.write(key, { ...accepted, fingerprint: 'wrong' })
    if (scenario === 'wrong-message') await store.write(key, { ...accepted, receipt: { ...accepted.receipt, clientMessageId: 'other' } })
    if (scenario === 'wrong-native') await store.write(key, { ...accepted, receipt: { ...accepted.receipt, externalSessionId: 'other-native' } })
    if (['prepared-only', 'late-receipt'].includes(scenario)) await store.write(key, { fingerprint: accepted.fingerprint, phase: 'prepared' })
    const recovered = new PiHost({ ...config, storageRoot })
    try {
      await recovered.restore()
      const read = () => recovered.request('getCreationOperation', { ...scope, createOperationId: 'create' })
      let result = await read()
      if (scenario === 'accepted') { assert.equal(result.phase, 'accepted'); assert.equal(result.messageAccepted, true) }
      else { assert.equal(result.phase, 'outcome_unknown'); assert.equal(result.messageAccepted, null) }
      if (scenario === 'late-receipt') { await store.write(key, accepted); result = await read(); assert.equal(result.messageAccepted, true) }
      assert.equal(recovered.supervisor.workers.size, 0, 'observation cannot restart a worker or replay the prompt')
    } finally { await recovered.stop() }
  }
  release()
  await until(() => call('getSessionCapabilities', { sessionId: 'session' }), value => value.capabilitySet.capabilities.some(x => x.capabilityId === 'session.send_message' && x.available))
  assert.equal(requests, 1)
  process.stdout.write('Actual SDK admission + pre-Host-write crash snapshot: accepted / conflicting / prepared-only / late receipt recovery passed; requests=1, recovery workers=0\n')
} finally { release(); await host.stop(); await new Promise(resolve => endpoint.close(resolve)); await rm(root, { recursive: true, force: true }) }
