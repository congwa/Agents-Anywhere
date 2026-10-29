import { randomUUID } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Methods, type Method } from '../contracts/protocol.js'
import { Mailbox, digest, failure, requireValue, RuntimeFailure } from '../domain/shared.js'
import { JsonStore } from '../infrastructure/storage.js'
import { Outbox, type Notification } from '../infrastructure/outbox.js'
import { WorkerSupervisor, type WorkerConfig, type WorkerEvent, type WorkerProxy } from '../infrastructure/workers.js'
import { readNativeHistory, readNativeHeader, nativeFiles } from '../infrastructure/native-history.js'
import { Projector } from '../infrastructure/projection.js'
import type { Position } from '../infrastructure/position.js'
import type { Interaction } from '../domain/interactions.js'
import { decideReservation } from '../domain/preparations.js'
import { ownsWorker, interruptedExecution, type WorkerExit } from '../domain/session-lifecycle.js'
import { CatalogRevisions } from '../infrastructure/catalog-revisions.js'

export type HostConfig = { runtimeId: string; sessionNamespace: string; agentDir: string; storageRoot: string; python: string; maxWorkers: number; maxRunMs: number; maxConcurrentRuns: number; preparationTtlMs: number }
type Preparation = { preparationId: string; clientPreparationId: string; projectId?: string; inputDigest: string; cwd: string; workspacePath?: string; phase: string; revision: number;
  expiresAt: string; interactions: Interaction[]; workspaceId?: string; trustMode?: string; resourceFingerprint?: string; catalog?: any; selections?: Record<string, any>;
  workerId?: string; createOperationId?: string; platformSessionId?: string; reservedSelections?: Record<string, string | null>; failure?: any }
type Creation = { createOperationId: string; sessionId: string; inputDigest: string; phase: string; revision: number;
  initializationId: string; ownerGeneration: string; created: boolean | null; messageAccepted: boolean | null;
  clientMessageId?: string; messageFingerprint?: string; nativeSessionId?: string;
  interactions: Interaction[]; workerId?: string; admissionReceipt?: any; failure?: any }
type Session = { sessionId: string; nativeSessionId: string; sourcePath?: string; cwd: string; workspacePath?: string; workspaceId: string; sourceId: string;
  selectionId: string; permission: string; trustMode: string; catalog: any; state?: any; position?: Position; ownerGeneration: string;
  items: Map<string, any>; interactions: Map<string, Interaction>; workerId?: string; ready?: boolean; title?: string; readOnly?: boolean }

export class PiHost {
  readonly generation = randomUUID()
  readonly supervisor: WorkerSupervisor
  readonly outbox: Outbox
  private readonly preparationStore: JsonStore
  private readonly creationStore: JsonStore
  private readonly sessionStore: JsonStore
  private readonly catalogRevisions: CatalogRevisions
  private readonly preparations = new Map<string, Preparation>()
  private readonly creations = new Map<string, Creation>()
  private readonly sessions = new Map<string, Session>()
  private readonly eventDrains = new Map<string, () => Promise<void>>()
  private readonly locks = new Map<string, Mailbox>()
  private readonly jobs = new Set<Promise<unknown>>()
  private closing = false
  private readonly restorePreviews = new Map<string, { resourceFingerprint: string; trustMode: string; expiresAt: number }>()
  private readonly activeRuns = new Set<string>()
  private readonly sessionClosures = new Map<string, Promise<any>>()
  private nativeDiagnostics: { path: string; code: string; message: string }[] = []
  constructor(readonly config: HostConfig) {
    this.supervisor = new WorkerSupervisor(config.maxWorkers)
    this.preparationStore = new JsonStore(join(config.storageRoot, 'preparations'))
    this.creationStore = new JsonStore(join(config.storageRoot, 'creations'))
    this.sessionStore = new JsonStore(join(config.storageRoot, 'bindings'))
    this.catalogRevisions = new CatalogRevisions(new JsonStore(join(config.storageRoot, 'catalog-revisions')))
    this.outbox = new Outbox(new JsonStore(join(config.storageRoot, 'outbox')))
  }
  async restore(): Promise<void> {
    await this.outbox.restore()
    await this.outbox.discardPreviousExecutionObservations()
    for (const record of await this.preparationStore.values<Preparation>()) {
      record.workerId = undefined
      if (record.phase !== 'consumed') { record.phase = 'expired'; record.interactions = []; record.revision++ }
      this.preparations.set(record.preparationId, record)
      if (record.catalog && record.workspaceId) await this.catalogRevisions.seed(record.workspaceId, digest(record.catalog.models), record.catalog.revision)
    }
    for (const record of await this.creationStore.values<Creation>()) {
      record.workerId = undefined; record.interactions = []
      if (!['accepted', 'rejected', 'failed', 'cancelled'].includes(record.phase)) record.phase = 'outcome_unknown'
      await this.recoverAdmission(record)
      this.creations.set(record.createOperationId, record)
    }
    for (const record of await this.sessionStore.values<any>()) {
      record.ready = false
      record.state = { sessionId: record.sessionId, runtime: 'pi', externalSessionId: record.nativeSessionId,
        status: record.position?.clean ? 'idle' : 'blocked', statusReason: record.position?.clean ? null : 'pi_position_reconciliation_required',
        selections: { model: record.selectionId || null, permission: record.permission }, metadata: {} }
      const interactions = new Map<string, Interaction>()
      for (const request of record.pendingInteractions ?? []) {
        interactions.set(request.interactionId, { ...request, status: 'cancelled', revision: request.revision + 1 })
      }
      this.sessions.set(record.sessionId, { ...record, items: new Map(), interactions, workerId: undefined })
      if (record.catalog && record.workspaceId) await this.catalogRevisions.seed(record.workspaceId, digest(record.catalog.models), record.catalog.revision)
    }
  }
  private lock(key: string): Mailbox { let lock = this.locks.get(key); if (!lock) this.locks.set(key, lock = new Mailbox()); return lock }
  private async versionCatalog(raw: any): Promise<any> {
    const { catalogFingerprint, ...result } = raw
    const revision = await this.catalogRevisions.observe(result.workspaceId, catalogFingerprint ?? digest(result.catalog.models))
    return { ...result, catalog: { ...result.catalog, revision } }
  }
  private job(work: Promise<unknown>): void { this.jobs.add(work); void work.finally(() => this.jobs.delete(work)).catch(() => undefined) }
  private async savePreparation(value: Preparation): Promise<void> { value.revision++; await this.preparationStore.write(value.preparationId, value) }
  private async saveCreation(value: Creation): Promise<void> { value.revision++; await this.creationStore.write(value.createOperationId, value) }
  private async recoverAdmission(value: Creation): Promise<void> {
    if (value.workerId || value.messageAccepted !== null || !value.clientMessageId || !value.messageFingerprint) return
    const ledger = await new JsonStore(join(this.config.storageRoot, 'worker-state'))
      .read<any>('admission:' + value.sessionId + ':' + value.clientMessageId)
    const receipt = ledger?.receipt
    // Never infer acceptance from transcript text or resend an uncertain prompt.
    // Both the original request fingerprint and the receipt identities must match.
    if (ledger?.fingerprint !== value.messageFingerprint || !receipt
      || receipt.sessionId !== value.sessionId || receipt.clientMessageId !== value.clientMessageId
      || value.nativeSessionId && receipt.externalSessionId !== value.nativeSessionId
      || typeof receipt.messageAccepted !== 'boolean' || typeof receipt.ok !== 'boolean') return
    value.created = receipt.created ?? value.created
    value.messageAccepted = receipt.messageAccepted; value.admissionReceipt = receipt
    value.phase = receipt.messageAccepted ? 'accepted' : 'rejected'
    value.failure = receipt.messageAccepted ? undefined : { code: receipt.code, message: receipt.message }
    await this.saveCreation(value)
  }
  private async saveSession(value: Session): Promise<void> {
    const { items, interactions, workerId, ...binding } = value
    await this.sessionStore.write(value.sessionId, { ...binding, pendingInteractions: [...interactions.values()].filter(request => request.status === 'open') })
  }
  private publicPreparation(value: Preparation): any {
    const { selections, inputDigest, workerId, ...snapshot } = value
    return { ...snapshot, canRespond: !!workerId && value.interactions.some(item => item.status === 'open'), canCancel: ['inspecting', 'awaiting_trust', 'previewing', 'ready'].includes(value.phase), catalogRevision: value.catalog?.revision }
  }
  private publicCreation(value: Creation): any {
    return { createOperationId: value.createOperationId, platformSessionId: value.sessionId, phase: value.phase,
      initializationId: value.initializationId, workerGeneration: value.ownerGeneration, revision: value.revision,
      platformSessionCreated: true, created: value.created, messageAccepted: value.messageAccepted,
      interactions: value.interactions, canRespond: !!value.workerId && value.interactions.some(item => item.status === 'open'),
      canCancelInitialization: !!value.workerId && value.messageAccepted === null,
      admissionReceipt: value.admissionReceipt, failure: value.failure }
  }
  private worker(id?: string): WorkerProxy {
    const worker = id && this.supervisor.workers.get(id)
    requireValue(worker, 'owner_unavailable', '执行进程已离线，旧请求不能继续回答。')
    return worker
  }
  private workerConfig(role: WorkerConfig['role'], scopeId: string, cwd: string): WorkerConfig {
    return { role, scopeId, cwd, workerId: randomUUID(), generation: randomUUID(), runtimeId: this.config.runtimeId,
      agentDir: this.config.agentDir, storageRoot: this.config.storageRoot, python: this.config.python, maxRunMs: this.config.maxRunMs }
  }
  private async notify(method: string, params: Record<string, any>): Promise<void> {
    await this.outbox.append({ method, params: { ...params, runtime: 'pi', runtimeId: this.config.runtimeId } })
  }
  private async event(session: Session | undefined, operation: Creation | undefined, event: WorkerEvent): Promise<void> {
    if (event.kind === 'workerExited' && session) {
      const exit = event.data as WorkerExit
      this.activeRuns.delete(exit.workerId)
      if (exit.expected) return
      session.workerId = undefined; session.ready = false
      for (const request of session.interactions.values()) if (request.ownerGeneration === exit.generation && request.status === 'open') {
        request.status = 'cancelled'; request.revision++
        await this.notify('notice.upsert', this.notice(session, request))
      }
      if (exit.role === 'session') {
        if (session.position) session.position = { ...session.position, clean: false }
        session.state = interruptedExecution(session, exit)
        if (operation) {
          operation.workerId = undefined
          for (const request of operation.interactions) if (request.status === 'open') { request.status = 'cancelled'; request.revision++ }
          await this.recoverAdmission(operation)
          if (operation.messageAccepted === null) operation.phase = 'outcome_unknown'
          await this.saveCreation(operation)
        }
      }
      await this.saveSession(session)
      if (exit.role === 'session') await this.notify('session.state.updated', session.state)
      await this.notify('runtime.capability.updated', this.capabilities(session).capabilitySet)
    } else if (event.kind === 'interaction') {
      const request = event.data as Interaction
      if (request.scope === 'creation' && operation) {
        operation.interactions = [...operation.interactions.filter(item => item.interactionId !== request.interactionId), request]
        if (operation.messageAccepted === null) operation.phase = request.status === 'open' ? 'awaiting_input' : 'initializing'
        await this.saveCreation(operation)
      } else if (session) {
        session.interactions.set(request.interactionId, request)
        await this.saveSession(session)
        await this.notify('notice.upsert', this.notice(session, request))
        await this.notify('runtime.capability.updated', this.capabilities(session).capabilitySet)
      }
    } else if (session && event.kind === 'timeline') {
      session.items.set(event.data.id, event.data)
      if (session.items.size > 2000) session.items.delete(session.items.keys().next().value!)
      await this.notify('timeline.itemUpsert', { sessionId: session.sessionId, externalSessionId: session.nativeSessionId, item: event.data })
    } else if (session && event.kind === 'state') {
      session.state = event.data; await this.saveSession(session)
      await this.notify('session.state.updated', event.data)
      await this.notify('runtime.capability.updated', this.capabilities(session).capabilitySet)
    } else if (session && event.kind === 'nativeCreated') {
      session.nativeSessionId = event.data.nativeSessionId; session.sourcePath = event.data.sourcePath
      if (operation) { operation.created = true; await this.saveCreation(operation) }
      await this.saveSession(session)
      await this.notify('session.meta.upsert', this.meta(session))
    } else if (session && event.kind === 'position') {
      session.position = event.data as Position; await this.saveSession(session)
    } else if (session && event.kind === 'runSettled') {
      if (session.workerId) this.activeRuns.delete(session.workerId)
      await this.notify('runtime.capability.updated', this.capabilities(session).capabilitySet)
    } else if (session && event.kind === 'settled') {
      await this.notify('session.turnEnded', { sessionId: session.sessionId, externalSessionId: session.nativeSessionId,
        outcome: event.data.error ? 'failed' : 'completed', sourceEventId: event.data.sourceEventId })
    } else if (session && (event.kind === 'runFailed' || event.kind === 'requestRejected')) {
      session.state = { ...session.state, status: event.kind === 'requestRejected' ? 'blocked' : 'error', error: event.data }
      if (operation && operation.messageAccepted === true) { operation.phase = 'failed'; operation.failure = event.data; await this.saveCreation(operation) }
      await this.notify('session.state.updated', { ...session.state, sessionId: session.sessionId })
    }
  }
  private onEvent(config: WorkerConfig, session?: Session, creation?: Creation): (event: WorkerEvent) => void {
    const events = session ? this.lock('events:' + session.sessionId) : new Mailbox()
    if (session) this.eventDrains.set(session.sessionId, () => events.run(async () => undefined))
    return event => { this.job(events.run(async () => {
      if (session && !ownsWorker(session, config)) return
      await this.event(session, creation, event)
    }).catch(async error => {
      if (session && ownsWorker(session, config)) { session.state = { status: 'error', error: failure(error) }; await this.saveSession(session); await this.supervisor.workers.get(session.workerId ?? '')?.close() }
    })) }
  }
  private meta(session: Session): Record<string, unknown> { return { sessionId: session.sessionId, externalSessionId: session.nativeSessionId, cwd: session.workspacePath ?? session.cwd, title: session.title,
    metadata: { sourceId: session.sourceId, workspaceId: session.workspaceId, origin: session.readOnly ? 'native-history' : 'managed-sdk', readOnly: !!session.readOnly } } }
  private notice(session: Session, request: Interaction): any {
    return { noticeId: request.interactionId, sessionId: session.sessionId, runtime: 'pi', type: 'interaction', title: request.title,
      message: request.message, severity: 'info', status: request.status === 'open' ? 'open' : 'closed',
      interactionType: request.kind === 'approval' ? 'approval' : 'input_request', responseRequired: request.status === 'open',
      actions: request.actions, context: { purpose: request.purpose }, source: { runtime: 'pi' }, revision: request.revision,
      metadata: { ...request.metadata, ownerGeneration: request.ownerGeneration, requestRevision: request.requestRevision, origin: 'managed_sdk' }, expiresAt: request.expiresAt }
  }
  private async resynchronizeSession(session: Session, limit: number): Promise<any> {
    const ids = await this.lock('events:' + session.sessionId).run(async () => {
      const snapshot = await this.request('getSessionSnapshot', { runtimeId: this.config.runtimeId, sessionNamespace: this.config.sessionNamespace, sessionId: session.sessionId, limit })
      const notifications: Notification[] = [
        { method: 'session.meta.upsert', params: this.meta(session) },
        ...snapshot.items.map((item: any) => ({ method: 'timeline.itemUpsert', params: { sessionId: session.sessionId, externalSessionId: session.nativeSessionId, item } })),
        { method: 'session.state.updated', params: (await this.request('getSessionState', { runtimeId: this.config.runtimeId, sessionNamespace: this.config.sessionNamespace, sessionId: session.sessionId })).state },
        ...[...session.interactions.values()].map(request => ({ method: 'notice.upsert', params: this.notice(session, request) })),
        { method: 'runtime.capability.updated', params: this.capabilities(session).capabilitySet },
      ]
      return this.outbox.appendMany(notifications.map(item => ({ ...item, params: { ...item.params, runtime: 'pi', runtimeId: this.config.runtimeId } })))
    })
    // Network waits stay outside the session transition lane.
    await this.outbox.waitDelivered(ids)
    return { delivered: true }
  }
  async request(method: Method, input: unknown): Promise<any> {
    const params = Methods[method].parse(input) as any
    requireValue(params.runtimeId === this.config.runtimeId && params.sessionNamespace === this.config.sessionNamespace, 'scope_mismatch', 'Runtime 实例或会话命名空间不匹配。')
    if (method === 'initialize') return { identity: { runtime: 'pi', runtimeVersion: '1.4.0', protocolVersion: '1.0' }, generation: this.generation, features: { workspacePreparation: true, asyncCreation: true, approval: true, strictSelectionEnforced: true, orderedSessionSync: true } }
    if (method === 'ping') return { ok: true, generation: this.generation, syncFailure: this.outbox.lastError ?? null, nativeHistoryDiagnostics: this.nativeDiagnostics }
    requireValue(!this.closing, 'runtime_closing', 'Runtime 正在停止。')
    if (method === 'prepareWorkspace') return this.prepare(params)
    if (method === 'refreshPreparation') { const old = this.preparation(params.preparationId); return this.prepare({ ...params, clientPreparationId: old.clientPreparationId, cwd: old.workspacePath ?? old.cwd, projectId: old.projectId }, true) }
    if (method === 'getPreparation') {
      const prep = this.preparation(params.preparationId)
      if (!prep.createOperationId && Date.parse(prep.expiresAt) <= Date.now() && !['expired', 'cancelled', 'failed'].includes(prep.phase)) {
        prep.phase = 'expired'; await this.supervisor.workers.get(prep.workerId ?? '')?.close(); prep.workerId = undefined; prep.interactions = []; await this.savePreparation(prep)
      }
      return this.publicPreparation(prep)
    }
    if (method === 'respondPreparationInteraction') return this.worker(this.preparation(params.preparationId).workerId).request('respond', params)
    if (method === 'cancelPreparation') {
      const prep = this.preparation(params.preparationId)
      requireValue(!prep.createOperationId, 'preparation_consuming', '准备已绑定创建操作。')
      await this.supervisor.workers.get(prep.workerId ?? '')?.close(); prep.phase = 'cancelled'; prep.interactions = []; await this.savePreparation(prep); return this.publicPreparation(prep)
    }
    if (method === 'reservePreparation') return this.reserve(params)
    if (method === 'beginCreateAndStartSession') return this.begin(params)
    if (method === 'getCreationOperation') return this.lock('create:' + params.createOperationId).run(async () => {
      const value = this.creation(params.createOperationId)
      await this.recoverAdmission(value)
      return this.publicCreation(value)
    })
    if (method === 'respondCreationInteraction') return this.worker(this.creation(params.createOperationId).workerId).request('respond', params)
    if (method === 'cancelInitialization') {
      const op = this.creation(params.createOperationId)
      requireValue(op.messageAccepted === null, 'not_cancellable', '消息已经准入，请使用中断。')
      const worker = this.worker(op.workerId)
      const receipt = await worker.request('cancelInitialization')
      op.messageAccepted = receipt.messageAccepted; op.created = receipt.created
      op.phase = receipt.messageAccepted ? 'accepted' : 'cancelled'
      await worker.close(); await this.saveCreation(op); return this.publicCreation(op)
    }
    if (method === 'getInteractionResponse') {
      const scope = this.preparations.get(params.scopeId) ?? this.creations.get(params.scopeId) ?? this.sessions.get(params.scopeId)
      return this.worker(scope?.workerId).request('getReceipt', params)
    }
    if (method === 'listModels') return { catalog: { runtime: 'pi', revision: 0, models: [] } }
    if (method === 'getScopedModelCatalog') {
      if (params.preparationId) return { catalog: this.preparation(params.preparationId).catalog }
      const session = this.session(params.sessionId)
      this.requireOpen(session)
      if (!session.readOnly && (!session.workerId || !this.supervisor.workers.has(session.workerId))) {
        await this.lock('session:' + session.sessionId).run(async () => {
          this.requireOpen(session)
          if (session.workerId && this.supervisor.workers.has(session.workerId)) return
          const config = this.workerConfig('preparation', session.sessionId, session.cwd)
          const worker = this.supervisor.spawn(config, this.onEvent(config, session))
          session.workerId = config.workerId
          try {
            const preview = await this.versionCatalog(await worker.boot())
            this.requireOpen(session)
            session.catalog = preview.catalog
            this.restorePreviews.set(session.sessionId, { resourceFingerprint: preview.resourceFingerprint, trustMode: preview.trustMode, expiresAt: Date.now() + this.config.preparationTtlMs })
            await this.saveSession(session)
          } finally { await worker.close(); session.workerId = undefined }
        })
      }
      return { catalog: session.catalog }
    }
    if (method === 'listSessions') {
      await this.scanNative()
      const all = [...this.sessions.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId))
      const epoch = digest(all.map(session => session.sessionId))
      const cursor = params.cursor ? JSON.parse(Buffer.from(params.cursor, 'base64url').toString()) : { epoch, offset: 0 }
      const offset = cursor.offset
      requireValue(cursor.epoch === epoch && Number.isSafeInteger(offset) && offset >= 0, 'inventory_changed', '目录或游标已变化，请重新读取。')
      return { sessions: all.slice(offset, offset + params.limit).map(session => this.meta(session)), diagnostics: this.nativeDiagnostics, nextCursor: offset + params.limit < all.length ? Buffer.from(JSON.stringify({ epoch, offset: offset + params.limit })).toString('base64url') : null }
    }
    const session = this.session(params.sessionId)
    if (method === 'resynchronizeSession') return this.resynchronizeSession(session, params.limit)
    if (method === 'getSessionState') return { state: session.state ?? { sessionId: session.sessionId, runtime: 'pi', status: 'blocked', statusReason: 'owner_unavailable', selections: { model: session.selectionId, permission: session.permission } } }
    if (method === 'getSessionNotices') return { notices: [...session.interactions.values()].map(value => this.notice(session, value)) }
    if (method === 'getSessionSnapshot') {
      if ((!session.workerId || !this.supervisor.workers.has(session.workerId)) && session.sourcePath) {
        const history = await readNativeHistory(session.sourcePath).catch(error => {
          if (error instanceof RuntimeFailure) throw error
          throw new RuntimeFailure('history_unavailable', error instanceof Error ? error.message : '原生历史无法读取。')
        })
        requireValue(history.header.id === session.nativeSessionId, 'history_source_changed', '原生来源已被替换，不能按旧会话展示。')
        const projector = new Projector(session.sessionId, session.nativeSessionId, new JsonStore(join(this.config.storageRoot, 'worker-state')), () => undefined)
        await projector.restore({ getEntries: () => history.entries })
        session.items = projector.items
      }
      return { sessionId: session.sessionId, items: [...session.items.values()].slice(-params.limit), complete: false }
    }
    if (method === 'getSessionCapabilities') return this.capabilities(session)
    if (method === 'respondInteraction') return this.worker(session.workerId).request('respond', params)
    if (method === 'interruptSession') return this.worker(session.workerId).request('interrupt')
    if (method === 'startTurn') {
      const worker = await this.resolve(session)
      this.requireOpen(session)
      return this.withRun(worker, { content: params.content, clientMessageId: params.clientMessageId, attachments: params.attachments })
    }
    if (method === 'updateSelections') {
      this.requireOpen(session)
      requireValue(!params.selections.permission || ['ask', 'ask_all', 'readonly'].includes(params.selections.permission), 'invalid_permission', '权限选择不在当前目录中。')
      if (!params.selections.model && params.selections.permission && (!session.workerId || !this.supervisor.workers.has(session.workerId))) {
        session.permission = params.selections.permission; await this.saveSession(session); return { ok: true }
      }
      params.selections.model ??= session.selectionId
      requireValue(params.selections.model, 'selection_required', '请选择模型。')
      const online = session.workerId && this.supervisor.workers.has(session.workerId)
      let worker: WorkerProxy
      if (!online) {
        const preview = this.restorePreviews.get(session.sessionId)
        requireValue(preview && preview.expiresAt > Date.now(), 'preparation_stale', '请刷新会话模型目录后再选择。')
        session.selectionId = params.selections.model
        if (params.selections.permission) session.permission = params.selections.permission
        worker = await this.resolve(session, preview)
        this.restorePreviews.delete(session.sessionId)
      } else worker = this.worker(session.workerId)
      const result = await worker.request('select', { selectionId: params.selections.model, permission: params.selections.permission })
      session.selectionId = params.selections.model
      if (params.selections.permission) session.permission = params.selections.permission
      await this.saveSession(session); return result
    }
    if (method === 'getSessionTree') return this.tree(session, params)
    if (method === 'selectExecutionPosition') return this.selectPosition(session, params)
    if (method === 'closeSession') return this.closeSession(session, params.ownerGeneration)
    throw new RuntimeFailure('unsupported_operation', '此能力尚未实现。')
  }
  private preparation(id: string): Preparation { const value = this.preparations.get(id); requireValue(value, 'preparation_not_found', '准备操作不存在。'); return value }
  private creation(id: string): Creation { const value = this.creations.get(id); requireValue(value, 'operation_not_found', '创建操作不存在。'); return value }
  private session(id: string): Session { const value = this.sessions.get(id); requireValue(value, 'session_not_found', '会话不存在。'); return value }
  private requireOpen(session: Session): void {
    requireValue(!this.sessionClosures.has(session.sessionId), 'session_closing', '会话正在关闭，请等待关闭完成。')
  }
  private async closeSession(session: Session, ownerGeneration: string): Promise<any> {
    requireValue(ownerGeneration === session.ownerGeneration, 'owner_changed', '执行者已变化。')
    const pending = this.sessionClosures.get(session.sessionId)
    if (pending) return pending
    if (!session.workerId || !this.supervisor.workers.has(session.workerId)) return { ok: true, alreadyClosed: true }
    const workerId = session.workerId, worker = this.worker(workerId)
    const drain = this.eventDrains.get(session.sessionId)
    const work = (async () => {
      try {
        await worker.close(); await drain?.()
        requireValue(session.workerId === workerId && session.ownerGeneration === ownerGeneration, 'owner_changed', '关闭期间执行者已变化。')
        if (this.eventDrains.get(session.sessionId) === drain) this.eventDrains.delete(session.sessionId)
        session.workerId = undefined; session.ready = false
        await this.saveSession(session)
        return { ok: true }
      } finally {
        this.sessionClosures.delete(session.sessionId)
        await this.notify('runtime.capability.updated', this.capabilities(session).capabilitySet)
      }
    })()
    this.sessionClosures.set(session.sessionId, work)
    return work
  }
  private async prepare(params: any, refresh = false): Promise<any> {
    return this.lock('prep:' + params.preparationId).run(async () => {
      const fingerprint = digest({ clientPreparationId: params.clientPreparationId, cwd: params.cwd, projectId: params.projectId })
      const old = this.preparations.get(params.preparationId)
      if (old && refresh) {
        requireValue(!old.createOperationId && old.revision === params.expectedRevision, 'preparation_conflict', '准备状态已变化。')
        await this.supervisor.workers.get(old.workerId ?? '')?.close()
      }
      if (old && !refresh) { requireValue(old.inputDigest === fingerprint, 'operation_conflict', '准备身份与内容不一致。'); return this.publicPreparation(old) }
      const cwd = await realpath(params.cwd)
      const value: Preparation = { preparationId: params.preparationId, clientPreparationId: params.clientPreparationId, cwd, workspacePath: params.cwd,
        inputDigest: fingerprint, projectId: params.projectId, phase: 'inspecting', revision: old?.revision ?? 0, expiresAt: new Date(Date.now() + this.config.preparationTtlMs).toISOString(), interactions: [] }
      this.preparations.set(value.preparationId, value); await this.savePreparation(value)
      let worker: WorkerProxy
      try { worker = this.supervisor.spawn(this.workerConfig('preparation', value.preparationId, cwd), event => {
        if (event.kind === 'interaction') { const request = event.data as Interaction; value.interactions = [...value.interactions.filter(item => item.interactionId !== request.interactionId), request]; value.phase = request.status === 'open' ? 'awaiting_trust' : 'previewing'; this.job(this.savePreparation(value)) }
      })
      } catch (error) { value.phase = 'failed'; value.failure = failure(error); await this.savePreparation(value); return this.publicPreparation(value) }
      value.workerId = worker.config.workerId
      this.job(worker.boot().then(async raw => {
        const result = await this.versionCatalog(raw)
        await worker.close()
        if (['cancelled', 'expired'].includes(value.phase)) return
        Object.assign(value, result, { phase: 'ready', workerId: undefined, interactions: [] })
        await this.savePreparation(value)
      }).catch(async error => { if (['cancelled', 'expired'].includes(value.phase)) return; value.phase = 'failed'; value.failure = failure(error); await worker.close(); await this.savePreparation(value) }))
      return this.publicPreparation(value)
    })
  }
  private async reserve(params: any): Promise<any> {
    return this.lock('prep:' + params.preparationId).run(async () => {
      const prep = this.preparations.get(params.preparationId)
      const decision = decideReservation(prep, params, Date.now())
      if (!decision.reserved) return decision
      requireValue(prep, 'preparation_not_found', '准备操作不存在。')
      if (prep.createOperationId) return decision
      prep.createOperationId = params.createOperationId; prep.platformSessionId = params.platformSessionId; prep.reservedSelections = params.selections; prep.phase = 'consuming'
      await this.savePreparation(prep)
      return { reserved: true }
    })
  }
  private async begin(params: any): Promise<any> {
    return this.lock('create:' + params.createOperationId).run(async () => {
      const fingerprint = digest(params)
      const old = this.creations.get(params.createOperationId)
      if (old) { requireValue(old.inputDigest === fingerprint, 'operation_conflict', '创建身份与内容不一致。'); return this.publicCreation(old) }
      const prep = this.preparation(params.preparationId)
      requireValue(prep.createOperationId === params.createOperationId && prep.platformSessionId === params.sessionId, 'preparation_not_reserved', '准备尚未绑定该会话。')
      requireValue(digest(params.selections) === digest(prep.reservedSelections), 'selection_conflict', '创建选择与准备预留不一致。')
      requireValue(!params.attachments.length, 'attachments_unsupported', '此 Runtime 尚未启用附件交付。')
      const config = this.workerConfig('session', params.createOperationId, prep.cwd)
      config.trustMode = prep.trustMode; config.expectedResourceFingerprint = prep.resourceFingerprint; config.selectionId = params.selections.model; config.permission = params.selections.permission ?? 'ask'
      config.sessionId = params.sessionId; config.nativeSessionId = randomUUID()
      const op: Creation = { createOperationId: params.createOperationId, sessionId: params.sessionId, inputDigest: fingerprint,
        phase: 'initializing', revision: 0, initializationId: randomUUID(), ownerGeneration: config.generation,
        clientMessageId: params.clientMessageId, nativeSessionId: config.nativeSessionId,
        messageFingerprint: digest({ content: params.content, clientMessageId: params.clientMessageId, attachments: params.attachments }),
        created: null, messageAccepted: null, interactions: [], workerId: config.workerId }
      const session: Session = { sessionId: params.sessionId, nativeSessionId: config.nativeSessionId, cwd: prep.cwd, workspacePath: prep.workspacePath,
        sourceId: digest([this.config.sessionNamespace, params.sessionId, config.nativeSessionId]), workspaceId: prep.workspaceId!,
        selectionId: params.selections.model, permission: config.permission!, trustMode: prep.trustMode!,
        catalog: prep.catalog, ownerGeneration: config.generation, items: new Map(), interactions: new Map(), workerId: config.workerId, title: params.title }
      this.creations.set(op.createOperationId, op); this.sessions.set(session.sessionId, session)
      await this.saveCreation(op); await this.saveSession(session)
      let worker: WorkerProxy
      try { worker = this.supervisor.spawn(config, this.onEvent(config, session, op)) }
      catch (error) {
        op.phase = 'failed'; op.created = false; op.messageAccepted = false; op.failure = failure(error)
        session.workerId = undefined; session.state = { sessionId: session.sessionId, runtime: 'pi', status: 'blocked', error: op.failure }
        await this.saveCreation(op); await this.saveSession(session)
        await this.notify('session.state.updated', session.state)
        return this.publicCreation(op)
      }
      let promptAttempted = false
      this.job(worker.boot().then(async raw => {
        const result = await this.versionCatalog(raw)
        await this.eventDrains.get(session.sessionId)?.()
        if (op.phase === 'cancelled') return
        requireValue(ownsWorker(session, config) && this.supervisor.workers.has(config.workerId), 'owner_unavailable', '执行者已离线。')
        session.ready = true
        requireValue(result.resourceFingerprint === prep.resourceFingerprint && result.catalog.revision === prep.catalog.revision, 'preparation_stale', '资源在正式装配时发生变化。')
        session.catalog = result.catalog; session.sourcePath = result.sourcePath; await this.saveSession(session)
        op.phase = 'starting'; await this.saveCreation(op)
        promptAttempted = true
        const receipt = await this.withRun(worker, { content: params.content, clientMessageId: params.clientMessageId, attachments: params.attachments })
        op.created = receipt.created ?? true; op.messageAccepted = receipt.messageAccepted ?? null; op.admissionReceipt = receipt
        op.phase = receipt.ok ? (session.state?.error ? 'failed' : 'accepted') : 'rejected'
        if (!receipt.ok) op.failure = { code: receipt.code, message: receipt.message }
        else if (session.state?.error) op.failure = session.state.error
        prep.phase = 'consumed'; await this.savePreparation(prep); await this.saveCreation(op)
      }).catch(async error => {
        if (op.phase === 'cancelled') return
        op.phase = promptAttempted && op.messageAccepted === null ? 'outcome_unknown' : 'failed'; op.failure = failure(error)
        if (op.messageAccepted === null && !promptAttempted) op.messageAccepted = false
        await worker.close(); await this.eventDrains.get(session.sessionId)?.(); await this.saveCreation(op)
        if (session.ownerGeneration !== config.generation) return
        session.state = { ...session.state, sessionId: session.sessionId, runtime: 'pi', status: 'blocked', statusReason: 'pi_position_reconciliation_required', error: op.failure }
        await this.saveSession(session); await this.notify('session.state.updated', session.state)
      }))
      return this.publicCreation(op)
    })
  }
  private async withRun(worker: WorkerProxy, params: any): Promise<any> {
    requireValue(!this.activeRuns.has(worker.config.workerId), 'session_busy', '该会话正在运行。')
    requireValue(this.activeRuns.size < this.config.maxConcurrentRuns, 'run_capacity', '并行运行已达到上限。')
    this.activeRuns.add(worker.config.workerId)
    void worker.exited.then(() => this.activeRuns.delete(worker.config.workerId))
    try {
      const result = await worker.request('prompt', params, this.config.maxRunMs)
      if (result.messageAccepted === false) this.activeRuns.delete(worker.config.workerId)
      return result
    } catch (error) {
      if (!(error instanceof RuntimeFailure) || !['outcome_unknown', 'worker_exited'].includes(error.code)) this.activeRuns.delete(worker.config.workerId)
      throw error
    }
  }
  private async resolve(session: Session, authorization?: { resourceFingerprint: string; trustMode: string }): Promise<WorkerProxy> {
    this.requireOpen(session)
    requireValue(!session.readOnly, 'native_attach_required', '该原生会话仅供浏览，需要协作 Bridge 才能接管执行。')
    if (session.workerId && this.supervisor.workers.has(session.workerId)) { requireValue(session.ready, 'runtime_initializing', '会话仍在初始化，请先处理当前交互。'); return this.worker(session.workerId) }
    return this.lock('session:' + session.sessionId).run(async () => {
      this.requireOpen(session)
      if (session.workerId && this.supervisor.workers.has(session.workerId)) { requireValue(session.ready, 'runtime_initializing', '会话仍在初始化，请先处理当前交互。'); return this.worker(session.workerId) }
      requireValue(session.position?.clean, 'pi_position_reconciliation_required', '会话关闭状态需要确认，请先选择继续位置。')
      const config = this.workerConfig('session', session.sessionId, session.cwd)
      const preview = authorization ?? this.restorePreviews.get(session.sessionId)
      if (preview && 'expiresAt' in preview) requireValue(Number(preview.expiresAt) > Date.now(), 'preparation_stale', '恢复准备已过期，请刷新模型目录。')
      Object.assign(config, { sessionId: session.sessionId, nativeSessionId: session.nativeSessionId, sourcePath: session.sourcePath,
        position: session.position, selectionId: session.selectionId, permission: session.permission,
        ...(preview ? { authorizeSelection: !!authorization, expectedResourceFingerprint: preview.resourceFingerprint, trustMode: preview.trustMode }
          : session.trustMode === 'basic' ? { trustMode: 'basic' } : {}) })
      const worker = this.supervisor.spawn(config, this.onEvent(config, session))
      session.workerId = config.workerId; session.ownerGeneration = config.generation
      try { const result = await this.versionCatalog(await worker.boot()); this.requireOpen(session); session.catalog = result.catalog; session.ready = true; await this.eventDrains.get(session.sessionId)?.(); this.restorePreviews.delete(session.sessionId); await this.saveSession(session); return worker }
      catch (error) { await worker.close(); throw error }
    })
  }
  private capabilities(session: Session): any {
    const closing = this.sessionClosures.has(session.sessionId)
    const online = !!session.workerId && this.supervisor.workers.has(session.workerId)
    const busy = !!session.workerId && this.activeRuns.has(session.workerId)
    const pending = [...session.interactions.values()].some(item => item.status === 'open')
    const availability: Record<string, boolean> = {
      'session.send_message': !closing && ['idle', 'error'].includes(session.state?.status ?? 'idle') && !session.readOnly && !busy && !pending && (online ? !!session.ready : !!session.position?.clean),
      'session.interrupt': online && busy,
      'session.close': online && !session.readOnly && this.supervisor.workers.get(session.workerId!)?.config.role === 'session',
      'session.interaction.approval': online && pending,
      'catalog.model': true, 'catalog.permission': true,
      'session.execution_position.read': true,
      'session.execution_position.select': !closing && !session.readOnly && !online,
    }
    return { capabilitySet: { runtime: 'pi', runtimeId: this.config.runtimeId, scope: 'session', sessionId: session.sessionId,
      revision: Date.now(), capabilities: Object.entries(availability).map(([capabilityId, available]) => ({
        capabilityId, scope: 'session', sessionId: session.sessionId, runtime: 'pi', runtimeId: this.config.runtimeId, supported: true, available,
        allowed: !session.readOnly || capabilityId === 'session.execution_position.read' || capabilityId.startsWith('catalog.'),
        ...(!available ? { unavailableReason: session.readOnly ? 'native_attach_required' : online ? 'session_busy' : 'owner_unavailable' } : {}),
        metadata: { strict_selection_enforced: !session.readOnly },
      })) } }
  }
  private async scanNative(): Promise<void> {
    const diagnostics: typeof this.nativeDiagnostics = []
    const report = (path: string, error: unknown) => { diagnostics.push({ path, ...failure(error) }) }
    const files = await nativeFiles([join(this.config.storageRoot, 'sessions'), join(this.config.agentDir, 'sessions')], report)
    const knownSources = new Set<string>()
    for (const session of this.sessions.values()) if (session.sourcePath) {
      try { knownSources.add(await realpath(session.sourcePath)) }
      catch (error) { report(session.sourcePath, error) }
    }
    for (const path of files) {
      if (knownSources.has(path)) continue
      let header: any
      try { header = await readNativeHeader(path) }
      catch (error) { report(path, error); continue }
      const sourceId = digest(path)
      const sessionId = 'sess_' + digest([this.config.sessionNamespace, sourceId, header.id]).slice(0, 40)
      if (this.sessions.has(sessionId)) continue
      const session: Session = { sessionId, nativeSessionId: header.id, sourcePath: path, cwd: header.cwd,
        workspaceId: digest([this.config.runtimeId, header.cwd]), sourceId, selectionId: '', permission: 'readonly',
        trustMode: 'basic', catalog: { runtime: 'pi', revision: 0, models: [] }, ownerGeneration: this.generation,
        items: new Map(), interactions: new Map(), readOnly: true,
        state: { sessionId, runtime: 'pi', status: 'blocked', statusReason: 'native_attach_required', selections: {} } }
      this.sessions.set(sessionId, session); await this.saveSession(session)
    }
    this.nativeDiagnostics = diagnostics
  }
  private async tree(session: Session, params: any): Promise<any> {
    const entries = session.sourcePath ? (await readFile(session.sourcePath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
    const epoch = digest(entries[0] ?? { id: session.nativeSessionId })
    const fileEntriesDigest = digest(entries.slice(1))
    const cursor = params.cursor ? JSON.parse(Buffer.from(params.cursor, 'base64url').toString()) : { epoch, fileEntriesDigest, offset: 0 }
    requireValue(cursor.epoch === epoch && cursor.fileEntriesDigest === fileEntriesDigest, 'source_changed', '原生历史已变化，请重新读取。')
    const offset = cursor.offset
    requireValue(Number.isSafeInteger(offset) && offset >= 0, 'invalid_cursor', '位置分页游标无效。')
    return { sourceEpoch: epoch, fileEntriesDigest, positionRevision: session.position?.positionRevision ?? 0, leafId: session.position?.leafId,
      entries: entries.slice(1 + offset, 1 + offset + (params.limit ?? 100)), nextCursor: offset + (params.limit ?? 100) < entries.length - 1 ? Buffer.from(JSON.stringify({ epoch, fileEntriesDigest, offset: offset + params.limit })).toString('base64url') : null }
  }
  private async selectPosition(session: Session, params: any): Promise<any> {
    return this.lock('session:' + session.sessionId).run(async () => {
      this.requireOpen(session)
      await this.eventDrains.get(session.sessionId)?.()
      requireValue(!session.readOnly, 'native_attach_required', '原生历史仅供浏览，不能接管执行。')
      requireValue(!session.workerId || !this.supervisor.workers.has(session.workerId), 'session_busy', '请先关闭执行进程再选择位置。')
      const tree = await this.tree(session, { limit: 500 })
      requireValue(tree.sourceEpoch === params.sourceEpoch && tree.fileEntriesDigest === params.fileEntriesDigest && (session.position?.positionRevision ?? 0) === params.positionRevision, 'position_conflict', '原生历史或位置已变化。')
      // A read-only tree can be loaded without importing SDK into this Host.
      const entries = (await readFile(session.sourcePath!, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
      requireValue(digest(entries[0]) === params.sourceEpoch && digest(entries.slice(1)) === params.fileEntriesDigest, 'position_conflict', '原生历史在选择期间发生变化。')
      const byId = new Map<string, any>(entries.slice(1).map(entry => [entry.id, entry]))
      const branch: any[] = []; let id = params.leafId
      while (id !== null) { const entry = byId.get(id); requireValue(entry && !branch.includes(entry), 'invalid_position', '位置不存在或分支有循环。'); branch.unshift(entry); id = entry.parentId }
      session.position = { piSessionId: session.nativeSessionId, sourceEpoch: tree.sourceEpoch, leafId: params.leafId,
        anchorDigest: digest(branch), positionRevision: params.positionRevision + 1, branchGeneration: randomUUID(),
        ownerGeneration: this.generation, fileEntriesDigest: digest(entries.slice(1)), clean: true }
      session.workerId = undefined; session.ready = false
      for (const request of session.interactions.values()) if (request.status === 'open') {
        request.status = 'cancelled'; request.revision++
        await this.notify('notice.upsert', this.notice(session, request))
      }
      session.state = { sessionId: session.sessionId, runtime: 'pi', externalSessionId: session.nativeSessionId,
        status: 'idle', statusReason: null, error: null,
        selections: { model: session.selectionId, permission: session.permission }, metadata: {} }
      await this.saveSession(session)
      await this.notify('session.state.updated', session.state)
      await this.notify('runtime.capability.updated', this.capabilities(session).capabilitySet)
      return { ok: true, position: session.position }
    })
  }
  async stop(): Promise<void> { this.closing = true; await this.supervisor.stop(); await Promise.allSettled([...this.jobs]); await this.outbox.stop() }
}
