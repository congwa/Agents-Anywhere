import { requireValue } from './shared.js'

export type CatalogVersion = { fingerprint: string; revision: number }
export function observeCatalog(current: CatalogVersion | undefined, fingerprint: string): CatalogVersion {
  if (current?.fingerprint === fingerprint) return current
  const revision = (current?.revision ?? 0) + 1
  requireValue(Number.isSafeInteger(revision) && revision > 0, 'catalog_revision_exhausted', '模型目录版本已达到上限。')
  return { fingerprint, revision }
}
