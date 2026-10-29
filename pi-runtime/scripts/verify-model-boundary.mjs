import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SettingsManager, SessionManager } from '@earendil-works/pi-coding-agent'
import { ModelGuard } from '../lib/src/infrastructure/model-guard.js'
import { modelCatalog } from '../lib/src/infrastructure/resources.js'
import { requestProfile } from '../lib/src/infrastructure/request-profile.js'

const root = await mkdtemp(join(tmpdir(), 'aa-pi-model-'))
await mkdir(join(root, 'agent'))
const runtime = await ModelRuntime.create({ authPath: join(root, 'agent/auth.json'), modelsPath: null, allowModelNetwork: false })
runtime.registerProvider('aa-guard-proof', { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', apiKey: 'fixture',
  models: ['physical-a', 'physical-b'].map(id => ({ id, name: id, reasoning: true, input: ['text'], contextWindow: 4096, maxTokens: 64, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })) })
const selected = runtime.getModel('aa-guard-proof', 'physical-a'), other = runtime.getModel('aa-guard-proof', 'physical-b')
runtime.registerProvider('aa-openrouter-proof', { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', apiKey: 'fixture',
  models: [{ ...selected, id: 'physical-a', compat: { thinkingFormat: 'openrouter' } }] })
const routed = runtime.getModel('aa-openrouter-proof', 'physical-a')
runtime.registerProvider('aa-unsupported-proof', { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', apiKey: 'fixture',
  models: [{ ...selected, id: 'physical-a', compat: { thinkingFormat: 'qwen-chat-template' } }] })
let wire = 0
const originalFetch = globalThis.fetch
// Any escaped request is intercepted here; the check never accesses an external provider.
globalThis.fetch = async () => {
  wire++
  return new Response(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'physical-a', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
}
async function check(name, factories, expected, model = selected, thinkingLevel = 'off') {
  const guard = new ModelGuard(name, () => undefined)
  const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off' })
  const resources = new DefaultResourceLoader({ cwd: root, agentDir: join(root, 'agent'), settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: factories })
  await resources.reload()
  const result = await createAgentSession({ cwd: root, agentDir: join(root, 'agent'), settingsManager: settings, resourceLoader: resources,
    modelRuntime: guard.wrap(runtime), model, thinkingLevel, noTools: 'all', sessionManager: SessionManager.inMemory(root) })
  const session = result.session
  try {
    guard.bind(session)
    await session.bindExtensions({})
    guard.permit = { operationId: name, provider: model.provider, model: model.id, api: model.api, baseUrl: model.baseUrl, thinkingLevel, requestProfile: requestProfile(model), generation: name, cancelled: false, dispatched: 0 }
    const before = wire
    await session.prompt('verify')
    assert.equal(wire - before, expected, name)
    if (expected === 0) assert.ok(guard.lastFailure, name)
  } finally { await session.abort(); session.dispose() }
}
try {
  const models = modelCatalog(runtime, 'profile-proof').models
  assert.equal(models.find(x => x.id.startsWith('aa-openrouter-proof/')).reasoningItems.find(x => x.id === 'high').enabled, true)
  assert.equal(models.find(x => x.id.startsWith('aa-unsupported-proof/')).enabled, false)
  await check('unchanged', [], 1)
  await check('late-model', [pi => pi.on('before_agent_start', async () => { await pi.setModel(other) })], 0)
  await check('late-effort', [pi => pi.on('before_agent_start', () => pi.setThinkingLevel('high'))], 0)
  await check('payload-model', [pi => pi.on('before_provider_request', event => ({ payload: { ...event.payload, model: 'physical-b' } }))], 0)
  await check('payload-effort', [pi => pi.on('before_provider_request', event => ({ payload: { ...event.payload, reasoning_effort: 'high' } }))], 0)
  await check('openrouter-high', [], 1, routed, 'high')
  await check('openrouter-off', [], 1, routed, 'off')
  await check('openrouter-payload-effort', [pi => pi.on('before_provider_request', event => ({ payload: { ...event.payload, reasoning: { effort: 'low' } } }))], 0, routed, 'high')
  assert.equal(requestProfile({ ...selected, provider: 'openrouter' }), 'openrouter')
  assert.equal(requestProfile({ ...selected, baseUrl: 'https://openrouter.ai/api/v1' }), 'openrouter')
  assert.equal(requestProfile({ ...selected, provider: 'deepseek' }), undefined)
  process.stdout.write('Production ModelGuard: standard/OpenRouter payloads, catalog availability and late model/effort changes: passed; escaped requests=0\n')
} finally { globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }) }
