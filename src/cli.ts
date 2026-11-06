import fs from 'node:fs';
import path from 'node:path';
import { bytes, fileBytes, mutate, vault, type Envelope, type Plan } from './git.ts';
import { discover, frontmatter, inConvention, isProject, materials, namedLink, nearest, PJError, projectStatuses, rel, requireValue, safePath, sessions, setField, setSessions, sid, snapshot, taskFile, within } from './model.ts';
import { planTask } from './tasks.ts';

const usage = 'pj init [--adopt] | show | list [--session SID] | context | session link/unlink SID [--title TITLE] | session fork SOURCE TARGET [--title TITLE] | status VALUE | tk OP ... | log TEXT [--session SID] | move DESTINATION';
const taskReadOperations = new Set(['list', 'ls', 'show', 'ready', 'blocked', 'closed', 'query']);
function isTaskReadOperation(operation: string | undefined): boolean { return taskReadOperations.has(operation ?? ''); }
function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name); if (index === -1) return undefined;
  requireValue(args[index + 1] && !args[index + 1]!.startsWith('--'), 'usage', `Value required for ${name}`);
  const value = args[index + 1]!; args.splice(index, 2); return value;
}
function booleanFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name); if (index === -1) return false; args.splice(index, 1); return true;
}
function notePlan(root: string, project: string, transform: (text: string) => string): Plan {
  const note = path.join(project, 'README.md');
  return { files: new Map([[note, bytes(transform(fs.readFileSync(note, 'utf8')))]]), after: () => ({ project: snapshot(root, project) }) };
}
function checkTicketsEnv(root: string, project: string, cwd: string) {
  const expected = path.join(project, '.tickets'); safePath(root, expected);
  if (process.env.TICKETS_DIR) {
    const supplied = path.resolve(cwd, process.env.TICKETS_DIR); safePath(root, supplied);
    requireValue(supplied === expected, 'tickets_scope_mismatch', 'TICKETS_DIR must resolve to this project\'s .tickets directory');
  }
}
function movePlan(root: string, project: string, destination: string): Plan {
  const target = path.resolve(root, destination); safePath(root, target);
  requireValue(inConvention(root, target) && !within(project, target) && !within(target, project), 'scope', 'Move destination must be a distinct project path inside the vault conventions');
  requireValue(!fs.existsSync(target), 'destination_exists', 'Move destination already exists');
  const files = new Map<string, Buffer | null>(); const sources: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name); safePath(root, file);
      requireValue(!entry.isSymbolicLink() && !['.git', 'node_modules'].includes(entry.name), 'unsafe_move', 'Move contains a symlink or technical directory');
      if (entry.isDirectory()) walk(file); else { requireValue(entry.isFile(), 'unsafe_move', 'Move contains a special file'); sources.push(file); }
    }
  }; walk(project);
  const mapLocation = (file: string) => within(project, file) ? path.join(target, path.relative(project, file)) : file;
  for (const file of sources) { files.set(file, null); files.set(mapLocation(file), fs.readFileSync(file)); }
  const managed = new Set([...sources.filter(file => file.endsWith('.md')), ...discover(root).flatMap(p => [path.join(root, p.notePath), ...p.tasks.map(task => path.join(root, task.path))])]);
  const freeTextReferences: Array<{ path: string; reference: string }> = [];
  for (const file of managed) {
    const original = fs.readFileSync(file, 'utf8'); const nextFile = mapLocation(file);
    const rewriteHref = (href: string): string => {
      if (!href || /^[a-z][a-z0-9+.-]*:|^[#?\/]/i.test(href)) return href;
      const suffixAt = href.search(/[?#]/u);
      const raw = suffixAt === -1 ? href : href.slice(0, suffixAt);
      const suffix = suffixAt === -1 ? '' : href.slice(suffixAt);
      let decoded: string; try { decoded = decodeURIComponent(raw); } catch { return href; }
      const previousTarget = path.resolve(path.dirname(file), decoded);
      if (!within(root, previousTarget)) return href;
      const newTarget = mapLocation(previousTarget);
      if (nextFile === file && newTarget === previousTarget) return href;
      const relative = rel(path.dirname(nextFile), newTarget) || '.';
      return relative.split('/').map(encodeURIComponent).join('/') + suffix;
    };
    const next = original
      .replace(/(!?\[[^\]\n]*\]\()([^\s)]+)(\))/g, (_full, prefix: string, href: string, suffix: string) => `${prefix}${rewriteHref(href)}${suffix}`)
      // Replace only the definition destination; retain labels, whitespace and optional titles verbatim.
      .replace(/^( {0,3}\[(?:\\.|[^\]\\\r\n])+\]:[\t ]*)(?:<([^>\r\n]*)>|([^\s<>]+))/gm, (_full, prefix: string, angled: string | undefined, bare: string | undefined) => `${prefix}${angled === undefined ? rewriteHref(bare!) : `<${rewriteHref(angled)}>`}`);
    if (next !== original) files.set(nextFile, bytes(next));
    if (original.includes(rel(root, project))) freeTextReferences.push({ path: rel(root, file), reference: rel(root, project) });
  }
  return { files, move: { from: project, to: target }, data: { from: rel(root, project), to: rel(root, target), freeTextReferences }, after: () => ({ project: snapshot(root, target) }) };
}
export function run(argv: string[], cwd = process.cwd()): Envelope {
  const args = argv.filter(arg => arg !== '--json');
  let project: string | null = null;
  let isMutation = false;
  try {
    const command = args.shift();
    if (!command || ['help', '--help', '-h'].includes(command)) return { version: 1, ok: true, project, data: { usage } };
    isMutation = ['init', 'status', 'session', 'log', 'move', '_claim'].includes(command)
      || (command === 'tk' && !isTaskReadOperation(args[0]));
    const root = vault(cwd); safePath(root, cwd);
    const success = (data: Record<string, unknown>): Envelope => ({ version: 1, ok: true, project, data });
    if (command === 'list') {
      const filter = flag(args, '--session'); if (filter) sid(filter);
      requireValue(args.length === 0, 'usage', usage);
      return success({ projects: discover(root).filter(p => !filter || p.sessions.some(s => s.id === filter)) });
    }
    if (command === 'session' && args[0] === 'fork') {
      isMutation = true; args.shift(); const title = flag(args, '--title');
      const source = sid(args.shift()), target = sid(args.shift());
      requireValue(args.length === 0 && source !== target, 'usage', 'pj session fork SOURCE TARGET [--title TITLE]');
      return mutate(root, null, `pj: fork project links ${source} → ${target}`, () => {
        const projects = discover(root).filter(p => p.sessions.some(s => s.id === source));
        const files = new Map<string, Buffer | null>();
        for (const p of projects) {
          const note = path.join(root, p.notePath), text = fs.readFileSync(note, 'utf8');
          const membership = p.sessions.find(s => s.id === target);
          const inherited = { id: target, title: title ?? p.sessions.find(s => s.id === source)!.title };
          files.set(note, bytes(setSessions(text, membership ? p.sessions.map(s => s.id === target && title !== undefined ? inherited : s) : [...p.sessions, inherited])));
        }
        return { files, after: () => ({ projects: discover(root).filter(p => p.sessions.some(s => s.id === target)), source, target }) };
      });
    }
    if (command === 'init') {
      isMutation = true;
      const adopt = booleanFlag(args, '--adopt'), status = flag(args, '--status') ?? 'backlog';
      requireValue(args.length === 0 && projectStatuses.includes(status), 'usage', usage);
      requireValue(inConvention(root, cwd), 'scope', 'Initialize a project folder under projects/ or .archived/');
      project = rel(root, cwd);
      return mutate(root, project, `pj: initialize ${project}`, () => {
        const note = path.join(cwd, 'README.md'); safePath(root, note);
        const previous = fileBytes(note);
        requireValue(!previous || adopt || isProject(root, note), 'adoption_required', 'Existing README requires pj init --adopt');
        if (previous && isProject(root, note)) return notePlan(root, cwd, text => text);
        let next = previous?.toString() ?? '';
        if (next.startsWith('---\n') || next.startsWith('---\r\n')) {
          const fm = frontmatter(next);
          if (!Object.hasOwn(fm.data, 'status')) next = setField(next, 'status', status);
          if (!Object.hasOwn(fm.data, 'opencode_sessions')) next = setField(next, 'opencode_sessions', '[]');
        } else next = `---\nstatus: ${status}\nopencode_sessions: []\n---\n${next ? '\n' + next : ''}`;
        const keep = path.join(cwd, '.tickets', '.gitkeep'); safePath(root, keep);
        const files = new Map<string, Buffer | null>([[note, bytes(next)]]);
        if (!fs.existsSync(path.dirname(keep))) files.set(keep, bytes(''));
        return { files, after: () => ({ project: snapshot(root, cwd) }) };
      });
    }
    const current = nearest(root, cwd); project = rel(root, current);
    if (command === 'show' || command === 'context') {
      requireValue(args.length === 0, 'usage', usage);
      const record = snapshot(root, current);
      return success(command === 'show' ? { project: record } : { project: record, note: fs.readFileSync(path.join(current, 'README.md'), 'utf8'), materials: materials(root, current) });
    }
    if (command === 'status') {
      isMutation = true;
      requireValue(args.length === 1 && projectStatuses.includes(args[0]!), 'invalid_status', `Project status must be one of: ${projectStatuses.join(', ')}`);
      return mutate(root, project, `pj: status ${project} ${args[0]}`, () => notePlan(root, current, text => setField(text, 'status', args[0]!)));
    }
    if (command === 'session') {
      isMutation = true; const title = flag(args, '--title'), operation = args.shift(), id = sid(args.shift());
      requireValue(args.length === 0 && ['link', 'unlink'].includes(operation ?? ''), 'usage', usage);
      return mutate(root, project, `pj: session ${operation} ${id}`, () => {
        const record = snapshot(root, current);
        if (operation === 'unlink') requireValue(!record.tasks.some(task => task.claimed_by_sessions.includes(id)), 'session_assigned', 'Reassign all tasks explicitly before unlinking this session');
        return notePlan(root, current, text => {
          let items = sessions(frontmatter(text).data.opencode_sessions);
          if (operation === 'unlink') items = items.filter(item => item.id !== id);
          else if (items.some(item => item.id === id)) items = items.map(item => item.id === id && title !== undefined ? { id, title } : item);
          else items.push({ id, title: title ?? id });
          return setSessions(text, items);
        });
      });
    }
    if (command === 'log') {
      isMutation = true; const author = flag(args, '--session'); if (author) sid(author);
      requireValue(args.length === 1, 'usage', 'pj log TEXT [--session SID]');
      return mutate(root, project, `pj: log ${project}`, () => notePlan(root, current, text => {
        const title = author ? snapshot(root, current).sessions.find(s => s.id === author)?.title ?? author : '';
        const attribution = author ? `Session: ${namedLink({ id: author, title })}\n\n` : '';
        const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
        return text + (/^## Notes/m.test(text) ? '' : '\n## Notes\n') + `\n**${timestamp}**\n\n${attribution}${args[0]}\n`;
      }));
    }
    if (command === 'move') {
      isMutation = true; requireValue(args.length === 1, 'usage', 'pj move VAULT_RELATIVE_DESTINATION');
      const result = mutate(root, project, `pj: move ${project} → ${args[0]}`, () => movePlan(root, current, args[0]!));
      if (result.ok) result.project = rel(root, path.resolve(root, args[0]!)); return result;
    }
    if (command === 'tk' || command === '_claim') {
      isMutation = command === '_claim' || !isTaskReadOperation(args[0]);
      checkTicketsEnv(root, current, cwd);
      const operation = command === '_claim' ? 'claim' : args.shift();
      if (isTaskReadOperation(operation)) {
        const record = snapshot(root, current); let tasks = record.tasks;
        if (operation === 'show') { requireValue(args.length === 1, 'usage', 'pj tk show EXACT_ID'); taskFile(root, current, args[0]!); return success({ project: record, task: tasks.find(task => task.id === args[0]) }); }
        requireValue(args.length === 0, 'usage', 'Read task commands take no arguments except show EXACT_ID');
        if (operation === 'ready') tasks = tasks.filter(task => task.ready);
        if (operation === 'blocked') tasks = tasks.filter(task => task.status !== 'closed' && !task.ready);
        if (operation === 'closed') tasks = tasks.filter(task => task.status === 'closed');
        return success({ project: record, tasks });
      }
      isMutation = true;
      if (operation === 'claim') {
        requireValue(args.length === 2, 'usage', 'tk claim TASK_ID SESSION_ID'); const id = sid(args[1]);
        return mutate(root, project, `pj: claim ${args[0]} ${id}`, () => {
          const record = snapshot(root, current);
          requireValue(record.sessions.some(s => s.id === id), 'session_not_linked', `Link the session explicitly first: pj session link ${id}`);
          const file = taskFile(root, current, args[0]!);
          return { files: new Map([[file, bytes(setField(fs.readFileSync(file, 'utf8'), 'claimed_by_sessions', `[${id}]`))]]), after: () => { const p = snapshot(root, current); return { project: p, task: p.tasks.find(t => t.id === args[0]) }; } };
        });
      }
      requireValue(operation && ['create', 'start', 'close', 'reopen', 'status', 'add-note', 'dep', 'undep', 'link', 'unlink'].includes(operation), 'unsupported_operation', 'Allowed tk operations: create/start/close/reopen/status/add-note/dep/undep/link/unlink and normalized reads');
      requireValue(operation === 'create' || args.length >= 1, 'usage', 'Task ID required');
      if (['start', 'close', 'reopen'].includes(operation)) requireValue(args.length === 1, 'usage', `${operation} takes exactly one task ID`);
      if (['dep', 'undep', 'unlink', 'status', 'add-note'].includes(operation)) requireValue(args.length === 2, 'usage', `${operation} takes two arguments`);
      if (operation === 'link') requireValue(args.length >= 2, 'usage', 'link takes at least two task IDs');
      return mutate(root, project, `pj: tk ${operation} ${project}`, scratch => planTask(root, current, scratch, operation, args));
    }
    throw new PJError('usage', usage);
  } catch (error) {
    const e = error instanceof PJError ? error : new PJError((error as NodeJS.ErrnoException).code === 'EACCES' ? 'permission_denied' : 'operation_failed', error instanceof Error ? error.message : String(error));
    return { version: 1, ok: false, project, data: {}, ...(isMutation ? { write: { state: 'not_written' as const, paths: [], commit: null } } : {}), error: { code: e.code, message: e.message, ...e.details } };
  }
}
export function main(argv = process.argv.slice(2)) {
  const response = run(argv);
  process.stdout.write(JSON.stringify(response) + '\n');
  if (!response.ok) { process.stderr.write(`${response.error?.code}: ${response.error?.message}\n`); process.exitCode = 1; }
}
