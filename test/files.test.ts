import { afterEach, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run } from '../src/cli.ts';
import { mutateFiles } from '../src/files.ts';
import { marker } from '../src/workspace.ts';

const created: string[] = [];
const repo = fileURLToPath(new URL('..', import.meta.url));
afterEach(() => { for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function empty() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pj-files-')));
  created.push(root); return root;
}
function fixture() {
  const root = empty(); expect(run(['init', '--workspace'], root).write?.state).toBe('saved');
  const project = path.join(root, 'projects/P'); fs.mkdirSync(project, { recursive: true });
  expect(run(['init'], project).write?.state).toBe('saved');
  return { root, project, note: path.join(project, 'README.md') };
}
test('explicit bootstrap, root discovery, read-only root, idempotence and boundary validation', () => {
  const root = empty();
  expect(run(['list'], root).ok).toBe(false);
  expect(fs.existsSync(path.join(root, '.pj'))).toBe(false);
  expect(run(['init', '--workspace'], root).write?.state).toBe('saved');
  expect(run(['init', '--workspace'], root).write?.state).toBe('unchanged');
  expect(run(['root', '--json'], root).data).toEqual({ root, storage: 'files' });
  expect(run(['root', 'extra'], root).error?.code).toBe('usage');
  expect(run(['list'], root).data.projects).toEqual([]);
  const sub = path.join(root, 'unrelated'); fs.mkdirSync(sub);
  expect(run(['root'], sub).data.root).toBe(root);
  expect(run(['init', '--workspace'], sub).error?.code).toBe('scope');
  expect(run(['init'], sub).error?.code).toBe('scope');
  fs.writeFileSync(path.join(root, marker), '{}');
  expect(run(['root'], sub).error?.code).toBe('invalid_workspace');
  expect(run(['status', 'done'], sub).write?.state).toBe('not_written');
});
test('complete standalone CLI and authentic tk with PATH containing no git binary', () => {
  const root = empty(), bin = path.join(root, 'tools'); fs.mkdirSync(bin);
  // Keep the real Unix toolchain, but physically exclude Git rather than mocking its result.
  for (const dir of ['/usr/bin', '/bin']) for (const name of fs.readdirSync(dir)) {
    if (name === 'git' || fs.existsSync(path.join(bin, name))) continue;
    fs.symlinkSync(path.join(dir, name), path.join(bin, name));
  }
  const node = spawnSync('which', ['node'], { encoding: 'utf8' }).stdout.trim();
  if (fs.existsSync(path.join(bin, 'node'))) fs.unlinkSync(path.join(bin, 'node'));
  fs.symlinkSync(node, path.join(bin, 'node'));
  const invoke = (args: string[], cwd = root, executable = 'pj') => {
    const result = spawnSync(path.join(repo, 'bin', executable), args, { cwd,
      env: { ...process.env, PATH: bin, TICKETS_DIR: '' }, encoding: 'utf8', timeout: 20000 });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const value = JSON.parse(result.stdout); expect(value.ok).toBe(true); return value;
  };
  expect(spawnSync('git', ['--version'], { env: { PATH: bin } }).error).toBeDefined();
  expect(invoke(['init', '--workspace']).write.state).toBe('saved');
  const project = path.join(root, 'projects/P'); fs.mkdirSync(project, { recursive: true });
  invoke(['init'], project);
  const docs = path.join(project, 'docs'); fs.mkdirSync(docs);
  expect(invoke(['root'], docs).data).toEqual({ root, storage: 'files' });
  invoke(['session', 'link', 'ses_Files'], docs);
  const id = invoke(['tk', 'create', 'Work without git'], docs).data.taskId;
  invoke([id, 'ses_Files'], docs, 'tk-claim');
  invoke(['claim', id, 'ses_Files'], docs, 'tk');
  invoke(['tk', 'start', id], docs);
  invoke(['tk', 'add-note', id, 'Evidence'], docs);
  invoke(['tk', 'close', id, '--result', 'Passed'], docs);
  expect(invoke(['tk', 'close', id], docs).write.state).toBe('unchanged');
  invoke(['session', 'fork', 'ses_Files', 'ses_Child']);
  invoke(['status', 'done'], docs);
  invoke(['log', 'All checks passed'], docs);
  fs.writeFileSync(path.join(docs, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(docs, 'blob'), Buffer.from([0, 1, 255]));
  fs.appendFileSync(path.join(project, 'README.md'), '\n[Run](docs/run.sh)\n');
  const moved = invoke(['move', '.archived/P'], docs);
  expect(moved.write.state).toBe('saved'); expect(moved.write.commit).toBeNull();
  expect(fs.statSync(path.join(root, '.archived/P/docs/run.sh')).mode & 0o777).toBe(0o755);
  expect(fs.readFileSync(path.join(root, '.archived/P/docs/blob'))).toEqual(Buffer.from([0, 1, 255]));
  expect(invoke(['list']).data.projects).toHaveLength(0);
  expect(invoke(['list', '--archived']).data.projects).toHaveLength(1);
  invoke(['context'], path.join(root, '.archived/P'));
  expect(fs.existsSync(path.join(root, '.git'))).toBe(false);
  const managed = path.join(root, 'managed'); fs.mkdirSync(managed);
  expect(spawnSync('git', ['init', managed]).status).toBe(0);
  const missingGit = spawnSync(path.join(repo, 'bin/pj'), ['init', '--json'], { cwd: managed,
    env: { ...process.env, PATH: bin }, encoding: 'utf8', timeout: 20000 });
  expect(missingGit.status).toBe(1);
  expect(JSON.parse(missingGit.stdout).write.state).toBe('not_written');
  expect(fs.existsSync(path.join(managed, marker))).toBe(false);
});
test('file lock, hardlinks, symlink targets, adoption and externally edited prose', () => {
  const f = fixture();
  const lock = path.join(f.root, '.pj/write.lock'); fs.writeFileSync(lock, '');
  expect(run(['status', 'done'], f.project).error?.code).toBe('locked');
  expect(run(['root'], f.project).ok).toBe(true);
  fs.unlinkSync(lock);
  fs.appendFileSync(f.note, '\nManual prose\n');
  expect(run(['status', 'done'], f.project).write?.state).toBe('saved');
  expect(fs.readFileSync(f.note, 'utf8')).toContain('Manual prose');
  expect(run(['status', 'done'], f.project).write?.state).toBe('unchanged');
  const hard = path.join(f.root, 'hard'); fs.linkSync(f.note, hard);
  expect(run(['status', 'backlog'], f.project).error?.code).toBe('unsafe_target');
  fs.unlinkSync(hard);
  const outside = path.join(f.root, 'outside'); fs.renameSync(f.note, outside); fs.symlinkSync(outside, f.note);
  expect(run(['status', 'backlog'], f.project).error?.code).toBe('symlink');
  fs.unlinkSync(f.note); fs.writeFileSync(f.note, '# Manual\n');
  expect(run(['init'], f.project).error?.code).toBe('adoption_required');
  expect(run(['init', '--adopt'], f.project).write?.state).toBe('saved');
  expect(fs.readFileSync(f.note, 'utf8')).toContain('# Manual');
});
test('planner races and mid-save failure retain honest evidence; no rollback or retry', () => {
  const f = fixture(), original = fs.readFileSync(f.note);
  const race = mutateFiles(f.root, 'projects/P', () => {
    fs.appendFileSync(f.note, '\nexternal');
    return { files: new Map([[f.note, original]]) };
  });
  expect(race.error?.code).toBe('concurrent_change');
  expect(race.write?.state).toBe('not_written');
  const second = path.join(f.project, 'second.md');
  const rename = fs.renameSync.bind(fs);
  const failure = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(to) === second) throw new Error('injected save failure');
    return rename(from, to);
  });
  let result;
  try { result = mutateFiles(f.root, 'projects/P', () => ({ files: new Map([
    [f.note, Buffer.concat([original, Buffer.from('\nfirst saved')])], [second, Buffer.from('second')],
  ]) })); } finally { failure.mockRestore(); }
  expect(result!.ok).toBe(false); expect(result!.write?.state).toBe('unknown');
  expect(result!.write?.paths).toEqual(['projects/P/README.md', 'projects/P/second.md']);
  expect(fs.readFileSync(f.note, 'utf8')).toContain('first saved');
  expect(fs.existsSync(second)).toBe(false);
  expect(fs.existsSync(path.join(f.root, '.pj/write.lock'))).toBe(false);
});
test('Git root remains managed; corrupt Git and marker conflicts never downgrade to files', () => {
  const root = empty(); fs.mkdirSync(path.join(root, '.git'));
  expect(run(['init', '--workspace'], root).error?.code).toBe('scope');
  expect(run(['root'], root).ok).toBe(false);
  expect(fs.existsSync(path.join(root, marker))).toBe(false);
  fs.writeFileSync(path.join(root, marker), '{"version":1,"storage":"files"}');
  expect(run(['root'], root).error?.code).toBe('workspace_conflict');
  fs.unlinkSync(path.join(root, marker)); fs.rmSync(path.join(root, '.git'), { recursive: true });
  expect(spawnSync('git', ['init', root]).status).toBe(0);
  expect(run(['root'], root).data).toEqual({ root, storage: 'git' });
});
test('dangling and symlink boundaries fail instead of crossing to an ancestor', () => {
  for (const name of [marker, '.git']) {
    const f = fixture(), sub = path.join(f.project, 'sub'); fs.mkdirSync(sub);
    fs.symlinkSync(path.join(f.root, 'missing'), path.join(sub, name));
    expect(run(['root'], sub).error?.code).toBe('symlink');
    expect(run(['init', '--workspace'], sub).error?.code).toBe('symlink');
    expect(run(['status', 'done'], sub).write?.state).toBe('not_written');
  }
});
test('nested projects, dependencies, symmetric links and move rewrite preserve stored state', () => {
  const f = fixture(), child = path.join(f.project, 'child'), sibling = path.join(f.root, 'projects/Q');
  for (const dir of [child, sibling]) { fs.mkdirSync(dir, { recursive: true }); expect(run(['init'], dir).ok).toBe(true); }
  const first = String(run(['tk', 'create', 'First'], f.project).data.taskId);
  const second = String(run(['tk', 'create', 'Second'], f.project).data.taskId);
  expect(run(['tk', 'dep', second, first], f.project).write?.state).toBe('saved');
  expect(run(['tk', 'link', first, second], f.project).write?.state).toBe('saved');
  expect(run(['tk', 'link', first, second], f.project).write?.state).toBe('unchanged');
  expect((run(['tk', 'blocked'], f.project).data.tasks as any[]).map(t => t.id)).toContain(second);
  expect(run(['tk', 'close', first], f.project).ok).toBe(true);
  expect((run(['tk', 'ready'], f.project).data.tasks as any[]).map(t => t.id)).toContain(second);
  fs.appendFileSync(f.note, '\n[Other](../Q/README.md)\n');
  fs.appendFileSync(path.join(sibling, 'README.md'), '\n[Parent](../P/README.md)\n');
  expect(run(['session', 'link', 'ses_Move'], child).ok).toBe(true);
  expect(run(['move', '.archived/P'], f.project).write?.state).toBe('saved');
  expect(fs.readFileSync(path.join(sibling, 'README.md'), 'utf8')).toContain('../../.archived/P/README.md');
  expect(fs.readFileSync(path.join(f.root, '.archived/P/README.md'), 'utf8')).toContain('../../projects/Q/README.md');
  const record = run(['show'], path.join(f.root, '.archived/P/child')).data.project as any;
  expect(record.parent).toBe('.archived/P');
  expect(record.sessions[0].id).toBe('ses_Move');
  expect(run(['move', 'projects/Q'], path.join(f.root, '.archived/P')).error?.code).toBe('destination_exists');
});
test('cooperating mutation is blocked throughout planning, unrelated bytes remain unchanged', () => {
  const f = fixture(), other = path.join(f.project, 'manual.bin');
  fs.writeFileSync(other, Buffer.from([0, 255, 1]));
  const result = mutateFiles(f.root, 'projects/P', () => {
    expect(run(['log', 'Contender'], f.project).error?.code).toBe('locked');
    return { files: new Map([[f.note, fs.readFileSync(f.note)]]) };
  });
  expect(result.write?.state).toBe('unchanged');
  expect(fs.readFileSync(other)).toEqual(Buffer.from([0, 255, 1]));
});
test('storage and move-source races are refused before any command-owned save', () => {
  const f = fixture();
  const storage = mutateFiles(f.root, 'projects/P', () => {
    fs.unlinkSync(path.join(f.root, marker));
    return { files: new Map([[f.note, Buffer.from('overwrite')]]) };
  });
  expect(storage.ok).toBe(false); expect(storage.write?.state).toBe('not_written');
  expect(fs.readFileSync(f.note, 'utf8')).toContain('status: backlog');
  expect(run(['init', '--workspace'], f.root).ok).toBe(true);
  const target = path.join(f.root, '.archived/P');
  const race = mutateFiles(f.root, 'projects/P', () => {
    fs.mkdirSync(path.join(f.project, 'new-empty-dir'));
    return { files: new Map([[f.note, null], [path.join(target, 'README.md'), fs.readFileSync(f.note)]]),
      move: { from: f.project, to: target } };
  });
  expect(race.error?.code).toBe('concurrent_change'); expect(race.write?.state).toBe('not_written');
  expect(fs.existsSync(f.project)).toBe(true); expect(fs.existsSync(target)).toBe(false);
});
test('move failure after branch rename and cleanup failure retain unknown state and evidence', () => {
  const f = fixture(), target = path.join(f.root, '.archived/P');
  const rename = fs.renameSync.bind(fs);
  const fail = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(to) === path.join(target, 'README.md')) throw new Error('injected after branch rename');
    return rename(from, to);
  });
  let result;
  try { result = run(['move', '.archived/P'], f.project); } finally { fail.mockRestore(); }
  expect(result!.write?.state).toBe('unknown'); expect(result!.ok).toBe(false);
  expect(fs.existsSync(f.project)).toBe(false);
  expect(fs.existsSync(path.join(target, 'README.md'))).toBe(true);
  expect(result!.data.to).toBe('.archived/P');
  const unlink = fs.unlinkSync.bind(fs), lock = path.join(f.root, '.pj/write.lock');
  const cleanup = spyOn(fs, 'unlinkSync').mockImplementation(file => {
    if (String(file) === lock) throw new Error('injected lock cleanup failure');
    return unlink(file);
  });
  try { result = run(['status', 'done'], target); } finally { cleanup.mockRestore(); }
  expect(result!.write?.state).toBe('unknown'); expect(result!.error?.code).toBe('cleanup_failed');
  expect(result!.write?.checks).toContain('saved_bytes');
  expect(fs.existsSync(lock)).toBe(true);
  unlink(lock);
});
test('overview mutation cannot turn modified saved bytes into verified success', () => {
  const f = fixture(), content = Buffer.concat([fs.readFileSync(f.note), Buffer.from('\nPlanned')]);
  const result = mutateFiles(f.root, 'projects/P', () => ({
    files: new Map([[f.note, content]]),
    after: () => { fs.appendFileSync(f.note, '\nExternal'); return {}; },
  }));
  expect(result.ok).toBe(false);
  expect(result.error?.code).toBe('verification_failed');
  expect(result.write?.state).toBe('unknown');
  expect(result.write?.paths).toEqual(['projects/P/README.md']);
});
