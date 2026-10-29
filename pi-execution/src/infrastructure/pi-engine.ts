import { existingTrust, trustAnswer } from '../domain/project-trust.js'
import { toolAuthorization } from '../domain/tool-authorization.js'
import { PromptSubmission } from '../domain/prompt-submission.js'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, realpath, stat, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  createAgentSessionServices, createAgentSessionFromServices, createAgentSessionRuntime,
  ProjectTrustStore, hasTrustRequiringProjectResources, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type AgentSessionServices,
} from '@earendil-works/pi-coding-agent'
import { DialogResult } from '../domain/dialog-result.js'
import { Interactions, type Response } from '../application/interactions.js'
import { digest, requireValue, RuntimeFailure, failure } from '../domain/shared.js'
import { ModelGuard } from './model-guard.js'
import { requestProfile } from './request-profile.js'
import { JsonStore } from './storage.js'
import { capturePosition, verifyPosition, type Position } from './position.js'
import { modelCatalog, resourceFingerprint } from './resources.js'
import { Projector } from './projection.js'
import type { WorkerConfig, WorkerEvent } from '../application/ports.js'

export class PiEngine {
  readonly interactions: Interactions
  private services?: AgentSessionServices
  private manager?: SessionManager
  private session?: AgentSession
  private lifecycle?: Awaited<ReturnType<typeof createAgentSessionRuntime>>
  private lease?: ChildProcess
  private closing = false
  private initialized = false
  private scope: 'preparation' | 'creation' | 'session'
  private scopeId: string
  private trusted = false
  private trustMode = 'basic'
  private catalog?: ReturnType<typeof modelCatalog>
  private workspaceId = ''
  private permission: string
  private guard: ModelGuard
  private position?: Position
  private projector?: Projector
  private selectedId?: string
  private run?: Promise<void>
  private clientMessageId?: string
  private lastRunFailure?: { code: string; message: string }
  private readonly abort = new AbortController()
  private readonly store: JsonStore
  private readonly grants = new Set<string>()
  private readonly pendingUpdates = new Map<string, any>()
  private updateTimer?: ReturnType<typeof setTimeout>

  constructor(readonly config: WorkerConfig, private readonly emit: (event: WorkerEvent) => void) {
    this.scope = config.role === 'preparation' ? 'preparation' : 'creation'
    this.scopeId = config.scopeId
    this.permission = config.permission ?? 'ask'
    this.store = new JsonStore(join(config.storageRoot, 'worker-state'))
    this.guard = new ModelGuard(config.generation, error => this.emit({ kind: 'requestRejected', data: failure(error) }))
    this.interactions = new Interactions(config.generation, request => {
      this.emit({ kind: 'interaction', data: request })
      if (this.session) this.publishState(request.status === 'open' ? 'waiting_approval' : this.run ? 'running' : 'idle')
    })
  }
  private emitState(data: Record<string, unknown>): void { this.emit({ kind: 'state', data }) }
  private async lockSource(sourcePath: string): Promise<void> {
    const directory = await realpath(dirname(sourcePath))
    const key = digest(join(directory, sourcePath.split(/[\\/]/).at(-1)!))
    const helper = fileURLToPath(new URL('../../../scripts/source-lock.py', import.meta.url))
    const child = spawn(this.config.python, [helper, join(directory, '.agents-anywhere-leases', key + '.lease')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.lease = child
    child.stderr.on('data', () => undefined)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new RuntimeFailure('owner_unavailable', '无法取得原生会话写入锁。')), 5000)
      child.stdout.once('data', value => { clearTimeout(timer); value.toString().startsWith('locked') ? resolve() : reject(new RuntimeFailure('owner_unavailable', '原生会话写入锁不可用。')) })
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', () => { clearTimeout(timer); reject(new RuntimeFailure('owner_unavailable', '该原生会话已有写入者。')) })
    })
  }
  private async determineTrust(): Promise<void> {
    const cwd = await realpath(this.config.cwd)
    requireValue((await stat(cwd)).isDirectory(), 'invalid_cwd', '工作目录不存在。')
    this.config.cwd = cwd
    this.workspaceId = digest([this.config.runtimeId, cwd])
    const store = new ProjectTrustStore(this.config.agentDir)
    const entry = store.getEntry(cwd)
    const known = existingTrust(hasTrustRequiringProjectResources(cwd), this.config.trustMode, entry?.decision)
    if (known) { this.trusted = known.enabled; this.trustMode = known.mode; return }
    if (this.config.role !== 'preparation') throw new RuntimeFailure('project_trust_required', '需要重新确认项目资源授权。')
    const { answer } = this.interactions.open({
      scope: this.scope, scopeId: this.scopeId, kind: 'project_trust', purpose: 'project_trust',
      title: '是否启用项目资源？', message: cwd,
      actions: [
        { actionId: 'basic', label: '继续基础能力', style: 'secondary', input: { required: false } },
        { actionId: 'once', label: '本次启用', style: 'primary', input: { required: false } },
        { actionId: 'trust_directory', label: '信任此目录及子目录', style: 'secondary', input: { required: false } },
        { actionId: 'cancel', label: '取消', style: 'danger', input: { required: false } },
      ], metadata: { cwd, workspaceId: this.workspaceId },
    }, 300_000, this.abort.signal)
    const result = await answer
    requireValue(result && result.actionId !== 'cancel', 'preparation_cancelled', '准备已取消。')
    if (result.actionId === 'trust_directory') store.set(cwd, true)
    const decision = trustAnswer(result.actionId)
    this.trusted = decision.enabled; this.trustMode = decision.mode
  }
  async boot(): Promise<Record<string, unknown>> {
    await mkdir(this.config.agentDir, { recursive: true, mode: 0o700 })
    await this.determineTrust()
    if (this.config.expectedResourceFingerprint) requireValue(
      await resourceFingerprint(this.config.cwd, this.config.agentDir, this.trusted) === this.config.expectedResourceFingerprint,
      'preparation_stale', '工作区资源已变化，请重新准备。')
    const nativeModels = await ModelRuntime.create({ authPath: join(this.config.agentDir, 'auth.json'), modelsPath: join(this.config.agentDir, 'models.json'), allowModelNetwork: false })
    const models = this.guard.wrap(nativeModels)
    const settings = SettingsManager.create(this.config.cwd, this.config.agentDir, { projectTrusted: false })
    settings.applyOverrides({ cacheWarming: 'off', transport: 'sse' })
    this.services = await createAgentSessionServices({
      cwd: this.config.cwd, agentDir: this.config.agentDir, modelRuntime: models, settingsManager: settings,
      resourceLoaderReloadOptions: { resolveProjectTrust: async () => this.trusted },
      resourceLoaderOptions: { extensionFactories: [pi => {
        pi.on('input', () => this.closing || !this.guard.permit ? { action: 'handled' as const } : undefined)
        pi.on('tool_call', async (event, ctx) => {
          requireValue(!this.closing && !ctx.signal?.aborted, 'run_cancelled', '运行已取消。')
          const { safeRead, key } = toolAuthorization({ runtimeId: this.config.runtimeId, sessionId: this.config.sessionId, generation: this.config.generation, parentToolCallId: event.parentToolCallId, toolName: event.toolName, cwd: this.config.cwd, branchGeneration: this.position?.branchGeneration, permission: this.permission }, event.input)
          if ((safeRead && this.permission !== 'ask_all') || this.grants.has(key)) return
          if (this.permission === 'readonly') return { block: true, reason: '当前会话只允许读取操作。' }
          const { answer } = this.interactions.open({ scope: this.scope, scopeId: this.scopeId,
            kind: 'approval', purpose: 'tool_permission', title: `允许执行 ${event.toolName}？`,
            message: JSON.stringify(event.input, null, 2),
            actions: [
              { actionId: 'approve', label: '允许一次', style: 'primary', input: { required: false } },
              { actionId: 'approve_for_session', label: '本会话允许相同操作', style: 'secondary', input: { required: false } },
              { actionId: 'reject', label: '拒绝', style: 'danger', input: { required: false } },
            ], metadata: { cwd: this.config.cwd, toolCallId: event.toolCallId, parentToolCallId: event.parentToolCallId ?? null, inputDigest: key },
          }, 300_000, ctx.signal)
          const decision = await answer
          if (decision?.actionId === 'approve_for_session') this.grants.add(key)
          if (this.closing || ctx.signal?.aborted || !decision || !['approve', 'approve_for_session'].includes(decision.actionId)) return { block: true, reason: '本次操作未获授权。' }
        })
        pi.on('message_start', async (event) => {
          if (this.manager && this.projector) await this.projector.reserve(event.message, this.manager, event.message.role === 'user' ? this.clientMessageId : undefined)
        })
        pi.on('agent_settled', async () => {
          this.flushUpdates()
          await this.checkpoint(false)
          this.guard.permit = undefined
          this.publishSettledState()
          this.emit({ kind: 'settled', data: { sessionId: this.config.sessionId, sourceEventId: digest([this.config.sessionId, this.config.generation, this.clientMessageId]), error: this.guard.lastFailure ?? this.lastRunFailure ?? null } })
        })
      }] },
    })
    requireValue(!this.closing, 'initialization_cancelled', '初始化已取消。')
    const errors = this.services.diagnostics.filter(item => item.type === 'error')
    requireValue(!errors.length, 'resource_load_failed', errors.map(item => item.message).join('\n'))
    this.catalog = modelCatalog(models, this.workspaceId)
    const fingerprint = await resourceFingerprint(this.config.cwd, this.config.agentDir, this.trusted)
    const prepared = { cwd: this.config.cwd, workspaceId: this.workspaceId, trustMode: this.trustMode,
      trust: { enabled: this.trusted, source: this.trustMode }, resourceFingerprint: fingerprint,
      catalogFingerprint: this.catalog.fingerprint,
      catalog: { runtime: 'pi', runtimeId: this.config.runtimeId, revision: 0, models: this.catalog.models },
      selections: this.catalog.selections }
    if (this.config.role === 'preparation') return prepared
    const selection = this.catalog.selections[this.config.selectionId ?? '']
    requireValue(selection, 'pi_restore_selection_required', '请选择当前工作区中可用的模型。')
    const model = models.getModel(selection.provider, selection.model)
    requireValue(model, 'pi_restore_model_unavailable', '所选模型已不可用。')
    const root = join(this.config.storageRoot, 'sessions')
    if (!this.config.sourcePath) this.manager = SessionManager.create(this.config.cwd, root, { id: this.config.nativeSessionId })
    const sourcePath = this.config.sourcePath ?? this.manager!.getSessionFile()
    requireValue(sourcePath, 'history_unavailable', '无法确定原生会话持久化位置。')
    await this.lockSource(sourcePath)
    if (this.config.sourcePath) this.manager = SessionManager.open(this.config.sourcePath, root, this.config.cwd)
    requireValue(this.manager, 'history_unavailable', '原生会话未打开。')
    if (this.config.position) {
      this.position = this.config.position as unknown as Position
      verifyPosition(this.manager, this.position)
      const branch = this.manager.getBranch()
      const nativeModel = branch.findLast(entry => entry.type === 'model_change')
      const nativeEffort = branch.findLast(entry => entry.type === 'thinking_level_change')
      if (this.config.authorizeSelection) {
        await this.store.write('restore-selection:' + this.config.sessionId, { generation: this.config.generation,
          position: this.position, selection, resourceFingerprint: fingerprint })
        this.manager.appendModelChange(selection.provider, selection.model)
        this.manager.appendThinkingLevelChange(selection.thinkingLevel as Parameters<AgentSession['setThinkingLevel']>[0])
      } else {
        requireValue((!nativeModel || nativeModel.provider === selection.provider && nativeModel.modelId === selection.model)
          && (!nativeEffort || nativeEffort.thinkingLevel === selection.thinkingLevel),
          'pi_restore_selection_changed', '原生分支模型与授权选择不同，请重新选择模型后恢复。')
      }
    }
    const result = await createAgentSessionFromServices({ services: this.services, sessionManager: this.manager,
      model, thinkingLevel: selection.thinkingLevel as Parameters<AgentSession['setThinkingLevel']>[0] })
    this.session = result.session
    this.selectedId = this.config.selectionId
    this.guard.bind(this.session)
    this.projector = new Projector(this.config.sessionId!, this.manager.getSessionId(), this.store,
      item => this.emit({ kind: 'timeline', data: item }))
    await this.projector.restore(this.manager)
    this.session.subscribe(event => {
      if (event.type === 'message_start' || event.type === 'message_update') {
        const id = this.projector!.messageId(event.message)
        if (!id) return
        this.pendingUpdates.set(id, event.message)
        this.updateTimer ??= setTimeout(() => { this.updateTimer = undefined; this.flushUpdates() }, 100)
      } else if (event.type === 'message_end') {
        if (event.message.role === 'assistant' && event.message.stopReason === 'error') this.lastRunFailure = { code: 'provider_error', message: event.message.errorMessage ?? '模型请求失败。' }
        const id = this.projector!.messageId(event.message)
        if (id) this.pendingUpdates.delete(id)
        this.projector!.update(event.message, false, event.message.role === 'user' ? this.clientMessageId : undefined)
        queueMicrotask(() => { void this.projector!.commit(event.message, this.manager!).catch(error => this.abortRun(error)) })
      }
    })
    this.emit({ kind: 'nativeCreated', data: { sessionId: this.config.sessionId, nativeSessionId: this.manager.getSessionId(), sourcePath: this.manager.getSessionFile() } })
    this.lifecycle = await createAgentSessionRuntime(async () => ({ ...result, services: this.services!, diagnostics: [] }), {
      cwd: this.config.cwd, agentDir: this.config.agentDir, sessionManager: this.manager,
    })
    await this.session.bindExtensions({ uiContext: this.ui() as any,
      commandContextActions: {
        newSession: async () => { throw new RuntimeFailure('unsupported_operation', '请通过工作台创建新会话。') },
        switchSession: async () => { throw new RuntimeFailure('unsupported_operation', '请通过工作台选择会话。') },
        fork: async () => { throw new RuntimeFailure('unsupported_operation', '暂不支持该原生命令。') },
        navigateTree: async () => { throw new RuntimeFailure('unsupported_operation', '请通过工作台恢复位置。') },
      } as any,
    })
    requireValue(!result.modelFallbackMessage && this.session.model?.provider === selection.provider
      && this.session.model.id === selection.model && this.session.thinkingLevel === selection.thinkingLevel,
    'pi_restore_selection_changed', 'SDK 实际选择发生变化，请重新确认模型。')
    await this.checkpoint(false)
    this.initialized = true
    this.publishState('idle')
    return { ...prepared, nativeSessionId: this.manager.getSessionId(), sourcePath: this.manager.getSessionFile(), position: this.position }
  }
  private flushUpdates(): void {
    for (const message of this.pendingUpdates.values()) this.projector?.update(message, true, message.role === 'user' ? this.clientMessageId : undefined)
    this.pendingUpdates.clear()
  }
  private ui(): Record<string, unknown> {
    const dialog = async (kind: 'confirm' | 'select' | 'input' | 'editor', title: string, options: any, initialValue?: string, choices?: string[]) => {
      const choicesWithIds = choices?.map((label, i) => ({ id: `option-${i}`, label }))
      const { answer } = this.interactions.open({ scope: this.scope, scopeId: this.scopeId, kind, purpose: 'general_input', title,
        actions: [
          { actionId: 'submit', label: '提交', style: 'primary', input: { required: true, schema: z.toJSONSchema(DialogResult),
            uiSchema: { component: 'runtimeDialog', version: 1, kind, initialValue: initialValue ?? '', allowEmpty: true,
              multiline: kind === 'editor', ...(choicesWithIds ? { options: choicesWithIds } : {}) } } },
          { actionId: 'cancel', label: '取消', style: 'secondary', input: { required: false } },
        ], metadata: { initialValue: initialValue ?? '', options: choicesWithIds ?? [] },
      }, options?.timeout ?? 300_000, options?.signal ? AbortSignal.any([options.signal, this.abort.signal]) : this.abort.signal)
      const response = await answer
      if (!response || response.actionId === 'cancel') return kind === 'confirm' ? false : undefined
      const value = DialogResult.parse(response.input)
      if (value.status === 'cancelled') return kind === 'confirm' ? false : undefined
      if (value.kind === 'confirm') return value.value
      if (value.kind === 'select') return choicesWithIds?.find(item => item.id === value.optionId)?.label
      return value.text
    }
    return {
      confirm: (title: string, message: string, options: any) => dialog('confirm', title + '\n' + message, options),
      select: (title: string, choices: string[], options: any) => dialog('select', title, options, undefined, choices),
      input: (title: string, _placeholder: string, options: any) => dialog('input', title, options),
      editor: (title: string, prefill: string) => dialog('editor', title, {}, prefill),
      notify: (message: string) => this.emit({ kind: 'diagnostic', data: { message: message.slice(0, 4096) } }),
      custom: async () => { throw new RuntimeFailure('ui_component_unsupported', '此扩展需要本地终端组件。') },
      setStatus() {}, setWidget() {}, setTitle() {}, setEditorText() {}, getEditorText: () => '',
      setWorkingMessage() {}, setFooter() {}, setHeader() {}, getAllThemes: () => [], getTheme: () => undefined,
      setTheme: () => ({ success: false, error: '无终端主题' }), setToolsExpanded() {}, getToolsExpanded: () => false,
    }
  }
  respond(response: Response): unknown {
    const request = this.interactions.current.get(response.interactionId)
    if (request && ['confirm', 'select', 'input', 'editor'].includes(request.kind) && response.actionId === 'submit') {
      const parsed = DialogResult.parse(response.input)
      requireValue(parsed.kind === request.kind, 'invalid_input', '回答类型不匹配。')
      if (parsed.status === 'submitted' && parsed.kind === 'select') requireValue((request.metadata.options as any[])?.some(item => item.id === parsed.optionId), 'invalid_input', '选项已失效。')
    }
    return this.interactions.respond(response)
  }
  async prompt(request: { content: string; clientMessageId: string; attachments?: any[] }, steer = false): Promise<any> {
    requireValue(this.session && this.services && this.catalog && this.initialized && !this.closing, 'session_unavailable', '会话尚未就绪。')
    requireValue(!this.run, 'session_busy', '会话正在运行，请先中断或等待结束。')
    requireValue(!request.attachments?.length, "attachments_unsupported", "此 Runtime 尚未启用附件交付。")
    requireValue(request.content.trim() || request.attachments?.length, 'empty_message', '消息不能为空。')
    const submission = new PromptSubmission(this.config.sessionId, request)
    const { fingerprint, key } = submission
    const prior = await this.store.read<any>(key)
    if (prior) { submission.requireSame(prior); return prior.receipt ?? { ok: false, code: 'outcome_unknown' } }
    const selection = this.catalog.selections[this.selectedId!]
    const model = this.services.modelRuntime.getModel(selection.provider, selection.model)!
    const auth = await this.services.modelRuntime.getAuth(model)
    requireValue(auth, 'pi_restore_model_unavailable', '模型认证不可用。')
    this.guard.permit = { operationId: request.clientMessageId, provider: selection.provider, model: selection.model,
      api: model.api, baseUrl: auth.auth.baseUrl ?? model.baseUrl, thinkingLevel: selection.thinkingLevel, wireEffort: model.thinkingLevelMap?.[selection.thinkingLevel as keyof typeof model.thinkingLevelMap],
      requestProfile: requestProfile(model),
      generation: this.config.generation, cancelled: false, dispatched: 0 }
    this.guard.lastFailure = undefined; this.lastRunFailure = undefined
    this.clientMessageId = request.clientMessageId
    await this.store.write(key, { fingerprint, phase: 'prepared' })
    let resolve!: (value: any) => void
    const accepted = new Promise<any>(done => { resolve = done })
    let intake = false
    const persistReceipt = async (result: any) => {
      const receipt = { ...result, sessionId: this.config.sessionId, externalSessionId: this.manager!.getSessionId(), clientMessageId: request.clientMessageId }
      await this.store.write(key, { fingerprint, receipt })
      this.emit({ kind: 'submission', data: receipt })
      resolve(receipt)
    }
    this.publishState('running')
    const timer = setTimeout(() => this.abortRun(new RuntimeFailure('run_timeout', '运行已达到时间上限。')), this.config.maxRunMs)
    timer.unref()
    this.run = this.session.prompt(request.content, { preflightResult: disposition => {
      intake = true
      this.scope = 'session'; this.scopeId = this.config.sessionId!
      void persistReceipt({ ok: true, created: true, messageAccepted: true, disposition,
        sessionId: this.config.sessionId, externalSessionId: this.manager!.getSessionId(), clientMessageId: request.clientMessageId })
        .catch(error => { this.abortRun(error); resolve({ ok: false, code: 'outcome_unknown', messageAccepted: true }) })
    } }).catch(async error => {
      this.lastRunFailure = failure(error)
      if (!intake) await persistReceipt({ ok: false, ...failure(error), created: true, messageAccepted: false })
      this.emit({ kind: 'runFailed', data: { ...failure(error), messageAccepted: intake } })
    }).finally(() => {
      clearTimeout(timer); this.run = undefined; this.guard.permit = undefined
      this.publishSettledState()
      this.emit({ kind: 'runSettled', data: { sessionId: this.config.sessionId } })
    })
    // Persist failures also settle the caller, without an unhandled rejection.
    void this.run.then(() => { if (!intake) resolve({ ok: false, code: 'outcome_unknown' }) }, () => resolve({ ok: false, code: 'outcome_unknown', messageAccepted: intake ? true : null }))
    return accepted
  }
  private abortRun(error: unknown): void {
    this.guard.cancel(); this.interactions.cancelAll(); this.lastRunFailure = failure(error)
    this.emit({ kind: 'runFailed', data: failure(error) })
    void this.session?.abort()
  }
  private publishState(status: string): void {
    this.emitState({ sessionId: this.config.sessionId, runtime: 'pi', externalSessionId: this.manager?.getSessionId(),
      status, selections: { model: this.selectedId ?? null, permission: this.permission },
      error: this.guard.lastFailure ?? this.lastRunFailure ?? null, metadata: { ownerGeneration: this.config.generation, selectionPolicy: 'fixed-selection', strict_selection_enforced: true,
        actualModel: this.session?.model ? { provider: this.session.model.provider, model: this.session.model.id, thinkingLevel: this.session.thinkingLevel } : null } })
  }
  private publishSettledState(): void {
    this.publishState(this.guard.lastFailure ? 'blocked' : this.lastRunFailure ? 'error' : 'idle')
  }
  async checkpoint(clean: boolean): Promise<Position | undefined> {
    if (!this.manager) return
    await this.projector?.save()
    if (clean) {
      const path = this.manager.getSessionFile()
      try {
        requireValue(path, 'history_unavailable', '原生会话路径缺失。')
        const handle = await open(path, 'r')
        try { await handle.sync() } finally { await handle.close() }
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') clean = false; else throw error }
    }
    this.position = capturePosition(this.manager, this.config.generation, this.position, clean)
    await this.store.write('position:' + this.config.sessionId, this.position)
    this.emit({ kind: 'position', data: this.position })
    return this.position
  }
  async getSubmission(clientMessageId: string): Promise<unknown> {
    return this.store.read('admission:' + this.config.sessionId + ':' + clientMessageId)
  }
  async settled(): Promise<void> { await this.run }
  history(): unknown[] { return this.manager?.getBranch() ?? [] }
  async dispatch(method: string, params: any): Promise<any> {
    if (method === 'getSubmission') return await this.getSubmission(params.clientMessageId) ?? { phase: 'not_found' }
    if (method === 'settled') { await this.settled(); return { settled: true, failure: this.lastRunFailure ?? this.guard.lastFailure ?? null } }
    if (method === 'history') return { entries: this.history() }
    if (method === 'respond') return this.respond(params)
    if (method === 'getReceipt') return this.interactions.getReceipt(params.responseOperationId) ?? { disposition: 'outcome_unknown' }
    if (method === 'prompt') return this.prompt(params)
    if (method === 'interrupt') { this.guard.cancel(); this.interactions.cancelAll(); await this.session?.abort(); await this.run; return { ok: true } }
    if (method === 'cancelInitialization') {
      await this.close()
      return { messageAccepted: this.scope === 'session', created: !!this.manager }
    }
    if (method === 'select') {
      requireValue(this.session && this.catalog && this.services && this.initialized && !this.run, 'session_busy', '请等待运行结束再切换模型。')
      const selection = this.catalog.selections[params.selectionId]
      requireValue(selection, 'pi_restore_selection_required', '所选模型不在当前工作区目录中。')
      await this.session.setModel(this.services.modelRuntime.getModel(selection.provider, selection.model)!)
      this.session.setThinkingLevel(selection.thinkingLevel as Parameters<AgentSession['setThinkingLevel']>[0])
      requireValue(this.session.thinkingLevel === selection.thinkingLevel, 'pi_restore_selection_changed', '推理强度不受支持。')
      this.selectedId = params.selectionId
      if (params.permission) { this.permission = params.permission; this.grants.clear() }
      await this.store.write('selection:' + this.config.sessionId, { selectionId: this.selectedId, selection })
      await this.checkpoint(false); this.publishState('idle'); return { ok: true }
    }
    if (method === 'close') return this.close()
    if (method === 'snapshot') return { items: [...this.projector?.items.values() ?? []] }
    throw new RuntimeFailure('unsupported_operation', '此执行操作尚不支持。')
  }
  async close(): Promise<any> {
    if (this.closing) return { clean: false }
    this.closing = true; this.abort.abort(); this.interactions.cancelAll(true); this.guard.cancel()
    if (this.updateTimer) clearTimeout(this.updateTimer)
    await this.session?.abort(); await this.run
    await this.lifecycle?.dispose()
    this.flushUpdates()
    const position = await this.checkpoint(true)
    // The lease helper keeps its pipe until the worker actually exits.
    // A close receipt is not evidence that the OS writer has terminated.
    return { clean: true, position }
  }
}
