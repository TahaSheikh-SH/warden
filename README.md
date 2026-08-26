# warden

![CI](https://github.com/TahaSheikh-SH/warden/actions/workflows/ci.yml/badge.svg)
![no runtime deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen)
![node](https://img.shields.io/badge/node-%3E%3D18-blue)

Watches your coding-agent session and warns before the context window runs
out. Recommends one of:

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

`npm run setup` wires up hooks for Claude Code and Codex CLI. Pi and
OpenCode print a manual step instead. `npm run setup -- --uninstall`
reverses everything it registered.

## Usage

```
node cli.js                                        # newest session, cwd
node cli.js <session.jsonl>
node cli.js --context-window <tokens> [session.jsonl]
```

Pass `--context-window` if warden can't determine your context window on
its own — otherwise percentage-based thresholds are skipped.

To have warden act on its own recommendation, install `actuators/native.js`
as a hook (`npm run setup` does this, or see `.claude/settings.json.example`).

### Env vars

| Variable | Effect |
|---|---|
| `WARDEN_CONTEXT_WINDOW` | Same as `--context-window`. |
| `WARDEN_NOTIFY=1` | OS desktop notification if a nudge keeps going unheeded. Off by default. |

### Visibility

- **Desktop notifications** (`WARDEN_NOTIFY=1`) — macOS/Windows native, Linux
  needs `notify-send`. Falls back to stderr + terminal bell elsewhere.
- **Claude Code status line** — `actuators/statusline.js` shows the latest
  decision in your `statusLine` footer. `npm run setup` wires this
  automatically, generating a wrapper if you already have a `statusLine`
  so your own script keeps working.

## Layout

- `decide.js` — pure decision function.
- `core/resourceStateCore.js` — harness-agnostic reducer shared by every adapter.
- `harnesses/<name>/` — one per coding agent: transcript normalization + actuator.
- `cli.js` / `actuators/native.js` — print vs. act on the recommendation.
- `scripts/backtest.js` — replays a transcript through `decide()`.

See `AGENTS.md` for design invariants and threshold rationale.

## Known limitations

- No context window resolves → warden reports `UNKNOWN` rather than
  guessing. Set `WARDEN_CONTEXT_WINDOW` to get it back.
- Claude Code is advisory-only, including `STOP` — it can't hard-block a
  turn. Codex can; Pi/OpenCode can only notify harder.
- Codex has no status-line equivalent; `WARDEN_NOTIFY` is its only nudge.

## Contributing

See `CONTRIBUTING.md`.

## License

MIT — see `LICENSE`.
