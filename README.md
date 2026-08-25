# 🛡️ warden

![CI](https://github.com/TahaSheikh-SH/warden/actions/workflows/ci.yml/badge.svg)
![no runtime deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen)
![node](https://img.shields.io/badge/node-%3E%3D18-blue)

Warden watches your coding-agent session and warns you before the context
window runs out — instead of the agent silently losing track of what it was
doing. It recommends one of five actions, escalating as the session fills up:

```
CONTINUE → COMPACT → CHECKPOINT → HANDOFF → STOP
```

Works with Claude Code, Codex CLI, Pi, and OpenCode.

## Install

```
git clone git@github.com:TahaSheikh-SH/warden.git
cd warden
npm install
npm run setup
```

`npm run setup` wires up a hook for Claude Code and Codex CLI automatically.
Pi and OpenCode don't have a hook registry, so setup prints a manual step
instead.

## Usage

Just printing the recommendation:

```
node cli.js                                        # newest session, cwd
node cli.js <session.jsonl>
node cli.js --context-window <tokens> [session.jsonl]
```

Warden reads the real context window from your harness or model. Use
`--context-window` when it can't be determined — without it, percentage
thresholds are skipped and only the absolute-token floors apply.

To have warden act on its own recommendation (not just print it), install
`actuators/native.js` as a hook — `npm run setup` does this for you, or see
`.claude/settings.json.example`.

### Environment variables (for hooks)

| Variable | Effect |
|---|---|
| `WARDEN_CONTEXT_WINDOW` | Same as `--context-window`. |
| `WARDEN_DISABLE_STOP_BLOCK=1` | Claude Code normally hard-blocks on `STOP`; this reverts it to advisory-only. |
| `WARDEN_NOTIFY=1` | Fire an OS desktop notification when a nudge keeps going unheeded (see below). Off by default. |

### Desktop notifications (`WARDEN_NOTIFY`)

If a nudge keeps getting missed, `WARDEN_NOTIFY=1` pops an OS notification
so you don't miss it. It fires once a non-`CONTINUE` recommendation
(`COMPACT`, `CHECKPOINT`, `HANDOFF`, or `STOP`) has stood for 3 turns in a
row, and again at 5 — the same trigger on every harness, including Pi and
OpenCode, which can't hard-block anything and rely on this as their only
real lever. The popup body is a plain-language message (e.g. "Start a fresh
one.") rather than the raw action name — full detail stays in the JSONL
decision log.

Notification support depends on your OS:

- **macOS** — native, via `osascript`.
- **Windows** — native, via `msg.exe` (not available on Windows Home).
- **Linux** — needs `notify-send` (`libnotify`), usually present on desktop
  distros, often missing on headless/server/container Linux.

Wherever the native notifier is unavailable, warden falls back to a stderr
line + terminal bell — easy to miss if you're not watching the terminal.
Set `WARDEN_NOTIFY=0` or leave it unset to turn this off entirely.

### Status line visibility (Claude Code)

`systemMessage`/`stderr` from an advisory (exit 0) hook response don't
reliably render in the Claude Code CLI (upstream issues
[#50542](https://github.com/anthropics/claude-code/issues/50542),
[#9090](https://github.com/anthropics/claude-code/issues/9090),
[#40380](https://github.com/anthropics/claude-code/issues/40380)) — the
nudge reaches the model via `additionalContext` but isn't guaranteed to
reach you. If you don't want to rely on `WARDEN_NOTIFY`'s OS popups,
`actuators/statusline.js` renders warden's most recently logged decision
as a line in Claude Code's `statusLine` footer, deterministically and
without needing notification permissions.

`npm run setup` wires this for you. If you have no `statusLine` yet, it
points `statusLine` straight at warden. If you already have one, it
generates `~/.warden/claude-statusline.sh` — a wrapper that runs your
existing command and then warden's, feeding both the same stdin payload —
and points `statusLine` at that. Your own script is never edited, so
reinstalling it doesn't drop warden's line. To wire it by hand instead:

```bash
node /path/to/warden/actuators/statusline.js
```

Not session-scoped — shows the latest logged decision across all warden
sessions, not just the current one. Codex has no equivalent mechanism
today (no command-backed status line, no way to write into its own
terminal output from a hook); `WARDEN_NOTIFY=1` remains the only option
there.

### Why these thresholds

| Threshold | Value | Source |
|---|---|---|
| `compactContextTokens` | 100,000 | [Context Rot](https://trychroma.com/research/context-rot) (Chroma) — accuracy degrades past ~50-60k tokens |
| `handoffContextTokens` | 200,000 | [Agent-loop token cost](https://www.augmentcode.com/guides/ai-agent-loop-token-cost-context-constraints) (Augment Code) — planning drift past 200k |
| `checkpointCompactionCount` | 2 | [Codex #14589](https://github.com/openai/codex/issues/14589) — repeated compaction degrades accuracy |
| `checkpointContextPct` | 60% | [Session lifecycle management](https://zylos.ai/research/2026-03-31-context-window-management-session-lifecycle-long-running-agents/) (Zylos) — early warning band |
| `compactContextPct` | 80% | Same source — compact/rotate ceiling |
| `handoffContextPct` | 92% | Tested — final safety margin |
| `burnRateMinTurnsUntilOverflow`, `minPctForBurnRateTrigger` | 3 turns, 50% | Tested — catches fast-growing sessions before the static % threshold would |
| `checkpointSessionAgeMinutes`, `activeSessionMaxIdleMinutes` | 240m, 30m | Tested — long sessions accrue risk beyond token count |

Both pct and absolute-token floors exist since a percentage means different
things on a 200k vs. 1M window — whichever trips first wins. The absolute
floors are also the only rules that still work when the window is unknown.
Threshold changes need a backtest (`scripts/backtest.js`) or a cited source — see
AGENTS.md.

## Layout

- `decide.js` — pure decision function.
- `core/resourceStateCore.js` — harness-agnostic reducer shared by every adapter.
- `harnesses/<name>/` — one per coding agent: transcript normalization + actuator.
- `cli.js` / `actuators/native.js` — print vs. act on the recommendation.
- `scripts/backtest.js` — replays a transcript through `decide()`.

See `AGENTS.md` for design invariants and rationale.

## Known limitations

- Warden never assumes a context window. Claude Code transcripts don't
  report one, so it's inferred from `message.model` against a table in the
  harness adapter; Codex, OpenCode, and Pi read theirs from the harness. When
  none resolves, warden reports `UNKNOWN` rather than guessing — set
  `WARDEN_CONTEXT_WINDOW` to get percentage-based recommendations back.
- `STOP` fires after `HANDOFF` is ignored `GRACE_TURN_LIMIT` (5) turns in a
  row, and stays escalated for the rest of the session. Claude Code/Codex
  can hard-block the turn; Pi/OpenCode can only notify harder.
- Codex has no deterministic, permission-free way to surface advisory
  nudges in its own terminal output — no command-backed status line, and
  its `notify` hook can only spawn an external program (same OS-popup
  path as `WARDEN_NOTIFY`). Claude Code has `actuators/statusline.js` for
  this; Codex doesn't have an equivalent yet.

## Contributing

See `CONTRIBUTING.md`.

## License

MIT — see `LICENSE`.
