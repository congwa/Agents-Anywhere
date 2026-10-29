import { digest, requireValue } from './shared.js'

export class PromptSubmission {
  readonly key: string
  readonly fingerprint: string
  constructor(sessionId: string | undefined, request: { clientMessageId: string; content: string }) {
    this.key = 'admission:' + sessionId + ':' + request.clientMessageId
    this.fingerprint = digest(request)
  }
  requireSame(previous: { fingerprint: string }): void {
    requireValue(previous.fingerprint === this.fingerprint, 'operation_conflict', '消息身份与内容不一致。')
  }
}
