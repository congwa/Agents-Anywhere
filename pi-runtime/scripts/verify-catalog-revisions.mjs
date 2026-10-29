import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PiHost } from '../lib/src/application/host.js'
import { CatalogRevisions } from '../lib/src/infrastructure/catalog-revisions.js'
import { JsonStore } from '../lib/src/infrastructure/storage.js'

const root = await mkdtemp(join(tmpdir(), 'aa-pi-catalog-'))
const agentDir = join(root, 'agent'), cwd = join(root, 'project')
await mkdir(agentDir); await mkdir(cwd)
const config = { runtimeId: 'pi', sessionNamespace: 'catalog', agentDir, storageRoot: join(root, 'state'),
  python: fileURLToPath(new URL('../../connector/.venv/bin/python', import.meta.url)), maxWorkers: 4, maxConcurrentRuns: 2, maxRunMs: 10000, preparationTtlMs: 30000 }
let host = new PiHost(config)
const scope = { runtimeId: 'pi', sessionNamespace: 'catalog' }
async function writeModels(name) {
  await writeFile(join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: {
    api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', apiKey: 'fixture',
    models: [{ id: 'physical-a', name, reasoning: false, input: ['text'], contextWindow: 4096, maxTokens: 64, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }))
}
async function prepare(id) {
  await host.request('prepareWorkspace', { ...scope, cwd, preparationId: id, clientPreparationId: id })
  for (let i = 0; i < 300; i++) {
    const result = await host.request('getPreparation', { ...scope, preparationId: id })
    if (result.phase === 'ready') return result
    assert.notEqual(result.phase, 'failed', JSON.stringify(result))
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('catalog preparation timed out')
}
try {
  await writeModels('Model A'); await host.restore()
  const first = await prepare('first'), unchanged = await prepare('unchanged')
  assert.equal(first.catalogRevision, unchanged.catalogRevision)
  await writeModels('Model B')
  const [changed, concurrent] = await Promise.all([prepare('changed'), prepare('concurrent')])
  assert.ok(changed.catalogRevision > first.catalogRevision)
  assert.equal(changed.catalogRevision, concurrent.catalogRevision)
  assert.equal(changed.catalog.models.find(x => x.id.endsWith('/physical-a')).displayName, 'Model B')
  await host.stop(); host = new PiHost(config); await host.restore()
  assert.equal((await prepare('after-restart')).catalogRevision, changed.catalogRevision)
  const store = new JsonStore(join(root, 'legacy-versions'))
  const versions = new CatalogRevisions(store)
  await versions.seed('legacy', 'old-fingerprint', 280170342172005)
  assert.equal(await versions.observe('legacy', 'old-fingerprint'), 280170342172005)
  const updated = await versions.observe('legacy', 'new-fingerprint')
  assert.ok(updated > 280170342172005)
  assert.equal(await new CatalogRevisions(store).observe('legacy', 'new-fingerprint'), updated)
  console.log('Actual SDK previews: unchanged/concurrent catalogs retain revision; changed catalogs increase; restart and legacy revision floors survive: passed')
} finally { await host.stop(); await rm(root, { recursive: true, force: true }) }
