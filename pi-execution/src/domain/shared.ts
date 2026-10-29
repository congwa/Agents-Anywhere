import { createHash } from 'node:crypto'

export class RuntimeFailure extends Error {
  constructor(readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message)
  }
}

/** Reject accessors/prototypes/cycles before either displaying or freezing tool input. */
export function canonical(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (typeof value !== 'object' || !value || seen.has(value)) throw new RuntimeFailure('invalid_json', '需要有限、无循环的 JSON 值。')
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null && !Array.isArray(value)) throw new RuntimeFailure('invalid_json', '不支持自定义参数对象。')
  seen.add(value)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (Array.isArray(value) && key === 'length') continue
    if (Array.isArray(value) && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) throw new RuntimeFailure('invalid_json', '数组不能包含额外属性。')
    if (!descriptor.enumerable || !('value' in descriptor)) throw new RuntimeFailure('invalid_json', '参数不能包含访问器。')
  }
  if (Object.getOwnPropertySymbols(value).length) throw new RuntimeFailure('invalid_json', '参数不能包含 symbol。')
  const result = Array.isArray(value)
    ? '[' + Array.from({ length: value.length }, (_, i) => canonical(value[i], seen)).join(',') + ']'
    : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key], seen)).join(',') + '}'
  seen.delete(value)
  return result
}

export function digest(value: unknown): string { return createHash('sha256').update(canonical(JSON.parse(JSON.stringify(value)))).digest('hex') }
export function freezeInput<T>(value: T): T {
  canonical(value)
  const freeze = (item: unknown): void => {
    if (!item || typeof item !== 'object') return
    for (const child of Object.values(item)) freeze(child)
    Object.freeze(item)
  }
  freeze(value)
  return value
}
export function failure(error: unknown): { code: string; message: string } {
  return error instanceof RuntimeFailure ? { code: error.code, message: error.message }
    : { code: 'pi_runtime_error', message: error instanceof Error ? error.message : 'pi Runtime 操作失败。' }
}
export function requireValue(value: unknown, code: string, message: string): asserts value {
  if (!value) throw new RuntimeFailure(code, message)
}

/** A short transition lock: never hold it while waiting on a model or a UI continuation. */
export class Mailbox {
  private tail: Promise<unknown> = Promise.resolve()
  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work)
    this.tail = result.catch(() => undefined)
    return result
  }
}
