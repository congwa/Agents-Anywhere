import { convertPrompt, buildReplay, classifyToolCall, BUILTIN_COMMANDS, parseSlashCommand } from '@openma/pi-acp'
type OpenmaVocabulary = { commands(): Record<string, any>[]; parseCommand(text: string): { name: string; args: string } | undefined; prompt(blocks: unknown[]): { text: string; images: unknown[] }; replay(entries: unknown[], cwd: string): Record<string, any>[]; tool(item: Record<string, any>, cwd: string): Record<string, unknown> }

/** Only the package root's published exports enter this anti-corruption layer. */
export const openmaVocabulary: OpenmaVocabulary = {
  commands: () => BUILTIN_COMMANDS.filter(command => command.name === 'compact'),
  parseCommand: parseSlashCommand,
  prompt: blocks => convertPrompt(blocks, { images: true }),
  replay: (entries, cwd) => buildReplay(entries, cwd).updates,
  tool: (item, cwd) => classifyToolCall(item.content.toolName ?? item.content.title ?? 'tool', item.content.arguments ?? {}, cwd),
}
