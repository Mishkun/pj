import fs from 'node:fs';
import path from 'node:path';
import { type Envelope, type Plan, type Write, fileBytes } from './git.ts';
import { discover, PJError, rel, requireValue, safePath } from './model.ts';
import { boundary, boundaryExists, marker } from './workspace.ts';

const equal = (a: Buffer | null, b: Buffer | null) => a === null ? b === null : b !== null && a.equals(b);
const stamp = (file: string): string | null => {
  try {
    const s = fs.lstatSync(file, { bigint: true });
    return `${s.dev}:${s.ino}:${s.mode}:${s.nlink}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
  } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
};
/** Serialized cooperating writers; partial multi-file writes are reported, never rolled back. */
export function mutateFiles(root: string, project: string | null, planner: (scratch: string) => Plan, bootstrap = false): Envelope {
  const write: Write = { state: 'not_written', paths: [], commit: null, checks: [] };
  let owned = false, attempted = false, scratch: string | undefined;
  let data: Record<string, unknown> = {};
  const directory = path.join(root, '.pj'), lock = path.join(directory, 'write.lock');
  let response: Envelope;
  try {
    safePath(root, directory);
    fs.mkdirSync(directory, { recursive: true });
    try { fs.closeSync(fs.openSync(lock, 'wx', 0o600)); owned = true; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new PJError('locked', 'A cooperating pj mutation holds the workspace lock'); throw e; }
    const checkBoundary = () => {
      const current = boundary(root);
      requireValue((bootstrap && !current) || (current?.files && current.root === root), 'scope', 'Workspace storage boundary changed');
    };
    checkBoundary();
    scratch = fs.mkdtempSync(path.join(directory, 'work-'));
    const baseline = new Map<string, string | null>();
    const scan = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      safePath(root, dir);
      if (boundaryExists(path.join(dir, '.git')) || boundaryExists(path.join(dir, marker))) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        baseline.set(file, stamp(file));
        if (entry.isDirectory() && !['.git', '.pj', 'node_modules'].includes(entry.name)) scan(file);
      }
    };
    for (const name of ['projects', '.archived']) scan(path.join(root, name));
    baseline.set(path.join(root, marker), stamp(path.join(root, marker)));
    const plan = planner(scratch); data = plan.data ?? {};
    checkBoundary();
    requireValue(stamp(path.join(root, marker)) === baseline.get(path.join(root, marker)), 'concurrent_change', 'Workspace marker changed during planning');
    const files = new Map<string, Buffer | null>(), before = new Map<string, Buffer | null>();
    for (const [file, next] of plan.files) {
      safePath(root, file);
      requireValue(file !== root, 'scope', 'Workspace root is not a file target');
      requireValue(!rel(root, file).split('/').some(p => ['.git', '.pj'].includes(p)), 'scope', 'Workspace internals are excluded');
      for (let dir = path.dirname(file); dir !== root; dir = path.dirname(dir)) {
        requireValue(!boundaryExists(path.join(dir, '.git')) && !boundaryExists(path.join(dir, marker)), 'scope', 'Nested repository or workspace is excluded');
      }
      requireValue(stamp(file) === (baseline.get(file) ?? null), 'concurrent_change', `Target changed during planning: ${rel(root, file)}`);
      const prior = fileBytes(file); before.set(file, prior);
      if (prior !== null) requireValue(fs.statSync(file).nlink === 1, 'unsafe_target', `Hard-linked target: ${rel(root, file)}`);
      if (!equal(prior, next)) files.set(file, next);
    }
    write.checks!.push('baseline_targets');
    if (files.size) {
      write.paths = [...files.keys()].map(f => rel(root, f)).sort();
      for (const [file, prior] of before) {
        safePath(root, file);
        requireValue(equal(fileBytes(file), prior) && stamp(file) === (baseline.get(file) ?? null), 'concurrent_change', `Target changed before save: ${rel(root, file)}`);
      }
      if (plan.move) {
        safePath(root, plan.move.from); safePath(root, plan.move.to);
        requireValue(!fs.existsSync(plan.move.to), 'destination_exists', 'Move destination already exists');
        const present = new Map<string, string | null>();
        const inspect = (dir: string) => {
          present.set(dir, stamp(dir));
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const file = path.join(dir, entry.name); present.set(file, stamp(file));
            if (entry.isDirectory()) inspect(file);
          }
        };
        inspect(plan.move.from);
        const prior = [...baseline].filter(([f]) => f === plan.move!.from || f.startsWith(plan.move!.from + path.sep));
        requireValue(prior.length === present.size && prior.every(([f, s]) => present.get(f) === s), 'concurrent_change', 'Move source tree changed during planning');
      }
      attempted = true; write.state = 'unknown';
      if (plan.move) { fs.mkdirSync(path.dirname(plan.move.to), { recursive: true }); fs.renameSync(plan.move.from, plan.move.to); }
      for (const [file, content] of files) {
        if (content === null) { if (fs.existsSync(file)) fs.unlinkSync(file); }
        else {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          const temporary = path.join(scratch, 'next-file');
          fs.writeFileSync(temporary, content);
          if (fs.existsSync(file)) fs.chmodSync(temporary, fs.statSync(file).mode & 0o7777);
          fs.renameSync(temporary, file);
        }
      }
      requireValue([...files].every(([f, b]) => equal(fileBytes(f), b)), 'verification_failed', 'Saved bytes differ from planned content');
      write.checks!.push('saved_bytes');
    }
    discover(root); data = { ...data, ...(plan.after?.() ?? {}) };
    checkBoundary();
    requireValue([...plan.files].every(([f, b]) => equal(fileBytes(f), b)), 'verification_failed', 'Targets changed during overview verification');
    write.checks!.push('overview');
    write.state = files.size ? 'saved' : 'unchanged';
    response = { version: 1, ok: true, project, data, write };
  } catch (error) {
    const e = error instanceof PJError ? error : new PJError('operation_failed', error instanceof Error ? error.message : String(error));
    if (attempted) write.checkErrors = [e.message];
    response = { version: 1, ok: false, project, data, write, error: { code: e.code, message: e.message, ...e.details } };
  }
  const cleanupErrors: string[] = [];
  for (const cleanup of [
    () => { if (scratch) fs.rmSync(scratch, { recursive: true, force: true }); },
    () => { if (owned) fs.unlinkSync(lock); },
  ]) { try { cleanup(); } catch (e) { cleanupErrors.push(String(e)); } }
  if (cleanupErrors.length) return { version: 1, ok: false, project, data,
    write: { ...write, state: attempted ? 'unknown' : 'not_written', checkErrors: cleanupErrors },
    error: { code: 'cleanup_failed', message: 'Inspect retained lock and saved paths before retrying', cleanupErrors } };
  return response;
}
