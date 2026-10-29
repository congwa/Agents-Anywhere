import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile, chmod, lstat, realpath, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
const execution = resolve(root, '../pi-execution')
if (!['darwin', 'linux', 'win32'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) throw new Error('Unsupported native build target')
if (process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime) throw new Error('Linux components require glibc')
if (!/^22\./.test(process.versions.node)) throw new Error('A native Node 22 build environment is required')
const tsc = join(root, 'node_modules/typescript/bin/tsc')
for (const directory of [execution, root]) execFileSync(process.execPath, [tsc, '-p', join(directory, 'tsconfig.json')], { stdio: 'inherit' })
const artifacts = join(root, 'artifact')
await mkdir(artifacts, { recursive: true })
const staging = await mkdtemp(join(artifacts, '.building-'))
try {
  await mkdir(join(staging, 'bin'))
  await cp(process.execPath, join(staging, 'bin', process.platform === 'win32' ? 'node.exe' : 'node'))
  await chmod(join(staging, 'bin', process.platform === 'win32' ? 'node.exe' : 'node'), 0o755)
  await mkdir(join(staging, 'licenses'))
  // The repository declares MIT in README and currently has no root LICENSE.
  await cp(resolve(root, '../README.md'), join(staging, 'licenses/agents-anywhere-README.md'))
  await cp(resolve(dirname(process.execPath), '../LICENSE'), join(staging, 'licenses/node-LICENSE'))
  const source = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const dependencies = { ...source.dependencies, zod: '^4.1.0' }
  delete dependencies['@agents-anywhere/pi-execution']
  await writeFile(join(staging, 'package.json'), JSON.stringify({ name: '@agents-anywhere/pi-acp-component', private: true, type: 'module', dependencies }, null, 2) + '\n')
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--ignore-scripts', '--package-lock=false', '--no-audit', '--no-fund'], { cwd: staging, stdio: 'inherit', shell: process.platform === 'win32' })
  await cp(join(root, 'lib'), join(staging, 'agent/lib'), { recursive: true })
  const kernel = join(staging, 'node_modules/@agents-anywhere/pi-execution')
  await mkdir(kernel, { recursive: true })
  for (const name of ['package.json', 'lib', 'scripts']) await cp(join(execution, name), join(kernel, name), { recursive: true })
  const files = {}
  async function inventory(directory) {
    for (const name of (await readdir(join(staging, directory))).sort()) {
      const relative = join(directory, name), path = join(staging, relative)
      if ((await lstat(path)).isSymbolicLink()) {
        const target = await realpath(path)
        if (!target.startsWith(staging + '/') && !target.startsWith(staging + '\\')) throw new Error('Dependency link escapes component')
        const temporary = path + '.materialized'
        await cp(target, temporary, { recursive: true, dereference: true })
        await unlink(path); await rename(temporary, path)
      }
      const info = await stat(path)
      if (info.isDirectory()) await inventory(relative)
      else files[relative.replaceAll('\\', '/')] = createHash('sha256').update(await readFile(path)).digest('hex')
    }
  }
  await inventory('')
  const inventoryDigest = createHash('sha256').update(JSON.stringify(files)).digest('hex')
  const metadata = { schemaVersion: '1.0', profileId: 'pi', platform: process.platform, architecture: process.arch,
    launcher: { executable: process.platform === 'win32' ? 'bin/node.exe' : 'bin/node', arguments: ['${COMPONENT_ROOT}/agent/lib/src/interfaces/stdio.js'] },
    protocols: [1], guarantees: ['project_trust_before_resources', 'durable_prompt_receipts', 'frozen_tool_parameters', 'final_model_request_guard', 'native_writer_lease', 'stable_native_identity'],
    provenance: { inventoryDigest, piSdk: '1.4.0', openmaPiAcp: '0.1.8', acpSdk: '1.9.0', node: process.versions.node, abi: process.versions.modules },
    acceptance: { workDevices: [], clients: [] } }
  const destination = join(artifacts, `${process.platform}-${process.arch}-${inventoryDigest.slice(0, 16)}`)
  await rename(staging, destination)
  await writeFile(destination + '.metadata.json', JSON.stringify(metadata, null, 2) + '\n')
  console.log(JSON.stringify({ component: destination, metadata: destination + '.metadata.json', platform: process.platform, architecture: process.arch, inventoryDigest, files: Object.keys(files).length }))
} finally { await rm(staging, { recursive: true, force: true }) }
