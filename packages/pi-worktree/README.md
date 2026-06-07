# pi-worktree

Pi extension for creating, switching, and cleaning up Git worktrees.

## Install

Install this package into a Pi environment that supports public extension packages, then enable the exported extension from `src/index.ts`.

## Command

Registers `/worktree` with support for:

- creating named worktrees from tasks, issues, or pull requests;
- pasting a GitHub issue or PR link after `/worktree create` or `/worktree ccd` to auto-expand it into a worktree title and branch name;
- jumping to recent worktrees;
- creating scratch worktrees;
- cleaning up merged or stale worktrees;
- moving a persistent Pi session into a selected worktree.

Run `/worktree` inside Pi for command-specific help.

## Environment files

By default, the extension symlinks top-level `.env*` files from the primary checkout into new worktrees. Configure this with `.pi/worktree.json`:

```json
{
	"autoSymlinkEnvFiles": false
}
```

Set `autoSymlinkEnvFiles` to `true`, `false`, or an array of top-level file names.

## Example usage

```text
/worktree create fix flaky auth test
/worktree ccd https://github.com/acme/widgets/issues/123
/worktree ccd https://github.com/acme/widgets/pull/456 --base main
/worktree cd
/worktree scratch 1
/worktree clean
/worktree clean --apply
```

`create` creates the worktree. `ccd` creates the worktree and moves the current pi session into it.

For GitHub issue and PR links, `/worktree create` and `/worktree ccd` expand the link into a readable task title and branch name.

## License

MIT. See [LICENSE](LICENSE).
