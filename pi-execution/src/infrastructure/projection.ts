import type { SessionManager } from '@earendil-works/pi-coding-agent'
import { digest, RuntimeFailure } from '../domain/shared.js'
import { JsonStore } from './storage.js'

export type ProjectedItem = Record<string, any>
type Reservation = { id: string; order: number; revision: number; clientMessageId?: string; entryId?: string }
/** Native reservation markers make crash recovery causal, never content-hash matching. */
export class Projector {
  private readonly messages = new WeakMap<object, Reservation>()
  // pi 1.4 emits fresh assistant objects for each stream event. There is one
  // active assistant stream per AgentSession; its reservation is the causal key.
  private assistant?: Reservation
  private sequence = 0
  private revisions: Record<string, number> = {}
  private readonly entries = new Map<string, string>()
  readonly items = new Map<string, ProjectedItem>()
  constructor(readonly sessionId: string, readonly nativeId: string, private readonly store: JsonStore,
    private readonly publish: (item: ProjectedItem) => void) {}
  async reserve(message: any, manager: SessionManager, clientMessageId?: string): Promise<void> {
    if (this.messages.has(message)) return
    const order = ++this.sequence
    if (order > 2_147_483_647) throw new RuntimeFailure('timeline_capacity', '会话时间线已达到排序上限。')
    const id = 'pi_' + digest([this.sessionId, this.nativeId, order]).slice(0, 40)
    await this.store.write(`reservation:${this.sessionId}:${order}`, { id, order, clientMessageId, state: 'reserved' })
    manager.appendCustomEntry('agents-anywhere.message-reservation', { id, order, clientMessageId, platformSessionId: this.sessionId, nativeId: this.nativeId })
    const reservation = { id, order, revision: 0, clientMessageId }
    this.messages.set(message, reservation)
    if (message.role === 'assistant') this.assistant = reservation
  }
  messageId(message: any): string | undefined {
    if (!this.messages.has(message) && message.role === 'assistant' && this.assistant) this.messages.set(message, this.assistant)
    return this.messages.get(message)?.id
  }
  private publishItem(item: ProjectedItem): void {
    const { type, status, role, content, source } = item
    item.contentHash = 'sha256:' + digest({ type, status, role, content, source })
    this.items.set(item.id, item); this.publish(item)
  }
  update(message: any, running: boolean, clientMessageId?: string): void {
    this.messageId(message)
    const reservation = this.messages.get(message)
    if (!reservation) return
    if (!running && this.assistant === reservation) this.assistant = undefined
    const role = message.role === 'custom' ? 'assistant' : message.role
    if (!['user', 'assistant', 'toolResult', 'system'].includes(role)) return
    const status = running ? 'running' : message.stopReason === 'error' ? 'failed' : message.stopReason === 'aborted' ? 'cancelled' : 'done'
    let text = typeof message.content === 'string' ? message.content : (message.content ?? [])
      .filter((part: any) => part.type === 'text' || part.type === 'thinking')
      .map((part: any) => part.text ?? part.thinking ?? '').join('\n')
    const calls = Array.isArray(message.content) ? message.content.filter((part: any) => part.type === 'toolCall') : []
    if (calls.length) text += calls.map((part: any) => `\n${part.name}\n\`\`\`json\n${JSON.stringify(part.arguments, null, 2)}\n\`\`\``).join('\n')
    if (message.errorMessage) text += '\n' + message.errorMessage
    const content = role === 'toolResult'
      ? { kind: 'tool_result', title: message.toolName ?? 'tool', output: text, metadata: { toolCallId: message.toolCallId } }
      : { kind: 'markdown', format: 'markdown', text, ...(message.usage ? { usage: message.usage } : {}) }
    const type = role === 'toolResult' ? 'tool' : 'message'
    const item = { id: reservation.id, sessionId: this.sessionId, type, role: role === 'toolResult' ? 'tool' : role,
      status, orderSeq: reservation.order, revision: ++reservation.revision, content,
      source: { runtime: 'pi', sessionId: this.nativeId, ...((clientMessageId ?? reservation.clientMessageId) ? { clientMessageId: clientMessageId ?? reservation.clientMessageId } : {}),
        ...(reservation.entryId ? { itemId: reservation.entryId } : {}),
        ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}) },
    }
    this.publishItem(item)
  }
  async commit(message: any, manager: SessionManager): Promise<void> {
    const reservation = this.messages.get(message)
    if (!reservation) return
    const entry = manager.getEntries().find(entry => entry.type === 'message' && entry.message === message)
    if (!entry) return // A later settled read must reconcile; do not guess by text.
    this.entries.set(entry.id, reservation.id); reservation.entryId = entry.id
    await this.store.write(`reservation:${this.sessionId}:${reservation.order}`, { ...reservation, entryId: entry.id, state: 'committed' })
    const item = this.items.get(reservation.id)
    if (item) { item.source.itemId = entry.id; item.revision = ++reservation.revision; this.publishItem(item) }
  }
  async save(): Promise<void> {
    this.revisions = Object.fromEntries([...this.items].map(([id, item]) => [id, item.revision]))
    await this.store.write('projection-revisions:' + this.sessionId, this.revisions)
  }
  async restore(manager: Pick<SessionManager, 'getEntries'>): Promise<void> {
    this.revisions = await this.store.read<Record<string, number>>('projection-revisions:' + this.sessionId) ?? {}
    let marker: { id: string; order: number; clientMessageId?: string } | undefined
    for (const entry of manager.getEntries()) {
      if (entry.type === 'custom' && entry.customType === 'agents-anywhere.message-reservation') {
        const candidate = entry.data as any
        marker = candidate?.platformSessionId === this.sessionId && candidate?.nativeId === this.nativeId
          && Number.isSafeInteger(candidate.order) && candidate.order > 0 && candidate.order <= 2_147_483_647
          && candidate.id === 'pi_' + digest([this.sessionId, this.nativeId, candidate.order]).slice(0, 40) ? candidate : undefined
        if (marker) this.sequence = Math.max(this.sequence, marker.order)
      } else if (entry.type === 'message') {
        const order = marker?.order ?? ++this.sequence
        const id = marker?.id ?? 'pi_' + digest([this.sessionId, this.nativeId, entry.id]).slice(0, 40)
        this.sequence = Math.max(this.sequence, order)
        this.messages.set(entry.message, { id, order, revision: this.revisions[id] ?? 0, clientMessageId: marker?.clientMessageId, entryId: entry.id })
        this.update(entry.message, false, marker?.clientMessageId)
        const item = this.items.get(id)
        if (item) item.source.itemId = entry.id
        this.entries.set(entry.id, id)
        marker = undefined
      }
    }
  }
}
