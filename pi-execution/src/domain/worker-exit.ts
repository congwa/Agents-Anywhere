export type WorkerExit = {
  workerId: string; generation: string; role: 'preparation' | 'session'; expected: boolean;
  code: number | null; signal: string | null;
}
