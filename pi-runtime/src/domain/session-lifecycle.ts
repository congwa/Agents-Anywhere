import type { WorkerExit } from '@agents-anywhere/pi-execution/worker-exit'
export type { WorkerExit } from '@agents-anywhere/pi-execution/worker-exit'


export function ownsWorker(session: { workerId?: string; ownerGeneration: string }, worker: Pick<WorkerExit, 'workerId' | 'generation' | 'role'>): boolean {
  return session.workerId === worker.workerId && (worker.role === 'preparation' || session.ownerGeneration === worker.generation)
}

export function interruptedExecution(session: { sessionId: string; nativeSessionId: string; selectionId: string; permission: string }, exit: WorkerExit): Record<string, unknown> {
  return { sessionId: session.sessionId, runtime: 'pi', externalSessionId: session.nativeSessionId,
    status: 'blocked', statusReason: 'pi_position_reconciliation_required',
    selections: { model: session.selectionId, permission: session.permission },
    error: { code: 'worker_exited', message: 'pi 执行进程异常退出，请确认继续位置。' },
    metadata: { ownerGeneration: exit.generation, exitCode: exit.code, exitSignal: exit.signal } }
}
