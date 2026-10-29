declare module '@openma/pi-acp' {
  export function convertPrompt(blocks: unknown[], options: { images: boolean }): { text: string; images: unknown[] }
  export function buildReplay(entries: unknown[], cwd: string): { updates: Record<string, any>[] }
}
