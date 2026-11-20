import fs from 'node:fs';
import path from 'node:path';
import { PJError, requireValue, safePath } from './model.ts';

export const marker = '.pj-workspace.json';
export const markerBytes = '{"version":1,"storage":"files"}\n';
export function boundaryExists(file: string): boolean {
  try {
    requireValue(!fs.lstatSync(file).isSymbolicLink(), 'symlink', 'Symlink workspace boundaries are excluded');
    return true;
  } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}
export function standalone(root: string): boolean {
  const file = path.join(root, marker);
  if (!boundaryExists(file)) return false;
  safePath(root, file);
  requireValue(fs.statSync(file).isFile(), 'invalid_workspace', 'Workspace marker must be a regular file');
  let config;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new PJError('invalid_workspace', 'Invalid workspace marker'); }
  requireValue(config?.version === 1 && config?.storage === 'files', 'invalid_workspace', 'Unsupported workspace marker');
  requireValue(!boundaryExists(path.join(root, '.git')), 'workspace_conflict', 'Standalone marker and Git root cannot coexist');
  return true;
}
/** A Git boundary is never bypassed, including when Git is broken or missing. */
export function boundary(cwd: string): { root: string; files: boolean } | null {
  let root = fs.realpathSync(cwd);
  while (true) {
    if (standalone(root)) return { root, files: true };
    if (boundaryExists(path.join(root, '.git'))) return { root, files: false };
    const parent = path.dirname(root);
    if (parent === root) return null;
    root = parent;
  }
}
