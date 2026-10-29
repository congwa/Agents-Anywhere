import { cp, mkdir, readdir, readFile, writeFile, rm, stat, chmod } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
const destination = resolve(process.argv[2] ?? join(root, 'artifact'))
if (destination === root || !destination.startsWith(root + '/')) throw new Error('产物必须位于 pi-runtime 子目录中。')
const executionRoot = resolve(root, '../pi-execution')
execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(executionRoot, 'tsconfig.json')], { stdio: 'inherit' })
execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'tsconfig.json')], { stdio: 'inherit' })
await rm(destination, { recursive: true, force: true })
await mkdir(join(destination, 'bin'), { recursive: true })
await cp(join(root, 'lib'), join(destination, 'lib'), { recursive: true })
await cp(join(root, 'scripts/source-lock.py'), join(destination, 'scripts/source-lock.py'))
await cp(process.execPath, join(destination, 'bin/node'))
await chmod(join(destination, 'bin/node'), 0o755)
const source = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const dependencies = { ...source.dependencies }
delete dependencies['@agents-anywhere/pi-execution']
await writeFile(join(destination, 'package.json'), JSON.stringify({ name: source.name, private: true, type: 'module', dependencies }, null, 2) + '\n')
execFileSync('npm', ['install', '--omit=dev', '--ignore-scripts', '--package-lock=false', '--no-audit', '--no-fund'], { cwd: destination, stdio: 'inherit' })
const executionDestination = join(destination, 'node_modules/@agents-anywhere/pi-execution')
await mkdir(executionDestination, { recursive: true })
for (const name of ['package.json', 'lib', 'scripts']) await cp(join(executionRoot, name), join(executionDestination, name), { recursive: true })
const checksums = {}
async function inspect(directory) {
  for (const entry of (await readdir(join(destination, directory))).sort()) {
    const relative = join(directory, entry)
    if (relative === 'manifest.json') continue
    const info = await stat(join(destination, relative))
    if (info.isDirectory()) await inspect(relative)
    else checksums[relative] = createHash('sha256').update(await readFile(join(destination, relative))).digest('hex')
  }
}
await inspect('')
const manifest = { sdkVersion: '1.4.0', platform: process.platform, arch: process.arch,
  abi: process.versions.modules, entry: 'lib/src/entrypoints/host.js', node: 'bin/node', checksums }
await writeFile(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
process.stdout.write(`pi artifact: ${destination}\n`)
