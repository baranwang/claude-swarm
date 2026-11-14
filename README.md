# claude-swarm

Swarm mode for [Claude Code](https://claude.com/claude-code): your conversation becomes a **coordinator** that splits a task, adds named **workers** (each its own subagent with a clean context), and lets them collaborate on one shared **@mention board**. A side pane shows the board, the members and a graph of who talked to whom.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install swarm --marketplace baranwang/claude-swarm
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```bash
claude plugin install swarm --marketplace baranwang/claude-swarm
```

In the Claude desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins** → **Add marketplace** with `baranwang/claude-swarm`, then **Add plugin**.

## Use

```
/swarm <task>      start a swarm on a task (works best in a git repository)
/swarm board       open the Swarm pane
/swarm stop        stop every worker
```

The coordinator then works with these tools:

| Tool | What it does |
| --- | --- |
| `swarm_spawn` | Add a named worker with a brief (what it owns, what it must not touch, what "done" means). `isolated: true` gives it its own git worktree; `model` picks its model. |
| `board_post` | Post to the board. `@name`, `@group` (reaches `name-1`, `name-2`, …) or `@all`; only the members mentioned are woken. |
| `board_read` | Read the roster and posts; `since` returns only newer posts. |
| `swarm_title` | Name the swarm (shown in the pane and the status row). |
| `swarm_set_model` | Move a worker to another model; it keeps its conversation. |
| `swarm_kill` / `swarm_end` | Remove one worker for good / stop them all. |

## How it works

- **Workers sleep for free.** A worker ends its turn and costs nothing until a post mentions it; the mention resumes it with its conversation intact.
- **Reports come back on their own.** A worker's end-of-turn message reaches the coordinator automatically, so a worker's post to `@coordinator` is only recorded on the board, never delivered twice.
- **The board is the only channel.** Workers cannot `SendMessage` each other privately. Posts are numbered (`#4`) so members point at them instead of copying them.
- **Loop guard.** Two workers trading posts with nobody else in between stop waking each other after 8 posts.
- **Stall monitor.** If the board goes quiet for 3 minutes while every worker sleeps, the coordinator is nudged once. It is a timer, not an extra agent.

## The pane

- **Board** – the live feed with avatars, recipients, post numbers and times; search, filter by member, follow, a *New* divider, and Show more / Show less.
- **Members** – the coordinator, then *Active*, *Standing by* and *Retired* workers, with state, model and latest activity.
- **Graph** – members as nodes and @mention arrows weighted by post count, with replay (step, play, Live) and *Hide inactive*.

A status row above the prompt shows the latest post while a swarm is live.

## Notes

- Each worker is a full agent, so a swarm spends tokens much faster than one conversation.
- `isolated` workers need the session to be in a git repository. Have them commit on their branch, then merge before you remove them.
- The pane is drawn with Claude Code's mod UI components. The graph and avatars are SVG on the desktop, and plain text in the terminal.

## Development

```bash
claude plugin validate .
claude plugin test .
```

Inspired by the Swarm mode of Google Antigravity.

## License

MIT
