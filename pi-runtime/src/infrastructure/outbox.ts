import { randomUUID } from 'node:crypto'
import { JsonStore } from './storage.js'
import { Mailbox, RuntimeFailure } from '../domain/shared.js'

export type Notification = { method: string; params: Record<string, any> }
type Batch = { id: string; sequence: number; notification: Notification }
/** Disk-backed, bounded delivery. Removal only follows Connector ingestion ACK. */
export class Outbox {
  private readonly pending = new Map<string, Batch>()
  private readonly mailbox = new Mailbox()
  private sequence = 0
  private timer?: ReturnType<typeof setTimeout>
  private sender?: (id: string, notifications: Notification[]) => Promise<void>
  private sending?: Promise<void>
  private closed = false
  private readonly waiters = new Set<{ ids: string[]; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  lastError?: string
  constructor(readonly store: JsonStore) {}
  async restore(): Promise<void> {
    for (const batch of await this.store.values<Batch>()) { this.pending.set(batch.id, batch); this.sequence = Math.max(this.sequence, batch.sequence) }
  }
  async discardPreviousExecutionObservations(): Promise<void> {
    // Called before connecting a sender. Old timeline/turn/decision facts remain
    // deliverable; observations about a dead execution owner are superseded.
    if (this.sender) throw new RuntimeFailure('sync_already_connected', '同步已连接，不能重建恢复观察。')
    for (const batch of [...this.pending.values()]) if (['session.state.updated', 'runtime.capability.updated'].includes(batch.notification.method)) {
      await this.store.remove(batch.id); this.pending.delete(batch.id)
    }
  }
  connect(sender: (id: string, notifications: Notification[]) => Promise<void>): void { this.sender = sender; this.schedule() }
  async append(notification: Notification): Promise<void> {
    await this.appendMany([notification])
  }
  async appendMany(notifications: Notification[]): Promise<string[]> {
    const ids = await this.mailbox.run(async () => {
      if (this.pending.size + notifications.length > 4096) throw new RuntimeFailure('sync_backpressure', '同步积压已达到上限，请恢复连接后继续。')
      const ids: string[] = []
      for (const notification of notifications) {
        const batch = { id: randomUUID(), sequence: ++this.sequence, notification: JSON.parse(JSON.stringify(notification)) }
        await this.store.write(batch.id, batch); this.pending.set(batch.id, batch); ids.push(batch.id)
      }
      return ids
    })
    this.schedule()
    return ids
  }
  waitDelivered(ids: string[], timeoutMs = 20_000): Promise<void> {
    if (ids.every(id => !this.pending.has(id))) return Promise.resolve()
    if (this.closed) return Promise.reject(new RuntimeFailure('runtime_closing', 'Runtime 正在停止。'))
    return new Promise((resolve, reject) => {
      const waiter = { ids, resolve, reject, timer: setTimeout(() => {
        this.waiters.delete(waiter); reject(new RuntimeFailure('sync_pending', '同步仍在等待接收确认，请稍后重试。'))
      }, timeoutMs) }
      waiter.timer.unref(); this.waiters.add(waiter)
    })
  }
  private acknowledgeWaiters(): void {
    for (const waiter of this.waiters) if (waiter.ids.every(id => !this.pending.has(id))) {
      clearTimeout(waiter.timer); this.waiters.delete(waiter); waiter.resolve()
    }
  }
  private schedule(delay = 0): void {
    if (this.closed || this.timer || this.sending || !this.sender || !this.pending.size) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.sending = this.flush().catch(error => { this.lastError = JSON.stringify({ message: error instanceof Error ? error.message : String(error), details: (error as any)?.details }) }).finally(() => { this.sending = undefined; this.schedule(1000) })
    }, delay)
    this.timer.unref()
  }
  private async flush(): Promise<void> {
    const blocked = new Set<string>()
    while (!this.closed && this.pending.size && this.sender) {
      const item = [...this.pending.values()].sort((a, b) => a.sequence - b.sequence)
        .find(value => !blocked.has(value.notification.params.sessionId ?? '__runtime__'))
      if (!item) return
      try {
        await this.sender(item.id, [item.notification])
        await this.store.remove(item.id); this.pending.delete(item.id)
        this.acknowledgeWaiters()
        this.lastError = undefined
      } catch (error) {
        this.lastError = JSON.stringify({ message: error instanceof Error ? error.message : String(error), details: (error as any)?.details })
        blocked.add(item.notification.params.sessionId ?? '__runtime__')
      }
    }
  }
  async stop(): Promise<void> {
    this.closed = true; if (this.timer) clearTimeout(this.timer)
    for (const waiter of this.waiters) { clearTimeout(waiter.timer); waiter.reject(new RuntimeFailure('runtime_closing', 'Runtime 正在停止。')) }
    this.waiters.clear(); await this.sending
  }
}
