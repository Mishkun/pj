import { afterEach, expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run } from '../src/cli.ts';
import { bytes, mutate } from '../src/git.ts';
import { frontmatter, setField } from '../src/model.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const created: string[] = [];
afterEach(() => { for (const directory of created.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function fixture(unborn = false) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pj-test-'))); created.push(root);
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 10000 });
    if (result.status !== 0) throw new Error(`${args.join(' ')}: ${result.stderr}`); return result.stdout.trim();
  };
  git('init', '-b', 'main'); git('config', 'user.name', 'PJ Tests'); git('config', 'user.email', 'tests@example.invalid'); git('config', 'commit.gpgsign', 'false'); git('config', 'core.hooksPath', path.join(root, '.git/hooks'));
  if (!unborn) { fs.writeFileSync(path.join(root, 'baseline'), 'baseline\n'); git('add', '.'); git('commit', '-m', 'baseline'); }
  const project = path.join(root, 'projects/P'); fs.mkdirSync(project, { recursive: true });
  const invoke = (args: string[], cwd = project) => run(args, cwd);
  const init = invoke(['init']); expect(init.ok).toBe(true);
  const note = path.join(project, 'README.md');
  const save = (...files: string[]) => { git('add', '--', ...files); git('commit', '-m', 'fixture'); };
  const cli = (args: string[], cwd = project, extra: Record<string, string> = {}, executable = 'pj') => {
    const result = spawnSync(path.join(repo, 'bin', executable), args, { cwd, env: { ...process.env, ...extra }, encoding: 'utf8', timeout: 20000 });
    if (result.error) throw result.error;
    return { code: result.status, value: JSON.parse(result.stdout), stderr: result.stderr };
  };
  const task = (title = 'Task') => {
    const result = invoke(['tk', 'create', title]); expect(result.ok).toBe(true); return String(result.data.taskId);
  };
  const hook = (content: string) => fs.writeFileSync(path.join(root, '.git/hooks/pre-commit'), '#!/bin/sh\n' + content + '\n', { mode: 0o755 });
  return { root, project, git, invoke, note, save, cli, task, hook };
}

test('installed entrypoints resolve relative and absolute symlink chains', () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.root, 'links'));
  fs.mkdirSync(path.join(f.root, 'installed'));
  for (const name of ['pj', 'tk', 'tk-claim']) {
    fs.symlinkSync(path.join(repo, 'bin', name), path.join(f.root, 'links', name));
    fs.symlinkSync(`../links/${name}`, path.join(f.root, 'installed', name));
  }
  expect(f.invoke(['session', 'link', 'ses_Installed']).ok).toBe(true);
  const task = f.task();
  for (const [name, args] of [
    ['pj', ['show', '--json']],
    ['tk-claim', [task, 'ses_Installed', '--json']],
    ['tk', ['claim', task, 'ses_Installed', '--json']],
  ] as const) {
    const result = spawnSync(path.join(f.root, 'installed', name), [...args], { cwd: f.project, encoding: 'utf8', timeout: 20000 });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).ok).toBe(true);
  }
});

test('new Git-vault supports first unborn commit and JSON flags anywhere', () => {
  const f = fixture(true);
  expect(f.git('rev-list', '--count', 'HEAD')).toBe('1');
  expect(f.cli(['--json', 'show']).value.data.project.path).toBe('projects/P');
  expect(f.cli(['show', '--json']).value.version).toBe(1);
});
test('nested projects, duplicate basenames, archived status and bounded read-only discovery', () => {
  const f = fixture();
  for (const relative of ['projects/P/Child', 'projects/Q/Child', '.archived/Child']) {
    const directory = path.join(f.root, relative); fs.mkdirSync(directory, { recursive: true }); expect(f.invoke(['init'], directory).ok).toBe(true);
  }
  fs.mkdirSync(path.join(f.project, 'docs')); fs.writeFileSync(path.join(f.project, 'docs/spec.md'), 'spec'); f.save('projects/P/docs/spec.md');
  const before = f.git('status', '--porcelain=v1'); const head = f.git('rev-parse', 'HEAD');
  const all = f.invoke(['list', '-a', '--archived'], f.root).data.projects as any[]; expect(all).toHaveLength(4);
  expect(all.find(p => p.path === 'projects/P/Child').parent).toBe('projects/P');
  expect(all.find(p => p.path === '.archived/Child').status).toBe('backlog');
  expect(f.invoke(['context'], path.join(f.project, 'docs')).data.materials).toEqual([{ path: 'projects/P/docs/spec.md', size: 4 }]);
  expect(f.invoke(['show'], f.root).error?.code).toBe('scope');
  expect(f.git('rev-parse', 'HEAD')).toBe(head); expect(f.git('status', '--porcelain=v1')).toBe(before);
});
test('discovery excludes technical directories and symlink escapes; symlink cwd fails safely', () => {
  const f = fixture(); const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pj-outside-')); created.push(outside);
  fs.writeFileSync(path.join(outside, 'README.md'), '---\nstatus: done\nopencode_sessions: []\n---\n');
  fs.symlinkSync(outside, path.join(f.project, 'escape'));
  for (const name of ['node_modules', '.tickets', '.git', '.opencode']) {
    const directory = path.join(f.project, name, 'hidden'); fs.mkdirSync(directory, { recursive: true }); fs.copyFileSync(path.join(outside, 'README.md'), path.join(directory, 'README.md'));
  }
  expect((f.invoke(['list'], f.root).data.projects as any[]).map(p => p.path)).toEqual(['projects/P']);
  expect(f.invoke(['show'], path.join(f.project, 'escape')).ok).toBe(false);
  expect(f.invoke(['context']).data.materials).toEqual([]);
});
test('unknown metadata, comments, prose and quoted state survive status changes and unchanged calls', () => {
  const f = fixture(); const content = '---\n# custom comment\nstatus: "backlog" # keep when unchanged\ncustom:\n  nested: [one, two]\nopencode_sessions: []\n---\n# Prose\n\n- [ ] Untouched\n';
  fs.writeFileSync(f.note, content); f.save('projects/P/README.md');
  const head = f.git('rev-parse', 'HEAD'); expect(f.invoke(['status', 'backlog']).write?.state).toBe('unchanged'); expect(f.git('rev-parse', 'HEAD')).toBe(head);
  expect(f.invoke(['status', 'waiting']).ok).toBe(true);
  const after = fs.readFileSync(f.note, 'utf8'); expect(after).toContain('custom:\n  nested: [one, two]'); expect(frontmatter(after).body).toBe(frontmatter(content).body);
  for (const status of ['in-progress', 'blocked', 'done']) expect(f.invoke(['status', status]).ok).toBe(true);
  expect(f.invoke(['status', 'open']).error?.code).toBe('invalid_status');
});
test('session named links round-trip titles and idempotent link does not commit', () => {
  const f = fixture(); const title = 'A [square] \\ title';
  expect(f.invoke(['session', 'link', 'ses_A', '--title', title]).ok).toBe(true);
  expect((f.invoke(['show']).data.project as any).sessions).toEqual([{ id: 'ses_A', title }]);
  const head = f.git('rev-parse', 'HEAD'); expect(f.invoke(['session', 'link', 'ses_A']).write?.state).toBe('unchanged'); expect(f.git('rev-parse', 'HEAD')).toBe(head);
  expect(f.invoke(['session', 'link', 'ses_A', '--title', 'Updated']).ok).toBe(true);
});
test('move keeps YAML and code examples verbatim while updating titled Markdown links', () => {
  const f = fixture();
  const content = '---\nstatus: backlog\nopencode_sessions: []\nexample: "[raw](../../shared.md)"\n---\n'
    + '[Document](../../shared.md "Reference title")\n'
    + '`[inline example](../../shared.md)`\n'
    + '```md\n[fenced example](../../shared.md)\n```\n';
  fs.writeFileSync(f.note, content); f.save('projects/P/README.md');
  const result = f.invoke(['move', 'projects/Nested/P']);
  expect(result.ok).toBe(true);
  const after = fs.readFileSync(path.join(f.root, 'projects/Nested/P/README.md'), 'utf8');
  expect(after).toContain('example: "[raw](../../shared.md)"');
  expect(after).toContain('[Document](../../../shared.md "Reference title")');
  expect(after).toContain('`[inline example](../../shared.md)`');
  expect(after).toContain('```md\n[fenced example](../../shared.md)\n```');
});
test('post-commit cleanup failure retains commit evidence instead of reporting not_written', () => {
  const f = fixture();
  f.hook('rm "$PWD/.git/pj.lock"\nmkdir "$PWD/.git/pj.lock"');
  const previous = f.git('rev-parse', 'HEAD');
  const result = f.invoke(['log', 'Committed before cleanup failed']);
  expect(f.git('rev-parse', 'HEAD')).not.toBe(previous);
  expect(result.ok).toBe(false);
  expect(result.error?.code).toBe('cleanup_failed');
  expect(result.write?.state).toBe('unknown');
  expect(result.write?.commit).toBe(f.git('rev-parse', 'HEAD'));
  expect(result.write?.paths).toEqual(['projects/P/README.md']);
});
test('dirty targets reject unstaged, staged and assume-unchanged edits before write', () => {
  for (const kind of ['unstaged', 'staged', 'assumed']) {
    const f = fixture(); const before = fs.readFileSync(f.note, 'utf8') + '\nUser edit\n';
    if (kind === 'assumed') f.git('update-index', '--assume-unchanged', 'projects/P/README.md');
    fs.writeFileSync(f.note, before); if (kind === 'staged') f.git('add', '--', 'projects/P/README.md');
    const head = f.git('rev-parse', 'HEAD'); const result = f.invoke(['log', 'Forbidden append']);
    expect(result.error?.code).toBe('dirty_target'); expect(result.write?.state).toBe('not_written'); expect(fs.readFileSync(f.note, 'utf8')).toBe(before); expect(f.git('rev-parse', 'HEAD')).toBe(head);
  }
});
test('untracked README collisions require adoption then explicit clean baseline', () => {
  const f = fixture(); const directory = path.join(f.root, 'projects/New'); fs.mkdirSync(directory);
  const file = path.join(directory, 'README.md'); fs.writeFileSync(file, '# Existing user prose\n');
  expect(f.invoke(['init'], directory).error?.code).toBe('adoption_required');
  expect(f.invoke(['init', '--adopt'], directory).error?.code).toBe('dirty_target');
  f.save('projects/New/README.md'); expect(f.invoke(['init', '--adopt'], directory).ok).toBe(true); expect(fs.readFileSync(file, 'utf8')).toContain('# Existing user prose');
});
test('exact owned commit preserves foreign staged, unstaged, flags and native hook execution', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.root, 'foreign'), 'base'); fs.writeFileSync(path.join(f.root, 'flagged'), 'base'); f.save('foreign', 'flagged');
  fs.writeFileSync(path.join(f.root, 'foreign'), 'staged'); f.git('add', '--', 'foreign'); fs.writeFileSync(path.join(f.root, 'foreign'), 'unstaged');
  f.git('update-index', '--assume-unchanged', 'flagged'); const flag = f.git('ls-files', '-v', '--', 'flagged');
  f.hook('echo ran >> "$PWD/.git/hook-evidence"');
  const result = f.invoke(['log', 'Owned']); expect(result.ok).toBe(true); expect(result.write?.state).toBe('committed');
  expect(f.git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD')).toBe('projects/P/README.md');
  expect(f.git('show', ':foreign')).toBe('staged'); expect(fs.readFileSync(path.join(f.root, 'foreign'), 'utf8')).toBe('unstaged'); expect(f.git('ls-files', '-v', '--', 'flagged')).toBe(flag);
  expect(fs.readFileSync(path.join(f.root, '.git/hook-evidence'), 'utf8')).toBe('ran\n');
});
test('preexisting actual index lock and cooperating repo lock stop before write', () => {
  const f = fixture(); const before = fs.readFileSync(f.note);
  fs.writeFileSync(path.join(f.root, '.git/index.lock'), 'existing');
  expect(f.invoke(['log', 'No']).error?.code).toBe('index_locked'); expect(fs.readFileSync(f.note)).toEqual(before); expect(fs.readFileSync(path.join(f.root, '.git/index.lock'), 'utf8')).toBe('existing');
  fs.unlinkSync(path.join(f.root, '.git/index.lock')); fs.writeFileSync(path.join(f.root, '.git/pj.lock'), 'existing');
  expect(f.invoke(['log', 'No']).error?.code).toBe('locked'); expect(fs.readFileSync(f.note)).toEqual(before);
});
test('failed native hook saves once, preserves index bytes and does not retry or roll back', () => {
  const f = fixture(); const head = f.git('rev-parse', 'HEAD'); const index = fs.readFileSync(path.join(f.root, '.git/index'));
  f.hook('echo attempt >> "$PWD/.git/attempts"\nexit 1');
  const result = f.invoke(['log', 'Saved once']); expect(result.ok).toBe(false); expect(result.error?.code).toBe('commit_failed'); expect(result.write?.state).toBe('saved_uncommitted'); expect(result.write?.commit).toBeNull();
  expect(f.git('rev-parse', 'HEAD')).toBe(head); expect(fs.readFileSync(path.join(f.root, '.git/index'))).toEqual(index);
  expect(fs.readFileSync(f.note, 'utf8')).toContain('Saved once'); expect(fs.readFileSync(path.join(f.root, '.git/attempts'), 'utf8')).toBe('attempt\n');
  expect(f.invoke(['log', 'Saved once']).error?.code).toBe('dirty_target');
});
test('hook adding an unrelated file yields unknown and never full success', () => {
  const f = fixture(); const index = fs.readFileSync(path.join(f.root, '.git/index'));
  fs.writeFileSync(path.join(f.root, 'foreign'), 'hook content'); f.hook('git add -- foreign');
  const result = f.invoke(['log', 'Owned but hook expands tree']);
  expect(result.ok).toBe(false); expect(result.write?.state).toBe('unknown'); expect(result.write?.commit).toBeNull(); expect(result.error?.code).toBe('commit_unknown');
  expect(f.git('show', 'HEAD:foreign')).toBe('hook content'); expect(fs.readFileSync(path.join(f.root, '.git/index'))).toEqual(index);
});
test('hook modifying saved target after commit is an unknown result', () => {
  const f = fixture(); fs.writeFileSync(path.join(f.root, '.git/hooks/post-commit'), '#!/bin/sh\nprintf "\\nHook mutation\\n" >> projects/P/README.md\n', { mode: 0o755 });
  const result = f.invoke(['log', 'Owned']); expect(result.ok).toBe(false); expect(result.write?.state).toBe('unknown');
});
test('verification failure preserves saved files with explicit checks and no commit', () => {
  const f = fixture(); const head = f.git('rev-parse', 'HEAD');
  const result = mutate(f.root, 'projects/P', 'Invalid fixture', () => ({ files: new Map([[f.note, bytes('---\nstatus: impossible\nopencode_sessions: []\n---\nSaved\n')]]) }));
  expect(result.error?.code).toBe('verification_failed'); expect(result.write?.state).toBe('saved_uncommitted'); expect(result.write?.checkErrors?.length).toBe(1); expect(f.git('rev-parse', 'HEAD')).toBe(head); expect(fs.readFileSync(f.note, 'utf8')).toContain('Saved');
});
test('task native create/start/close/add-note, parent/deps/links, exact IDs and plain Markdown prose', () => {
  const f = fixture(); const a = f.task('Blocker'), b = f.task('Dependent');
  expect(f.invoke(['tk', 'dep', b, a]).ok).toBe(true); expect(f.invoke(['tk', 'link', a, b]).ok).toBe(true);
  const child = f.invoke(['tk', 'create', 'Child', '--parent', a]); expect(child.ok).toBe(true);
  const file = path.join(f.project, '.tickets', `${a}.md`); let text = fs.readFileSync(file, 'utf8'); text = setField(text, 'unknown', '{ nested: preserved }') + '\n## Checklist\n- [ ] ordinary text\n'; fs.writeFileSync(file, text); f.save(`projects/P/.tickets/${a}.md`);
  expect(f.invoke(['tk', 'start', a]).ok).toBe(true); expect(frontmatter(fs.readFileSync(file, 'utf8')).body).toBe(frontmatter(text).body);
  expect(f.invoke(['tk', 'close', a]).ok).toBe(true); expect((f.invoke(['show']).data.project as any).tasks.find((t: any) => t.id === b)).toMatchObject({ ready: true, status: 'open' });
  const prefix = fs.readFileSync(file, 'utf8'); expect(f.invoke(['tk', 'add-note', a, 'Task note']).ok).toBe(true); expect(fs.readFileSync(file, 'utf8').startsWith(prefix)).toBe(true);
  expect(fs.readFileSync(file, 'utf8')).toContain('unknown: { nested: preserved }');
  expect(f.invoke(['tk', 'show', a.slice(-4)]).error?.code).toBe('task_not_found');
  expect(f.invoke(['tk', 'checkitem', a]).error?.code).toBe('unsupported_operation');
});
test('actual tk dispatcher claims only linked sessions and unlink rejects current responsibility', () => {
  const f = fixture(); const id = f.task();
  expect(f.cli(['claim', id, 'ses_A', '--json'], f.project, {}, 'tk').value.error.code).toBe('session_not_linked');
  f.invoke(['session', 'link', 'ses_A']); f.invoke(['session', 'link', 'ses_B']);
  const file = path.join(f.project, '.tickets', `${id}.md`); const prose = frontmatter(fs.readFileSync(file, 'utf8')).body;
  expect(f.cli(['claim', id, 'ses_A', '--json'], f.project, {}, 'tk').value.ok).toBe(true);
  expect(f.cli(['claim', id, 'ses_B', '--force', '--json'], f.project, {}, 'tk').value.ok).toBe(true);
  expect((f.invoke(['show']).data.project as any).tasks[0]).toMatchObject({ status: 'open', claimed_by_sessions: ['ses_B'] });
  expect(frontmatter(fs.readFileSync(file, 'utf8')).body).toBe(prose);
  expect(f.invoke(['session', 'unlink', 'ses_B']).error?.code).toBe('session_assigned'); expect(f.invoke(['session', 'unlink', 'ses_A']).ok).toBe(true);
});
test('claim checks ambient TICKETS_DIR disagreement and preserves stored multiassign on reads', () => {
  const f = fixture(); const id = f.task(); const file = path.join(f.project, '.tickets', `${id}.md`);
  fs.writeFileSync(file, setField(fs.readFileSync(file, 'utf8'), 'claimed_by_sessions', '[ses_A, ses_B]')); f.save(`projects/P/.tickets/${id}.md`);
  expect((f.invoke(['show']).data.project as any).tasks[0].claimed_by_sessions).toEqual(['ses_A', 'ses_B']);
  expect(f.cli(['claim', id, 'ses_A', '--json'], f.project, { TICKETS_DIR: path.join(f.root, 'other') }, 'tk').value.error.code).toBe('tickets_scope_mismatch');
});
test('fork copies all memberships in one commit, retains assignments and rejects dirty multi-project targets atomically', () => {
  const f = fixture(); const q = path.join(f.root, 'projects/Q'); fs.mkdirSync(q); f.invoke(['init'], q);
  for (const cwd of [f.project, q]) f.invoke(['session', 'link', 'ses_A', '--title', 'A'], cwd);
  const id = f.task(); f.invoke(['tk', 'claim', id, 'ses_A']); const head = f.git('rev-list', '--count', 'HEAD');
  const result = f.invoke(['session', 'fork', 'ses_A', 'ses_B', '--title', 'B'], f.root); expect(result.ok).toBe(true);
  expect(Number(f.git('rev-list', '--count', 'HEAD'))).toBe(Number(head) + 1); expect(result.write?.paths).toEqual(['projects/P/README.md', 'projects/Q/README.md']);
  expect((f.invoke(['show']).data.project as any).tasks[0].claimed_by_sessions).toEqual(['ses_A']);
  const before = fs.readFileSync(f.note); fs.appendFileSync(path.join(q, 'README.md'), '\nDirty\n');
  expect(f.invoke(['session', 'fork', 'ses_A', 'ses_C'], f.root).error?.code).toBe('dirty_target'); expect(fs.readFileSync(f.note)).toEqual(before);
});
test('project log follows exact tk add-note shape, preserves prefix and repeats with explicit SID only', () => {
  const f = fixture(); const before = fs.readFileSync(f.note, 'utf8');
  f.invoke(['log', 'Repeated']); const first = fs.readFileSync(f.note, 'utf8'); expect(first.startsWith(before)).toBe(true); expect(first.slice(before.length)).toMatch(/^\n## Notes\n\n\*\*\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\*\*\n\nRepeated\n$/);
  f.invoke(['log', 'Repeated', '--session', 'ses_A']); const after = fs.readFileSync(f.note, 'utf8'); expect(after.startsWith(first)).toBe(true); expect(after.match(/Repeated/g)).toHaveLength(2); expect(after).toContain('Session: [ses_A]'); expect((f.invoke(['show']).data.project as any).sessions).toEqual([]);
});
test('managed move preserves binary contents, nested identity, executable modes and relative Markdown references', () => {
  const f = fixture(); const q = path.join(f.root, 'projects/Q'); fs.mkdirSync(q); f.invoke(['init'], q);
  const nested = path.join(f.project, 'Child'); fs.mkdirSync(nested); f.invoke(['init'], nested);
  fs.appendFileSync(path.join(q, 'README.md'), '\n[Other](../P/README.md)\n');
  fs.appendFileSync(f.note, '\n[Peer](../Q/README.md)\n[Material](data.bin)\n');
  const binary = Buffer.from([0, 255, 128, 42]); fs.writeFileSync(path.join(f.project, 'data.bin'), binary); fs.chmodSync(path.join(f.project, 'data.bin'), 0o755); f.save('projects');
  const result = f.invoke(['move', '.archived/P']); expect(result.ok).toBe(true);
  const target = path.join(f.root, '.archived/P'); expect(fs.existsSync(f.project)).toBe(false); expect(fs.readFileSync(path.join(target, 'data.bin'))).toEqual(binary); expect(fs.statSync(path.join(target, 'data.bin')).mode & 0o111).toBe(0o111);
  expect(fs.readFileSync(path.join(q, 'README.md'), 'utf8')).toContain('../../.archived/P/README.md'); expect(fs.readFileSync(path.join(target, 'README.md'), 'utf8')).toContain('../../projects/Q/README.md'); expect((f.invoke(['show'], path.join(target, 'Child')).data.project as any).parent).toBe('.archived/P');
});
test('native managed task commands bypass ambient tk plugins and reject ambient Git redirection', () => {
  const f = fixture(); const bin = path.join(f.root, 'malicious-bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'tk-create'), '#!/bin/sh\necho MALICIOUS >&2\nexit 99\n', { mode: 0o755 });
  const result = f.cli(['tk', 'create', 'Safe', '--json'], f.project, { PATH: `${bin}:${process.env.PATH}`, GIT_DIR: '/nonexistent', GIT_WORK_TREE: '/nonexistent', GIT_INDEX_FILE: '/nonexistent' });
  expect(result.code).toBe(0); expect(result.value.data.task.title).toBe('Safe');
});
test('cooperating concurrent writers report locked before any target mutation', async () => {
  const f = fixture(); f.hook('touch "$PWD/.git/hook-entered"\nsleep 1');
  const child = spawn(path.join(repo, 'bin/pj'), ['log', 'First', '--json'], { cwd: f.project, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout!.on('data', chunk => output += chunk.toString());
  const finished = new Promise<number | null>(resolve => child.on('close', resolve));
  const deadline = Date.now() + 5000; while (!fs.existsSync(path.join(f.root, '.git/hook-entered')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  expect(fs.existsSync(path.join(f.root, '.git/hook-entered'))).toBe(true);
  const result = f.invoke(['log', 'Second']); expect(result.error?.code).toBe('locked'); expect(await finished).toBe(0); expect(JSON.parse(output).ok).toBe(true);
  expect(fs.readFileSync(f.note, 'utf8')).not.toContain('Second');
});
test('native read permissions stop discovery without creating state', () => {
  const f = fixture(); const directory = path.join(f.project, 'private'); fs.mkdirSync(directory); fs.chmodSync(directory, 0o000);
  try {
    const result = f.invoke(['list'], f.root); expect(result.ok).toBe(false); expect(result.error?.code).toBe('permission_denied');
    expect(fs.existsSync(path.join(f.root, '.git/pj.lock'))).toBe(false);
  } finally { fs.chmodSync(directory, 0o755); }
});
test('unrelated unresolved staging entries remain byte-for-byte identical', () => {
  const f = fixture();
  const one = f.git('hash-object', '-w', '--stdin');
  const line = `100644 ${one} 1\tconflict\n100644 ${one} 2\tconflict\n100644 ${one} 3\tconflict\n`;
  const inserted = spawnSync('git', ['-C', f.root, 'update-index', '--index-info'], { input: line, encoding: 'utf8', timeout: 10000 }); expect(inserted.status).toBe(0);
  const conflict = f.git('ls-files', '--stage', '--', 'conflict');
  expect(f.invoke(['log', 'Scoped despite unrelated merge conflict']).ok).toBe(true);
  expect(f.git('ls-files', '--stage', '--', 'conflict')).toBe(conflict);
});
test('linked Git worktree uses actual index and common repository lock', () => {
  const f = fixture(); const worktree = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pj-worktree-'))); created.push(worktree);
  f.git('worktree', 'add', '-b', 'other', worktree);
  const project = path.join(worktree, 'projects/P');
  expect(f.invoke(['log', 'Worktree change'], project).ok).toBe(true);
  expect(f.git('show', 'other:projects/P/README.md')).toContain('Worktree change'); expect(f.git('show', 'main:projects/P/README.md')).not.toContain('Worktree change');
  fs.writeFileSync(path.join(f.root, '.git/pj.lock'), 'Common lock');
  expect(f.invoke(['log', 'Blocked'], project).error?.code).toBe('locked');
});
test('block-style named memberships preserve the following unknown field and task status idempotence', () => {
  const f = fixture();
  fs.writeFileSync(f.note, '---\nstatus: backlog\nopencode_sessions:\n  - "[Existing](raycast://script-commands/opencode-session?arguments=ses_A)"\ncustom:\n  deep: value\n---\nProse\n'); f.save('projects/P/README.md');
  expect(f.invoke(['session', 'link', 'ses_B']).ok).toBe(true); expect(fs.readFileSync(f.note, 'utf8')).toContain('custom:\n  deep: value');
  const id = f.task(); const head = f.git('rev-parse', 'HEAD'); expect(f.invoke(['tk', 'status', id, 'open']).write?.state).toBe('unchanged'); expect(f.git('rev-parse', 'HEAD')).toBe(head);
  expect(f.invoke(['tk', 'start', id]).ok).toBe(true); expect((f.invoke(['show']).data.project as any).tasks[0].ready).toBe(true);
});
test('vendored official extras dispatch through the real pinned script', () => {
  const f = fixture(); const id = f.task('Official extras');
  for (const command of ['ls', 'list', 'query']) {
    const result = spawnSync(path.join(repo, 'bin/tk'), [command], { cwd: f.project, encoding: 'utf8', timeout: 10000 });
    expect(result.status).toBe(0); expect(result.stdout).toContain(id);
  }
});
test('state-setting dirty target and hard-linked target stop before changes', () => {
  const f = fixture(); fs.appendFileSync(f.note, '\nUser edit\n');
  expect(f.invoke(['status', 'backlog']).error?.code).toBe('dirty_target');
  f.save('projects/P/README.md'); fs.linkSync(f.note, path.join(f.root, 'hard-linked-note'));
  const before = fs.readFileSync(f.note); expect(f.invoke(['log', 'Not saved']).error?.code).toBe('unsafe_target'); expect(fs.readFileSync(f.note)).toEqual(before);
});
test('managed move preserves complete query and fragment suffixes on relative links', () => {
  const f = fixture(); fs.writeFileSync(path.join(f.root, 'shared.md'), '# Shared\n');
  fs.appendFileSync(f.note, '\n[Shared](../../shared.md?x=1#section)\n'); f.save('shared.md', 'projects/P/README.md');
  const result = f.invoke(['move', 'projects/deeper/P']); expect(result.ok).toBe(true);
  const moved = fs.readFileSync(path.join(f.root, 'projects/deeper/P/README.md'), 'utf8');
  expect(moved).toContain('[Shared](../../../shared.md?x=1#section)');
  expect(f.git('status', '--porcelain=v1')).toBe('');
});
test('managed move rewrites reference definitions and preserves their titles and usages', () => {
  const f = fixture(); fs.writeFileSync(path.join(f.root, 'shared.md'), '# Shared\n');
  const q = path.join(f.root, 'projects/Q'); fs.mkdirSync(q); f.invoke(['init'], q);
  fs.appendFileSync(f.note, '\n[Shared][plain]\n[Angled][angle]\n\n[plain]: ../../shared.md?x=1#section "A shared title"\n  [angle]: <../../shared.md#anchor> \'An angled title\'\n');
  fs.appendFileSync(path.join(q, 'README.md'), '\n[Moved][peer]\n\n[peer]: ../P/README.md "Keep peer title"\n'); f.save('shared.md', 'projects');
  const result = f.invoke(['move', 'projects/deeper/P']); expect(result.ok).toBe(true);
  const moved = fs.readFileSync(path.join(f.root, 'projects/deeper/P/README.md'), 'utf8');
  expect(moved).toContain('[Shared][plain]\n[Angled][angle]');
  expect(moved).toContain('[plain]: ../../../shared.md?x=1#section "A shared title"');
  expect(moved).toContain("  [angle]: <../../../shared.md#anchor> 'An angled title'");
  expect(fs.readFileSync(path.join(q, 'README.md'), 'utf8')).toContain('[peer]: ../deeper/P/README.md "Keep peer title"');
});
test('context skips a descendant README symlink before reading external invalid YAML', () => {
  const f = fixture(); const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pj-invalid-yaml-'))); created.push(outside);
  const external = path.join(outside, 'README.md'); fs.writeFileSync(external, '---\nstatus: [broken\nopencode_sessions: []\n---\nExternal unreadable project YAML\n');
  const docs = path.join(f.project, 'docs'); fs.mkdirSync(docs); fs.symlinkSync(external, path.join(docs, 'README.md')); fs.writeFileSync(path.join(docs, 'guide.md'), 'Allowed material');
  const before = f.git('status', '--porcelain=v1'), head = f.git('rev-parse', 'HEAD');
  const result = f.cli(['context', '--json']); expect(result.code).toBe(0); expect(result.value.ok).toBe(true);
  expect(result.value.data.materials).toEqual([{ path: 'projects/P/docs/guide.md', size: 16 }]);
  expect(f.git('rev-parse', 'HEAD')).toBe(head); expect(f.git('status', '--porcelain=v1')).toBe(before);
});

test('list defaults to compact active records, with explicit full, archived, session and field projections', () => {
  const f = fixture(); const archived = path.join(f.root, '.archived/P'); fs.mkdirSync(archived, { recursive: true }); f.invoke(['init'], archived);
  for (const cwd of [f.project, archived]) expect(f.invoke(['session', 'link', 'ses_A'], cwd).ok).toBe(true);
  const a = f.task('Open'), b = f.task('Working'), c = f.task('Closed'), d = f.task('Blocked');
  f.invoke(['tk', 'start', b]); f.invoke(['tk', 'close', c]); f.invoke(['tk', 'dep', d, a]);
  const head = f.git('rev-parse', 'HEAD'), index = fs.readFileSync(path.join(f.root, '.git/index'));
  const compact = { path: 'projects/P', name: 'P', parent: null, status: 'backlog', taskCounts: { open: 2, in_progress: 1, closed: 1, ready: 2 } };
  expect(f.invoke(['list'], f.root)).toEqual({ version: 1, ok: true, project: null, data: { projects: [compact] } });
  expect(f.invoke(['list', '--session', 'ses_A'], f.root).data.projects).toEqual([compact]);
  expect((f.invoke(['list', '--archived', '--session', 'ses_A'], f.root).data.projects as any[]).map(p => p.path)).toEqual(['projects/P', '.archived/P']);
  const full = f.invoke(['show']).data.project as any;
  expect(full.tasks.every((t: any) => typeof t.body === 'string')).toBe(true);
  expect(f.invoke(['context']).data.project).toEqual(full);
  for (const flag of ['-a', '--all']) {
    const records = f.invoke(['list', flag], f.root).data.projects as any[];
    expect(records).toEqual([{ ...full, taskCounts: compact.taskCounts }]);
    expect(Object.keys(compact).every(key => Object.hasOwn(records[0], key))).toBe(true);
  }
  expect((f.invoke(['list', '-a', '--archived'], f.root).data.projects as any[])).toHaveLength(2);
  const fields = f.invoke(['list', '--fields', 'path,sessions,tasks,notePath,taskCounts'], f.root).data.projects as any[];
  expect(fields).toEqual([{ path: full.path, sessions: full.sessions, tasks: full.tasks.map(({ body, ...task }: any) => task), notePath: full.notePath, taskCounts: compact.taskCounts }]);
  expect(f.invoke(['list', '--fields', 'name,parent,status'], f.root).data.projects).toEqual([{ name: 'P', parent: null, status: 'backlog' }]);
  expect(f.git('rev-parse', 'HEAD')).toBe(head); expect(fs.readFileSync(path.join(f.root, '.git/index'))).toEqual(index); expect(f.git('status', '--porcelain')).toBe('');
});
test('list rejects empty, invalid, ambiguous and unknown flags', () => {
  const f = fixture(); const head = f.git('rev-parse', 'HEAD');
  for (const args of [
    ['--fields'], ['--fields', ''], ['--fields', 'path,'], ['--fields', ',path'], ['--fields', 'body'], ['--fields', 'path,unknown'],
    ['--fields', 'path,path'], ['--fields', '--archived'], ['--fields', '-a'], ['-a', '--fields', 'path'], ['--all', '--fields', 'tasks'],
    ['--unknown'], ['--archived=true'], ['--all', 'extra'], ['--session'], ['--session', ''], ['--session', '-a'],
  ]) { const result = f.invoke(['list', ...args], f.root); expect(result.ok).toBe(false); expect(result.write).toBeUndefined(); }
  expect(f.git('rev-parse', 'HEAD')).toBe(head); expect(f.git('status', '--porcelain')).toBe('');
});
test('list excludes archived projects before parsing their malformed task bodies', () => {
  const f = fixture(); const archived = path.join(f.root, '.archived/P'); fs.mkdirSync(archived, { recursive: true }); expect(f.invoke(['init'], archived).ok).toBe(true);
  fs.writeFileSync(path.join(archived, '.tickets/broken.md'), '---\nid: broken\nstatus: invalid\n---\nArchived task\n'); f.save('.archived/P/.tickets/broken.md');
  const head = f.git('rev-parse', 'HEAD');
  for (const flags of [[], ['-a'], ['--fields', 'tasks'], ['--session', 'ses_A']]) expect(f.invoke(['list', ...flags], f.root).ok).toBe(true);
  expect(f.invoke(['list', '--archived'], f.root).error?.code).toBe('invalid_task');
  expect(f.git('rev-parse', 'HEAD')).toBe(head); expect(f.git('status', '--porcelain')).toBe('');
});
test('claim conflicts preserve task, HEAD and index; explicit force and same sole owner are supported by native dispatch', () => {
  const f = fixture(); const id = f.task();
  for (const sid of ['ses_A', 'ses_B']) f.invoke(['session', 'link', sid]);
  expect(f.invoke(['tk', 'claim', id, 'ses_A']).ok).toBe(true);
  const file = path.join(f.project, '.tickets', `${id}.md`);
  for (const owners of [['ses_A'], ['ses_A', 'ses_B']]) {
    fs.writeFileSync(file, setField(fs.readFileSync(file, 'utf8'), 'claimed_by_sessions', JSON.stringify(owners)));
    if (f.git('status', '--porcelain')) f.save(`projects/P/.tickets/${id}.md`);
    const before = fs.readFileSync(file), head = f.git('rev-parse', 'HEAD'), index = fs.readFileSync(path.join(f.root, '.git/index'));
    if (owners.length === 1) expect(f.invoke(['tk', 'claim', id, 'ses_A']).write?.state).toBe('unchanged');
    for (const [executable, args] of [['pj', ['tk', 'claim']], ['tk', ['claim']], ['tk-claim', []]] as const) {
      const result = f.cli([...args, id, owners.length === 1 ? 'ses_B' : 'ses_A', '--json'], f.project, {}, executable);
      expect(result.code).toBe(1); expect(result.value).toMatchObject({ ok: false, error: { code: 'claim_conflict', owners, requested: owners.length === 1 ? 'ses_B' : 'ses_A' }, write: { state: 'not_written', paths: [], commit: null } });
    }
    expect(fs.readFileSync(file)).toEqual(before); expect(f.git('rev-parse', 'HEAD')).toBe(head); expect(fs.readFileSync(path.join(f.root, '.git/index'))).toEqual(index);
  }
  expect(f.cli(['claim', id, 'ses_B', '--force', '--json'], f.project, {}, 'tk').value.data.task.claimed_by_sessions).toEqual(['ses_B']);
  expect(f.invoke(['tk', 'claim', id, 'ses_A', '--force']).ok).toBe(true);
  expect(f.invoke(['tk', 'claim', id, 'ses_C', '--force']).error?.code).toBe('session_not_linked');
  for (const args of [[id, 'ses_A', '--bad'], [id, 'ses_A', '--force', '--force'], [id, '--force']]) expect(f.invoke(['tk', 'claim', ...args]).ok).toBe(false);
});
test('close --result appends once and closes in one owned commit, preserving prose, metadata and foreign staging', () => {
  const f = fixture(); const id = f.task('Result task'), dependent = f.task('Dependent'); f.invoke(['tk', 'dep', dependent, id]);
  const file = path.join(f.project, '.tickets', `${id}.md`);
  fs.writeFileSync(file, setField(fs.readFileSync(file, 'utf8'), 'custom', '{ nested: kept }') + '\n- [ ] Existing checklist\n'); f.save(`projects/P/.tickets/${id}.md`);
  f.invoke(['tk', 'add-note', id, 'Earlier note']);
  fs.writeFileSync(path.join(f.root, 'foreign'), 'base'); f.save('foreign'); fs.writeFileSync(path.join(f.root, 'foreign'), 'staged'); f.git('add', 'foreign'); fs.appendFileSync(path.join(f.root, 'foreign'), '\nunstaged');
  f.hook('echo ran >> "$PWD/.git/close-hooks"');
  const before = fs.readFileSync(file, 'utf8'), note = fs.readFileSync(f.note), count = Number(f.git('rev-list', '--count', 'HEAD'));
  const result = f.cli(['tk', 'close', id, '--result', 'Verified result\nSecond line', '--json']);
  expect(result.code).toBe(0); expect(result.value.write.state).toBe('committed'); expect(result.value.write.paths).toEqual([`projects/P/.tickets/${id}.md`]);
  expect(Number(f.git('rev-list', '--count', 'HEAD'))).toBe(count + 1); expect(fs.readFileSync(path.join(f.root, '.git/close-hooks'), 'utf8')).toBe('ran\n');
  const after = fs.readFileSync(file, 'utf8'); expect(after).toContain('custom: { nested: kept }'); expect(frontmatter(after).data.status).toBe('closed'); expect(frontmatter(after).body.startsWith(frontmatter(before).body)).toBe(true);
  expect(after).toMatch(/\*\*\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\*\*\n\nVerified result\nSecond line\n$/);
  expect(result.value.data.project.tasks.find((t: any) => t.id === dependent)).toMatchObject({ ready: true, status: 'open' });
  expect(fs.readFileSync(f.note)).toEqual(note); expect(f.git('show', ':foreign')).toBe('staged'); expect(fs.readFileSync(path.join(f.root, 'foreign'), 'utf8')).toBe('staged\nunstaged');
  const head = f.git('rev-parse', 'HEAD');
  expect(f.invoke(['tk', 'close', id, '--result', 'Duplicate']).error?.code).toBe('already_closed'); expect(fs.readFileSync(file, 'utf8')).toBe(after); expect(f.git('rev-parse', 'HEAD')).toBe(head);
  expect(f.invoke(['tk', 'close', id]).write?.state).toBe('unchanged');
});
test.each(['exit', 'prefix', 'empty', 'close'])('failed close result planning (%s) leaves status and all real bytes unchanged', failure => {
  const f = fixture(); const id = f.task(); const file = path.join(f.project, '.tickets', `${id}.md`);
  const before = fs.readFileSync(file), head = f.git('rev-parse', 'HEAD'), index = fs.readFileSync(path.join(f.root, '.git/index'));
  const original = childProcess.spawnSync; let appendCalls = 0;
  const mocked = spyOn(childProcess, 'spawnSync').mockImplementation(((command: string, args: string[], options: any) => {
    if (failure === 'close' && args?.[1] === 'super' && args[2] === 'close') return { status: 1, stderr: 'Injected close failure', stdout: '' };
    if (args?.[1] === 'super' && args[2] === 'add-note') {
      appendCalls++;
      if (failure === 'exit') return { status: 1, stderr: 'Injected append failure', stdout: '' };
      if (failure === 'empty') return { status: 0, stderr: '', stdout: '' };
      const result = original(command, args, options); if (failure === 'prefix') fs.writeFileSync(path.join(options.env.TICKETS_DIR, `${id}.md`), 'corrupt prefix\n'); return result;
    }
    return original(command, args, options);
  }) as typeof childProcess.spawnSync);
  let result; try { result = f.invoke(['tk', 'close', id, '--result', 'Verified']); } finally { mocked.mockRestore(); }
  expect(appendCalls).toBe(1); expect(result!.ok).toBe(false); expect(result!.write?.state).toBe('not_written'); expect(result!.error?.code).toBe(failure === 'exit' || failure === 'close' ? 'tk_failed' : 'verification_failed');
  expect(fs.readFileSync(file)).toEqual(before); expect(frontmatter(before.toString()).data.status).toBe('open'); expect(f.git('rev-parse', 'HEAD')).toBe(head); expect(fs.readFileSync(path.join(f.root, '.git/index'))).toEqual(index);
});
test('close rejects missing/empty/unknown results and dirty targets before saving', () => {
  const f = fixture(); const id = f.task(); const file = path.join(f.project, '.tickets', `${id}.md`), before = fs.readFileSync(file), head = f.git('rev-parse', 'HEAD');
  for (const args of [['--result'], ['--result', ''], ['--result', '  \n'], ['--result', '--bad'], ['--result', 'x', '--result', 'y'], ['--unknown'], ['--result', 'x', 'extra']]) expect(f.invoke(['tk', 'close', id, ...args])).toMatchObject({ ok: false, write: { state: 'not_written' } });
  expect(fs.readFileSync(file)).toEqual(before); expect(f.git('rev-parse', 'HEAD')).toBe(head);
  fs.appendFileSync(file, '\nUser edit\n'); const dirty = fs.readFileSync(file); expect(f.invoke(['tk', 'close', id, '--result', 'Verified']).error?.code).toBe('dirty_target'); expect(fs.readFileSync(file)).toEqual(dirty);
});
