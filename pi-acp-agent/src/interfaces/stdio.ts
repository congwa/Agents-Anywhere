import { Writable, Readable } from 'node:stream'
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { AgentSideConnection, ndJsonStream, RequestError } from '@agentclientprotocol/sdk'
import { RuntimeFailure } from '@agents-anywhere/pi-execution'
import { JsonStore } from '@agents-anywhere/pi-execution/storage'
import { AaPiAgent } from '../application/agent.js'
import { executionFactory } from '../infrastructure/kernel.js'
import { openmaVocabulary } from '../infrastructure/openma/index.js'
import { nativeHistory } from '../infrastructure/history.js'

const args = parseArgs({ options: { 'agent-dir': { type: 'string' }, 'state-dir': { type: 'string' },
  'runtime-id': { type: 'string' }, python: { type: 'string' } } }).values
if (!args['agent-dir'] || !args['state-dir'] || !args['runtime-id'] || !args.python) throw new Error('Missing managed Agent paths or identity')
let agent: AaPiAgent
const connection = new AgentSideConnection(conn => {
  agent = new AaPiAgent({ agentDir: resolve(args['agent-dir']!), stateDir: resolve(args['state-dir']!),
    runtimeId: args['runtime-id']!, python: args.python!, maxRunMs: 600000 },
  new JsonStore(resolve(args['state-dir']!, 'coordination')), executionFactory,
  { update: (sessionId, update) => conn.sessionUpdate({ sessionId, update: update as any }),
    permission: params => conn.requestPermission(params as any), form: params => conn.createElicitation(params as any),
    notify: (method, params) => conn.notify('_' + method.replace(/^_/, ''), params) }, openmaVocabulary,
    new JsonStore(resolve(args['state-dir']!, 'worker-state')), nativeHistory)
  const invoke = async (work: () => Promise<any>) => {
    try { return await work() }
    catch (error) {
      if (error instanceof RuntimeFailure) throw new RequestError(-32010, error.message, { code: error.code, ...error.details })
      throw error
    }
  }
  return {
    initialize: params => invoke(() => agent.initialize(params)),
    newSession: params => invoke(() => agent.newSession(params)),
    prompt: params => invoke(() => agent.prompt(params)),
    cancel: params => invoke(() => agent.cancel(params)),
    closeSession: params => invoke(() => agent.closeSession(params)),
    resumeSession: params => invoke(() => agent.resumeSession(params)),
    loadSession: params => invoke(() => agent.loadSession(params)),
    setSessionConfigOption: params => invoke(() => agent.setSessionConfigOption(params)),
    authenticate: () => invoke(() => agent.authenticate()),
    extMethod: (method, params) => invoke(() => agent.extMethod(method, params)),
  }
}, ndJsonStream(Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>))
let shuttingDown = false
async function shutdown(code: number) {
  if (shuttingDown) return
  shuttingDown = true
  try { await agent?.dispose() } finally { process.exit(code) }
}
process.once('SIGTERM', () => { void shutdown(143) })
process.once('SIGINT', () => { void shutdown(130) })
await connection.closed.finally(() => shutdown(0))
