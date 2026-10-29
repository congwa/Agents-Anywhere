import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PiHost } from '../lib/src/application/host.js'
import { nativeFiles } from '../lib/src/infrastructure/native-history.js'
import { freezeInput } from '../lib/src/domain/shared.js'
const root = await mkdtemp(join(tmpdir(), 'aa-pi-runtime-'))
const agentDir = join(root, 'agent'), cwd = join(root, 'project')
await mkdir(agentDir, { recursive: true }); await mkdir(join(cwd, '.pi/extensions'), { recursive: true })
let requests = 0
const server = createServer((req, res) => {
  let body = ''; req.on('data', chunk => body += chunk)
  req.on('end', () => {
    const payload = JSON.parse(body); assert.equal(payload.model, 'physical-a'); requests++
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', model: payload.model, choices: [{ index: 0, delta: { content: 'verified ' }, finish_reason: null }] })}\n\n`)
    setTimeout(() => res.end(`data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', model: payload.model, choices: [{ index: 0, delta: { content: 'reply' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`), 400)
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
await writeFile(join(agentDir, 'models.json'), JSON.stringify({ providers: { 'aa-local-verification': {
  api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'local-verification',
  models: ['physical-a', 'physical-b'].map(id => ({ id, name: id, reasoning: false, input: ['text'], contextWindow: 4096, maxTokens: 64, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })) } } }))
await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false }, providerRetry: { maxRetries: 0 }, cacheWarming: 'off' }))
await writeFile(join(cwd, '.pi/extensions/startup.ts'), `export default function(pi) { pi.on('session_start', async (_event, ctx) => { const value = await ctx.ui.editor('创建中的输入', '  prefill\\n'); if (value !== '  answered\\n') throw new Error('raw editor answer lost'); }); pi.on('before_agent_start', async (event, ctx) => { if (event.prompt === 'pause for crash') await ctx.ui.confirm('Crash check', 'Continue?'); }); }`)
let host = new PiHost({ runtimeId: 'pi', sessionNamespace: 'verification', agentDir, storageRoot: join(root, 'state'), python: fileURLToPath(new URL('../../connector/.venv/bin/python', import.meta.url)), maxWorkers: 4, maxConcurrentRuns: 2, maxRunMs: 10000, preparationTtlMs: 30000 })
const scope = { runtimeId: 'pi', sessionNamespace: 'verification' }
const call = (method, params = {}) => host.request(method, { ...scope, ...params })
async function until(get, predicate, label) {
  for (let i = 0; i < 400; i++) { const result = await get(); if (predicate(result)) return result; if (result.phase === 'failed') throw new Error(label + ': ' + JSON.stringify(result)); await new Promise(resolve => setTimeout(resolve, 25)) }
  throw new Error('timeout: ' + label + ' requests=' + requests + ' state=' + JSON.stringify(await get()))
}
try {
  const input = { command: 'A', nested: { value: 'original' } }; freezeInput(input)
  assert.throws(() => input.command = 'B', TypeError); assert.throws(() => input.nested.value = 'changed', TypeError)
  await host.restore()
  await assert.rejects(call('reservePreparation', { preparationId: 'missing', createOperationId: 'missing-create', platformSessionId: 'missing-session', expectedRevision: 1, catalogRevision: 1, selections: { model: 'missing' } }), error => error.code === 'preparation_not_found')
  await call('prepareWorkspace', { preparationId: 'prep-1', clientPreparationId: 'client-prep-1', cwd })
  let preparation = await until(() => call('getPreparation', { preparationId: 'prep-1' }), value => value.interactions.some(x => x.status === 'open'), 'trust')
  const trust = preparation.interactions.find(x => x.status === 'open'); assert.equal(trust.kind, 'project_trust')
  await call('respondPreparationInteraction', { preparationId: 'prep-1', interactionId: trust.interactionId, requestRevision: trust.requestRevision, ownerGeneration: trust.ownerGeneration, responseOperationId: 'trust-once', actionId: 'once' })
  preparation = await until(() => call('getPreparation', { preparationId: 'prep-1' }), value => value.phase === 'ready', 'preparation')
  const selections = { model: preparation.catalog.models.find(x => x.id.endsWith('/physical-a')).selectionId, permission: 'ask' }
  await call('reservePreparation', { preparationId: 'prep-1', createOperationId: 'create-1', platformSessionId: 'sess-1', expectedRevision: preparation.revision, catalogRevision: preparation.catalog.revision, selections })
  const begin = { preparationId: 'prep-1', createOperationId: 'create-1', sessionId: 'sess-1', content: 'hello', clientMessageId: 'message-1', selections }
  assert.equal((await call('beginCreateAndStartSession', begin)).messageAccepted, null)
  let operation = await until(() => call('getCreationOperation', { createOperationId: 'create-1' }), value => value.interactions.some(x => x.status === 'open'), 'startup interaction')
  const interaction = operation.interactions.find(x => x.status === 'open'); assert.equal(interaction.kind, 'editor')
  const response = { createOperationId: 'create-1', interactionId: interaction.interactionId, requestRevision: interaction.requestRevision, ownerGeneration: interaction.ownerGeneration, responseOperationId: 'startup-answer', actionId: 'submit', input: { kind: 'editor', status: 'submitted', text: '  answered\n' } }
  assert.equal((await call('respondCreationInteraction', response)).disposition, 'applied')
  assert.equal((await call('respondCreationInteraction', response)).disposition, 'already_applied')
  operation = await until(() => call('getCreationOperation', { createOperationId: 'create-1' }), value => value.messageAccepted === true, 'admission')
  const partial = await until(() => call('getSessionSnapshot', { sessionId: 'sess-1' }), value => value.items.some(x => x.role === 'assistant' && x.content.text === 'verified ' && x.status === 'running'), 'live partial')
  const partialAssistant = partial.items.find(x => x.role === 'assistant')
  const snapshot = await until(() => call('getSessionSnapshot', { sessionId: 'sess-1' }), value => value.items.some(x => x.id === partialAssistant.id && x.content.text === 'verified reply' && x.status === 'done' && x.source.itemId), 'live final')
  assert.equal(snapshot.complete, false)
  const finalAssistant = snapshot.items.find(x => x.id === partialAssistant.id)
  assert.ok(finalAssistant.revision > partialAssistant.revision)
  assert.equal(snapshot.items.filter(x => x.role === 'assistant').length, 1)
  await until(() => call('getSessionCapabilities', { sessionId: 'sess-1' }), value => value.capabilitySet.capabilities.some(x => x.capabilityId === 'session.send_message' && x.available), 'settled')
  assert.ok((await call('getSessionTree', { sessionId: 'sess-1' })).entries.length)
  // A real worker dies while holding an SDK UI continuation; the Host stays up.
  const pendingTurn = call('startTurn', { sessionId: 'sess-1', content: 'pause for crash', clientMessageId: 'crash-message' }).catch(error => ({ code: error.code }))
  await until(() => call('getSessionNotices', { sessionId: 'sess-1' }), value => value.notices.some(x => x.status === 'open'), 'live continuation')
  const crashed = [...host.supervisor.workers.values()][0]
  process.kill(-crashed.child.pid, 'SIGKILL'); await crashed.exited
  assert.equal((await pendingTurn).code, 'worker_exited')
  await until(() => call('getSessionState', { sessionId: 'sess-1' }), value => value.state.status === 'blocked', 'worker exit state')
  assert.ok((await call('getSessionNotices', { sessionId: 'sess-1' })).notices.every(x => x.status === 'closed'))
  assert.equal(host.supervisor.workers.size, 0)
  const config = host.config; await host.stop(); host = new PiHost(config); await host.restore()
  const states = [], notices = new Map()
  let release, entered
  const gate = new Promise(resolve => release = resolve), sending = new Promise(resolve => entered = resolve)
  const keepAlive = setInterval(() => undefined, 1000)
  host.outbox.connect(async (_batch, notifications) => {
    entered(); await gate
    for (const item of notifications) {
      if (item.method === 'session.state.updated') states.push(item.params.status)
      if (item.method === 'notice.upsert') notices.set(item.params.noticeId, item.params.status)
    }
  })
  let delivered = false
  const sync = call('resynchronizeSession', { sessionId: 'sess-1' }).then(value => { delivered = true; return value })
  try {
    await sending; await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal(delivered, false, 'resynchronization must wait for ingest ACK')
    release(); assert.equal((await sync).delivered, true)
    assert.deepEqual(states, ['blocked'], 'a prior running state cannot overwrite recovery')
    assert.ok([...notices.values()].every(status => status === 'closed'))
  } finally { release(); clearInterval(keepAlive) }
  await call('closeSession', { sessionId: 'sess-1', closeOperationId: 'close-1', ownerGeneration: operation.workerGeneration })
  assert.equal(host.supervisor.workers.size, 0); assert.equal(requests, 1)
  const closedTree = await call('getSessionTree', { sessionId: 'sess-1' })
  await assert.rejects(call('selectExecutionPosition', { sessionId: 'sess-1', sourceEpoch: closedTree.sourceEpoch, fileEntriesDigest: 'changed', positionRevision: closedTree.positionRevision, leafId: closedTree.leafId }), error => error.code === 'position_conflict')
  assert.equal((await call('selectExecutionPosition', { sessionId: 'sess-1', sourceEpoch: closedTree.sourceEpoch, fileEntriesDigest: closedTree.fileEntriesDigest, positionRevision: closedTree.positionRevision, leafId: closedTree.leafId })).ok, true)
  const offline = await call('getSessionSnapshot', { sessionId: 'sess-1' })
  assert.ok(offline.items.some(item => snapshot.items.some(prior => prior.id === item.id && item.content.text?.includes('verified reply'))))
  const source = (await nativeFiles([join(root, 'state/sessions')]))[0]
  const sourceBefore = (await stat(source)).mtimeMs
  const rows = (await readFile(source, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  rows[0].id = 'native-foreign-session'
  await mkdir(join(agentDir, 'sessions'), { recursive: true })
  await writeFile(join(agentDir, 'sessions/foreign.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  const inventory = await call('listSessions')
  const native = inventory.sessions.find(session => session.externalSessionId === 'native-foreign-session')
  assert.ok(native); assert.equal(native.metadata.readOnly, true)
  const foreign = await call('getSessionSnapshot', { sessionId: native.sessionId })
  assert.ok(foreign.items.length); assert.equal(host.supervisor.workers.size, 0)
  assert.equal((await stat(source)).mtimeMs, sourceBefore)
  assert.ok(foreign.items.every(item => !snapshot.items.some(prior => prior.id === item.id)))
  process.stdout.write(JSON.stringify({ sdk: '1.4.0', trustBeforeResources: true, startupEditorRawAnswer: true, duplicateAnswer: true, realHttpRequests: requests, timelineItems: snapshot.items.length, workersAfterClose: 0, workerCrashCancelsNotice: true, orderedRecoveryAck: true }) + '\n')
} finally { await host.stop(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }) }
