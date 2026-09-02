import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { RunWorktreeManager } from '../lib/run-worktrees/manager'

const exec = promisify(execFile)
const repo = await mkdtemp(join(tmpdir(), 'notionforge-worktree-source-'))
const state = await mkdtemp(join(tmpdir(), 'notionforge-worktree-state-'))
const run = async (args: string[], cwd = repo) => exec('git', args, { cwd, windowsHide: true })
await run(['init', '-b', 'main'])
await run(['config', 'user.email', 'test@example.invalid'])
await run(['config', 'user.name', 'worktree test'])
await writeFile(join(repo, 'seed.txt'), 'seed\n')
await run(['add', '.']); await run(['commit', '-m', 'seed'])

const manager = new RunWorktreeManager({ rootDir: state })
const [one, two] = await Promise.all([manager.create(repo, 'run-one'), manager.create(repo, 'run-two')])
const retried = await manager.create(repo, 'run-one')
if (retried.branch !== 'agent/run/run-one') throw new Error('recovered worktree was not recreated')
await writeFile(join(one.worktreePath, 'one.txt'), 'one\n')
await writeFile(join(two.worktreePath, 'two.txt'), 'two\n')
await exec('git', ['add', '.'], { cwd: one.worktreePath }); await exec('git', ['commit', '-m', 'one'], { cwd: one.worktreePath })
await exec('git', ['add', '.'], { cwd: two.worktreePath }); await exec('git', ['commit', '-m', 'two'], { cwd: two.worktreePath })
if ((await readFile(join(one.worktreePath, 'two.txt')).catch(() => null)) !== null) throw new Error('worktrees are not isolated')
await manager.remove(one); await manager.remove(two)
console.log('Run worktree concurrency/isolation smoke test passed')
