import { mkdir, open, readFile, rename, readdir, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { Mailbox } from '../domain/shared.js'

/** Private, atomic and fsynced integration metadata. Never stores a second model transcript. */
export class JsonStore {
  private readonly mailbox = new Mailbox()
  constructor(readonly directory: string) {}
  private path(key: string): string { return join(this.directory, createHash('sha256').update(key).digest('hex') + '.json') }
  async read<T>(key: string): Promise<T | undefined> {
    try { return JSON.parse(await readFile(this.path(key), 'utf8')) as T }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  }
  async write(key: string, value: unknown): Promise<void> {
    await this.mailbox.run(async () => {
      const path = this.path(key)
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      const temporary = path + '.' + randomUUID() + '.tmp'
      const handle = await open(temporary, 'wx', 0o600)
      try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync() }
      finally { await handle.close() }
      try {
        await rename(temporary, path)
        if (process.platform !== 'win32') {
          const directory = await open(dirname(path), 'r')
          try { await directory.sync() } finally { await directory.close() }
        }
      } catch (error) { await unlink(temporary).catch(() => undefined); throw error }
    })
  }
  async values<T>(): Promise<T[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const output: T[] = []
    for (const file of await readdir(this.directory)) if (/^[a-f0-9]{64}\.json$/.test(file)) output.push(JSON.parse(await readFile(join(this.directory, file), 'utf8')) as T)
    return output
  }
  async remove(key: string): Promise<void> { await unlink(this.path(key)).catch(error => { if (error.code !== 'ENOENT') throw error }) }
}
