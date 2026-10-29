import { randomUUID } from 'node:crypto'
import { digest, RuntimeFailure } from '@agents-anywhere/pi-execution'
import { JsonStore } from '@agents-anywhere/pi-execution/storage'
import type { AgentCapabilityPort, ApplicationSettings, AgentEvent, ExecutionContext, ExecutionPort } from '../application/ports.js'
import type { SessionRecord } from '../domain/sessions.js'
import { EXECUTION_GUARANTEES } from '../domain/sessions.js'
import { WorkerProxy } from '@agents-anywhere/pi-execution/workers'
import { nativeHistory } from './history.js'
import { openmaVocabulary } from './openma/index.js'

export type PiSettings = ApplicationSettings & { runtimeId: string; agentDir: string; stateDir: string; python: string }

/** Composes published OpenMA behavior with AA's missing execution guarantees. */
export class PiCapabilities implements AgentCapabilityPort {
  readonly descriptor = { name: 'aa-pi-acp', promptCapabilities: { image: true, embeddedContext: true }, guarantees: EXECUTION_GUARANTEES, capabilities: ['session.commands', 'runtime.attachment'] }
  private receipts: JsonStore
  constructor(private settings: PiSettings) {
    this.receipts = new JsonStore(settings.stateDir + '/worker-state')
  }
  create({ role, session: row }: ExecutionContext, publish: (event: AgentEvent) => void) {
    return new WorkerProxy({ role, workerId: randomUUID(), generation: row.generation,
      runtimeId: this.settings.runtimeId, scopeId: row.id, cwd: row.cwd,
      agentDir: this.settings.agentDir, storageRoot: this.settings.stateDir,
      python: this.settings.python, maxRunMs: this.settings.maxRunMs, sessionId: row.platformSessionId,
      nativeSessionId: row.id, trustMode: row.prepared?.trustMode, selectionId: row.selectionId,
      permission: row.permission, expectedResourceFingerprint: row.prepared?.resourceFingerprint,
      sourcePath: row.sourcePath, position: row.position }, publish,
    fact => publish({ kind: 'workerExited', data: fact }))
  }
  prompt = openmaVocabulary.prompt
  replay = openmaVocabulary.replay
  tool = openmaVocabulary.tool
  receipt(row: SessionRecord, messageId: string): Promise<unknown> {
    return this.receipts.read('admission:' + row.platformSessionId + ':' + messageId)
  }
  commands(): Record<string, any>[] { return openmaVocabulary.commands() }
  async executeCommand(worker: ExecutionPort, params: Record<string, any>): Promise<Record<string, any>> {
    const command = params.command
    const line = params.raw ?? `/${command}${params.args?.length ? ' ' + params.args.join(' ') : ''}`
    const parsed = typeof line === 'string' ? openmaVocabulary.parseCommand(line) : undefined
    if (!parsed || command !== 'compact' || parsed.name !== command || !Array.isArray(params.args ?? []) || (params.args ?? []).some((arg: unknown) => typeof arg !== 'string')) {
      throw new RuntimeFailure('invalid_command', '请使用命令目录中的 compact 命令。')
    }
    try {
      await worker.request('compact', { instructions: parsed.args }, this.settings.maxRunMs)
      return { command, ok: true, result: { executionState: 'completed' } }
    } catch (error) {
      return { command, ok: false, code: 'command_outcome_unknown', message: error instanceof Error ? error.message : '命令结果未知。', result: { executionState: 'unknown', retryable: false } }
    }
  }
  initializeSession(row: SessionRecord, metadata: Record<string, any>): void {
    row.selectionId = metadata.selectionId ?? Object.keys(row.prepared?.selections ?? {})[0]
    row.permission ??= 'ask'
  }
  async configure(row: SessionRecord, worker: ExecutionPort, key: string, value: string | boolean): Promise<void> {
    if (!['model', 'permission'].includes(key) || typeof value !== 'string') throw new RuntimeFailure('invalid_configuration', '配置选项不可用。')
    const selectionId = key === 'model' ? value : row.selectionId
    const permission = key === 'permission' ? value : row.permission
    await worker.request('select', { selectionId, permission })
    row.selectionId = selectionId; row.permission = permission
  }
  configuration(row: SessionRecord): Record<string, any>[] {
    const selections = row.prepared?.selections ?? {}
    return [{ id: 'model', name: '模型与推理强度', category: 'model', type: 'select',
      currentValue: row.selectionId ?? Object.keys(selections)[0],
      options: Object.entries(selections).map(([id, value]: any) => ({ value: id, name: `${value.provider}/${value.model} · ${value.thinkingLevel}` })) },
    { id: 'permission', name: '工具权限', category: 'mode', _meta: { aa: { selectionCategory: 'permission' } }, type: 'select', currentValue: row.permission ?? 'ask',
      options: [{ value: 'ask', name: '写入与命令审批' }, { value: 'ask_all', name: '全部工具审批' }, { value: 'readonly', name: '只读' }] }]
  }
  async selectPosition(row: SessionRecord, params: Record<string, any>): Promise<Record<string, unknown>> {
    if (!row.sourcePath) throw new RuntimeFailure('position_unavailable', '原生来源不存在。')
    const snapshot = await nativeHistory.read(row.sourcePath)
    if (!snapshot.complete || snapshot.header.id !== row.id || params.sourceEpoch !== digest(snapshot.header)
        || params.fileEntriesDigest !== digest(snapshot.entries) || params.positionRevision !== row.position?.positionRevision) {
      throw new RuntimeFailure('position_stale', '原生来源或位置已变化。')
    }
    const entries = new Map(snapshot.entries.map(entry => [entry.id, entry])), branch: any[] = [], seen = new Set<string>()
    let cursor = params.leafId
    while (cursor !== null) {
      if (typeof cursor !== 'string' || seen.has(cursor) || !entries.has(cursor)) throw new RuntimeFailure('position_invalid', '原生分支不完整。')
      seen.add(cursor); const entry = entries.get(cursor); branch.unshift(entry); cursor = entry.parentId
    }
    return { piSessionId: row.id, sourceEpoch: digest(snapshot.header), fileEntriesDigest: digest(snapshot.entries),
      leafId: params.leafId, anchorDigest: digest(branch), positionRevision: params.positionRevision + 1,
      branchGeneration: randomUUID(), ownerGeneration: row.generation, clean: true }
  }
}
