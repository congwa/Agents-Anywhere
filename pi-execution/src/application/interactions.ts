import { randomUUID } from 'node:crypto'
import { digest, requireValue } from '../domain/shared.js'
import type { Interaction, Response, DecisionReceipt } from '../domain/interaction.js'
export type { Interaction, Response, DecisionReceipt } from '../domain/interaction.js'
/** This registry lives in the process holding the real continuation. */
export class Interactions {
  readonly current = new Map<string, Interaction>()
  private readonly pending = new Map<string, { resolve: (value: Response | undefined) => void; timer: ReturnType<typeof setTimeout> }>()
  private readonly receipts = new Map<string, { digest: string; receipt: DecisionReceipt }>()
  private closed = false
  constructor(readonly generation: string, private readonly publish: (value: Interaction) => void) {}
  open(spec: Omit<Interaction, 'interactionId' | 'ownerGeneration' | 'requestRevision' | 'revision' | 'status' | 'expiresAt'>,
    timeoutMs = 300_000, signal?: AbortSignal): { request: Interaction; answer: Promise<Response | undefined> } {
    requireValue(!this.closed, 'interaction_closed', '执行进程正在关闭。')
    requireValue(this.pending.size < 64, 'too_many_interactions', '待回答请求过多。')
    const request: Interaction = { ...spec, interactionId: randomUUID(), ownerGeneration: this.generation,
      requestRevision: 1, revision: 1, status: 'open', expiresAt: new Date(Date.now() + timeoutMs).toISOString() }
    const answer = new Promise<Response | undefined>(resolve => {
      const timer = setTimeout(() => this.finish(request.interactionId, 'expired'), timeoutMs)
      timer.unref()
      this.pending.set(request.interactionId, { resolve, timer })
    })
    this.current.set(request.interactionId, request)
    this.publish(request)
    if (signal?.aborted) this.finish(request.interactionId, 'cancelled')
    else if (signal) {
      const abort = () => this.finish(request.interactionId, 'cancelled')
      signal.addEventListener('abort', abort, { once: true })
      void answer.finally(() => signal.removeEventListener('abort', abort))
    }
    return { request, answer }
  }
  respond(response: Response): DecisionReceipt {
    const fingerprint = digest(response)
    const old = this.receipts.get(response.responseOperationId)
    if (old) {
      requireValue(old.digest === fingerprint, 'operation_conflict', '同一回答身份不能提交不同内容。')
      return { ...old.receipt, disposition: 'already_applied' }
    }
    const request = this.current.get(response.interactionId)
    requireValue(request && request.ownerGeneration === response.ownerGeneration && request.requestRevision === response.requestRevision,
      'stale_interaction', '该请求已失效，请刷新。')
    requireValue(request.status === 'open' && this.pending.has(request.interactionId), 'not_pending', '该请求已结束。')
    requireValue(request.actions.some(action => action.actionId === response.actionId), 'invalid_action', '该请求不支持此动作。')
    const receipt: DecisionReceipt = { interactionId: request.interactionId, responseOperationId: response.responseOperationId,
      ownerGeneration: request.ownerGeneration, requestRevision: request.requestRevision, revision: request.revision + 1, disposition: 'applied' }
    this.receipts.set(response.responseOperationId, { digest: fingerprint, receipt })
    this.finish(request.interactionId, 'resolved', response)
    if (this.receipts.size > 4096) this.receipts.delete(this.receipts.keys().next().value!)
    return receipt
  }
  getReceipt(id: string): DecisionReceipt | undefined { return this.receipts.get(id)?.receipt }
  cancelAll(close = false): void { this.closed ||= close; for (const id of this.pending.keys()) this.finish(id, 'cancelled') }
  private finish(id: string, status: Interaction['status'], response?: Response): void {
    const waiter = this.pending.get(id), request = this.current.get(id)
    if (!waiter || !request) return
    clearTimeout(waiter.timer)
    this.pending.delete(id)
    request.status = status; request.revision++
    this.publish(request)
    waiter.resolve(response)
    if (this.current.size > 512) {
      for (const [key, value] of this.current) if (value.status !== 'open') { this.current.delete(key); break }
    }
  }
}
