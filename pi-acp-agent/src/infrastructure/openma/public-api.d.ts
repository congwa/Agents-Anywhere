declare module '@openma/pi-acp' {
  export const BUILTIN_COMMANDS: { name: string; description: string; input?: { hint: string } }[]
  export function parseSlashCommand(text: string): { name: string; args: string } | undefined
  export function convertPrompt(blocks: unknown[], options: { images: boolean }): { text: string; images: unknown[] }
  export function classifyToolCall(name: string, args: unknown, cwd: string): { kind: string; title: string; locations: { path: string; line?: number }[] }
  export function buildReplay(entries: unknown[], cwd: string): { updates: Record<string, any>[] }
}
