import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { cleanEnv, type Plan } from './git.ts';
import { frontmatter, requireValue, safePath, snapshot, taskFile } from './model.ts';

export const ticketScript = fileURLToPath(new URL('../vendor/ticket/ticket', import.meta.url));
/** Execute the authentic pinned built-ins in an isolated planning directory, never through ambient plugins. */
export function planTask(root: string, project: string, scratch: string, operation: string, args: string[], closeResult?: string): Plan {
  const before = snapshot(root, project);
  if (operation === 'close' && closeResult !== undefined) {
    taskFile(root, project, args[0]!);
    requireValue(before.tasks.find(task => task.id === args[0])!.status !== 'closed', 'already_closed', 'Task is already closed; result was not appended');
  }
  const working = path.join(scratch, path.basename(project));
  const tickets = path.join(working, '.tickets'); fs.mkdirSync(tickets, { recursive: true });
  for (const task of before.tasks) {
    const source = taskFile(root, project, task.id); fs.copyFileSync(source, path.join(tickets, `${task.id}.md`));
  }
  const readId = (id: string | undefined) => { requireValue(id, 'usage', 'An exact local task ID is required'); taskFile(root, project, id); return id; };
  if (operation !== 'create') readId(args[0]);
  if (['dep', 'undep', 'link', 'unlink'].includes(operation)) for (const id of args.slice(1)) readId(id);
  if (operation === 'create') {
    const accepted = new Set(['-d', '--description', '--design', '--acceptance', '-t', '--type', '-p', '--priority', '-a', '--assignee', '--external-ref', '--parent', '--tags']);
    for (let i = 0; i < args.length; i++) if (args[i]!.startsWith('-')) {
      requireValue(accepted.has(args[i]!) && args[i + 1] !== undefined, 'usage', `Unsupported create option: ${args[i]}`);
      if (args[i] === '--parent') readId(args[i + 1]);
      i++;
    }
  }
  const native = (op: string, values: string[]) => {
    const result = spawnSync('/bin/bash', [ticketScript, 'super', op, ...values], { cwd: working, env: cleanEnv({ TICKETS_DIR: tickets, TK_SCRIPT: ticketScript }), encoding: 'utf8', timeout: 15000 });
    requireValue(!result.error && result.status === 0, 'tk_failed', result.error?.message ?? (result.stderr.trim() || `tk ${op} failed (${result.status})`));
    return result;
  };
  let appendedBody: string | undefined;
  if (operation === 'close' && closeResult !== undefined) {
    const file = path.join(tickets, `${args[0]}.md`), prefix = fs.readFileSync(file);
    native('add-note', [args[0]!, closeResult]);
    const appended = fs.readFileSync(file);
    requireValue(appended.length > prefix.length && appended.subarray(0, prefix.length).equals(prefix), 'verification_failed', 'Task result must append to existing bytes and preserve them as prefix');
    appendedBody = frontmatter(appended.toString()).body;
  }
  const result = native(operation, args);
  const files = new Map<string, Buffer | null>();
  let taskId = operation === 'create' ? result.stdout.trim() : args[0]!;
  if (operation === 'create') requireValue(!before.tasks.some(task => task.id === taskId), 'task_collision', 'Generated task ID already exists');
  for (const entry of fs.readdirSync(tickets)) {
    requireValue(/^[A-Za-z0-9][A-Za-z0-9_-]*\.md$/.test(entry), 'invalid_task', 'tk produced an unexpected file');
    const file = path.join(project, '.tickets', entry); safePath(root, file);
    const next = fs.readFileSync(path.join(tickets, entry));
    const old = fs.existsSync(file) ? fs.readFileSync(file) : null;
    if (!old || !old.equals(next)) {
      if (old && operation !== 'add-note') requireValue((appendedBody !== undefined && entry === `${args[0]}.md` ? appendedBody : frontmatter(old.toString()).body) === frontmatter(next.toString()).body, 'verification_failed', 'Native tk changed task prose; original file remains intact');
      if (old && operation === 'add-note') requireValue(next.subarray(0, old.length).equals(old), 'verification_failed', 'Task note must preserve existing bytes as prefix');
      files.set(file, next);
    }
  }
  // Include all owned targets so idempotent and symmetric commands still check dirty/staged edits.
  const owned = operation === 'create' ? [] : (['link', 'unlink'].includes(operation) ? args : [taskId]);
  for (const id of owned) {
    const target = taskFile(root, project, id); if (!files.has(target)) files.set(target, fs.readFileSync(target));
  }
  return { files, data: { output: result.stdout.trim(), taskId }, after: () => { const current = snapshot(root, project); return { project: current, task: current.tasks.find(task => task.id === taskId) ?? null }; } };
}
