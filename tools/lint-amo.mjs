// addons-linter has no --max-warnings, and the bar for this extension is a
// hard 0 errors / 0 warnings / 0 notices, so run it with JSON output and
// enforce the gate here.

import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bin = join(root, 'node_modules', 'addons-linter', 'bin', 'addons-linter')

// The two version strings are independent, and the one that reaches AMO is
// the manifest's. `npm version` only touches the other, and an AMO version
// number can never be reused once uploaded.
const pkgVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const mfVersion = JSON.parse(readFileSync(join(root, 'src', 'manifest.json'), 'utf8')).version
if (pkgVersion !== mfVersion) {
  console.error(`version drift: package.json ${pkgVersion} vs src/manifest.json ${mfVersion}`)
  process.exit(1)
}

const r = spawnSync(process.execPath, [bin, 'src', '-o', 'json'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024
})
if (r.error) {
  console.error(r.error.message)
  process.exit(1)
}

let report
try {
  report = JSON.parse(r.stdout)
} catch {
  console.error(r.stdout || r.stderr)
  process.exit(1)
}

const problems = [...report.errors, ...report.warnings, ...report.notices]
for (const p of problems) {
  const where = p.file ? ` ${p.file}${p.line ? ':' + p.line : ''}` : ''
  console.error(`${p._type || 'problem'} ${p.code}${where}  ${p.message}`)
}
const s = report.summary
console.log(`addons-linter: ${s.errors} errors, ${s.warnings} warnings, ${s.notices} notices (v${mfVersion})`)
process.exit(problems.length ? 1 : 0)
