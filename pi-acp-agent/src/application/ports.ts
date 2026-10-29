import type { WorkerConfig, WorkerEvent } from '@agents-anywhere/pi-execution'

export interface ExecutionPort {
  boot(): Promise<any>;
  request(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<any>;
  close(): Promise<void>;
}
export interface ExecutionFactory {
  create(config: WorkerConfig, publish: (event: WorkerEvent) => void): ExecutionPort;
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
export interface NativeVocabulary {
  prompt(blocks: unknown[]): { text: string; images: unknown[] };
  replay(entries: unknown[], cwd: string): Record<string, any>[];
}
export interface NativeHistoryPort {
  read(path: string): Promise<{ header: any; entries: any[]; complete: boolean }>;
}
export type AgentSettings = { runtimeId: string; agentDir: string; stateDir: string; python: string; maxRunMs: number }
