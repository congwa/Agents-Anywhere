import { open, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { requireValue } from '../domain/shared.js'

/** Reads only: listing history never constructs SessionManager or acquires a writer. */
export async function readNativeHistory(path: string): Promise<{ header: any; entries: any[]; complete: boolean }> {
  requireValue((await stat(path)).size <= 64 * 1024 * 1024, 'history_too_large', '原生会话超过读取上限。')
  const text = await readFile(path, 'utf8')
  const lines = text.split('\n')
  const records: any[] = []; let complete = true
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue
    try { records.push(JSON.parse(lines[i])) }
    catch (error) { if (i === lines.length - 1 && !text.endsWith('\n')) { complete = false; break }; throw error }
  }
  const header = records.shift()
  requireValue(header?.type === 'session' && typeof header.id === 'string' && typeof header.cwd === 'string', 'history_invalid', '原生会话头无效。')
  requireValue(records.every(entry => entry && typeof entry.id === 'string' && (entry.parentId === null || typeof entry.parentId === 'string')), 'history_invalid', '原生会话条目无效。')
  return { header, entries: records, complete }
}
export async function nativeFiles(roots: string[], onError?: (path: string, error: unknown) => void): Promise<string[]> {
  const files: string[] = [], visited = new Set<string>()
  async function walk(path: string, depth: number): Promise<void> {
    if (depth > 5) return
    try {
      const actual = await realpath(path)
      if (visited.has(actual)) return
      visited.add(actual)
      const info = await stat(actual)
      if (info.isDirectory()) for (const item of await readdir(actual)) await walk(join(actual, item), depth + 1)
      else if (actual.endsWith('.jsonl')) {
        requireValue(files.length < 20_000, 'inventory_too_large', '原生历史数量超过读取上限。')
        files.push(actual)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      if (!onError || (error as { code?: string }).code === 'inventory_too_large') throw error
      onError(path, error)
    }
  }
  for (const root of roots) await walk(root, 0)
  return files.sort()
}

export async function readNativeHeader(path: string): Promise<any> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(64 * 1024)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const content = buffer.subarray(0, bytesRead).toString('utf8')
    const end = content.indexOf('\n')
    requireValue(end >= 0, 'history_invalid', '原生会话头不完整或超过读取上限。')
    const header = JSON.parse(content.slice(0, end))
    requireValue(header?.type === 'session' && typeof header.id === 'string' && typeof header.cwd === 'string', 'history_invalid', '原生会话头无效。')
    return header
  } finally { await handle.close() }
}
