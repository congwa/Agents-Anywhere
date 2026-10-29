import { randomUUID, createHash } from 'node:crypto'
import { AgentFailure as RuntimeFailure } from '../domain/failures.js'
import { type SessionRecord } from '../domain/sessions.js'
import { AA_ACP_PROTOCOL } from './protocol.js'
import type { AcpTransport, ApplicationSettings, CoordinationStore, AgentCapabilityPort, ExecutionPort, AgentEvent } from './ports.js'

/** ACP-specific orchestration owns no SDK objects and no model transcript. */
export class AcpAgentApplication {
  private records = new Map<string, SessionRecord>()
  private workers = new Map<string, ExecutionPort>()
  private pending = new Set<Promise<unknown>>()
  private displayed = new Map<string, string>()
  private handled = new Set<string>()
  private closing = false
  private failedDelivery?: unknown
  private formSupported = false
  constructor(private settings: ApplicationSettings, private store: CoordinationStore,
    private capabilities: AgentCapabilityPort, private transport: AcpTransport) {}

  async initialize(params: any): Promise<any> {
    if (params.protocolVersion !== 1) throw new RuntimeFailure('unsupported_acp_version', '仅支持 ACP v1。')
    this.formSupported = !!params.clientCapabilities?.elicitation?.form
    for (const row of await this.store.values<SessionRecord>()) {
      if (row.id && row.phase) { row.phase = 'recovery_required'; this.records.set(row.id, row); await this.save(row) }
    }
    return { protocolVersion: 1, agentInfo: { name: this.capabilities.descriptor.name, version: '1' }, authMethods: [],
      agentCapabilities: { promptCapabilities: this.capabilities.descriptor.promptCapabilities, sessionCapabilities: { close: {}, resume: {} }, loadSession: true,
        _meta: { aa: { protocolVersion: AA_ACP_PROTOCOL, guarantees: [...this.capabilities.descriptor.guarantees], capabilities: [...this.capabilities.descriptor.capabilities] } } } }
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
  private worker(row: SessionRecord, role: 'preparation' | 'session'): ExecutionPort {
    const worker = this.capabilities.create({ role, session: row }, event => this.event(row, event))
    this.workers.set(row.id, worker)
    return worker
  }
  private event(row: SessionRecord, event: AgentEvent): void {
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
      await this.transport.update(row.id, { sessionUpdate: 'tool_call', toolCallId: item.id, ...this.capabilities.tool(item, row.cwd), status: item.status === 'failed' ? 'failed' : item.status === 'done' ? 'completed' : 'in_progress',
        rawOutput: item.content, _meta: meta })
    } else {
      const previous = this.displayed.get(item.id) ?? '', current = item.content.text ?? ''
      this.displayed.set(item.id, current)
      await this.transport.update(row.id, { sessionUpdate: item.role === 'user' ? 'user_message_chunk' : item.content.isThinking ? 'agent_thought_chunk' : 'agent_message_chunk',
        content: { type: 'text', text: current.startsWith(previous) ? current.slice(previous.length) : current }, _meta: meta })
    }
  }
  private options(row: SessionRecord): any[] { return this.capabilities.configuration(row) }
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
    const row: SessionRecord = { id, preparationId, platformSessionId: id, generation: randomUUID(), cwd: params.cwd, phase: 'preparing' }
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
    this.capabilities.initializeSession(prepared, params._meta?.aa ?? {})
    prepared.phase = 'opening'; await this.save(prepared)
    const worker = this.worker(prepared, 'session')
    try {
      const result = await worker.boot(); prepared.sourcePath = result.sourcePath; prepared.position = result.position
      prepared.phase = 'ready'; await this.save(prepared)
      return { sessionId: prepared.id, configOptions: this.options(prepared), _meta: { aa: { guarantees: [...this.capabilities.descriptor.guarantees], capabilities: [...this.capabilities.descriptor.capabilities], ownerGeneration: prepared.generation } } }
    } catch (error) { prepared.phase = 'recovery_required'; await this.save(prepared); await worker.close(); this.workers.delete(prepared.id); throw error }
  }
  async setSessionConfigOption(params: any): Promise<any> {
    const row = this.record(params.sessionId), worker = this.workers.get(row.id)
    if (!worker || row.phase !== 'ready') throw new RuntimeFailure('session_unavailable', '会话需要恢复。')
    const option = this.options(row).find(x => (x.configId ?? x.id) === params.configId)
    const choices = (option?.options ?? []).flatMap((group: any) => group.options ?? [group])
    const valid = option?.type === 'boolean' ? typeof params.value === 'boolean' : option?.type === 'select' && choices.some((choice: any) => choice.value === params.value)
    if (!valid) throw new RuntimeFailure('invalid_configuration', '配置值已失效。')
    await this.capabilities.configure(row, worker, params.configId, params.value)
    await this.save(row); return { configOptions: this.options(row) }
  }
  async prompt(params: any): Promise<any> {
    const row = this.record(params.sessionId), worker = this.workers.get(row.id)
    if (!worker || row.phase !== 'ready') throw new RuntimeFailure('session_unavailable', '会话需要恢复。')
    if (!params._meta?.aa?.clientMessageId) throw new RuntimeFailure('message_identity_required', '消息需要稳定业务身份。')
    if (this.failedDelivery) throw new RuntimeFailure('sync_failed', '事件同步失败，需要恢复校准。')
    const converted = this.capabilities.prompt(params.prompt)
    const receipt = await worker.request('prompt', { content: converted.text, ...(converted.images.length ? { images: converted.images } : {}), clientMessageId: params._meta.aa.clientMessageId }, this.settings.maxRunMs)
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
      if (!worker) return await this.capabilities.receipt(row, params.clientMessageId) ?? { phase: 'not_found' }
      return worker.request('getSubmission', { clientMessageId: params.clientMessageId })
    }
    if (method === 'aa/get_position') return { position: this.record(params.sessionId).position }
    if (method === 'aa/select_position') {
      const row = this.record(params.sessionId)
      if (this.workers.has(row.id) || params.ownerGeneration !== row.generation) throw new RuntimeFailure('owner_changed', '选择位置前必须释放原执行者并核验代际。')
      row.position = await this.capabilities.selectPosition(row, params)
      row.phase = 'recovery_required'; await this.save(row)
      return { position: row.position }
    }
    if (method === 'aa/list_commands' || method === 'aa/execute_command') {
      const row = this.record(params.sessionId), worker = this.workers.get(row.id)
      if (!worker || row.phase !== 'ready') throw new RuntimeFailure('session_unavailable', '会话需要恢复。')
      if (method === 'aa/list_commands') return { commands: this.capabilities.commands() }
      return this.capabilities.executeCommand(worker, params)
    }
    if (method === 'aa/replay') {
      const row = this.record(params.sessionId), worker = this.workers.get(row.id)
      if (!worker) throw new RuntimeFailure('session_unavailable', '会话需要恢复。')
      const history = await worker.request('history')
      return { sourceId: createHash('sha256').update(JSON.stringify([row.id, row.sourcePath])).digest('hex'), complete: true, updates: this.capabilities.replay(history.entries, row.cwd) }
    }
    throw new RuntimeFailure('unsupported_operation', '不支持该 ACP 扩展方法。')
  }
  async authenticate(): Promise<any> { throw new RuntimeFailure('external_auth_required', '请通过工作设备上的 Agent 认证配置完成登录。') }
  async dispose(): Promise<void> {
    this.closing = true
    await Promise.allSettled([...this.records.values()].filter(x => this.workers.has(x.id)).map(x => this.closeSession({ sessionId: x.id })))
  }
}

// Compatibility for existing component consumers.
export { AcpAgentApplication as AaPiAgent }
