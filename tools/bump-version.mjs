// Sets the version in the three files that have to agree: package.json, its
// lockfile, and the extension manifest. The release workflow refuses to
// publish a tag that disagrees with any of them, and the manifest is the one
// npm cannot reach, so doing this by hand is how a release gets blocked --
// or worse, how the wrong number goes up. AMO never lets a version be
// reused, so there is no fixing that afterwards.
//
//   npm run bump 1.0.1
//
// Writes the files and stops. Committing, tagging and pushing stay manual,
// because pushing the tag is the publication.
import { readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const next = process.argv[2]

/** @param {string} msg */
function fail (msg) {
  console.error(`bump: ${msg}`)
  process.exit(1)
}

/** @param {string} file @returns {Promise<string>} */
async function versionOf (file) {
  const raw = await readFile(join(root, file), 'utf8')
  const m = raw.match(/^\s*"version":\s*"([^"]+)"/m)
  if (!m) fail(`no version line in ${file}`)
  return /** @type {RegExpMatchArray} */ (m)[1]
}

/** @param {string} v @returns {number[]} */
const parts = v => v.split('.').map(Number)

if (!next || !/^\d+\.\d+\.\d+$/.test(next)) {
  fail('usage: npm run bump 1.0.1')
}

// A dirty tree would fold unrelated edits into the release commit, and the
// version bump is the one commit worth being able to read at a glance.
const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()
if (dirty) fail(`working tree is not clean:\n${dirty}`)

const tags = execFileSync('git', ['tag', '--list', `v${next}`], { cwd: root, encoding: 'utf8' }).trim()
if (tags) fail(`tag v${next} already exists`)

const current = await versionOf('package.json')
for (const file of ['package-lock.json', 'src/manifest.json']) {
  const v = await versionOf(file)
  if (v !== current) fail(`${file} says ${v} but package.json says ${current}; fix that first`)
}

const [a, b] = [parts(next), parts(current)]
const ahead = a.some((n, i) => n > b[i] && a.slice(0, i).every((x, j) => x === b[j]))
if (!ahead) fail(`${next} is not ahead of ${current}`)

// npm owns package.json and the lockfile, and writes both in its own format.
// Node will not execFile a .cmd without a shell, so Windows gets one; the
// version reaching the command line has already been through the pattern
// above and is three groups of digits.
execFileSync('npm', ['version', next, '--no-git-tag-version'], {
  cwd: root,
  stdio: 'pipe',
  shell: process.platform === 'win32'
})

// The manifest is edited in place rather than round-tripped through JSON,
// which would flatten the blank lines it groups its sections with.
const mfPath = join(root, 'src', 'manifest.json')
const mf = await readFile(mfPath, 'utf8')
await writeFile(mfPath, mf.replace(/^(\s*"version":\s*")[^"]+(")/m, `$1${next}$2`))

for (const file of ['package.json', 'package-lock.json', 'src/manifest.json']) {
  const v = await versionOf(file)
  if (v !== next) fail(`${file} still says ${v} after the bump`)
  console.log(`  ${file} -> ${v}`)
}

console.log(`
${current} -> ${next}. To release:

  git commit -am "Release ${next}"
  git tag v${next}
  git push origin main --tags

Pushing the tag submits to AMO. That version number cannot be reused.`)
