import { randomUUID } from 'node:crypto'
import { digest, RuntimeFailure } from '@agents-anywhere/pi-execution'
import type { WorkerConfig, WorkerEvent } from '@agents-anywhere/pi-execution'
import { EXECUTION_GUARANTEES, type SessionRecord } from '../domain/sessions.js'
import { AA_ACP_PROTOCOL } from './protocol.js'
import type { AcpTransport, AgentSettings, CoordinationStore, ExecutionFactory, ExecutionPort, NativeVocabulary, NativeHistoryPort } from './ports.js'

/** ACP-specific orchestration owns no SDK objects and no model transcript. */
export class AaPiAgent {
  private records = new Map<string, SessionRecord>()
  private workers = new Map<string, ExecutionPort>()
  private pending = new Set<Promise<unknown>>()
  private displayed = new Map<string, string>()
  private handled = new Set<string>()
  private closing = false
  private failedDelivery?: unknown
  private formSupported = false
  constructor(private settings: AgentSettings, private store: CoordinationStore,
    private factory: ExecutionFactory, private transport: AcpTransport, private vocabulary: NativeVocabulary,
    private receipts: Pick<CoordinationStore, 'read'> = store, private history?: NativeHistoryPort) {}

  async initialize(params: any): Promise<any> {
    if (params.protocolVersion !== 1) throw new RuntimeFailure('unsupported_acp_version', '仅支持 ACP v1。')
    this.formSupported = !!params.clientCapabilities?.elicitation?.form
    for (const row of await this.store.values<SessionRecord>()) {
      if (row.id && row.phase) { row.phase = 'recovery_required'; this.records.set(row.id, row); await this.save(row) }
    }
    return { protocolVersion: 1, agentInfo: { name: 'aa-pi-acp', version: '1' }, authMethods: [],
      agentCapabilities: { sessionCapabilities: { close: {}, resume: {} }, loadSession: true,
        _meta: { aa: { protocolVersion: AA_ACP_PROTOCOL, guarantees: [...EXECUTION_GUARANTEES] } } } }
  }
  private save(row: SessionRecord): Promise<void> { return this.store.write('session:' + row.id, row) }
  private record(id: string): SessionRecord {
    const row = this.records.get(id)
    if (!row) throw new RuntimeFailure('session_not_found', '会话不存在。')
    return row
  }
  private track(work: Promise<unknown>): void {
    this.pending.add(work)
    void work.catch(error => { this.failedDelivery = error }).finally(() => this.pending.delete(work))
  }
  private config(row: SessionRecord, role: 'preparation' | 'session'): WorkerConfig {
    return { role, workerId: randomUUID(), generation: row.generation, runtimeId: this.settings.runtimeId,
      scopeId: row.id, cwd: row.cwd, agentDir: this.settings.agentDir, storageRoot: this.settings.stateDir,
      python: this.settings.python, maxRunMs: this.settings.maxRunMs, sessionId: row.platformSessionId,
      nativeSessionId: row.id, trustMode: row.prepared?.trustMode, selectionId: row.selectionId,
      permission: row.permission, expectedResourceFingerprint: row.prepared?.resourceFingerprint,
      sourcePath: row.sourcePath, position: row.position }
  }
  private worker(row: SessionRecord, role: 'preparation' | 'session'): ExecutionPort {
    const worker = this.factory.create(this.config(row, role), event => this.event(row, event))
    this.workers.set(row.id, worker)
    return worker
  }
  private event(row: SessionRecord, event: WorkerEvent): void {
    if (event.kind === 'interaction' && event.data.status === 'open' && !this.handled.has(event.data.interactionId)) {
      this.handled.add(event.data.interactionId); this.track(this.answer(row, event.data))
    } else if (event.kind === 'timeline') {
      this.track(this.project(row, event.data.item ?? event.data))
    } else if (event.kind === 'submission') {
      this.track(this.transport.notify('aa/operation_update', { ...event.data, agentSessionId: row.id, ownerGeneration: row.generation }))
    } else if (event.kind === 'nativeCreated') {
      row.sourcePath = event.data.sourcePath; this.track(this.save(row))
    } else if (event.kind === 'position') {
      row.position = event.data; this.track(this.save(row))
    } else if (event.kind === 'workerExited' && !event.data.expected) {
      row.phase = 'recovery_required'; this.workers.delete(row.id); this.track(this.save(row))
    }
  }
  private async answer(row: SessionRecord, request: any): Promise<void> {
    const metadata = { interactionId: request.interactionId, ownerGeneration: request.ownerGeneration,
      requestRevision: request.requestRevision, responseOperationId: randomUUID() }
    let actionId = 'cancel', input: unknown
    if (request.kind === 'approval' || request.kind === 'project_trust') {
      const options = request.actions.map((action: any) => ({ optionId: action.actionId, name: action.label,
        kind: ['reject', 'cancel'].includes(action.actionId) ? 'reject_once' : action.actionId === 'approve_for_session' ? 'allow_always' : 'allow_once' }))
      const result = await this.transport.permission({ sessionId: row.id, options,
        toolCall: { toolCallId: request.metadata.toolCallId ?? request.interactionId, title: request.title,
          kind: 'other', status: 'pending', rawInput: { description: request.message }, _meta: { aa: { ...metadata, ...request.metadata, purpose: request.purpose } } } })
      actionId = result.outcome?.outcome === 'selected' ? result.outcome.optionId : request.kind === 'approval' ? 'reject' : 'cancel'
    } else {
      if (!this.formSupported) throw new RuntimeFailure('form_unsupported', '客户端不支持初始化表单。')
      const choices = request.metadata.options ?? []
      const property = request.kind === 'confirm' ? { type: 'boolean', default: false }
        : request.kind === 'select' ? { type: 'string', enum: choices.map((x: any) => x.id), enumNames: choices.map((x: any) => x.label) }
        : { type: 'string', default: request.metadata.initialValue ?? '' }
      const result = await this.transport.form({ message: request.title, mode: 'form', sessionId: row.id,
        requestedSchema: { type: 'object', properties: { value: property }, required: ['value'] }, _meta: { aa: metadata } })
      actionId = result.action === 'accept' ? 'submit' : 'cancel'
      input = result.action !== 'accept' ? { kind: request.kind, status: 'cancelled' }
        : request.kind === 'confirm' ? { kind: request.kind, status: 'submitted', value: result.content.value }
        : request.kind === 'select' ? { kind: request.kind, status: 'submitted', optionId: result.content.value }
        : { kind: request.kind, status: 'submitted', text: result.content.value }
    }
    await this.workers.get(row.id)?.request('respond', { ...metadata, actionId, input })
  }
  private async project(row: SessionRecord, item: any): Promise<void> {
    if (!item.id) return
    const meta = { aa: { timelineItem: { ...item, sessionId: row.platformSessionId, source: { ...item.source, runtime: 'acp' } } } }
    if (item.type === 'tool') {
      await this.transport.update(row.id, { sessionUpdate: 'tool_call', toolCallId: item.id, kind: 'other',
        title: item.content.title ?? 'Pi tool', status: item.status === 'failed' ? 'failed' : item.status === 'done' ? 'completed' : 'in_progress',
        rawOutput: item.content, _meta: meta })
    } else {
      const previous = this.displayed.get(item.id) ?? '', current = item.content.text ?? ''
      this.displayed.set(item.id, current)
      await this.transport.update(row.id, { sessionUpdate: item.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
        content: { type: 'text', text: current.startsWith(previous) ? current.slice(previous.length) : current }, _meta: meta })
    }
  }
  private options(row: SessionRecord): any[] {
    const selections = row.prepared?.selections ?? {}
    return [{ id: 'model', name: '模型与推理强度', category: 'model', type: 'select', currentValue: row.selectionId ?? Object.keys(selections)[0],
      options: Object.entries(selections).map(([id, value]: any) => ({ value: id, name: `${value.provider}/${value.model} · ${value.thinkingLevel}` })) },
    { id: 'permission', name: '工具权限', category: 'permission', type: 'select', currentValue: row.permission,
      options: [{ value: 'ask', name: '写入与命令审批' }, { value: 'ask_all', name: '全部工具审批' }, { value: 'readonly', name: '只读' }] }]
  }
  async prepare(params: any): Promise<any> {
    if (this.closing) throw new RuntimeFailure('agent_closing', '执行端正在关闭。')
    const preparationId = params.preparationId ?? randomUUID()
    const previous = [...this.records.values()].find(row => row.preparationId === preparationId)
    if (previous) {
      if (previous.cwd !== params.cwd) throw new RuntimeFailure('operation_conflict', '准备身份不能用于不同目录。')
      if (previous.phase !== 'prepared') throw new RuntimeFailure('preparation_stale', '准备需要重新核验。')
      return this.preparation(previous)
    }
    const id = randomUUID()
    const row: SessionRecord = { id, preparationId, platformSessionId: id, generation: randomUUID(), cwd: params.cwd, phase: 'preparing', permission: 'ask' }
    this.records.set(id, row); await this.save(row)
    const worker = this.worker(row, 'preparation')
    try {
      row.prepared = await worker.boot(); row.phase = 'prepared'; await this.save(row)
      return this.preparation(row)
    } catch (error) { row.phase = 'recovery_required'; await this.save(row); throw error }
    finally { await worker.close(); this.workers.delete(id) }
  }
  private preparation(row: SessionRecord): any {
    return { sessionId: row.id, deferred: true, ticket: row.id, configOptions: this.options(row),
      resourceFingerprint: row.prepared?.resourceFingerprint, trustMode: row.prepared?.trustMode }
  }
  async newSession(params: any): Promise<any> {
    if (params.mcpServers?.length || params.additionalDirectories?.length) throw new RuntimeFailure('unsupported_session_input', '当前尚未启用 MCP 或额外工作目录，输入未被忽略。')
    const ticket = params._meta?.aa?.preparationId
    const prepared = ticket ? this.record(ticket) : this.record((await this.prepare({ cwd: params.cwd })).sessionId)
    if (prepared.cwd !== params.cwd || prepared.phase !== 'prepared') throw new RuntimeFailure('preparation_stale', '准备不能用于本次创建。')
    prepared.platformSessionId = params._meta?.aa?.platformSessionId ?? prepared.id
    prepared.generation = params._meta?.aa?.ownerGeneration ?? prepared.generation
    prepared.selectionId = params._meta?.aa?.selectionId ?? Object.keys(prepared.prepared?.selections ?? {})[0]
    prepared.phase = 'opening'; await this.save(prepared)
    const worker = this.worker(prepared, 'session')
    try {
      const result = await worker.boot(); prepared.sourcePath = result.sourcePath; prepared.position = result.position
      prepared.phase = 'ready'; await this.save(prepared)
      return { sessionId: prepared.id, configOptions: this.options(prepared), _meta: { aa: { guarantees: [...EXECUTION_GUARANTEES], ownerGeneration: prepared.generation } } }
    } catch (error) { prepared.phase = 'recovery_required'; await this.save(prepared); await worker.close(); this.workers.delete(prepared.id); throw error }
  }
  async setSessionConfigOption(params: any): Promise<any> {
    const row = this.record(params.sessionId), worker = this.workers.get(row.id)
    if (!worker || row.phase !== 'ready') throw new RuntimeFailure('session_unavailable', '会话需要恢复。')
    const option = this.options(row).find(x => x.id === params.configId)
    if (!option?.options.some((x: any) => x.value === params.value)) throw new RuntimeFailure('invalid_configuration', '配置值已失效。')
    const selectionId = params.configId === 'model' ? params.value : row.selectionId
    const permission = params.configId === 'permission' ? params.value : row.permission
    await worker.request('select', { selectionId, permission }); row.selectionId = selectionId; row.permission = permission
    await this.save(row); return { configOptions: this.options(row) }
  }
  async prompt(params: any): Promise<any> {
    const row = this.record(params.sessionId), worker = this.workers.get(row.id)
    if (!worker || row.phase !== 'ready') throw new RuntimeFailure('session_unavailable', '会话需要恢复。')
    if (!params._meta?.aa?.clientMessageId) throw new RuntimeFailure('message_identity_required', '消息需要稳定业务身份。')
    if (this.failedDelivery) throw new RuntimeFailure('sync_failed', '事件同步失败，需要恢复校准。')
    const converted = this.vocabulary.prompt(params.prompt)
    if (converted.images.length) throw new RuntimeFailure('attachments_unsupported', '附件尚未通过执行侧验证。')
    const receipt = await worker.request('prompt', { content: converted.text, clientMessageId: params._meta.aa.clientMessageId }, this.settings.maxRunMs)
    if (receipt.messageAccepted !== true) throw new RuntimeFailure(receipt.code ?? 'prompt_rejected', '消息尚未接纳。')
    const settled = await worker.request('settled', {}, this.settings.maxRunMs)
    await Promise.all([...this.pending])
    if (this.failedDelivery) throw new RuntimeFailure('sync_failed', '执行结果尚未可靠同步。')
    if (settled.failure) throw new RuntimeFailure(settled.failure.code, settled.failure.message)
    return { stopReason: 'end_turn' }
  }
  async cancel(params: any): Promise<void> { await this.workers.get(params.sessionId)?.request('interrupt') }
  async resumeSession(params: any): Promise<any> {
    if (this.closing) throw new RuntimeFailure('agent_closing', '执行端正在关闭。')
    const row = this.record(params.sessionId)
    if (row.cwd !== params.cwd || !row.sourcePath || !row.position || this.workers.has(row.id)) throw new RuntimeFailure('session_recovery_conflict', '恢复目录、原生来源或执行者状态不匹配。')
    const previousGeneration = row.generation
    row.generation = params._meta?.aa?.ownerGeneration ?? randomUUID()
    row.phase = 'opening'; await this.save(row)
    const worker = this.worker(row, 'session')
    try {
      const result = await worker.boot(); row.position = result.position; row.phase = 'ready'
      await this.save(row)
      return { configOptions: this.options(row), _meta: { aa: { ownerGeneration: row.generation, previousGeneration } } }
    } catch (error) {
      row.phase = 'recovery_required'; await worker.close(); this.workers.delete(row.id); await this.save(row); throw error
    }
  }
  async loadSession(params: any): Promise<any> { return this.resumeSession(params) }
  async closeSession(params: any): Promise<any> {
    const row = this.record(params.sessionId), worker = this.workers.get(row.id)
    row.phase = 'closing'; await this.save(row)
    if (worker) { const result = await worker.request('close'); row.position = result.position; await worker.close() }
    this.workers.delete(row.id); row.phase = 'closed'; await this.save(row); return {}
  }
  async extMethod(method: string, params: any): Promise<any> {
    method = method.replace(/^_/, '')
    if (method === 'aa/prepare_workspace') return this.prepare(params)
    if (method === 'aa/get_operation') {
      const row = this.record(params.agentSessionId ?? params.sessionId)
      const worker = this.workers.get(row.id)
      if (!worker) return await this.receipts.read('admission:' + row.platformSessionId + ':' + params.clientMessageId) ?? { phase: 'not_found' }
      return worker.request('getSubmission', { clientMessageId: params.clientMessageId })
    }
    if (method === 'aa/get_position') return { position: this.record(params.sessionId).position }
    if (method === 'aa/select_position') {
      const row = this.record(params.sessionId)
      if (this.workers.has(row.id) || !row.sourcePath || !this.history || params.ownerGeneration !== row.generation) throw new RuntimeFailure('owner_changed', '选择位置前必须释放原执行者并核验代际。')
      const snapshot = await this.history.read(row.sourcePath)
      if (!snapshot.complete || snapshot.header.id !== row.id || params.sourceEpoch !== digest(snapshot.header)
          || params.fileEntriesDigest !== digest(snapshot.entries) || params.positionRevision !== row.position?.positionRevision) throw new RuntimeFailure('position_stale', '原生来源或位置已变化。')
      const entries = new Map(snapshot.entries.map(entry => [entry.id, entry])), branch: any[] = [], seen = new Set<string>()
      let cursor = params.leafId
      while (cursor !== null) {
        if (typeof cursor !== 'string' || seen.has(cursor) || !entries.has(cursor)) throw new RuntimeFailure('position_invalid', '原生分支不完整。')
        seen.add(cursor); const entry = entries.get(cursor); branch.unshift(entry); cursor = entry.parentId
      }
      row.position = { piSessionId: row.id, sourceEpoch: digest(snapshot.header), fileEntriesDigest: digest(snapshot.entries),
        leafId: params.leafId, anchorDigest: digest(branch), positionRevision: params.positionRevision + 1,
        branchGeneration: randomUUID(), ownerGeneration: row.generation, clean: true }
      row.phase = 'recovery_required'; await this.save(row)
      return { position: row.position }
    }
    if (method === 'aa/replay') {
      const row = this.record(params.sessionId), worker = this.workers.get(row.id)
      if (!worker) throw new RuntimeFailure('session_unavailable', '会话需要恢复。')
      const history = await worker.request('history')
      return { sourceId: digest([row.id, row.sourcePath]), complete: true, updates: this.vocabulary.replay(history.entries, row.cwd) }
    }
    throw new RuntimeFailure('unsupported_operation', '不支持该 ACP 扩展方法。')
  }
  async authenticate(): Promise<any> { throw new RuntimeFailure('external_auth_required', '请通过本机 Pi 认证配置完成登录。') }
  async dispose(): Promise<void> {
    this.closing = true
    await Promise.allSettled([...this.records.values()].filter(x => this.workers.has(x.id)).map(x => this.closeSession({ sessionId: x.id })))
  }
}
