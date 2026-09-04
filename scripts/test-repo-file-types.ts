// R12-P5.5 — "the file viewer handles the files that actually exist", proven
// against a real repository holding every type the roadmap names: a large
// binary, a submodule, a symlink, and a non-UTF-8 (UTF-16) text file.
//
//   npx tsx scripts/test-repo-file-types.ts
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { listDirectory, readBlob } from '../lib/git/tree'

const exec = promisify(execFile)

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`)
}

async function main() {
  const repo = await mkdtemp(join(tmpdir(), 'notionforge-filetypes-'))
  const run = async (args: string[]) => exec('git', args, { cwd: repo, windowsHide: true })
  await run(['init', '-b', 'main'])
  await run(['config', 'user.email', 'test@example.invalid'])
  await run(['config', 'user.name', 'filetypes test'])

  // A normal text file.
  await writeFile(join(repo, 'readme.txt'), 'hello\n')

  // A binary file — well past BINARY_SNIFF_BYTES's first 8KB, with a NUL
  // early on so the sniff catches it regardless of size.
  const binaryBuf = Buffer.alloc(200_000, 0x41)
  binaryBuf[10] = 0
  await writeFile(join(repo, 'binary.dat'), binaryBuf)

  // A large text file, over MAX_BLOB_BYTES (1 MB).
  await writeFile(join(repo, 'large.txt'), Buffer.alloc(1024 * 1024 + 500, 'a'.charCodeAt(0)))

  // A UTF-16 LE file with a BOM — plain ASCII content, which is exactly the
  // case that would otherwise sniff as binary (every other byte is 0x00).
  const utf16Text = 'hello from utf-16\r\nsecond line\r\n'
  const utf16Buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(utf16Text, 'utf16le')])
  await writeFile(join(repo, 'utf16.txt'), utf16Buf)

  await run(['add', 'readme.txt', 'binary.dat', 'large.txt', 'utf16.txt'])

  // A symlink, via git plumbing rather than `fs.symlink` — Windows requires
  // developer mode or admin privileges to create a REAL symlink, but a git
  // symlink is just a blob (the target text) at mode 120000, and the object
  // store does not care what OS wrote it.
  const target = '../elsewhere/some-file.ts'
  const symlinkOid = execFileSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: repo,
    windowsHide: true,
    encoding: 'utf8',
    input: target,
  }).trim()
  await run(['update-index', '--add', '--cacheinfo', `120000,${symlinkOid},link-to-elsewhere`])

  // A submodule gitlink — mode 160000, type `commit`. A fake-but-well-formed
  // 40-hex-char oid is enough: nothing here ever tries to resolve it as a
  // real object, only to see that the TREE ENTRY reports type `commit`.
  const fakeSubmoduleOid = '1'.repeat(40)
  await run(['update-index', '--add', '--cacheinfo', `160000,${fakeSubmoduleOid},vendored-lib`])

  await run(['commit', '-m', 'seed every file type'])

  // --- Listing ------------------------------------------------------------
  const listing = await listDirectory(repo, { ref: 'main', path: '' })
  const byName = new Map(listing.entries.map((e) => [e.name, e]))

  assert(byName.get('link-to-elsewhere')?.type === 'symlink', `expected link-to-elsewhere to list as a symlink, got: ${JSON.stringify(byName.get('link-to-elsewhere'))}`)
  assert(byName.get('vendored-lib')?.type === 'commit', `expected vendored-lib to list as a submodule (commit), got: ${JSON.stringify(byName.get('vendored-lib'))}`)
  assert(byName.get('binary.dat')?.type === 'blob', 'binary.dat should list as an ordinary blob (binary-ness is a read-time fact, not a listing fact)')
  assert(byName.get('large.txt')?.size === 1024 * 1024 + 500, `expected large.txt's listed size to match, got ${byName.get('large.txt')?.size}`)
  console.log('listing correctly typed every entry:', {
    symlink: byName.get('link-to-elsewhere')?.type,
    submodule: byName.get('vendored-lib')?.type,
  })

  // --- Reading each one -----------------------------------------------------
  const symlinkBlob = await readBlob(repo, { ref: 'main', path: 'link-to-elsewhere' })
  assert(symlinkBlob.symlinkTarget === target, `expected symlink target "${target}", got "${symlinkBlob.symlinkTarget}"`)
  assert(symlinkBlob.binary === false, 'a symlink target string must not be reported as binary')
  console.log('symlink read correctly:', symlinkBlob.symlinkTarget)

  const binaryBlob = await readBlob(repo, { ref: 'main', path: 'binary.dat' })
  assert(binaryBlob.binary === true, 'binary.dat must be detected as binary')
  assert(binaryBlob.text === null, 'a binary file must not carry decoded text')
  assert(binaryBlob.size === binaryBuf.length, `expected binary.dat size ${binaryBuf.length}, got ${binaryBlob.size}`)
  console.log('binary file detected and sized correctly:', binaryBlob.size)

  const largeBlob = await readBlob(repo, { ref: 'main', path: 'large.txt' })
  assert(largeBlob.tooLarge === true, 'large.txt (over the 1MB cap) must be reported as too large')
  assert(largeBlob.text === null, 'a too-large file must not carry decoded text')
  assert(largeBlob.size === 1024 * 1024 + 500, `expected large.txt's read size to match, got ${largeBlob.size}`)
  console.log('oversized file capped correctly:', largeBlob.size)

  const utf16Blob = await readBlob(repo, { ref: 'main', path: 'utf16.txt' })
  assert(utf16Blob.binary === false, 'a UTF-16 text file must not be misdetected as binary just because every other byte is 0x00')
  assert(utf16Blob.text === utf16Text, `expected UTF-16 decode to round-trip exactly, got: ${JSON.stringify(utf16Blob.text)}`)
  console.log('UTF-16 (non-UTF-8) file decoded correctly:', JSON.stringify(utf16Blob.text))

  const readmeBlob = await readBlob(repo, { ref: 'main', path: 'readme.txt' })
  assert(readmeBlob.text === 'hello\n', 'a normal UTF-8 text file must still round-trip exactly')

  console.log('Repo file-type handling test passed (binary, oversized, symlink, submodule, UTF-16)')
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
