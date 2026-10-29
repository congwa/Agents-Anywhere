import type { SessionRecord } from '../domain/sessions.js'

export type AgentEvent = { kind: string; data: Record<string, any> }
export type ExecutionContext = { role: 'preparation' | 'session'; session: SessionRecord }

export interface ExecutionPort {
  boot(): Promise<any>;
  request(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<any>;
  close(): Promise<void>;
}
export interface ExecutionFactory {
  create(context: ExecutionContext, publish: (event: AgentEvent) => void): ExecutionPort;
}
export interface CoordinationStore {
  read<T>(key: string): Promise<T | undefined>;
  write(key: string, value: unknown): Promise<void>;
  values<T>(): Promise<T[]>;
}
export interface AcpTransport {
  update(sessionId: string, update: Record<string, unknown>): Promise<void>;
  permission(params: Record<string, unknown>): Promise<any>;
  form(params: Record<string, unknown>): Promise<any>;
  notify(method: string, params: Record<string, unknown>): Promise<void>;
}
export type ApplicationSettings = { maxRunMs: number }

/** The application consumes capabilities, never Pi SDK or OpenMA objects. */
export interface AgentCapabilityPort extends ExecutionFactory {
  readonly descriptor: { name: string; promptCapabilities: Record<string, boolean>; guarantees: readonly string[]; capabilities: readonly string[] };
  commands(): Record<string, any>[];
  executeCommand(worker: ExecutionPort, params: Record<string, any>): Promise<Record<string, any>>;
  initializeSession(session: SessionRecord, metadata: Record<string, any>): void;
  configure(session: SessionRecord, worker: ExecutionPort, key: string, value: string | boolean): Promise<void>;
  configuration(session: SessionRecord): Record<string, any>[];
  prompt(blocks: unknown[]): { text: string; images: unknown[] };
  replay(entries: unknown[], cwd: string): Record<string, any>[];
  receipt(session: SessionRecord, messageId: string): Promise<unknown>;
  selectPosition(session: SessionRecord, request: Record<string, any>): Promise<Record<string, unknown>>;
  tool(item: Record<string, any>, cwd: string): Record<string, unknown>;
}
