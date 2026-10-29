import { AA_ACP_PROTOCOL } from '../application/protocol.js'
import { EXECUTION_GUARANTEES } from '../domain/sessions.js'

const id = { type: 'string', minLength: 1, maxLength: 160 }
const object = (required: string[], properties: Record<string, unknown>, additionalProperties = false) => ({ type: 'object', required, properties, additionalProperties })

export const aaAcpSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:agents-anywhere:acp-runtime:1.1',
  $defs: {
    capabilities: object(['protocolVersion', 'guarantees', 'capabilities'], { protocolVersion: { const: AA_ACP_PROTOCOL },
      guarantees: { type: 'array', uniqueItems: true, items: { enum: EXECUTION_GUARANTEES } },
      capabilities: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } } }),
    prepareRequest: object(['cwd'], { preparationId: id, cwd: { type: 'string', minLength: 1, maxLength: 4096 } }),
    prepareResult: object(['sessionId', 'deferred', 'ticket', 'configOptions', 'resourceFingerprint', 'trustMode'], {
      sessionId: id, deferred: { const: true }, ticket: id, configOptions: { type: 'array' },
      resourceFingerprint: { type: 'string', pattern: '^[a-f0-9]{64}$' }, trustMode: { enum: ['basic', 'once', 'persistent'] },
    }),
    newSessionMetadata: object(['preparationId', 'platformSessionId', 'ownerGeneration'], {
      preparationId: id, platformSessionId: id, ownerGeneration: id, selectionId: id,
    }),
    promptMetadata: object(['clientMessageId'], { clientMessageId: id }),
    commandRequest: object(['sessionId', 'command'], { sessionId: id, command: id,
      raw: { type: ['string', 'null'] }, args: { type: 'array', items: { type: 'string' } } }),
    operationUpdate: object(['agentSessionId', 'sessionId', 'clientMessageId', 'ownerGeneration', 'messageAccepted'], {
      agentSessionId: id, sessionId: id, externalSessionId: id, clientMessageId: id, ownerGeneration: id,
      messageAccepted: { type: 'boolean' }, ok: { type: 'boolean' }, created: { type: 'boolean' },
      disposition: { type: 'string' }, code: { type: 'string' }, message: { type: 'string' },
    }),
    operationQuery: object(['sessionId', 'clientMessageId'], { sessionId: id, clientMessageId: id }),
    position: object(['piSessionId', 'sourceEpoch', 'leafId', 'anchorDigest', 'positionRevision', 'branchGeneration', 'ownerGeneration', 'fileEntriesDigest', 'clean'], {
      piSessionId: id, sourceEpoch: id, leafId: { type: ['string', 'null'] }, anchorDigest: id,
      positionRevision: { type: 'integer', minimum: 0 }, branchGeneration: id, ownerGeneration: id,
      fileEntriesDigest: id, clean: { type: 'boolean' },
    }),
  },
}
