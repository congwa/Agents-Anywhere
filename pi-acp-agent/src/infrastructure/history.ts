import { readNativeHistory } from '@agents-anywhere/pi-execution/native-history'
import type { NativeHistoryPort } from '../application/ports.js'

export const nativeHistory: NativeHistoryPort = { read: readNativeHistory }
