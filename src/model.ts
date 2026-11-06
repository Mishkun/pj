import fs from 'node:fs';
import path from 'node:path';
import { parseDocument, isMap } from 'yaml';

export const projectStatuses = ['backlog', 'in-progress', 'waiting', 'blocked', 'done'];
export const taskStatuses = ['open', 'in_progress', 'closed'];
export class PJError extends Error {
  code: string;
  details: Record<string, unknown>;
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message); this.code = code; this.details = details;
  }
}
export function requireValue(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new PJError(code, message);
}
export function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
export function rel(root: string, file: string) { return path.relative(root, file).split(path.sep).join('/'); }
export function sid(value: string | undefined): string {
  requireValue(value && /^ses_[A-Za-z0-9]+$/.test(value), 'invalid_session', 'An explicit ses_<id> is required');
  return value;
}
export function safePath(root: string, file: string): void {
  requireValue(within(root, file), 'scope', 'Path escapes Git-vault');
  let cursor = root;
  for (const segment of path.relative(root, file).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try { requireValue(!fs.lstatSync(cursor).isSymbolicLink(), 'symlink', `Symlink path is excluded: ${rel(root, cursor)}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
export function frontmatter(text: string) {
  const match = /^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(text);
  requireValue(match, 'invalid_metadata', 'Expected YAML frontmatter');
  const yaml = match[2]!;
  const doc = parseDocument(yaml, { uniqueKeys: true });
  requireValue(doc.errors.length === 0 && isMap(doc.contents), 'invalid_metadata', 'Invalid frontmatter YAML');
  return { yaml, doc, start: match[1]!.length, end: match[0].length, body: text.slice(match[0].length), data: doc.toJS() as Record<string, unknown> };
}
/** Replace only the owned top-level field. Other frontmatter bytes and the entire body stay intact. */
export function setField(text: string, key: string, literal: string): string {
  const fm = frontmatter(text);
  const desired = parseDocument(`${key}: ${literal}`).toJS() as Record<string, unknown>;
  if (JSON.stringify(fm.data[key]) === JSON.stringify(desired[key])) return text;
  requireValue(isMap(fm.doc.contents), 'invalid_metadata', 'Expected a frontmatter mapping');
  const pairs = fm.doc.contents!.items as Array<{ key: { value?: unknown; range?: [number, number, number] }; value?: { range?: [number, number, number] } }>;
  const index = pairs.findIndex(pair => pair.key.value === key);
  if (index === -1) return text.slice(0, fm.start) + `${key}: ${literal}\n` + text.slice(fm.start);
  const pair = pairs[index]!;
  const start = pair.key.range![0];
  // Range ends before a following field (including comments on that following field).
  const valueEnd = pair.value?.range?.[2] ?? pair.key.range![2];
  let end = valueEnd;
  if (fm.yaml[end] === '\r') end++;
  if (fm.yaml[end] === '\n') end++;
  const suffix = fm.yaml.slice(end);
  const replacement = `${key}: ${literal}${suffix.length ? '\n' : ''}`;
  const yaml = fm.yaml.slice(0, start) + replacement + suffix;
  return text.slice(0, fm.start) + yaml + text.slice(fm.start + fm.yaml.length);
}
export type Session = { id: string; title: string };
export type TaskSnapshot = { id: string; title: string; status: string; parent: string | null; deps: string[]; links: string[]; claimed_by_sessions: string[]; ready: boolean; body: string; path: string };
export type ProjectSnapshot = { path: string; name: string; parent: string | null; status: string; sessions: Session[]; tasks: TaskSnapshot[]; notePath: string };
export function strings(value: unknown, label: string): string[] {
  requireValue(Array.isArray(value) && value.every(item => typeof item === 'string'), 'invalid_metadata', `${label} must be a list of strings`);
  return value;
}
export function sessions(value: unknown): Session[] {
  return strings(value, 'opencode_sessions').map(item => {
    const match = /^\[((?:\\.|[^\]])*)\]\(raycast:\/\/script-commands\/opencode-session\?arguments=(ses_[A-Za-z0-9]+)\)$/.exec(item);
    requireValue(match, 'invalid_metadata', 'Session relationships must be named links with explicit SIDs');
    return { id: sid(match[2]), title: match[1]!.replace(/\\([\\\[\]])/g, '$1') };
  });
}
export function namedLink(session: Session): string {
  return `[${session.title.replace(/[\\\[\]]/g, '\\$&')}](raycast://script-commands/opencode-session?arguments=${sid(session.id)})`;
}
export function setSessions(text: string, items: Session[]): string {
  return setField(text, 'opencode_sessions', JSON.stringify(items.map(namedLink)));
}
export const excluded = new Set(['.git', '.tickets', 'node_modules', '.pj', '.opencode']);
export function inConvention(root: string, file: string): boolean {
  const parts = rel(root, file).split('/');
  return (parts[0] === 'projects' || parts[0] === '.archived') && parts.length > 1 && !parts.slice(1).some(p => excluded.has(p));
}
export function isProject(root: string, file: string): boolean {
  safePath(root, path.dirname(file));
  try { if (!fs.lstatSync(file).isFile()) return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  const text = fs.readFileSync(file, 'utf8');
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return false;
  const { data } = frontmatter(text);
  return Object.hasOwn(data, 'status') && Object.hasOwn(data, 'opencode_sessions');
}
export function nearest(root: string, cwd: string): string {
  safePath(root, cwd);
  let cursor = cwd;
  while (inConvention(root, cursor)) {
    const note = path.join(cursor, 'README.md'); safePath(root, note);
    if (isProject(root, note)) return cursor;
    cursor = path.dirname(cursor);
  }
  throw new PJError('scope', 'Run this command inside a project under projects/ or .archived/');
}
export function discover(root: string): ProjectSnapshot[] {
  const result: ProjectSnapshot[] = [];
  const walk = (directory: string, parent: string | null) => {
    safePath(root, directory);
    let current = parent;
    if (inConvention(root, directory)) {
      const note = path.join(directory, 'README.md');
      if (isProject(root, note)) {
        const record = snapshot(root, directory, parent); result.push(record); current = record.path;
      }
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && !excluded.has(entry.name)) walk(path.join(directory, entry.name), current);
    }
  };
  for (const name of ['projects', '.archived']) {
    const directory = path.join(root, name);
    if (fs.existsSync(directory) && !fs.lstatSync(directory).isSymbolicLink()) { safePath(root, directory); walk(directory, null); }
  }
  return result;
}
export function taskFile(root: string, project: string, id: string): string {
  requireValue(/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id), 'invalid_task', 'Use an exact local task ID');
  const file = path.join(project, '.tickets', `${id}.md`); safePath(root, file);
  requireValue(fs.existsSync(file), 'task_not_found', `Task ${id} does not exist in this project`);
  return file;
}
export function snapshot(root: string, project: string, parent?: string | null): ProjectSnapshot {
  const note = path.join(project, 'README.md'); safePath(root, note);
  const { data } = frontmatter(fs.readFileSync(note, 'utf8'));
  requireValue(projectStatuses.includes(String(data.status)), 'invalid_metadata', 'Unknown project status');
  if (parent === undefined) {
    try { parent = rel(root, nearest(root, path.dirname(project))); } catch (error) { if (!(error instanceof PJError && error.code === 'scope')) throw error; parent = null; }
  }
  const directory = path.join(project, '.tickets'); safePath(root, directory);
  const tasks: TaskSnapshot[] = [];
  if (fs.existsSync(directory)) for (const entry of fs.readdirSync(directory).sort()) {
    if (!entry.endsWith('.md')) continue;
    const file = path.join(directory, entry); safePath(root, file);
    const fm = frontmatter(fs.readFileSync(file, 'utf8')); const task = fm.data;
    requireValue(task.id === entry.slice(0, -3) && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(String(task.id)), 'invalid_task', `Task filename and id disagree: ${entry}`);
    requireValue(taskStatuses.includes(String(task.status)), 'invalid_task', `Unknown task status: ${entry}`);
    const assignments = strings(task.claimed_by_sessions ?? [], 'claimed_by_sessions'); assignments.forEach(sid);
    const refs = (value: unknown, key: string) => strings(value ?? [], key).map(id => { requireValue(/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id), 'invalid_task', `${key} must use same-project task IDs`); return id; });
    const taskParent = task.parent == null ? null : String(task.parent);
    if (taskParent !== null) refs([taskParent], 'parent');
    tasks.push({ id: String(task.id), title: /^#\s+(.+)$/m.exec(fm.body)?.[1] ?? String(task.id), status: String(task.status), parent: taskParent, deps: refs(task.deps, 'deps'), links: refs(task.links, 'links'), claimed_by_sessions: assignments, ready: false, body: fm.body, path: rel(root, file) });
  }
  for (const task of tasks) task.ready = task.status !== 'closed' && task.deps.every(id => tasks.some(dependency => dependency.id === id && dependency.status === 'closed'));
  return { path: rel(root, project), name: path.basename(project), parent: parent ?? null, status: String(data.status), sessions: sessions(data.opencode_sessions), tasks, notePath: rel(root, note) };
}
export function materials(root: string, project: string): Array<{ path: string; size: number }> {
  const result: Array<{ path: string; size: number }> = [];
  const walk = (directory: string) => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (excluded.has(item.name) || item.isSymbolicLink()) continue;
      const file = path.join(directory, item.name); safePath(root, file);
      if (item.isDirectory()) { if (!isProject(root, path.join(file, 'README.md'))) walk(file); }
      else if (item.isFile() && file !== path.join(project, 'README.md')) result.push({ path: rel(root, file), size: fs.statSync(file).size });
    }
  }; walk(project); return result;
}
