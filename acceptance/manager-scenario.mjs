import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Independent black-box acceptance: only synthetic files in an explicitly supplied directory.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const destination = process.argv[2]
if (!destination) throw new Error('Usage: node acceptance/manager-scenario.mjs <temporary-evidence-directory>')
mkdirSync(resolve(destination), { recursive: true })
const evidence = mkdtempSync(join(resolve(destination), 'pj-acceptance-'))
const vault = join(evidence, 'vault')
mkdirSync(vault)
const trace = []
const checks = []
const env = {
  ...process.env,
  PATH: `${join(repo, 'bin')}:${process.env.PATH}`,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
}
const started = Date.now()
function command(executable, args, cwd = vault, expected = 0) {
  const at = Date.now()
  const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', timeout: 30000 })
  trace.push({ executable, args, cwd, code: result.status, stdout: result.stdout, stderr: result.stderr, milliseconds: Date.now() - at })
  if (result.error) throw result.error
  if (expected === 'failure') assert.notEqual(result.status, 0, `Unexpected success: ${args.join(' ')}`)
  else assert.equal(result.status, expected, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}
const git = (...args) => command('git', args).trim()
function pj(args, cwd = vault, failure = false) {
  const output = command(join(repo, 'bin/pj'), [...args, '--json'], cwd, failure ? 'failure' : 0)
  const json = JSON.parse(output)
  assert.equal(json.version, 1)
  assert.equal(json.ok, !failure, output)
  return json
}
const show = cwd => pj(['show'], cwd).data.project
const ids = p => p.sessions.map(s => s.id).sort()
function check(name, fn) {
  fn()
  checks.push(name)
  console.log(`PASS ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`)
}
function persist(ok, error) {
  writeFileSync(join(evidence, 'commands.json'), JSON.stringify(trace, null, 2))
  writeFileSync(join(evidence, 'receipt.json'), JSON.stringify({ ok, started: new Date(started).toISOString(), elapsedMs: Date.now() - started, vault, checks, error }, null, 2))
  console.log(`Evidence: ${evidence}`)
}

try {
  git('init', '-b', 'main')
  git('config', 'user.name', 'PJ Acceptance')
  git('config', 'user.email', 'pj-acceptance@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  let P = join(vault, 'projects/P')
  const Q = join(vault, 'projects/Q')
  const child = join(P, 'Child')
  for (const dir of [P, Q, child]) {
    mkdirSync(dir, { recursive: true })
    pj(['init'], dir)
  }
  check('project initialization and nested hierarchy', () => {
    assert.equal(show(P).path, 'projects/P')
    assert.equal(show(child).parent, 'projects/P')
    assert.equal(pj(['list']).data.projects.length, 3)
  })
  mkdirSync(join(P, 'docs'))
  writeFileSync(join(P, 'docs/spec.md'), '# Synthetic specification\n')
  git('add', '--', 'projects/P/docs/spec.md')
  git('commit', '-m', 'Add synthetic material')
  check('nested cwd and document inventory', () => {
    assert.equal(show(join(P, 'docs')).path, 'projects/P')
    const context = pj(['context'], P).data
    assert.equal(typeof context.note, 'string')
    assert(context.materials.some(m => m.path.endsWith('docs/spec.md')))
  })
  for (const dir of [P, Q]) pj(['session', 'link', 'ses_A', '--title', 'Session A'], dir)
  check('many-to-many relationship reads', () => {
    assert.deepEqual(ids(show(P)), ['ses_A'])
    assert.deepEqual(ids(show(Q)), ['ses_A'])
    assert.deepEqual(pj(['list', '--session', 'ses_A']).data.projects.map(p => p.path).sort(), ['projects/P', 'projects/Q'])
  })

  pj(['tk', 'create', 'Blocking task'], P)
  pj(['tk', 'create', 'Dependent task'], P)
  let project = show(P)
  const T = project.tasks.find(t => t.title === 'Blocking task').id
  const U = project.tasks.find(t => t.title === 'Dependent task').id
  const tPath = join(P, '.tickets', `${T}.md`)
  const uPath = join(P, '.tickets', `${U}.md`)
  writeFileSync(tPath, readFileSync(tPath, 'utf8') + '\n## Checklist\n- [ ] Preserve ordinary task text\n')
  writeFileSync(uPath, readFileSync(uPath, 'utf8').replace(/^deps:.*$/m, `deps: [${T}]`))
  git('add', '--', `projects/P/.tickets/${T}.md`, `projects/P/.tickets/${U}.md`)
  git('commit', '-m', 'Prepare synthetic dependency and task prose')
  command(join(repo, 'bin/tk'), ['claim', T, 'ses_A'], P)
  check('dependency remains blocked before close', () => {
    assert.equal(show(P).tasks.find(t => t.id === U).ready, false)
  })
  pj(['session', 'fork', 'ses_A', 'ses_B', '--title', 'Session B'])
  check('fork copies all relationships without task responsibility', () => {
    assert.deepEqual(ids(show(P)), ['ses_A', 'ses_B'])
    assert.deepEqual(ids(show(Q)), ['ses_A', 'ses_B'])
    assert.deepEqual(show(P).tasks.find(t => t.id === T).claimed_by_sessions, ['ses_A'])
  })
  const taskBeforeClaim = readFileSync(tPath, 'utf8')
  const claimHead = git('rev-parse', 'HEAD')
  const conflict = JSON.parse(command(join(repo, 'bin/tk'), ['claim', T, 'ses_B'], P, 'failure'))
  check('claim conflict retains owners and writes no task state', () => {
    assert.equal(conflict.error.code, 'claim_conflict')
    assert.deepEqual(conflict.error.owners, ['ses_A'])
    assert.equal(conflict.error.requested, 'ses_B')
    assert.equal(conflict.write.state, 'not_written')
    assert.equal(readFileSync(tPath, 'utf8'), taskBeforeClaim)
    assert.equal(git('rev-parse', 'HEAD'), claimHead)
  })
  command(join(repo, 'bin/tk'), ['claim', T, 'ses_B', '--force'], P)
  check('real tk plugin dispatch transfers responsibility only', () => {
    const task = show(P).tasks.find(t => t.id === T)
    assert.deepEqual(task.claimed_by_sessions, ['ses_B'])
    assert.equal(task.status, 'open')
    assert(readFileSync(tPath, 'utf8').includes('- [ ] Preserve ordinary task text'))
    assert.equal(readFileSync(tPath, 'utf8').split('---').slice(2).join('---'), taskBeforeClaim.split('---').slice(2).join('---'))
  })
  const beforeClose = Number(git('rev-list', '--count', 'HEAD'))
  pj(['tk', 'close', T, '--result', 'Synthetic verification passed'], P)
  check('close records result in one commit and unblocks dependent without starting it', () => {
    const dependent = show(P).tasks.find(t => t.id === U)
    assert.equal(dependent.ready, true)
    assert.equal(dependent.status, 'open')
    assert.equal(show(P).tasks.find(t => t.id === T).status, 'closed')
    assert(readFileSync(tPath, 'utf8').includes('Synthetic verification passed'))
    assert.equal(Number(git('rev-list', '--count', 'HEAD')), beforeClose + 1)
  })
  pj(['tk', 'add-note', T, 'Task-local synthetic note'], P)
  const beforeLog = readFileSync(join(P, 'README.md'), 'utf8')
  pj(['log', 'Project-level synthetic note', '--session', 'ses_B'], P)
  pj(['log', 'Project-level synthetic note', '--session', 'ses_B'], P)
  check('task notes and append-only project README history', () => {
    const note = readFileSync(join(P, 'README.md'), 'utf8')
    assert(note.startsWith(beforeLog))
    assert.equal(note.split('Project-level synthetic note').length - 1, 2)
    assert(note.includes('## Notes'))
    assert(readFileSync(tPath, 'utf8').includes('Task-local synthetic note'))
    assert(!existsSync(join(P, 'journal.jsonl')))
    assert(!existsSync(join(P, '.pj')))
  })
  const headBeforeRead = git('rev-parse', 'HEAD')
  show(P); pj(['list']); pj(['context'], P)
  check('reads leave git state unchanged', () => {
    assert.equal(git('rev-parse', 'HEAD'), headBeforeRead)
    assert.equal(git('status', '--porcelain'), '')
  })
  mkdirSync(join(vault, '.archived'), { recursive: true })
  pj(['move', join(vault, '.archived/P')], P)
  P = join(vault, '.archived/P')
  check('managed move changes address and preserves nested projects', () => {
    assert.equal(show(P).path, '.archived/P')
    assert.equal(show(join(P, 'Child')).parent, '.archived/P')
    assert.deepEqual(ids(show(P)), ['ses_A', 'ses_B'])
    assert.equal(show(P).tasks.length, 2)
    assert(existsSync(join(P, 'docs/spec.md')))
    assert.deepEqual(pj(['list']).data.projects.map(p => p.path), ['projects/Q'])
    assert.deepEqual(pj(['list', '--session', 'ses_B', '--archived']).data.projects.map(p => p.path), ['projects/Q', '.archived/P'])
    const full = pj(['list', '-a', '--archived']).data.projects.find(p => p.path === '.archived/P')
    assert(full.tasks.find(t => t.id === T).body.includes('Synthetic verification passed'))
    assert.deepEqual(full.taskCounts, { open: 1, in_progress: 0, closed: 1, ready: 1 })
  })
  writeFileSync(join(vault, 'foreign.txt'), 'Unrelated staged content\n')
  git('add', '--', 'foreign.txt')
  pj(['log', 'Owned change while foreign stage exists'], P)
  check('owned commit preserves unrelated staging', () => {
    assert.equal(git('diff', '--cached', '--name-only'), 'foreign.txt')
    assert.equal(git('show', ':foreign.txt'), 'Unrelated staged content')
    assert.deepEqual(git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').split('\n'), ['.archived/P/README.md'])
  })
  const readme = join(P, 'README.md')
  writeFileSync(readme, readFileSync(readme, 'utf8') + '\nUncommitted synthetic user edit\n')
  const dirty = readFileSync(readme, 'utf8')
  const beforeDirty = git('rev-parse', 'HEAD')
  const rejected = pj(['log', 'Must not be written'], P, true)
  check('dirty target rejects before writing', () => {
    assert.equal(rejected.error.code, 'dirty_target')
    assert.equal(readFileSync(readme, 'utf8'), dirty)
    assert.equal(git('rev-parse', 'HEAD'), beforeDirty)
  })
  const hook = join(vault, '.git/hooks/pre-commit')
  writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  const beforeFailure = git('rev-parse', 'HEAD')
  const failed = pj(['log', 'Saved despite synthetic commit failure'], Q, true)
  check('commit failure explicitly preserves saved data', () => {
    assert.equal(failed.write.state, 'saved_uncommitted')
    assert.equal(failed.error.code, 'commit_failed')
    assert.equal(git('rev-parse', 'HEAD'), beforeFailure)
    assert(readFileSync(join(Q, 'README.md'), 'utf8').includes('Saved despite synthetic commit failure'))
    assert.equal(git('diff', '--cached', '--name-only'), 'foreign.txt')
  })
  persist(true)
} catch (error) {
  persist(false, String(error.stack || error))
  process.exitCode = 1
}
