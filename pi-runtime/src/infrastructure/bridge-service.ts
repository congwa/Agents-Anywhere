import { service, query, mutates, MeshCallError } from 'meshcall'
import { PI_BRIDGE, Methods, Payload, type Method } from '../contracts/protocol.js'
import { failure } from '../domain/shared.js'
import type { PiHost } from '../application/host.js'

@service(PI_BRIDGE, { description: 'Agents Anywhere pi Runtime control host' })
export class PiBridgeService {
  constructor(private readonly host: PiHost) {}
  private async call(method: Method, request: unknown): Promise<Payload> {
    try { return JSON.parse(JSON.stringify(await this.host.request(method, request))) as Payload }
    catch (error) { const result = failure(error); throw new MeshCallError(result.code, result.message) }
  }
  @query({ description: "pi Runtime initialize", request: Methods.initialize, response: Payload })
  initialize(request: unknown): Promise<Payload> { return this.call('initialize', request) }
  @query({ description: "pi Runtime ping", request: Methods.ping, response: Payload })
  ping(request: unknown): Promise<Payload> { return this.call('ping', request) }
  @mutates({ description: "pi Runtime prepareWorkspace", request: Methods.prepareWorkspace, response: Payload })
  prepareWorkspace(request: unknown): Promise<Payload> { return this.call('prepareWorkspace', request) }
  @query({ description: "pi Runtime getPreparation", request: Methods.getPreparation, response: Payload })
  getPreparation(request: unknown): Promise<Payload> { return this.call('getPreparation', request) }
  @mutates({ description: "pi Runtime refreshPreparation", request: Methods.refreshPreparation, response: Payload })
  refreshPreparation(request: unknown): Promise<Payload> { return this.call('refreshPreparation', request) }
  @mutates({ description: "pi Runtime cancelPreparation", request: Methods.cancelPreparation, response: Payload })
  cancelPreparation(request: unknown): Promise<Payload> { return this.call('cancelPreparation', request) }
  @mutates({ description: "pi Runtime respondPreparationInteraction", request: Methods.respondPreparationInteraction, response: Payload })
  respondPreparationInteraction(request: unknown): Promise<Payload> { return this.call('respondPreparationInteraction', request) }
  @mutates({ description: "pi Runtime reservePreparation", request: Methods.reservePreparation, response: Payload })
  reservePreparation(request: unknown): Promise<Payload> { return this.call('reservePreparation', request) }
  @mutates({ description: "pi Runtime beginCreateAndStartSession", request: Methods.beginCreateAndStartSession, response: Payload })
  beginCreateAndStartSession(request: unknown): Promise<Payload> { return this.call('beginCreateAndStartSession', request) }
  @query({ description: "pi Runtime getCreationOperation", request: Methods.getCreationOperation, response: Payload })
  getCreationOperation(request: unknown): Promise<Payload> { return this.call('getCreationOperation', request) }
  @mutates({ description: "pi Runtime respondCreationInteraction", request: Methods.respondCreationInteraction, response: Payload })
  respondCreationInteraction(request: unknown): Promise<Payload> { return this.call('respondCreationInteraction', request) }
  @mutates({ description: "pi Runtime cancelInitialization", request: Methods.cancelInitialization, response: Payload })
  cancelInitialization(request: unknown): Promise<Payload> { return this.call('cancelInitialization', request) }
  @query({ description: "pi Runtime listModels", request: Methods.listModels, response: Payload })
  listModels(request: unknown): Promise<Payload> { return this.call('listModels', request) }
  @query({ description: "pi Runtime getScopedModelCatalog", request: Methods.getScopedModelCatalog, response: Payload })
  getScopedModelCatalog(request: unknown): Promise<Payload> { return this.call('getScopedModelCatalog', request) }
  @query({ description: "pi Runtime listSessions", request: Methods.listSessions, response: Payload })
  listSessions(request: unknown): Promise<Payload> { return this.call('listSessions', request) }
  @query({ description: "pi Runtime getSessionState", request: Methods.getSessionState, response: Payload })
  getSessionState(request: unknown): Promise<Payload> { return this.call('getSessionState', request) }
  @query({ description: "pi Runtime getSessionSnapshot", request: Methods.getSessionSnapshot, response: Payload })
  getSessionSnapshot(request: unknown): Promise<Payload> { return this.call('getSessionSnapshot', request) }
  @mutates({ description: 'Capture and deliver ordered pi session observations', request: Methods.resynchronizeSession, response: Payload })
  resynchronizeSession(request: unknown): Promise<Payload> { return this.call('resynchronizeSession', request) }
  @query({ description: "pi Runtime getSessionNotices", request: Methods.getSessionNotices, response: Payload })
  getSessionNotices(request: unknown): Promise<Payload> { return this.call('getSessionNotices', request) }
  @query({ description: "pi Runtime getSessionCapabilities", request: Methods.getSessionCapabilities, response: Payload })
  getSessionCapabilities(request: unknown): Promise<Payload> { return this.call('getSessionCapabilities', request) }
  @mutates({ description: "pi Runtime startTurn", request: Methods.startTurn, response: Payload })
  startTurn(request: unknown): Promise<Payload> { return this.call('startTurn', request) }
  @mutates({ description: "pi Runtime steerTurn", request: Methods.steerTurn, response: Payload })
  steerTurn(request: unknown): Promise<Payload> { return this.call('steerTurn', request) }
  @mutates({ description: "pi Runtime interruptSession", request: Methods.interruptSession, response: Payload })
  interruptSession(request: unknown): Promise<Payload> { return this.call('interruptSession', request) }
  @mutates({ description: "pi Runtime updateSelections", request: Methods.updateSelections, response: Payload })
  updateSelections(request: unknown): Promise<Payload> { return this.call('updateSelections', request) }
  @mutates({ description: "pi Runtime respondInteraction", request: Methods.respondInteraction, response: Payload })
  respondInteraction(request: unknown): Promise<Payload> { return this.call('respondInteraction', request) }
  @query({ description: "pi Runtime getInteractionResponse", request: Methods.getInteractionResponse, response: Payload })
  getInteractionResponse(request: unknown): Promise<Payload> { return this.call('getInteractionResponse', request) }
  @query({ description: "pi Runtime getSessionTree", request: Methods.getSessionTree, response: Payload })
  getSessionTree(request: unknown): Promise<Payload> { return this.call('getSessionTree', request) }
  @mutates({ description: "pi Runtime selectExecutionPosition", request: Methods.selectExecutionPosition, response: Payload })
  selectExecutionPosition(request: unknown): Promise<Payload> { return this.call('selectExecutionPosition', request) }
  @mutates({ description: "pi Runtime closeSession", request: Methods.closeSession, response: Payload })
  closeSession(request: unknown): Promise<Payload> { return this.call('closeSession', request) }
}
