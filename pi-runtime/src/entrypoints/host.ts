import { createInterface } from 'node:readline'
import { Mesh, Router } from 'meshcall'
import { PiHost, type HostConfig } from '../application/host.js'
import { PiBridgeService } from '../infrastructure/bridge-service.js'
import { PI_SYNC } from '../contracts/protocol.js'

// Bootstrap secrets arrive through the parent's private stdin, never argv/env.
const input = createInterface({ input: process.stdin, terminal: false })
const bootstrap = await new Promise<string>((resolve, reject) => {
  input.once('line', value => value.length <= 65_536 ? resolve(value) : reject(new Error('Bootstrap too large')))
  input.once('close', () => reject(new Error('Parent closed before bootstrap')))
})
const config = JSON.parse(bootstrap) as HostConfig & {
  endpoint: { unixPath: string } | { pipe: string }; key: string;
}
const host = new PiHost(config)
await host.restore()
const mesh = new Mesh(new Router(config.endpoint), { token: config.key, peerId: `pi-host-${host.generation}` })
mesh.mount(new PiBridgeService(host), { instanceId: `pi-${config.runtimeId}` })
const server = await mesh.startServing()
host.outbox.connect(async (batchId, notifications) => {
  const result = await mesh.unary<Record<string, unknown>, { ok: boolean }>(PI_SYNC, 'ingestBatch', {
    batch: { batchId, runtimeId: config.runtimeId, sessionNamespace: config.sessionNamespace, notifications },
  }, { timeoutMs: 30_000, idempotencyKey: batchId })
  if (result.ok !== true) throw new Error('Connector did not acknowledge pi sync batch')
})
process.stdout.write(JSON.stringify({ ready: true, generation: host.generation }) + '\n')
let stopping: Promise<void> | undefined
const stop = () => stopping ??= (async () => {
  await host.stop()
  await server.close({ drain: true, drainTimeoutMs: 1000 })
  await mesh.close()
})().finally(() => process.exit(0))
process.once('SIGTERM', () => { void stop() })
process.once('SIGINT', () => { void stop() })
input.once('close', () => { void stop() })
