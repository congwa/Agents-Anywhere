import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, realpath, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PiHost } from '../lib/src/application/host.js'

const root = await mkdtemp(join(tmpdir(), 'aa-pi-recovery-'))
const cwd = join(root, 'workspace-link'), physical = join(root, 'workspace'), agentDir = join(root, 'agent')
await mkdir(join(physical, '.pi/extensions'), { recursive: true })
await mkdir(agentDir)
await symlink(physical, cwd)
// Loading this project extension is forbidden by the explicit basic-mode grant.
await writeFile(join(physical, '.pi/extensions/must-not-load.ts'), `throw new Error('untrusted project extension loaded')`)
let requests = 0
let rejectNext = false
const endpoint = createServer((req, res) => {
  let text = ''; req.on('data', part => text += part)
  req.on('end', () => {
    const payload = JSON.parse(text); assert.equal(payload.model, 'physical-a'); requests++
    if (rejectNext) {
      rejectNext = false
      res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'temporary fixture failure' } })); return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', model: payload.model, choices: [{ index: 0, delta: { content: 'recovered reply' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
})
await new Promise(resolve => endpoint.listen(0, '127.0.0.1', resolve))
await writeFile(join(agentDir, 'models.json'), JSON.stringify({ providers: { 'aa-recovery': {
  api: 'openai-completions', baseUrl: `http://127.0.0.1:${endpoint.address().port}`, apiKey: 'local-fixture',
  models: [{ id: 'physical-a', name: 'physical-a', reasoning: false, input: ['text'], contextWindow: 4096, maxTokens: 64, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
} } }))
await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false }, providerRetry: { maxRetries: 0 }, cacheWarming: 'off' }))
const config = { runtimeId: 'pi', sessionNamespace: 'recovery', agentDir, storageRoot: join(root, 'state'),
  python: fileURLToPath(new URL('../../connector/.venv/bin/python', import.meta.url)), maxWorkers: 4, maxConcurrentRuns: 2, maxRunMs: 10000, preparationTtlMs: 30000 }
let host = new PiHost(config)
const scope = { runtimeId: 'pi', sessionNamespace: 'recovery' }
const call = (method, params = {}) => host.request(method, { ...scope, ...params })
async function until(get, predicate) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const value = await get(); if (predicate(value)) return value
    assert.notEqual(value.phase, 'failed', JSON.stringify(value))
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('recovery probe timed out: ' + JSON.stringify(await get()))
}
const sessionId = 'recovery-session'
try {
  await host.restore()
  await call('prepareWorkspace', { preparationId: 'prep', clientPreparationId: 'prep-client', cwd })
  let prep = await until(() => call('getPreparation', { preparationId: 'prep' }), value => value.interactions.some(item => item.status === 'open'))
  const trust = prep.interactions.find(item => item.status === 'open')
  await call('respondPreparationInteraction', { preparationId: 'prep', interactionId: trust.interactionId,
    ownerGeneration: trust.ownerGeneration, requestRevision: trust.requestRevision, responseOperationId: 'basic-grant', actionId: 'basic' })
  prep = await until(() => call('getPreparation', { preparationId: 'prep' }), value => value.phase === 'ready')
  const selections = { model: prep.catalog.models.find(item => item.id.endsWith('/physical-a')).selectionId, permission: 'ask' }
  await call('reservePreparation', { preparationId: 'prep', createOperationId: 'create', platformSessionId: sessionId,
    expectedRevision: prep.revision, catalogRevision: prep.catalogRevision, selections })
  await call('beginCreateAndStartSession', { preparationId: 'prep', createOperationId: 'create', sessionId, selections, content: 'first', clientMessageId: 'first' })
  await until(() => call('getCreationOperation', { createOperationId: 'create' }), value => value.messageAccepted === true)
  const canSend = value => value.capabilitySet.capabilities.some(item => item.capabilityId === 'session.send_message' && item.available)
  await until(() => call('getSessionCapabilities', { sessionId }), canSend)
  assert.equal(requests, 1)
  const inventory = await call('listSessions')
  assert.equal(inventory.sessions.length, 1, 'canonical source must not be imported a second time')
  assert.equal(inventory.sessions[0].cwd, cwd, 'platform metadata must retain the registered workspace path')

  rejectNext = true
  await call('startTurn', { sessionId, content: 'temporary failure', clientMessageId: 'temporary-failure' })
  await until(() => call('getSessionState', { sessionId }), value => value.state.status === 'error')
  await until(() => call('getSessionCapabilities', { sessionId }), canSend)
  await call('startTurn', { sessionId, content: 'retry after failure', clientMessageId: 'retry-after-failure' })
  await until(() => call('getSessionCapabilities', { sessionId }), canSend)
  assert.equal((await call('getSessionState', { sessionId })).state.error, null)

  // Hold the old close at its event-drain await, after the OS writer has exited.
  const originalDrain = host.eventDrains.get(sessionId)
  let entered, release
  const drained = new Promise(resolve => entered = resolve), gate = new Promise(resolve => release = resolve)
  host.eventDrains.set(sessionId, async () => { await originalDrain(); entered(); await gate })
  const owner = (await call('getSessionState', { sessionId })).state.metadata.ownerGeneration
  const closing = call('closeSession', { sessionId, ownerGeneration: owner, closeOperationId: 'close-race' })
  try {
    await drained
    await assert.rejects(call('startTurn', { sessionId, content: 'during close', clientMessageId: 'during-close' }), error => error.code === 'session_closing')
    assert.equal(canSend(await call('getSessionCapabilities', { sessionId })), false)
  } finally { release(); await closing }
  await call('startTurn', { sessionId, content: 'after close', clientMessageId: 'after-close' })
  await until(() => call('getSessionCapabilities', { sessionId }), canSend)
  assert.equal(host.supervisor.workers.size, 1)
  assert.ok((await call('getSessionCapabilities', { sessionId })).capabilitySet.capabilities.find(item => item.capabilityId === 'session.close').available)
  const requestsBeforeCrash = requests

  const worker = [...host.supervisor.workers.values()][0]
  process.kill(-worker.child.pid, 'SIGKILL'); await worker.exited; await host.stop()
  host = new PiHost(config); await host.restore()
  assert.equal((await call('getSessionState', { sessionId })).state.status, 'blocked')
  const tree = await call('getSessionTree', { sessionId })
  const position = { sessionId, sourceEpoch: tree.sourceEpoch, fileEntriesDigest: tree.fileEntriesDigest, positionRevision: tree.positionRevision, leafId: tree.leafId }
  await assert.rejects(call('selectExecutionPosition', { ...position, fileEntriesDigest: 'stale' }), error => error.code === 'position_conflict')
  assert.equal((await call('getSessionState', { sessionId })).state.status, 'blocked')
  assert.equal((await call('selectExecutionPosition', position)).ok, true)
  const state = (await call('getSessionState', { sessionId })).state
  assert.equal(state.status, 'idle'); assert.equal(state.statusReason, null); assert.equal(state.error, null)
  assert.ok(canSend(await call('getSessionCapabilities', { sessionId })))
  assert.equal((await call('startTurn', { sessionId, content: 'after crash', clientMessageId: 'after-crash' })).messageAccepted, true)
  await until(() => call('getSessionCapabilities', { sessionId }), canSend)
  assert.equal(requests, requestsBeforeCrash + 1)
  const liveState = (await call('getSessionState', { sessionId })).state
  await call('closeSession', { sessionId, ownerGeneration: liveState.metadata.ownerGeneration, closeOperationId: 'close' })
  assert.equal(host.supervisor.workers.size, 0)
  // More than 500 entries forces the exact cursor returned by the Host through its schema.
  const sourcePath = (await call('listSessions')).sessions[0]
  const { nativeFiles } = await import('../lib/src/infrastructure/native-history.js')
  const file = (await nativeFiles([join(root, 'state/sessions')]))[0]
  const records = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  for (let i = 0; i < 510; i++) records.push({ type: 'custom', customType: 'qa', id: 'qa-' + i, parentId: records.at(-1).id, data: {}, timestamp: new Date().toISOString() })
  await writeFile(file, records.map(record => JSON.stringify(record)).join('\n') + '\n')
  const first = await call('getSessionTree', { sessionId, limit: 500 })
  assert.ok(first.nextCursor.length > 160)
  const second = await call('getSessionTree', { sessionId, limit: 500, cursor: first.nextCursor })
  assert.equal(first.entries.length + second.entries.length, records.length - 1)
  assert.ok(second.entries.every(item => !first.entries.some(prior => prior.id === item.id)))
  assert.equal(sourcePath.cwd, cwd)
  assert.notEqual(cwd, await realpath(cwd))
  console.log('Basic trust / workspace binding / provider-error retry / close-resume race / crash reconciliation / tree pagination: passed')
} finally {
  await host.stop(); await new Promise(resolve => endpoint.close(resolve)); await rm(root, { recursive: true, force: true })
}
