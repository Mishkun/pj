import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { Envelope } from './git.ts';
import { requireValue } from './model.ts';

const events = ['post-init', 'post-move'] as const;
type Event = typeof events[number];
type Hook = { event: Event; executable: string };
const usage = 'pj hook list [EVENT] | hook add/remove EVENT EXECUTABLE';
function registry(root: string): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  requireValue(path.isAbsolute(base), 'invalid_config', 'XDG_CONFIG_HOME must be absolute');
  const key = createHash('sha256').update(root).digest('hex');
  return path.join(base, 'pj', 'registrations', `${key}.json`);
}
function load(file: string, root: string): Hook[] {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const r = JSON.parse(text);
  requireValue(r.version === 1 && r.workspace === root && Array.isArray(r.hooks) &&
    r.hooks.every((h: Hook) => h && events.includes(h.event) && typeof h.executable === 'string' && path.isAbsolute(h.executable)),
    'invalid_registry', 'Invalid user hook registry');
  return r.hooks;
}
export function manageHooks(root: string, cwd: string, args: string[]) {
  const [op, event, executable] = args, file = registry(root);
  requireValue(!event || events.includes(event as Event), 'usage', `Events: ${events.join(', ')}`);
  if (op === 'list' && args.length <= 2) return { workspace: root, hooks: load(file, root).filter(h => !event || h.event === event) };
  requireValue((op === 'add' || op === 'remove') && event && executable && args.length === 3, 'usage', usage);
  const target = path.resolve(cwd, executable);
  if (op === 'add') {
    requireValue(fs.statSync(target).isFile(), 'invalid_hook', 'Expected an executable file');
    fs.accessSync(target, fs.constants.X_OK);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`, temp = `${file}.${randomUUID()}.tmp`;
  fs.closeSync(fs.openSync(lock, 'wx', 0o600));
  try {
    const old = load(file, root), match = (h: Hook) => h.event === event && h.executable === target;
    const changed = op === 'add' ? !old.some(match) : old.some(match);
    const hooks = changed ? (op === 'add' ? [...old, { event: event as Event, executable: target }] : old.filter(h => !match(h))) : old;
    if (changed) {
      fs.writeFileSync(temp, JSON.stringify({ version: 1, workspace: root, hooks }) + '\n', { flag: 'wx', mode: 0o600 });
      fs.renameSync(temp, file);
    }
    return { workspace: root, changed, hooks };
  } finally { fs.rmSync(temp, { force: true }); fs.unlinkSync(lock); }
}
export function notifyProjectChange(root: string, event: Event, result: Envelope): Envelope {
  if (!result.ok || !['committed', 'saved'].includes(result.write?.state ?? '')) return result;
  try {
    const hooks = load(registry(root), root).filter(h => h.event === event);
    if (hooks.length) result.data.hooks = hooks.map(({ executable }) => {
      const child = spawnSync(executable, [event, result.project!, String(result.data.from ?? '')], {
        cwd: root, stdio: 'ignore', timeout: 3000, killSignal: 'SIGKILL',
      });
      return child.status === 0 ? { event, executable, state: 'delivered' } :
        { event, executable, state: 'failed', message: child.error?.message ?? `exit ${child.status ?? child.signal}` };
    });
  } catch (err) {
    result.data.hookError = err instanceof Error ? err.message : String(err);
  }
  return result;
}
