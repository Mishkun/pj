import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { run } from '../src/cli.ts';

for (const storage of ['git', 'files']) test(`post-project-change follows verified ${storage} lifecycle only`, () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pj-event-')));
  const root = path.join(tmp, 'vault'), project = path.join(root, 'projects', 'p');
  const config = path.join(tmp, 'config'), hook = path.join(config, 'pj/hooks/post-project-change');
  const original = process.env.XDG_CONFIG_HOME;
  try {
    process.env.XDG_CONFIG_HOME = config;
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, '#!/bin/sh\nset -eu\ntest ! -e .git/pj.lock && test ! -e .git/index.lock && test ! -e .pj/write.lock || exit 2\nprintf "%s|%s|%s\\n" "$1" "$2" "$3" >> events\n', { mode: 0o755 });
    const other = path.join(tmp, 'second handler');
    fs.writeFileSync(other, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    if (storage === 'git') {
      for (const args of [['init', '-q'], ['config', 'user.name', 'test'], ['config', 'user.email', 'test@example.invalid']])
        expect(spawnSync('git', args, { cwd: root }).status).toBe(0);
    } else expect(run(['init', '--workspace'], root).data.hooks).toBeUndefined();
    expect(run(['hook','list'], root).data.hooks).toEqual([]);
    for (const event of ['post-init','post-move']) {
      expect(run(['hook','add',event,hook], root).data.changed).toBe(true);
      expect(run(['hook','add',event,hook], root).data.changed).toBe(false);
      expect(run(['hook','add',event,other], project).data.changed).toBe(true);
    }
    expect(run(['hook','remove','post-init',other], root).data.changed).toBe(true);
    expect(run(['hook','remove','post-init',other], root).data.changed).toBe(false);
    expect(run(['hook','list','post-init'], project).data.hooks).toEqual([{event:'post-init',executable:hook}]);
    const elsewhere = path.join(tmp,'other');fs.mkdirSync(elsewhere);run(['init','--workspace'], elsewhere);
    expect(run(['hook','list'],elsewhere).data.hooks).toEqual([]);
    expect(run(['init'], project).data.hooks).toEqual([{event:'post-init',executable:hook,state:'delivered'}]);
    expect(run(['init'], project).data.hooks).toBeUndefined();
    expect(run(['status', 'done'], project).data.hooks).toBeUndefined();
    expect(run(['move', 'projects/p'], project).ok).toBe(false);
    expect(run(['move', '.archived/p'], project).data.hooks).toHaveLength(2);
    expect(fs.readFileSync(path.join(root, 'events'), 'utf8')).toBe('post-init|projects/p|\npost-move|.archived/p|projects/p\n');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 42\n');
    const moved = run(['move', 'projects/p'], path.join(root, '.archived/p'));
    expect(moved.ok).toBe(true);
    expect(moved.data.hooks).toEqual([{event:'post-move',executable:hook,state:'failed',message:'exit 42'},
      {event:'post-move',executable:other,state:'delivered'}]);
  } finally {
    if (original === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = original;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
