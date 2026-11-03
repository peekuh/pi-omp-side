# pi-omp-side

`/side <prompt>` delegates a tangent from Pi or OMP to a fork in another
Herdr pane, without moving keyboard focus or changing the parent's conversation.

## Design

- Separate adapters for Pi and OMP, with a dependency-free shared implementation.
- Snapshot only the active branch, before asynchronous launch work.
- Give every child a new native session ID and a separate persisted session file.
- Keep the parent running; never switch its session or wait for its model turn.
- Split the calling pane with `--no-focus` and preserve its working directory.
- Keep the delegated prompt and results out of the parent model context.
- No automatic merge, worktree creation, or filesystem isolation.

Implementation and installation instructions will follow with the adapters.
