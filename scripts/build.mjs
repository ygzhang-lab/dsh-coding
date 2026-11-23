/**
 * Build the `dsh-coding` bundle.
 *
 * Host half: `tsc` emits ESM JavaScript plus declarations, keeping every
 * `@deepseek-ai/*` import external (the profile resolves those from the DSH
 * installation, never from this package).
 *
 * Client half: `esbuild` compiles `src/client` into the browser module-table
 * format (`window.__ModuleLoader__.load({ id, factory })`), with React provided
 * by the host module table.
 *
 * Both halves are written into a staging directory and swapped in only after
 * every step succeeded, so a failed build never leaves an installed plugin
 * without entry files.
 */
import { build } from 'esbuild'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const lib = join(root, 'lib')
const staging = join(root, '.lib-build')
const backup = join(root, '.lib-backup')

/**
 * 原子换入时的目录重命名。
 * Windows 上杀毒软件或文件监视可能短暂持有刚写入的目录句柄，让 rename 抛出
 * EPERM/EBUSY/EACCES；退避重试即可，不需要放弃原子替换。
 */
async function renameWithRetry(from, to, attempts = 10) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await rename(from, to)
    } catch (error) {
      const retryable = error?.code === 'EPERM' || error?.code === 'EBUSY' || error?.code === 'EACCES'
      if (!retryable || attempt >= attempts) throw error
      await new Promise(resolve => setTimeout(resolve, 100 * attempt))
    }
  }
}

const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const packageName = manifest.name

/** Host entries every composition imports by package subpath. */
const HOST_ENTRIES = {
  index: join(root, 'src', 'index.ts'),
  preset: join(root, 'src', 'preset.ts'),
  editor: join(root, 'src', 'editor.ts'),
  verifier: join(root, 'src', 'verifier.ts'),
}

/** React and its runtime are supplied by the browser module table. */
const CLIENT_EXTERNAL = ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client']

async function main() {
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })

  // 1. Client bundle, wrapped in the module-table factory contract.
  const clientResult = await build({
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    format: 'cjs',
    entryPoints: [join(root, 'src', 'client', 'index.ts')],
    write: false,
    external: CLIENT_EXTERNAL,
    sourcemap: false,
    logLevel: 'warning',
  })
  const clientCode = clientResult.outputFiles[0].text
  const wrapped = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(packageName)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${clientCode}
    return module.exports;
  },
});
`
  await writeFile(join(staging, 'client.js'), wrapped)

  // 2. Host half: ESM JavaScript and declarations.
  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
  await execFileAsync(
    process.execPath,
    [tsc, '-p', join(root, 'tsconfig.build.json'), '--outDir', join(staging, '.'), '--declarationDir', join(staging, 'types')],
    { cwd: root },
  )

  // 3. Prove the entries the manifest advertises actually exist.
  const missing = Object.keys(HOST_ENTRIES).filter(name => !existsSync(join(staging, `${name}.js`)))
  if (missing.length > 0) {
    throw new Error(`dsh-coding: build did not produce ${missing.map(name => `${name}.js`).join(', ')}`)
  }
  if (!existsSync(join(staging, 'types', 'index.d.ts'))) {
    throw new Error('dsh-coding: build did not produce types/index.d.ts')
  }

  // 4. Swap in only after everything succeeded; keep a fallback on failure.
  await rm(backup, { recursive: true, force: true })
  const hadLib = existsSync(lib)
  if (hadLib) await renameWithRetry(lib, backup)
  try {
    await renameWithRetry(staging, lib)
  } catch (error) {
    if (hadLib) await renameWithRetry(backup, lib)
    throw error
  }
  await rm(backup, { recursive: true, force: true })
}

try {
  await main()
} finally {
  await rm(staging, { recursive: true, force: true })
}
