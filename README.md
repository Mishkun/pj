---
title: pj — file-based project workspaces
status: experimental
updated: 2026-11-06
---

# pj

Project and task CLI for a Git-vault. Project records live in `projects/` and `.archived/`. A project is a folder whose `README.md` frontmatter contains `status` and `opencode_sessions`. Its path relative to the Git root is its address. Nested folders derive their project parent from the nearest project ancestor.

## Run locally

Requires Node **22.23+**, Git, Bash and standard Unix tools. Bun is a project-local development dependency. The CLI runs through Node and needs no global Bun installation.

```sh
cd /Users/themishkun/projects/pj
npm ci
export PATH="/Users/themishkun/projects/pj/bin:$PATH"
pj --help
```

Run project commands inside the target project or its materials directory. Run `list` and `session fork` anywhere inside the Git-vault, including its root. There is no project selector or root configuration file.

```sh
mkdir -p projects/payments
cd projects/payments
pj init --json
pj status in-progress --json
pj session link ses_A --title 'Payment work' --json
pj tk create 'Verify payment' --description 'Keep ordinary Markdown here.' --json
pj show --json
tk claim pay-ab12 ses_A --json
pj tk start pay-ab12 --json
pj tk close pay-ab12 --json
pj tk add-note pay-ab12 'Verification passed.' --json
pj log 'Payment verification complete.' --session ses_A --json
```

Task IDs in the example are illustrative; `pj tk create` returns `data.taskId` and `data.task.id`. Use exact local task IDs. The native tk parser's partial matching is excluded from managed operations.

## Commands

| Command | Result |
| --- | --- |
| `pj init [--status backlog]` | Create README and `.tickets/.gitkeep` in the current folder |
| `pj init --adopt` | Explicitly add project metadata to an existing **clean, tracked** README |
| `pj show` | Current normalized project snapshot |
| `pj list [--session SID]` | Active and archived project snapshots, including nested projects |
| `pj context` | Project snapshot, complete README text, material inventory |
| `pj status VALUE` | Set `backlog`, `in-progress`, `waiting`, `blocked` or `done` |
| `pj session link SID [--title TITLE]` | Create or refresh a named project relationship |
| `pj session unlink SID` | Remove a relationship after its task responsibility has been reassigned |
| `pj session fork SOURCE TARGET [--title TITLE]` | Copy every source membership in one mutation and one commit; retain task assignments |
| `pj log TEXT [--session SID]` | Append an independently timestamped README Notes entry |
| `pj move DESTINATION` | Move the complete project branch to a vault-relative or absolute destination inside the same vault |
| `pj tk create/start/close/reopen/status/add-note …` | Run the pinned native task operation through the common write boundary |
| `pj tk dep/undep/link/unlink …` | Manage same-project task dependencies and links |
| `pj tk list/ls/query/ready/blocked/closed` | Normalized task reads; these take no extra arguments |
| `pj tk show EXACT_ID` | One normalized task |
| `tk claim EXACT_ID SID` | Native tk plugin dispatch into the same pj write boundary |

All `pj` output and claim-plugin output is a JSON envelope. `--json` is accepted before or after the command. Errors use nonzero exit status and JSON on stdout; concise diagnostics go to stderr. `pj tk add-note` requires explicit note text. Native raw tk commands remain available through `bin/tk`; raw tk mutations have their upstream behavior and sit outside pj's commit guarantees. Use `pj tk` for managed mutations.

## Files and reads

```markdown
---
status: in-progress
opencode_sessions:
  - "[Payment work](raycast://script-commands/opencode-session?arguments=ses_A)"
---

Project context and [materials](docs/spec.md).
```

Unknown frontmatter fields and ordinary Markdown survive managed edits. State-setting calls return `unchanged` when the requested state already holds. Log calls always append, including repeated text. A project log preserves all prior bytes as a prefix and uses the exact native tk add-note timestamp/Notes layout. An explicit `--session` adds attribution; it creates no membership.

Tasks are native tk `.tickets/<id>.md` files. The extra inline field `claimed_by_sessions: [ses_A]` records responsibility. Reads expose all stored assignments. Claim replaces that field with the one explicitly supplied, linked SID, retaining task status, unknown metadata and prose. Parent/dependency/link IDs are local to the project. A task is ready when it is open or in progress and every dependency exists and is closed. Closing a blocker leaves a dependent task's status intact. Markdown checklists are ordinary task text.

Discovery is bounded to the two convention directories and skips symlinks and technical directories, including `.git`, `.tickets`, `node_modules` and `.opencode`. Material inventories skip nested project branches. Paths in snapshots and material records are vault-relative. Reads require native filesystem permissions and create no state. Explicit write targets reject symlinks and hard links.

## Machine contract

```json
{
  "version": 1,
  "ok": true,
  "project": "projects/payments",
  "data": {},
  "write": { "state": "committed", "paths": ["projects/payments/README.md"], "commit": "<sha>" }
}
```

- List: `data.projects: ProjectSnapshot[]`.
- Show: `data.project: ProjectSnapshot`.
- Context: `data.project`, `data.note: string`, `data.materials: {path,size}[]`.
- Writes additionally return saved state projections where applicable. Task writes include `data.task`.
- Error: `error: {code,message,…}` with `ok:false`.

`ProjectSnapshot` contains `path`, `name`, `parent`, `status`, `sessions:[{id,title}]`, `tasks`, and `notePath`. Task records contain `id`, `title`, `status`, `parent`, `deps`, `links`, `claimed_by_sessions`, `ready`, `body` and `path`.

Write states are `committed`, `not_written`, `saved_uncommitted`, `unchanged` and `unknown`. Responses include completed checks; verification errors additionally include check errors. A failed commit returns `commit_failed`, `saved_uncommitted`, saved paths and `commit:null`. An unexpected HEAD/tree/index/hook outcome returns `unknown` with `commit:null`. Inspect Git and saved files explicitly before deciding a recovery action.

Consumers, including plugins, invoke the CLI for project links. Library exports in `src/index.ts` provide types and a programmatic runner for local tests; README parsing stays owned by pj.

## Git write boundary

Each managed mutation:

1. Acquires an exclusive lock in Git's actual common directory and the actual index's `index.lock`.
2. Rereads project data and prepares an exact file plan. Native task operations run using `tk super` in a repository-local temporary planning directory, bypassing ambient plugins.
3. Rejects dirty/staged targets and existing untracked collisions before saving. Actual target bytes are checked against HEAD even with `assume-unchanged`; unrelated working/staged changes stay untouched.
4. Saves, verifies bytes and rebuilds the overview.
5. Starts an isolated index from HEAD (or empty for an unborn branch), stages only owned paths and invokes ordinary `git commit` once with native hooks.
6. Confirms one direct child of the baseline HEAD, its exact expected tree, saved bytes, branch and actual index baseline. Then reconciles only owned index entries into a copy of the original index and atomically installs it through the held lock. Foreign staging entries and flags survive.

Hooks and Git filters are trusted repository code. Hooks can perform arbitrary external actions; pj detects unexpected committed trees/ref changes and reports an unknown result. Writers that bypass pj remain outside its serialization guarantee. The implementation performs no push, automatic retry or rollback. A crash can leave a lock; inspect the process and Git state before explicitly removing a stale lock. Signing and hooks retain the repository's normal behavior, within a 30-second timeout per Git subprocess.

Moves preserve the complete branch, nested projects, task files, binary materials and file modes. Markdown inline relative links and reference definitions in project notes, task notes and moved Markdown files are updated for their new locations, retaining query/fragment suffixes and definition titles. Matching free-text paths are reported in `data.freeTextReferences`. HTML links, wiki links and embedded application-specific path formats require explicit inspection.

## Pinned tk and provenance

The authentic upstream Bash script and all official extras are vendored under `vendor/ticket/` at revision **194b71a8bbc3771da1ce9f579395937c976bbddc** from [wedow/ticket](https://github.com/wedow/ticket). Upstream files are byte-identical; `manifest.json` records source URLs, Git blob hashes and SHA-256 hashes. The upstream MIT license is retained at `vendor/ticket/LICENSE`. The native dispatcher executes the local `tk-claim` plugin. For a missing ambient `TICKETS_DIR`, the wrapper forwards directly to that plugin so the scope error retains its JSON envelope.

Official extras retain upstream dependencies: query/migrate use `jq`; edit uses the user's editor. These extras are available through raw `tk`. Managed normalized reads use pj's parser.

## Verification

```sh
npm run verify:vendor
npm run typecheck
npm test
node acceptance/manager-scenario.mjs /path/to/temporary-evidence-directory
```

Tests create isolated temporary Git-vaults and execute real Git, native hooks, the pinned native task script, actual claim dispatcher and Node CLI wrappers. Coverage includes foreign staging/flags/conflicts, dirty targets, unborn HEAD, held locks, concurrent cooperating writers, worktrees, commit/verification failures, hook-expanded trees, read permissions, symlink escapes, nested projects, fork, dependencies, task prose, append-only logs and moves.

The independent acceptance script is maintained separately from the core implementation. Native OpenCode navigation, running-session behavior, sidebar display, session archiving and profile restart acceptance belong to the host integration. Production installation and existing-vault migration require their own explicit cutover.
