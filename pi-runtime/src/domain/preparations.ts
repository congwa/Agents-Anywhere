import { digest, RuntimeFailure, requireValue } from './shared.js'

type PreparationFacts = {
  phase: string; revision: number; expiresAt: string; createOperationId?: string; platformSessionId?: string;
  reservedSelections?: unknown; selections?: Record<string, unknown>;
  catalog?: { revision: number; models: { enabled: boolean; selectionId?: string; reasoningItems: { enabled: boolean; selectionId: string }[] }[] };
}
type ReservationRequest = { createOperationId: string; platformSessionId: string; expectedRevision: number; catalogRevision: number; selections: Record<string, string | null> }
export type ReservationDecision = { reserved: true } | { reserved: false; failure: { code: string; message: string } }

/** Pure admission decision. Persistence failures are outside this decision. */
export function decideReservation(prep: PreparationFacts | undefined, request: ReservationRequest, now: number): ReservationDecision {
  // Missing owner metadata is not proof that an earlier attempt had no effect.
  requireValue(prep, 'preparation_not_found', '准备操作不存在，无法确认先前预留结果。')
  try {
    if (prep.createOperationId) {
      requireValue(prep.createOperationId === request.createOperationId && prep.platformSessionId === request.platformSessionId
        && digest(prep.reservedSelections) === digest(request.selections), 'preparation_consumed', '准备已绑定另一创建操作。')
      return { reserved: true }
    }
    requireValue(prep.phase === 'ready' && prep.revision === request.expectedRevision && prep.catalog?.revision === request.catalogRevision
      && Date.parse(prep.expiresAt) > now, 'preparation_stale', '准备已失效，请刷新并保留草稿。')
    requireValue(!request.selections.permission || ['ask', 'ask_all', 'readonly'].includes(request.selections.permission), 'invalid_permission', '权限选择不在当前目录中。')
    const id = request.selections.model
    requireValue(id && prep.selections?.[id], 'selection_required', '请选择该工作区的有效模型。')
    requireValue(prep.catalog.models.some(model => model.enabled && (model.selectionId === id || model.reasoningItems.some(item => item.enabled && item.selectionId === id))), 'model_unavailable', '所选模型不支持严格请求核验。')
    return { reserved: true }
  } catch (error) {
    if (!(error instanceof RuntimeFailure)) throw error
    return { reserved: false, failure: { code: error.code, message: error.message } }
  }
}
