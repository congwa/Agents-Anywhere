import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { webcrypto } from 'node:crypto'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const dom = new JSDOM('<div id="root"></div>', { url: 'http://fixture' })
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.IS_REACT_ACT_ENVIRONMENT = true
function load(name, stubs) {
  const source = ts.transpileModule(readFileSync(new URL('../src/components/session/' + name, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText
  const context = vm.createContext({ exports: {}, require: name => stubs[name] ?? require(name), localStorage: dom.window.localStorage, crypto: webcrypto,
    window: { setInterval: () => 1, clearInterval() {}, setTimeout } })
  vm.runInContext(source, context)
  return context.exports
}
const operation = id => ({ id, kind: 'creation', state: { phase: 'cancelled', interactions: [{ title: 'private-' + id }] } })
async function accountSwitch(action, fail) {
  const pending = []
  const defer = () => new Promise((resolve, reject) => pending.push({ resolve, reject }))
  const hook = load('use-session-creation.ts', {
    '@/features/dashboard/runtime-workflows': { workflowApi: { cancel: defer, respond: defer, get: defer } },
    '@/lib/api': { apiClient: {} }, '@/lib/api/errors': {}, './creation-configuration': {}, '@/features/dashboard/api': {},
    './session-creation': { releaseCreationAttachments() {} },
  })
  let api
  function Probe({ options }) { api = hook.useSessionCreation(options); return null }
  const root = createRoot(document.getElementById('root'))
  const options = user => ({ userId: user, token: user + '-token', storageScope: user, removeLocal() {} })
  try {
    await React.act(() => root.render(React.createElement(Probe, { options: options('old') })))
    let oldRequest
    await React.act(() => { oldRequest = action === 'cancel' ? api.cancelWorkflow(operation('old'))
      : action === 'respond' ? api.respondWorkflow(operation('old'), {}, 'submit') : api.refreshWorkflow(operation('old')) })
    await React.act(() => root.render(React.createElement(Probe, { options: options('new') })))
    let newRequest
    await React.act(() => { newRequest = api.cancelWorkflow(operation('new')) })
    await React.act(async () => { fail ? pending[0].reject(new Error('old private failure')) : pending[0].resolve(operation('old')); await oldRequest })
    assert.deepEqual(Object.keys(api.workflowCreations), [])
    assert.equal(api.workflowError, undefined)
    assert.equal(api.workflowPending, true, 'old completion must not unlock a new request')
    await React.act(async () => { pending[1].resolve(operation('new')); await newRequest })
    assert.deepEqual(Object.keys(api.workflowCreations), ['new'])
    assert.equal(api.workflowPending, false)
  } finally { await React.act(() => root.unmount()) }
}
async function ownerChange() {
  const passthrough = ({ children }) => React.createElement(React.Fragment, null, children)
  const stubs = {
    '@/lib/api': { apiClient: { get: async () => ({ entries: [], leafId: null, nextCursor: null, sourceEpoch: 'e', fileEntriesDigest: 'd', positionRevision: 1 }), post: async () => ({ ok: true }) } },
    '@/components/ui/button': { Button: ({ children, onClick, disabled }) => React.createElement('button', { onClick, disabled }, children) },
  }
  for (const [path, names] of Object.entries({ dialog: ['Dialog', 'DialogContent', 'DialogHeader', 'DialogTitle', 'DialogTrigger'],
    field: ['Field', 'FieldGroup', 'FieldLabel'], select: ['Select', 'SelectContent', 'SelectGroup', 'SelectItem', 'SelectTrigger', 'SelectValue'] })) {
    stubs['@/components/ui/' + path] = Object.fromEntries(names.map(name => [name, passthrough]))
  }
  const { RuntimePositionDialog } = load('runtime-position-dialog.tsx', stubs)
  const root = createRoot(document.getElementById('root'))
  const props = { token: 'fixture', sessionId: 'session', ownerGeneration: 'owner-1', canClose: true, canSelect: false }
  const closeButton = () => [...document.querySelectorAll('button')].find(item => item.textContent === '关闭当前执行进程')
  try {
    await React.act(() => root.render(React.createElement(RuntimePositionDialog, props)))
    await React.act(async () => { closeButton().click(); await Promise.resolve() })
    assert.equal(closeButton(), undefined)
    await React.act(() => root.render(React.createElement(RuntimePositionDialog, { ...props, ownerGeneration: 'owner-2' })))
    assert.ok(closeButton(), 'a new owner must be closable again')
  } finally { await React.act(() => root.unmount()) }
}
try {
  for (const action of ['cancel', 'respond', 'refresh']) for (const fail of [false, true]) await accountSwitch(action, fail)
  await ownerChange()
  console.log('Runtime workflow account isolation (success/error/cancel/reply/query) and owner-scoped position dialog: passed')
} finally { dom.window.close() }
