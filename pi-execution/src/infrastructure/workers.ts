import { fork, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { RuntimeFailure } from '../domain/shared.js'
import type { WorkerExit } from '../domain/worker-exit.js'

import type { WorkerConfig, WorkerEvent } from '../application/ports.js'
export type { WorkerConfig, WorkerEvent } from '../application/ports.js'
type Reply = { id?: string; result?: unknown; error?: { code: string; message: string }; event?: WorkerEvent }

export class WorkerProxy {
  readonly child: ChildProcess
  readonly exited: Promise<void>
  private readonly requests = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private dead = false
  private stopping = false
  private closeTask?: Promise<void>
  constructor(readonly config: WorkerConfig, onEvent: (event: WorkerEvent) => void, onExit: (fact: WorkerExit) => void) {
    const environment: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(process.env)) if (!/^(?:AGENT_|AGENTS_ANYWHERE|AA_|ELECTRON_|NODE_OPTIONS|NODE_INSPECT)/i.test(key)) environment[key] = value
    this.child = fork(fileURLToPath(new URL('../interfaces/worker.js', import.meta.url)), [], {
      cwd: config.cwd, env: environment, detached: process.platform !== 'win32', silent: true,
    })
    // Always drain both pipes; extension output cannot block private IPC.
    this.child.stdout?.on('data', () => undefined)
    this.child.stderr?.on('data', () => undefined)
    this.child.on('message', value => {
      const message = value as Reply
      if (message.event) { onEvent(message.event); return }
      const request = message.id && this.requests.get(message.id)
      if (!request || !message.id) return
      this.requests.delete(message.id); clearTimeout(request.timer)
      message.error ? request.reject(new RuntimeFailure(message.error.code, message.error.message)) : request.resolve(message.result)
    })
    this.exited = new Promise(resolve => {
      const ended = (code: number | null, signal: string | null) => {
        if (this.dead) return
        this.dead = true
        for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(new RuntimeFailure('worker_exited', 'pi 执行进程已退出，操作结果需确认。')) }
        this.requests.clear()
        onExit({ workerId: config.workerId, generation: config.generation, role: config.role, expected: this.stopping, code, signal })
        resolve()
      }
      this.child.once('exit', ended)
      this.child.once('error', () => ended(null, null))
    })
  }
  request(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<any> {
    if (this.dead) return Promise.reject(new RuntimeFailure('worker_exited', 'pi 执行进程不可用。'))
    if (this.stopping && ['boot', 'prompt', 'select'].includes(method)) return Promise.reject(new RuntimeFailure('session_closing', '执行进程正在关闭。'))
    if (this.requests.size >= 128) return Promise.reject(new RuntimeFailure('worker_busy', '执行进程请求过多。'))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(id); reject(new RuntimeFailure('outcome_unknown', '请求超时，请先查询结果。')) }, timeoutMs)
      timer.unref()
      this.requests.set(id, { resolve, reject, timer })
      this.child.send({ id, method, params }, error => {
        if (error) { this.requests.delete(id); clearTimeout(timer); reject(error) }
      })
    })
  }
  boot(): Promise<any> { return this.request('boot', this.config as unknown as Record<string, unknown>, 600_000) }
  close(): Promise<void> { this.stopping = true; return this.closeTask ??= this.closing() }
  private async closing(): Promise<void> {
    if (!this.dead) await this.request('close', {}, 15_000).catch(() => undefined)
    await Promise.race([this.exited, new Promise(resolve => setTimeout(resolve, 500))])
    if (this.child.pid && process.platform !== 'win32') {
      try { process.kill(-this.child.pid, 'SIGTERM') } catch { /* group already gone */ }
      await Promise.race([this.exited, new Promise(resolve => setTimeout(resolve, 500))])
      try { process.kill(-this.child.pid, 'SIGKILL') } catch { /* group already gone */ }
    } else if (!this.dead) this.child.kill('SIGKILL')
    await this.exited
  }
}

export class WorkerSupervisor {
  readonly workers = new Map<string, WorkerProxy>()
  constructor(readonly maximum: number) {}
  spawn(config: WorkerConfig, event: (value: WorkerEvent) => void): WorkerProxy {
    if (this.workers.size >= this.maximum) throw new RuntimeFailure('worker_capacity', 'pi 执行进程已达到上限，请稍后重试。')
    const worker = new WorkerProxy(config, event, fact => {
      this.workers.delete(config.workerId)
      event({ kind: 'workerExited', data: fact })
    })
    this.workers.set(config.workerId, worker)
    return worker
  }
  async stop(): Promise<void> { await Promise.allSettled([...this.workers.values()].map(worker => worker.close())) }
}
