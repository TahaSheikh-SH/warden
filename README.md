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

`npm run setup -- --uninstall` reverses every registration setup made —
Claude Code and Codex hooks, the Pi and OpenCode config entries, and the
Claude Code statusLine (restoring whatever command it pointed at before,
recovered from the generated wrapper script). Each registration file is
backed up before either install or uninstall touches it; only the newest 5
backups per file are kept. `~/.warden/sessions` and `~/.warden/cache` are
swept for entries older than 30 days on every write, so neither grows
without bound. Setup also warns if `statusLine` is configured but points at
neither warden nor its generated wrapper — meaning warden's decision line
isn't visible anywhere.

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
generates `~/.warden/claude-statusline.sh` — a wrapper that reads the
status-line payload once and pipes it to your existing command and then to
warden's — and points `statusLine` at that. Your own script is never
edited, so reinstalling it doesn't drop warden's line. To wire it by hand
instead:

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
| `compactContextTokens` | 100,000 | Anthropic's `clear_tool_uses_20250919` default `trigger` (vendor, primary) — corroborated by the [Gemini 2.5 technical report](https://arxiv.org/abs/2507.06261) (agents favor repeating past actions over new plans beyond ~100k tokens) and [LOCA-bench](https://arxiv.org/abs/2602.07962) (Claude-4.5-Opus accuracy 45.3 @ 96K, 34.0 @ 128K vs. 96.0 @ 8K). [Context Rot](https://trychroma.com/research/context-rot) (Chroma) supports only the general claim — long context degrades quality, non-uniformly — not this specific number. |
| `checkpointCompactionCount` | 2 | Re-derived from a local backtest (n=86 epochs, 21 sessions): the original decay premise ([Codex #14589](https://github.com/openai/codex/issues/14589)) did not hold on any of 4 measures, but every compaction costs ~43-46k tokens of cache re-write (~55k token-equivalents), which is real regardless of decay — the rule now fires on count alone, no pct gate |
| `compactContextPct` | 70% | [Context Rot in AI Agents](https://www.mindstudio.ai/blog/context-rot-ai-agents-auto-compact-fix) (MindStudio) — engineering guidance, not peer-reviewed; degradation zone starts ~70-80% context capacity, recommends compacting at 0.7 to fire before it |
| `handoffContextPct` | 92% | Tested — final safety margin |
| `burnRateMinTurnsUntilOverflow`, `minPctForBurnRateTrigger` | 3 turns, 50% | Tested — catches fast-growing sessions before the static % threshold would |
| `checkpointSessionAgeMinutes`, `activeSessionMaxIdleMinutes` | 240m, 30m | Tested — long sessions accrue risk beyond token count |

There used to be a `handoffContextTokens: 200,000` absolute floor. It was
deleted: the cited source (Augment Code) never made the claim attributed to
it, no other source places a degradation breakpoint near 200k, and
[LOCA-bench](https://arxiv.org/abs/2602.07962)'s accuracy curve shows 200k
would have fired *after* quality had already collapsed — late, not
conservative. `HANDOFF` now has only the pct floor above; a future absolute
floor needs its own committed backtest, not a guess.

The remaining pct and absolute-token floors coexist since a percentage means
different things on a 200k vs. 1M window — whichever trips first wins. The
absolute floor is also the only rule that still works when the window is
unknown. Threshold changes need a backtest (`scripts/backtest.js`) or a cited
source — see AGENTS.md.

### Format-drift canary

Claude Code's transcript format is undocumented private on-disk storage — if a
future version renames `usage` or moves it, every line still parses as valid
JSON, `contextUsedTokens` silently stays 0, and warden would otherwise
recommend `CONTINUE` forever with no signal. To catch that: if a session has
parsed more than 20 transcript lines and none of them ever yielded a usable
usage entry, warden logs `driftDetected: true` (plus `harnessVersion` when the
harness reports one, for context) and surfaces a warning through the same
channel it already uses for nudges — the status line on Claude Code, stderr on
Codex. This is diagnostic only; it never gates a `decide()` action.

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
  row, and stays escalated for the rest of the session. Claude Code is
  advisory-only for every action, including `STOP` — exit code 2 on
  `UserPromptSubmit` erases the user's prompt, so warden never returns it.
  Codex can hard-block the turn; Pi/OpenCode can only notify harder.
- Codex has no deterministic, permission-free way to surface advisory
  nudges in its own terminal output — no command-backed status line, and
  its `notify` hook can only spawn an external program (same OS-popup
  path as `WARDEN_NOTIFY`). Claude Code has `actuators/statusline.js` for
  this; Codex doesn't have an equivalent yet.

## Contributing

See `CONTRIBUTING.md`.

## License

MIT — see `LICENSE`.
