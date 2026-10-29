import { observeCatalog, type CatalogVersion } from '../domain/catalog.js'
import { Mailbox } from '../domain/shared.js'
import { JsonStore } from './storage.js'

/** The single Host owns platform revisions; SDK workers supply definitions only. */
export class CatalogRevisions {
  private readonly transitions = new Mailbox()
  constructor(private readonly store: JsonStore) {}
  seed(workspaceId: string, fingerprint: string, revision: number): Promise<void> {
    return this.transitions.run(async () => {
      if (!Number.isSafeInteger(revision) || revision <= 0) return
      const old = await this.store.read<CatalogVersion>(workspaceId)
      if (!old || old.revision < revision) await this.store.write(workspaceId, { fingerprint, revision })
    })
  }
  observe(workspaceId: string, fingerprint: string): Promise<number> {
    return this.transitions.run(async () => {
      const old = await this.store.read<CatalogVersion>(workspaceId)
      const next = observeCatalog(old, fingerprint)
      if (next !== old) await this.store.write(workspaceId, next)
      return next.revision
    })
  }
}
