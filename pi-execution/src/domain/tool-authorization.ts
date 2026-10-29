import { digest, freezeInput } from './shared.js'

export type ToolAuthorizationScope = {
  runtimeId: string; sessionId?: string; generation: string; parentToolCallId?: string | null;
  toolName: string; cwd: string; branchGeneration?: string; permission: string;
}

export function toolAuthorization(scope: ToolAuthorizationScope, input: unknown): { input: unknown; key: string; safeRead: boolean } {
  freezeInput(input)
  return { input, key: digest([scope.runtimeId, scope.sessionId, scope.generation, scope.parentToolCallId ?? null,
    scope.toolName, input, scope.cwd, scope.branchGeneration, scope.permission]),
    safeRead: ['read', 'ls', 'find', 'grep'].includes(scope.toolName) }
}
