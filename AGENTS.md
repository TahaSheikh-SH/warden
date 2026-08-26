# warden — design invariants

## Keep decide.js pure
No I/O, clocks, randomness, or harness-specific behavior. Keep harness
integration in the adapter/CLI layer.

## Keep decisions as an ordered rule pipeline
Decision rules are named predicates evaluated in priority order with a
final fallback. Add new rules to the existing rule set and cover them
with tests; don't replace the pipeline with ad-hoc branching.

## Keep the action vocabulary fixed
Use `ACTIONS` from `decide.js`; never hardcode action strings. decide.js
does not return `STOP`. Enforcement, including escalation of ignored
`HANDOFF`s and human notification, belongs in the actuator layer.

Do not restore blanket stop-blocking across all harnesses. Enforcement is
intentionally asymmetric because some harnesses can notify but cannot
block. Human notification (`WARDEN_NOTIFY=1`) is opt-in and off by
default; see README.md for trigger conditions and platform coverage.

## Keep tests off the real notification path
`notifyHuman` defaults to the real `execFile`, so a test that reaches it
with `WARDEN_NOTIFY=1` in the environment fires actual desktop
notifications at whoever runs `npm test`. Any test that can reach
`maybeNotifyHuman` must either inject `notifyOpts.execFileFn` or clear
`WARDEN_NOTIFY` at module scope — never rely on the developer's
environment leaving it unset.

## Treat threshold changes as evidence-backed changes
Changes to `THRESHOLDS` or `RISK_MULTIPLIER` require either a backtest
against real transcripts or a cited source. Keep both percentage and
absolute-token thresholds; they measure different failure modes.

## Keep harness-specific behavior out of the shared core
Harnesses adapt to the shared resource-state core. Do not add
harness-specific behavior to the core to accommodate one harness. A new
harness should add an adapter rather than modify the shared core.

## Read context limits from the harness/model
Resolve the context window through `resolveContextWindow`
(`harnesses/claude-code/contextWindow.js`): explicit override, then
harness-reported/settings window, then the per-model table, then
`unknown`. Do not reintroduce an assumed default outside this chain: a
window guessed too large is silent, since `isContextUsageTrustworthy` can
only catch one that's too small. When nothing resolves, report the window
as unknown and let percentage rules stand down; the absolute-token floors
still apply.

## Gate B — what a decide.js rule may read
Before a signal backs a rule in `decide.js`, classify it against every
harness: **passes** (same concept, measurable everywhere — use directly),
**degrades** (real concept, some harnesses can't measure it — normalize
the missing case to `null` and let the rule stand down, same pattern as an
unknown context window), or **fails** (the concept doesn't exist on some
harness — enrichment stays adapter-local; no `decide.js` rule may read it).
Shared-infrastructure changes that never touch `decide.js` or
`core/resourceStateCore.js` (e.g. caching, I/O performance) aren't
signals and this gate doesn't apply to them.

## Avoid new runtime dependencies
Prefer the existing lightweight runtime and test/tooling stack. Add a
runtime dependency only when its benefit clearly justifies the added
complexity.
