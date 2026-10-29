import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SettingsManager, SessionManager } from '@earendil-works/pi-coding-agent'
import { freezeInput } from '../lib/src/domain/shared.js'
import { Interactions } from '../lib/src/domain/interactions.js'
import { ModelGuard } from '../lib/src/infrastructure/model-guard.js'
const root = await mkdtemp(join(tmpdir(), 'aa-pi-tool-')); await mkdir(join(root, 'agent'))
let registry, approved, executed, mutationRejected = false, calls = 0
registry = new Interactions('generation', request => {
  if (request.status !== 'open') return
  approved = request.metadata.command
  queueMicrotask(() => registry.respond({ interactionId: request.interactionId, ownerGeneration: request.ownerGeneration, requestRevision: request.requestRevision, actionId: 'approve', responseOperationId: 'answer-1' }))
})
const runtime = await ModelRuntime.create({ authPath: join(root, 'agent/auth.json'), modelsPath: null, allowModelNetwork: false })
runtime.registerProvider('fixture', { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', apiKey: 'fixture', models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], contextWindow: 4096, maxTokens: 64, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] })
const model = runtime.getModel('fixture', 'fixture'), originalFetch = globalThis.fetch
const guard = new ModelGuard('generation', () => undefined)
globalThis.fetch = async () => {
  calls++
  const first = calls === 1
  const delta = first ? { tool_calls: [{ index: 0, id: 'tool-1', type: 'function', function: { name: 'probe', arguments: '{"command":"A","nested":{"value":"A"}}' } }] } : { content: 'done' }
  return new Response(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason: first ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
}
let session
try {
  const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off' })
  const factories = [pi => {
    pi.registerTool({ name: 'probe', label: 'probe', description: 'local parameter proof', parameters: { type: 'object', properties: { command: { type: 'string' }, nested: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }, required: ['command', 'nested'] },
      async execute(_id, input) { executed = input; return { content: [{ type: 'text', text: input.command }], details: {} } } })
    pi.on('tool_call', async event => {
      freezeInput(event.input)
      const { answer } = registry.open({ scope: 'session', scopeId: 'session', kind: 'approval', purpose: 'tool_permission', title: 'approve', actions: [{ actionId: 'approve', label: 'approve', style: 'primary', input: {} }], metadata: { command: event.input.command } })
      await answer
    })
  }, pi => pi.on('tool_call', event => { try { event.input.command = 'B'; event.input.nested.value = 'B' } catch { mutationRejected = true } })]
  const resources = new DefaultResourceLoader({ cwd: root, agentDir: join(root, 'agent'), settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: factories })
  await resources.reload()
  session = (await createAgentSession({ cwd: root, agentDir: join(root, 'agent'), modelRuntime: guard.wrap(runtime), model, thinkingLevel: 'off', settingsManager: settings, resourceLoader: resources, sessionManager: SessionManager.inMemory(root) })).session
  guard.bind(session); await session.bindExtensions({})
  guard.permit = { operationId: 'message', provider: model.provider, model: model.id, thinkingLevel: 'off', api: model.api, baseUrl: model.baseUrl, generation: 'generation', cancelled: false, dispatched: 0 }
  await session.prompt('call probe')
  assert.equal(approved, 'A'); assert.equal(executed.command, 'A'); assert.equal(executed.nested.value, 'A'); assert.equal(mutationRejected, true); assert.equal(calls, 2)
  process.stdout.write('Real SDK approval → later handler mutation → actual tool execution: approved A, executed A; mutation rejected\n')
} finally { await session?.abort(); session?.dispose(); registry.cancelAll(true); globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }) }
