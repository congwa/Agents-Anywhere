import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { WorkerSupervisor } from '../lib/src/infrastructure/workers.js'

const root = await mkdtemp(join(tmpdir(), 'aa-pi-workers-'))
const cwd = join(root, 'project'), agentDir = join(root, 'agent'), storageRoot = join(root, 'state')
await mkdir(cwd); await mkdir(agentDir)
await writeFile(join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', apiKey: 'fixture', models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], contextWindow: 4096, maxTokens: 64, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }))
const supervisor = new WorkerSupervisor(2), outsider = new WorkerSupervisor(1)
const config = (role, id) => ({ role, scopeId: id, workerId: randomUUID(), generation: randomUUID(), runtimeId: 'pi',
  cwd, agentDir, storageRoot, python: fileURLToPath(new URL('../../connector/.venv/bin/python', import.meta.url)), maxRunMs: 10000 })
try {
  const preview = supervisor.spawn(config('preparation', 'preview'), () => undefined)
  const prepared = await preview.boot(); await preview.close()
  const selectionId = prepared.catalog.models.find(item => item.id === 'fixture/fixture').selectionId
  const firstConfig = { ...config('session', 'first'), sessionId: 'first', nativeSessionId: randomUUID(), selectionId }
  const secondConfig = { ...config('session', 'second'), sessionId: 'second', nativeSessionId: randomUUID(), selectionId }
  const first = supervisor.spawn(firstConfig, () => undefined), second = supervisor.spawn(secondConfig, () => undefined)
  const [a, b] = await Promise.all([first.boot(), second.boot()])
  assert.notEqual(first.child.pid, second.child.pid); assert.notEqual(a.nativeSessionId, b.nativeSessionId)
  assert.equal(a.cwd, b.cwd); assert.equal(supervisor.workers.size, 2)
  assert.throws(() => supervisor.spawn(config('preparation', 'overflow'), () => undefined), error => error.code === 'worker_capacity')
  const competing = outsider.spawn({ ...firstConfig, workerId: randomUUID(), generation: randomUUID(), sourcePath: a.sourcePath }, () => undefined)
  await assert.rejects(competing.boot(), error => error.code === 'owner_unavailable')
  await competing.close()
  await first.close(); assert.equal(supervisor.workers.size, 1)
  await second.close(); assert.equal(supervisor.workers.size, 0)
  process.stdout.write('Independent same-cwd SDK workers / capacity / cross-process writer exclusion / actual exit: passed\n')
} finally { await supervisor.stop(); await outsider.stop(); await rm(root, { recursive: true, force: true }) }
