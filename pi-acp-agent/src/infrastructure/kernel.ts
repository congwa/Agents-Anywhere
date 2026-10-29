import { WorkerProxy } from '@agents-anywhere/pi-execution/workers'
import type { ExecutionFactory } from '../application/ports.js'

export const executionFactory: ExecutionFactory = {
  create: (config, publish) => new WorkerProxy(config, publish, fact => publish({ kind: 'workerExited', data: fact })),
}
