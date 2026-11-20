---
title: pj — file-based project workspaces
status: experimental
updated: 2026-11-20
---

# pj

Project and task CLI for standalone directories and Git-managed vaults. Project records live in `projects/` and `.archived/`. A project is a folder whose `README.md` frontmatter contains `status` and `opencode_sessions`. Its path relative to the workspace root is its address. Nested folders derive their project parent from the nearest project ancestor.

Use the companion [OpenCode plugin](https://github.com/Mishkun/opencode-pj-tk-plugin) to browse projects, tasks and related sessions in the terminal sidebar.

## Install from GitHub

Requires Node **22.23+**, Bash and standard Unix tools. Git is required only for Git-managed vaults (and cloning this source checkout). Standalone operations, including managed tk operations, work without a Git binary. Bun is a project-local development dependency. The CLI runs through Node and needs no global Bun installation.

```sh
git clone https://github.com/Mishkun/pj.git
cd pj
npm ci
export PATH="$PWD/bin:$PATH"
pj --help
```

Add the absolute path to this checkout's `bin` directory to your shell's PATH for future sessions. Keep the checkout and its installed dependencies together.

## Start without Git

In an empty directory:

```sh
pj init --workspace --json
mkdir -p projects/payments
cd projects/payments
pj init --json
pj tk create 'Verify payment' --json
pj root --json
```

`init --workspace` creates `.pj-workspace.json` containing `{"version":1,"storage":"files"}`. This explicit marker defines the root; ordinary `init` creates a project, not a workspace. Repeating either initialization is idempotent. No Git repository is created. `.pj/` holds a workspace-wide mutation lock and temporary planning files; it is excluded from project discovery.

The directory convention is identical in both modes: `projects/<name>/README.md` and `.archived/<name>/README.md`. Keep the marker at their common parent. Root discovery walks ancestors to the nearest explicit workspace or `.git` boundary, never inferring a root from arbitrary `projects/` directories. A standalone bootstrap inside an existing workspace or Git repository is refused. Invalid markers, symlink boundaries and simultaneous Git/standalone markers are errors. A missing or broken Git executable never downgrades an existing Git repository to file-only writes.

`pj root --json` is read-only and returns `data.root` (the validated absolute root) and `data.storage` (`files` or `git`). Integrations should use this result rather than infer the workspace from a Git root.

## Use in a Git repository

An existing Git repository retains its managed commit workflow without a standalone marker. Run project commands inside the target project or its materials directory. Run `root`, `list` and `session fork` anywhere inside either workspace type, including its root. There is no project selector.

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
pj tk close pay-ab12 --result 'Verification passed.' --json
pj tk add-note pay-ab12 'Additional evidence.' --json
pj log 'Payment verification complete.' --session ses_A --json
```

Task IDs in the example are illustrative; `pj tk create` returns `data.taskId` and `data.task.id`. Use exact local task IDs. The native tk parser's partial matching is excluded from managed operations.

## Commands

| Command | Result |
| --- | --- |
| `pj init --workspace` | Initialize an explicit file-only workspace in the current directory |
| `pj root` | Validated absolute workspace root and storage mode |
| `pj init [--status backlog]` | Create README and `.tickets/.gitkeep` in the current folder |
| `pj init --adopt` | Explicitly add project metadata to an existing README; Git mode requires a **clean, tracked** file |
| `pj show` | Current normalized project snapshot |
| `pj list [--session SID] [--archived]` | Compact non-archived projects by default; `--archived` includes both trees |
| `pj list -a` / `pj list --all` | All snapshot fields, including task bodies; archive inclusion still requires `--archived` |
| `pj list --fields FIELD,...` | Explicit projection using the fields listed below |
| `pj context` | Project snapshot, complete README text, material inventory |
| `pj status VALUE` | Set `backlog`, `in-progress`, `waiting`, `blocked` or `done` |
| `pj session link SID [--title TITLE]` | Create or refresh a named project relationship |
| `pj session unlink SID` | Remove a relationship after its task responsibility has been reassigned |
| `pj session fork SOURCE TARGET [--title TITLE]` | Copy every source membership in one mutation (one commit in Git mode); retain task assignments |
| `pj log TEXT [--session SID]` | Append an independently timestamped README Notes entry |
| `pj move DESTINATION` | Move the complete project branch to a vault-relative or absolute destination inside the same vault |
| `pj tk create/start/close/reopen/status/add-note …` | Run the pinned native task operation through the common write boundary |
| `pj tk dep/undep/link/unlink …` | Manage same-project task dependencies and links |
| `pj tk list/ls/query/ready/blocked/closed` | Normalized task reads; these take no extra arguments |
| `pj tk show EXACT_ID` | One normalized task |
| `pj tk claim EXACT_ID SID [--force]` | Claim for a linked session; explicit `--force` permits reassignment |
| `tk claim EXACT_ID SID [--force]` | Native tk plugin dispatch into the same pj write boundary |
| `pj tk close EXACT_ID [--result TEXT]` | Append a nonempty result and close in one managed mutation |

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

Tasks are native tk `.tickets/<id>.md` files. The extra inline field `claimed_by_sessions: [ses_A]` records responsibility. Reads expose all stored assignments. Claim requires a linked SID. The same sole owner returns `unchanged`. Any other owner or multiple stored owners returns `claim_conflict` with `error.owners`, `error.requested` and `write.state: not_written`. Explicit `--force` replaces the owners with the supplied SID. Claim retains task status, unknown metadata and prose.

`pj tk close ID --result TEXT` appends a timestamped native task note and closes the task in one planning directory and one managed mutation. Existing task bytes remain the prefix during note append; the close step preserves the appended prose. A failed append leaves the real task unchanged. An already closed task returns `already_closed` with no duplicate result. Bare close retains its existing idempotence. Standalone `add-note` accepts additional notes on closed tasks. Project status remains an explicit operation.

Parent/dependency/link IDs are local to the project. A task is ready when it is open or in progress and every dependency exists and is closed. Closing a blocker leaves a dependent task's status intact. Markdown checklists are ordinary task text.

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

- List: `data.projects` contains compact records by default: `path`, `name`, `parent`, `status`, `taskCounts: {open,in_progress,closed,ready}`. Counts use task status and readiness; a ready in-progress task contributes to both counts.
- List `-a` / `--all`: every `ProjectSnapshot` field, including task bodies, plus the same computed `taskCounts`. This changes fields only. Add `--archived` to include `.archived/`; otherwise discovery reads `projects/` only. `--session SID` filters within the selected trees.
- List `--fields`: comma-separated names from `path,name,parent,status,taskCounts,sessions,notePath,tasks`. Selected `tasks` contain every task field except `body`. Empty, unknown or duplicate fields and `-a` / `--all` together with `--fields` return a usage error.
- Show: `data.project: ProjectSnapshot`.
- Context: `data.project`, `data.note: string`, `data.materials: {path,size}[]`.
- Writes additionally return saved state projections where applicable. Task writes include `data.task`.
- Error: `error: {code,message,…}` with `ok:false`.

`ProjectSnapshot` contains `path`, `name`, `parent`, `status`, `sessions:[{id,title}]`, `tasks`, and `notePath`. Task records contain `id`, `title`, `status`, `parent`, `deps`, `links`, `claimed_by_sessions`, `ready`, `body` and `path`.

Write states are `committed`, `saved`, `not_written`, `saved_uncommitted`, `unchanged` and `unknown`. `saved` means verified file-only success with `commit:null`; it is not a pending commit. Responses include completed checks. A failed Git commit returns `commit_failed`, `saved_uncommitted`, saved paths and `commit:null`. An unexpected HEAD/tree/index/hook outcome returns `unknown` with `commit:null`. Inspect saved files and, in Git mode, repository state explicitly before deciding a recovery action.

### Project lifecycle notification

Register executables from anywhere inside a workspace:

```sh
pj hook add post-init /absolute/path/to/notify
pj hook add post-move /absolute/path/to/notify
pj hook list
pj hook remove post-init /absolute/path/to/notify
```

Each registration belongs to this user and workspace; cloning a workspace does not enable its hooks. An event can have several executables. Add/remove are idempotent. Register only trusted programs. After a verified project `init` (including adoption) or `move`, pj releases its locks and invokes subscribed executables in registration order from the workspace root with three arguments: event, new project path, and previous path (empty for init). No-op, failed or uncertain writes, `init --workspace`, and unrelated commands do not notify. Git and standalone storage use the same contract. Each executable has three seconds to queue follow-up work. `data.hooks` reports individual delivery outcomes; a failed handler does not undo the project or suppress later handlers. `data.hookError` reports a registry read failure separately from the verified write result.

Post-write cleanup failures return `cleanup_failed` and `unknown`, retaining saved paths and any already verified commit. The response includes cleanup errors so a retained lock can be inspected explicitly. Cleanup errors never turn a completed write into `not_written`.

Consumers, including plugins, invoke the CLI for project links. Library exports in `src/index.ts` provide types and a programmatic runner for local tests; README parsing stays owned by pj.

## File-only write boundary

Mutations hold `.pj/write.lock` exclusively across planning, save and verification. Native tk runs in `.pj/work-*` through its pinned built-ins. The pre-planning inventory records metadata for files under the two convention trees (including `.tickets`), skipping technical directories and nested repository/workspace contents. Targets are checked for concurrent metadata/byte changes, symlinks and hard links. Unrelated manually edited files require no commit. Files are replaced by rename from scratch storage with existing permissions retained; moves rename the branch and then rewrite planned links. Saved bytes and the project overview are verified before reporting `saved`.

This is cooperating-writer serialization, not a multi-file filesystem transaction. Failure after saving begins returns `unknown` with all planned paths, even if only some were saved; there is no automatic rollback or retry. A crash or kill can leave a stale lock and partial changes without a JSON response. Inspect files and the process before removing a stale lock. Power-loss durability/fsync and isolation from arbitrary external editors are not guaranteed. Replacement files retain permission bits, not original ownership, ACLs or extended attributes. Cross-device renames can fail; keep workspace data and `.pj` on the same filesystem. The metadata inventory costs O(workspace entries) per mutation.

## Git write boundary

Each managed mutation:

1. Acquires an exclusive lock in Git's actual common directory and the actual index's `index.lock`.
2. Rereads project data and prepares an exact file plan. Native task operations run using `tk super` in a repository-local temporary planning directory, bypassing ambient plugins.
3. Rejects dirty/staged targets and existing untracked collisions before saving. Actual target bytes are checked against HEAD even with `assume-unchanged`; unrelated working/staged changes stay untouched.
4. Saves, verifies bytes and rebuilds the overview.
5. Starts an isolated index from HEAD (or empty for an unborn branch), stages only owned paths and invokes ordinary `git commit` once with native hooks.
6. Confirms one direct child of the baseline HEAD, its exact expected tree, saved bytes, branch and actual index baseline. Then reconciles only owned index entries into a copy of the original index and atomically installs it through the held lock. Foreign staging entries and flags survive.

Hooks and Git filters are trusted repository code. Hooks can perform arbitrary external actions; pj detects unexpected committed trees/ref changes and reports an unknown result. Writers that bypass pj remain outside its serialization guarantee. The implementation performs no push, automatic retry or rollback. A crash can leave a lock; inspect the process and Git state before explicitly removing a stale lock. Signing and hooks retain the repository's normal behavior, within a 30-second timeout per Git subprocess.

Moves preserve the complete branch, nested projects, task files, binary materials and file modes. A CommonMark parser identifies link destination spans in project notes, task notes and moved Markdown files. Relative link destinations and reference definitions are updated for their new locations, retaining titles and query/fragment suffixes. Frontmatter, code examples and surrounding formatting remain byte-identical. Matching free-text paths are reported in `data.freeTextReferences`. HTML links, wiki links and embedded application-specific path formats require explicit inspection.

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

Tests create isolated temporary Git-vaults and standalone workspaces, and execute real Git, native hooks, the pinned native task script, actual claim dispatcher and Node CLI wrappers. Standalone end-to-end coverage uses a PATH physically excluding the Git binary, including task create/claim/start/close and archive moves. Coverage includes root discovery, invalid boundaries, held locks, injected partial saves, concurrent edits, foreign staging/flags/conflicts, dirty targets, unborn HEAD, concurrent cooperating writers, worktrees, commit/verification failures, hook-expanded trees, read permissions, symlink escapes, nested projects, fork, dependencies, task prose, append-only logs and moves.

The independent acceptance script is maintained separately from the core implementation. Native OpenCode navigation, running-session behavior, sidebar display, session archiving and profile restart acceptance belong to the host integration. Production installation and existing-vault migration require their own explicit cutover.

## License

[MIT](LICENSE). The vendored [wedow/ticket](https://github.com/wedow/ticket) code retains its [upstream MIT license](vendor/ticket/LICENSE).
