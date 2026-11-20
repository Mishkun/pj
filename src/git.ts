import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { discover, PJError, rel, requireValue, safePath, within } from './model.ts';
import { boundary, standalone } from './workspace.ts';
import { mutateFiles } from './files.ts';

export type Write = { state: 'committed' | 'saved' | 'not_written' | 'saved_uncommitted' | 'unchanged' | 'unknown'; paths: string[]; commit: string | null; checks?: string[]; checkErrors?: string[] };
export type Envelope = { version: 1; ok: boolean; project: string | null; data: Record<string, unknown>; write?: Write; error?: { code: string; message: string; [key: string]: unknown } };
export function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Environment must not redirect Git outside the validated vault or inject arbitrary Git configuration.
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1', ...extra };
}
export function git(root: string, args: string[], options: { env?: NodeJS.ProcessEnv; input?: string | Buffer; allowFailure?: boolean } = {}) {
  const result = spawnSync('git', ['-C', root, ...args], { env: cleanEnv(options.env), input: options.input, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  if ((result.error || result.status !== 0) && !options.allowFailure) throw new PJError('git_failed', result.error?.message ?? result.stderr.trim() ?? 'Git failed', { gitArgs: args, exit: result.status });
  return result;
}
export function vault(cwd: string): string {
  const workspace = boundary(cwd);
  if (workspace?.files) return workspace.root;
  const result = git(cwd, ['rev-parse', '--show-toplevel'], { allowFailure: true });
  requireValue(result.status === 0, 'scope', 'This command requires a Git-vault');
  const root = fs.realpathSync(result.stdout.trim());
  requireValue(!workspace || workspace.root === root, 'scope', 'Git resolved outside the nearest repository boundary');
  requireValue(within(root, fs.realpathSync(cwd)), 'scope', 'Working directory escapes Git-vault');
  return root;
}
export function readHead(root: string): string | null {
  const result = git(root, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true });
  return result.status === 0 ? result.stdout.trim() : null;
}
export type Plan = { files: Map<string, Buffer | null>; data?: Record<string, unknown>; move?: { from: string; to: string }; after?: () => Record<string, unknown> };
export const bytes = (value: string) => Buffer.from(value);
export function fileBytes(file: string): Buffer | null {
  try { return fs.readFileSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
function equal(a: Buffer | null, b: Buffer | null) { return a === null ? b === null : b !== null && a.equals(b); }
function errorEnvelope(project: string | null, write: Write, error: unknown, data: Record<string, unknown> = {}): Envelope {
  const e = error instanceof PJError ? error : new PJError('operation_failed', error instanceof Error ? error.message : String(error));
  return { version: 1, ok: false, project, data, write, error: { code: e.code, message: e.message, ...e.details } };
}
/** Cooperating writers serialize here. Native Git hooks run once with an isolated command-owned index. */
export function mutate(root: string, project: string | null, description: string, planner: (scratch: string) => Plan): Envelope {
  if (standalone(root)) return mutateFiles(root, project, planner);
  const write: Write = { state: 'not_written', paths: [], commit: null, checks: [] };
  let lock: string | undefined, indexLock: string | undefined, scratch: string | undefined;
  let repoOwned = false, indexOwned = false, attemptedSave = false, attemptedCommit = false;
  let baselineHead: string | null = null;
  let plan: Plan | undefined;
  let data: Record<string, unknown> = {};
  try {
    const common = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).stdout.trim();
    const index = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index']).stdout.trim();
    lock = path.join(common, 'pj.lock');
    try { fs.closeSync(fs.openSync(lock, 'wx', 0o600)); repoOwned = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new PJError('locked', 'A cooperating pj mutation holds the repository lock'); throw error; }
    indexLock = `${index}.lock`;
    try { fs.closeSync(fs.openSync(indexLock, 'wx', 0o600)); indexOwned = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new PJError('index_locked', 'Git index is locked; no files were written'); throw error; }
    baselineHead = readHead(root);
    const baselineRef = git(root, ['symbolic-ref', '-q', 'HEAD'], { allowFailure: true }).stdout.trim();
    const originalIndex = fileBytes(index);
    scratch = fs.mkdtempSync(path.join(common, 'pj-work-'));
    plan = planner(scratch); data = plan.data ?? {};
    const files = new Map<string, Buffer | null>();
    const before = new Map<string, Buffer | null>();
    for (const [file, next] of plan.files) {
      safePath(root, file);
      requireValue(!within(common, file), 'scope', 'Git internals are excluded from project writes');
      const current = fileBytes(file); before.set(file, current);
      if (current !== null) requireValue(fs.statSync(file).nlink === 1, 'unsafe_target', `Hard-linked target is excluded: ${rel(root, file)}`);
      if (!equal(current, next)) files.set(file, next);
    }
    // Every planned target is checked, including an idempotent state-setting command.
    for (const file of plan.files.keys()) {
      const relative = rel(root, file);
      const status = git(root, ['status', '--porcelain=v1', '--untracked-files=all', '--', relative]).stdout;
      requireValue(!status, 'dirty_target', `Target has pending changes: ${relative}`);
      if (fileBytes(file) !== null && git(root, ['ls-files', '--error-unmatch', '--', relative], { allowFailure: true }).status !== 0) throw new PJError('dirty_target', `Existing untracked target: ${relative}`);
      // Git status honors assume-unchanged/skip-worktree. Compare actual clean-filtered bytes as well.
      const current = fileBytes(file);
      if (current !== null && baselineHead) {
        const entry = git(root, ['ls-tree', '-z', baselineHead, '--', relative]).stdout;
        const tracked = /^(\d+) blob ([a-f0-9]+)\t/.exec(entry);
        requireValue(tracked, 'dirty_target', `Target is absent from HEAD: ${relative}`);
        const actual = git(root, ['hash-object', `--path=${relative}`, '--stdin'], { input: current }).stdout.trim();
        requireValue(actual === tracked[2], 'dirty_target', `Target bytes differ from HEAD: ${relative}`);
        if (git(root, ['config', '--bool', 'core.filemode'], { allowFailure: true }).stdout.trim() === 'true') {
          const mode = fs.statSync(file).mode & 0o111 ? '100755' : '100644';
          requireValue(mode === tracked[1], 'dirty_target', `Target mode differs from HEAD: ${relative}`);
        }
      }
    }
    write.checks!.push('clean_targets', 'baseline_index');
    if (files.size === 0) return { version: 1, ok: true, project, data: { ...data, ...(plan.after?.() ?? {}) }, write: { ...write, state: 'unchanged' } };
    write.paths = [...files.keys()].map(file => rel(root, file)).sort();
    requireValue(readHead(root) === baselineHead && equal(fileBytes(index), originalIndex), 'concurrent_change', 'Git baseline changed before save');
    for (const [file, prior] of before) requireValue(equal(fileBytes(file), prior), 'concurrent_change', `Target changed before save: ${rel(root, file)}`);
    attemptedSave = true;
    if (plan.move) { fs.mkdirSync(path.dirname(plan.move.to), { recursive: true }); fs.renameSync(plan.move.from, plan.move.to); }
    for (const [file, content] of files) {
      if (content === null) { if (fs.existsSync(file)) fs.unlinkSync(file); }
      else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
    }
    write.state = 'saved_uncommitted';
    const savedMatches = () => [...files].every(([file, content]) => equal(fileBytes(file), content));
    requireValue(savedMatches(), 'verification_failed', 'Saved bytes differ from command-owned content');
    write.checks!.push('saved_bytes');
    try { discover(root); data = { ...data, ...(plan.after?.() ?? {}) }; }
    catch (error) { throw new PJError('verification_failed', error instanceof Error ? error.message : String(error)); }
    write.checks!.push('overview');
    const commitIndex = path.join(scratch, 'commit-index');
    const env = { GIT_INDEX_FILE: commitIndex };
    git(root, baselineHead ? ['read-tree', baselineHead] : ['read-tree', '--empty'], { env });
    try { git(root, ['add', '-A', '--', ...write.paths], { env }); }
    catch (error) { throw new PJError('verification_failed', error instanceof Error ? error.message : String(error)); }
    const expectedTree = git(root, ['write-tree'], { env }).stdout.trim();
    requireValue(readHead(root) === baselineHead && equal(fileBytes(index), originalIndex) && savedMatches(), 'verification_failed', 'Baseline changed before commit');
    attemptedCommit = true;
    const committed = git(root, ['commit', '-m', description], { env, allowFailure: true });
    // The command's exit code alone cannot establish the outcome of hooks and ref updates.
    const head = readHead(root);
    const ref = git(root, ['symbolic-ref', '-q', 'HEAD'], { allowFailure: true }).stdout.trim();
    if (head === baselineHead && ref === baselineRef && savedMatches()) throw new PJError('commit_failed', committed.stderr.trim() || committed.stdout.trim() || committed.error?.message || 'Commit did not advance HEAD');
    write.state = 'unknown';
    requireValue(head && head !== baselineHead && ref === baselineRef, 'commit_unknown', 'Commit result cannot be confirmed');
    const parents = git(root, ['show', '-s', '--format=%P', head]).stdout.trim();
    const tree = git(root, ['show', '-s', '--format=%T', head]).stdout.trim();
    requireValue(parents === (baselineHead ?? '') && tree === expectedTree && savedMatches() && equal(fileBytes(index), originalIndex), 'commit_unknown', 'HEAD, tree, saved files or actual index differ from the expected owned commit');
    // Reconcile from the original index, replacing only owned entries. Foreign stages and flags survive.
    const reconcileIndex = path.join(scratch, 'reconcile-index');
    const reconcileEnv = { GIT_INDEX_FILE: reconcileIndex };
    if (originalIndex) fs.writeFileSync(reconcileIndex, originalIndex); else git(root, ['read-tree', '--empty'], { env: reconcileEnv });
    for (const relative of write.paths) {
      git(root, ['update-index', '--force-remove', '--', relative], { env: reconcileEnv });
      const entry = git(root, ['ls-tree', '-z', head, '--', relative]).stdout;
      if (entry) {
        const match = /^(\d+) blob ([a-f0-9]+)\t([\s\S]*)\0$/.exec(entry);
        requireValue(match, 'commit_unknown', 'Cannot reconcile committed target entry');
        git(root, ['update-index', '-z', '--index-info'], { env: reconcileEnv, input: `${match[1]} ${match[2]}\t${match[3]}\0` });
      }
    }
    requireValue(readHead(root) === head && equal(fileBytes(index), originalIndex), 'commit_unknown', 'Git changed during index reconciliation');
    fs.writeFileSync(indexLock, fs.readFileSync(reconcileIndex));
    if (fs.existsSync(index)) fs.chmodSync(indexLock, fs.statSync(index).mode & 0o777);
    fs.renameSync(indexLock, index); indexOwned = false;
    write.commit = head; write.state = 'committed'; write.checks!.push('owned_commit', 'index_reconciled');
    return { version: 1, ok: true, project, data, write };
  } catch (error) {
    if (attemptedCommit && write.state !== 'unknown') {
      try { write.state = readHead(root) === baselineHead ? 'saved_uncommitted' : 'unknown'; }
      catch { write.state = 'unknown'; }
    } else if (attemptedSave && write.state === 'not_written') write.state = 'unknown';
    if (write.state === 'saved_uncommitted' && error instanceof PJError && error.code !== 'commit_failed') write.checkErrors = [error.message];
    return errorEnvelope(project, write, error, data);
  } finally {
    const cleanupErrors: string[] = [];
    const cleanup = (action: () => void) => {
      try { action(); } catch (error) { cleanupErrors.push(error instanceof Error ? error.message : String(error)); }
    };
    if (indexOwned && indexLock) cleanup(() => fs.unlinkSync(indexLock!));
    if (repoOwned && lock) cleanup(() => fs.unlinkSync(lock!));
    if (scratch) cleanup(() => fs.rmSync(scratch!, { recursive: true, force: true }));
    // Cleanup is after the write/commit boundary. Never let it escape to the
    // CLI's pre-write error handler and erase confirmed commit or path evidence.
    if (cleanupErrors.length) return errorEnvelope(project, {
      ...write,
      state: attemptedSave ? 'unknown' : 'not_written',
      checkErrors: [...(write.checkErrors ?? []), ...cleanupErrors],
    }, new PJError('cleanup_failed', 'Cleanup failed; inspect retained lock paths and commit evidence before another mutation', { cleanupErrors }), data);
  }
}
