import { z } from 'zod'

export const PI_BRIDGE = 'aa.pi.v1.Bridge'
export const PI_SYNC = 'aa.pi.v1.Sync'
export const PI_NATIVE = 'aa.pi.v1.NativeAttach'
export const BRIDGE_PROTOCOL = '1.0'
const text = z.string().min(1).max(4096)
const id = z.string().min(1).max(160)
const cursor = z.string().min(1).max(1024)
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const json = z.record(z.string(), z.json())
export const Scope = z.object({ runtimeId: id, sessionNamespace: z.string().min(1).max(1024) }).strict()
export const SessionRequest = Scope.extend({ sessionId: id, externalSessionId: id.optional() }).strict()
export { DialogResult } from '@agents-anywhere/pi-execution/dialog-result'
export const InteractionResponse = z.object({
  interactionId: id, requestRevision: revision, ownerGeneration: id,
  responseOperationId: id, actionId: id, input: z.json().optional(),
}).strict()
const preparation = Scope.extend({ preparationId: id }).strict()
const creation = Scope.extend({ createOperationId: id }).strict()
export const Methods = {
  initialize: Scope.extend({ protocolVersion: z.literal(BRIDGE_PROTOCOL) }).strict(),
  ping: Scope,
  prepareWorkspace: Scope.extend({ preparationId: id, clientPreparationId: id, cwd: text, projectId: id.optional() }).strict(),
  getPreparation: preparation,
  refreshPreparation: preparation.extend({ expectedRevision: revision }).strict(),
  cancelPreparation: preparation,
  respondPreparationInteraction: preparation.extend(InteractionResponse.shape).strict(),
  reservePreparation: preparation.extend({ createOperationId: id, platformSessionId: id, expectedRevision: revision, catalogRevision: revision, selections: z.record(z.string(), z.string().nullable()) }).strict(),
  beginCreateAndStartSession: creation.extend({ preparationId: id, sessionId: id, content: z.string().max(1_000_000), clientMessageId: id, title: text.optional(), selections: z.record(z.string(), z.string().nullable()), attachments: z.array(json).max(32).default([]) }).strict(),
  getCreationOperation: creation,
  respondCreationInteraction: creation.extend(InteractionResponse.shape).strict(),
  cancelInitialization: creation.extend({ cancelOperationId: id }).strict(),
  listModels: Scope.extend({ limit: z.number().int().min(1).max(1000).default(100) }).strict(),
  getScopedModelCatalog: z.union([Scope.extend({ preparationId: id }).strict(), Scope.extend({ sessionId: id }).strict()]),
  listSessions: Scope.extend({ limit: z.number().int().min(1).max(1000).default(100), cursor: cursor.optional() }).strict(),
  getSessionState: SessionRequest,
  getSessionSnapshot: SessionRequest.extend({ limit: z.number().int().min(1).max(1000).default(100), cursor: cursor.optional() }).strict(),
  resynchronizeSession: SessionRequest.extend({ limit: z.number().int().min(1).max(1000).default(1000) }).strict(),
  getSessionNotices: SessionRequest,
  getSessionCapabilities: SessionRequest,
  startTurn: SessionRequest.extend({ content: z.string().max(1_000_000), clientMessageId: id, attachments: z.array(json).max(32).default([]) }).strict(),
  steerTurn: SessionRequest.extend({ content: text, clientMessageId: id }).strict(),
  interruptSession: SessionRequest,
  updateSelections: SessionRequest.extend({ selections: z.record(z.string(), z.string().nullable()) }).strict(),
  respondInteraction: SessionRequest.extend(InteractionResponse.shape).strict(),
  getInteractionResponse: Scope.extend({ scopeId: id, responseOperationId: id }).strict(),
  getSessionTree: SessionRequest.extend({ cursor: cursor.optional(), limit: z.number().int().min(1).max(500).default(100) }).strict(),
  selectExecutionPosition: SessionRequest.extend({ sourceEpoch: id, fileEntriesDigest: id, positionRevision: revision, leafId: id.nullable() }).strict(),
  closeSession: SessionRequest.extend({ closeOperationId: id, ownerGeneration: id }).strict(),
} as const
export type Method = keyof typeof Methods
export type BridgeRequest<M extends Method = Method> = z.infer<(typeof Methods)[M]>
export const Payload = z.record(z.string(), z.json()).meta({ id: 'PiBridgePayload' })
export type Payload = z.infer<typeof Payload>
export const SyncBatch = z.object({ runtimeId: id, sessionNamespace: z.string().min(1).max(1024), batchId: id, notifications: z.array(z.object({ method: id, params: json }).strict()).min(1).max(256) }).strict().meta({ id: 'PiSyncBatch' })

/** Python MeshCall uses the method parameter name as an envelope. */
export const SyncRequest = z.object({ batch: SyncBatch }).strict()
