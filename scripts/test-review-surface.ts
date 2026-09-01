// ROADMAP P6.4 — review-surface smoke test, same spirit as
// `test-run-worktrees.ts`/`test-broker.ts`: exercises the real modules
// (diff reading, worktree state, merge) against disposable temp repos, never
// the real notionforge repo. Run with: npx tsx scripts/test-review-surface.ts
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { RunWorktreeManager, describeRunWorktree } from '../lib/run-worktrees/manager'
import { getChangedFiles, getFileDiff, getWorktreeState } from '../lib/run-worktrees/diff'
import { mergeRunBranch } from '../lib/run-worktrees/merge'

const exec = promisify(execFile)
let failures = 0

function check(label: string, condition: boolean) {
  console.log(`${condition ? 'OK  ' : 'FAIL'} ${label}`)
  if (!condition) failures += 1
}

async function main() {
  const source = await mkdtemp(join(tmpdir(), 'review-surface-source-'))
  const state = await mkdtemp(join(tmpdir(), 'review-surface-state-'))
  const git = async (args: string[], cwd = source) => exec('git', args, { cwd, windowsHide: true })

  await git(['init', '-b', 'main'])
  await git(['config', 'user.email', 'test@example.invalid'])
  await git(['config', 'user.name', 'review surface test'])
  await writeFile(join(source, 'seed.txt'), 'seed\n')
  await git(['add', '.'])
  await git(['commit', '-m', 'seed'])

  const manager = new RunWorktreeManager({ rootDir: state })

  // --- Run 1: fast-forward case ---
  const wt1 = await manager.create(source, 'run-1', 'main')
  await writeFile(join(wt1.worktreePath, 'feature.txt'), 'line one\nline two\n')
  await git(['add', '.'], wt1.worktreePath)
  await git(['commit', '-m', 'add feature.txt'], wt1.worktreePath)

  // Independently re-locate the same worktree the way the review page would
  // (it doesn't hold onto the RunWorktreeManager instance/result — it only
  // knows the run id).
  const located = describeRunWorktree(state, source, 'run-1', 'main')
  check('describeRunWorktree matches manager.create()’s own descriptor', JSON.stringify(located) === JSON.stringify(wt1))

  const changed = await getChangedFiles(located)
  check('getChangedFiles reports exactly one added file', changed.length === 1 && changed[0].status === 'added' && changed[0].path === 'feature.txt')

  const patch = await getFileDiff(located, changed[0])
  check('getFileDiff patch contains the added lines', patch.includes('+line one') && patch.includes('+line two'))

  const stateBefore = await getWorktreeState(located)
  check('getWorktreeState: branch exists', stateBefore.branchExists)
  check('getWorktreeState: 1 commit ahead, 0 behind', stateBefore.aheadCount === 1 && stateBefore.behindCount === 0)
  check('getWorktreeState: worktree still on disk, no uncommitted changes', stateBefore.worktreeExists && !stateBefore.hasUncommittedChanges)

  const mergeResult1 = await mergeRunBranch(located, { sourceRepo: source, baseBranch: 'main', rootDir: state })
  check('mergeRunBranch (fast-forward case): merged', mergeResult1.merged)
  check('mergeRunBranch (fast-forward case): reported as fast-forward', mergeResult1.fastForward)
  // Compared with CRLF normalized to LF — Windows' `core.autocrlf` checks
  // this file out with CRLF line endings, which is expected/correct git
  // behavior, not a bug in the merge itself (confirmed while debugging this
  // exact assertion: the merge/push mechanics were fine all along, this
  // comparison was just too strict).
  const sourceFeatureContent = (await readFile(join(source, 'feature.txt'), 'utf8').catch(() => null))?.replace(/\r\n/g, '\n')
  check(
    'source repo working tree actually has feature.txt after merge (push-rejected fallback path exercised, since main is checked out in source)',
    sourceFeatureContent === 'line one\nline two\n',
  )

  await manager.remove(wt1)
  const stateAfterRemove = await getWorktreeState(located)
  check('getWorktreeState after removal: worktree gone but branch/diff still readable from the bare clone', !stateAfterRemove.worktreeExists && stateAfterRemove.branchExists)

  // --- Run 2: non-fast-forward case — advance source's main independently first ---
  await writeFile(join(source, 'unrelated.txt'), 'unrelated change on main\n')
  await git(['add', '.'])
  await git(['commit', '-m', 'unrelated change on main'])

  const wt2 = await manager.create(source, 'run-2', 'main')
  await writeFile(join(wt2.worktreePath, 'other-feature.txt'), 'other feature\n')
  await git(['add', '.'], wt2.worktreePath)
  await git(['commit', '-m', 'add other-feature.txt'], wt2.worktreePath)

  const mergeResult2 = await mergeRunBranch(wt2, { sourceRepo: source, baseBranch: 'main', rootDir: state })
  check('mergeRunBranch (non-fast-forward case): merged', mergeResult2.merged)
  check('mergeRunBranch (non-fast-forward case): reported as a real merge, not fast-forward', mergeResult2.fastForward === false)
  const sourceHasBoth =
    (await readFile(join(source, 'unrelated.txt'), 'utf8').catch(() => null)) !== null &&
    (await readFile(join(source, 'other-feature.txt'), 'utf8').catch(() => null)) !== null
  check('source repo has both the independent commit and the merged run commit', sourceHasBoth)

  await manager.remove(wt2)

  // --- Never-dispatched run: no branch exists in the bare clone at all ---
  const neverDispatched = describeRunWorktree(state, source, 'run-999-never-dispatched', 'main')
  const neverState = await getWorktreeState(neverDispatched)
  check('a run id nobody ever dispatched: branchExists is false, not thrown', neverState.branchExists === false)

  console.log('')
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((err) => {
  console.error('[review-surface smoke] FAILED:', err)
  process.exitCode = 1
})
