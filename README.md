# pi-omp-side

Fork a tangent into another [Herdr](https://herdr.dev) pane from **Pi or OMP**, without
moving keyboard focus or putting the tangent in the parent's model context.

```text
/side Investigate whether our webhook handler is idempotent. Don't change files.
```

Keep typing in the original pane. The child inherits a snapshot of the active
conversation branch and automatically starts the delegated task. Switch to its
pane whenever you want to continue that conversation.

## Behavior

- **`/side <prompt>`** forks the current branch and runs the prompt in a sibling pane.
- **`/side`** opens the fork with an empty editor, without making a model request.
- **`/side --name "Task label" [prompt]`** gives the fork an explicit task label.
  Without a prompt, it opens a named idle fork.
- Every child gets a **new native session ID** and its own persisted session file.
  The session header records the original file as `parentSession`.
- The original session is not aborted, switched, or made to wait for a model turn.
- Focus is never moved: pane creation explicitly uses `--no-focus`.
- The calling pane is resolved with Herdr's caller context, not the UI-focused pane.
- Wide panes split right; narrow panes split down. The working directory is preserved.
- Model, thinking level, and active tool selection are passed to the child. The exact
  running host executable and CLI script are used, rather than another version on PATH.
- The child is saved beside the parent and can be resumed with the host's normal
  session picker (`/resume`). OMP's session artifacts are copied to a separate directory.
- The delegated prompt and output are **not** inserted into the parent's conversation.
  The command only shows a local UI notification. There is no automatic merge.

Each fork has its own native session ID; the parent's ID is not reused for cache
affinity. Cache reuse is provider-dependent and is not guaranteed.

## Naming forks

Use `--name` before the prompt to choose a short task label:

```text
/side --name "Webhook audit" Investigate whether webhook processing is idempotent. Don't change files.
/side --name "Test coverage"
```

Both the native Pi/OMP session and the Herdr pane receive the same title:

```text
Payments refactor ↳ Webhook audit · a31f
```

The format is **parent name ↳ task label · first four characters of the child's UUID**.
The parent keeps its original name and ID; the child still owns a new full UUID.

- Without `--name`, the first prompt line becomes the label (up to 80 characters).
- Bare `/side` uses `Explore` as the label.
- An unnamed parent falls back to the working directory's name.
- A fork of a fork uses its immediate parent's task label, avoiding an ever-growing
  title: `Webhook audit ↳ Retry tests · b72e`.
- Parent labels are shortened to 60 characters. Explicit task labels must be
  non-empty, at most 80 Unicode code points, and contain no control characters.
- Single/double quotes, backslash escapes, and `--name="Task label"` are supported.
  Names are parsed locally, never evaluated as shell commands or sent as task text.
- Options must precede the prompt. Use `--` to start a literal prompt that begins
  with `--name`, for example `/side -- --name is an option I want you to explain`.
  After the prompt starts, its quotes, newlines, and option-like text stay literal.

Pane labeling is best-effort: if Herdr cannot rename the new pane, a warning is
shown and the child still launches with its native session name. The launch
notification includes the full title, pane ID, and native session ID.

After updating this checkout, run `/reload` in an already-open agent to load the
new command code. New agent processes load it automatically. Existing forks keep
their names; they are not renamed retroactively.

## Requirements

- Pi or OMP in interactive mode, running inside a Herdr-managed pane.
- A persisted session, not `--no-session`.
- `herdr` on PATH, or `HERDR_BIN_PATH` set.
- A POSIX shell: Linux, macOS, or WSL. Native Windows is not supported.
- Node.js 22.19+ for the local installer and tests. OMP runs its adapter under Bun.

Verified with **Pi 1.2.0, OMP 18.8.4, Herdr 0.8.0, Node 26.12.1, and Bun 1.4.2**
on Linux. Other versions/platforms have not been tested.

## Install locally for both agents

```bash
git clone https://github.com/peekuh/pi-omp-side.git
cd pi-omp-side
npm run install:local
```

The extension has **no runtime npm dependencies**; installing dev dependencies is
only needed to run the typechecker and tests.

The installer writes small absolute-import entrypoints to:

```text
~/.pi/agent/extensions/side.ts
~/.omp/agent/extensions/side.ts
```

It refuses to overwrite an unrelated existing extension. Keep the checkout at its
installed path. Reload or restart both agents after installing. The command is
handled locally; it doesn't require a skill or an extra model-callable tool.

For alternate agent directories or OMP profiles:

```bash
npm run install:local -- --pi-dir /path/to/pi-agent --omp-dir /path/to/omp-agent
```

Remove only this extension's entrypoints:

```bash
npm run install:local -- --uninstall
```

## Important boundaries

**A session fork is not a sandbox.** Parent and child share the same working
directory. Both can edit the same files and run commands. Use separate worktrees
or other isolation when needed; this extension never creates one automatically.

The fork captures finalized entries on the active branch synchronously before
launching the child. It does not include sibling branches or later parent activity.
A still-streaming response is absent. If the parent is in an unfinished tool batch,
the entire unfinished batch is omitted from the fork, including any completed
siblings in that batch; a warning is shown. This avoids orphan tool calls, but
cannot undo filesystem effects already performed by the parent.

This is a history snapshot, not a clone of arbitrary in-memory extension state.
Children load their own usual extensions and configuration. One-off parent CLI
options such as `--append-system-prompt` or disabled discovery are not reproduced.
Native MCP server availability/exposure still follows the child's configuration
and the host's `--tools` behavior; indirect MCP reach is not guaranteed identical.

The initial child message has a `Side task:` prefix so leading `@`, `/`, and `--`
remain literal task text rather than file references, commands, or flags. Prompts
can be multiline; NUL bytes and prompts over 64 KiB are rejected.

The child receives the parent's exported environment, except terminal, Herdr-pane,
and per-session identity variables, which come from the new pane or host process.
Credentials are written only to a private temporary launcher (directory `0700`,
file `0600`), not a shell command line; the launcher deletes itself before starting
the child. If launch cannot be confirmed, the private launcher may remain for
inspection/recovery. Session files are created with mode `0600`.

A startup failure before command submission closes only the newly created pane
and removes the failed fork. An ambiguous submission failure leaves the pane and
session intact rather than risking duplicate work or killing a running child.
The startup toast confirms command submission, not that authentication or a model
request succeeded: inspect the child pane for provider/trust/startup errors.

## Development

```bash
npm ci --ignore-scripts
npm run check
bun test test
```

The automated tests cover unique IDs, immutable snapshots, partial tool batches,
artifact copies, name/option parsing, session and pane labels, literal shell
argument handling, environment separation, no-focus pane creation, failure cleanup,
and safe installation.

Optional live smoke test, **run inside Herdr**: creates two sibling panes, launches
real named idle Pi/OMP children, checks matching session/pane labels, focus, and
parent-file preservation, then closes only its own panes. It makes no model
requests by default.

```bash
node /absolute/path/to/pi-omp-side/scripts/smoke-live.ts
```

To also verify prompt delivery and a real response, specify working model routes
(this makes one small model request per host):

```bash
SIDE_PI_MODEL=provider/model SIDE_OMP_MODEL=provider/model \
  node /absolute/path/to/pi-omp-side/scripts/smoke-live.ts --prompt
```

Add `--host=pi` or `--host=omp` to test just one host. Run from a trusted working
directory, and avoid changing focus during the check. Host startup/provider latency
can make the prompt check take several minutes.

## Layout

```text
pi.ts / omp.ts        Small host adapters
src/extension.ts     Local slash-command orchestration
src/arguments.ts     Leading --name parsing; untouched literal prompt
src/naming.ts        Bounded parent/task/short-ID display titles
src/snapshot.ts      Branch capture and independent session persistence
src/herdr.ts         Explicit-caller, no-focus pane control
src/launch.ts        Safe native-host arguments and private one-shot launcher
scripts/install.ts   Local installation/removal
scripts/smoke-live.ts Opt-in real-host integration test
```

MIT licensed.
