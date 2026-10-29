import { PiEngine } from '../infrastructure/pi-engine.js'
import { failure, RuntimeFailure } from '../domain/shared.js'
import type { WorkerConfig } from '../application/ports.js'

let engine: PiEngine | undefined
let booted = false
const send = (message: unknown) => { if (process.connected) process.send?.(message) }
process.on('message', async (value: any) => {
  const { id, method, params } = value
  try {
    let result: unknown
    if (method === 'boot') {
      if (booted) throw new RuntimeFailure('already_booted', '执行进程不能复用。')
      booted = true
      engine = new PiEngine(params as WorkerConfig, event => send({ event }))
      result = await engine.boot()
    } else {
      if (!engine) throw new RuntimeFailure('not_initialized', '执行进程尚未初始化。')
      result = await engine.dispatch(method, params)
    }
    send({ id, result })
    if (method === 'close') setTimeout(() => process.exit(0), 25)
  } catch (error) { send({ id, error: failure(error) }) }
})
process.once('disconnect', () => {
  const timer = setTimeout(() => process.exit(1), 15_000)
  timer.unref()
  void engine?.close().finally(() => process.exit(0))
})
