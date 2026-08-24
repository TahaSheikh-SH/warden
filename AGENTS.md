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

## Treat threshold changes as evidence-backed changes
Changes to `THRESHOLDS` or `RISK_MULTIPLIER` require either a backtest
against real transcripts or a cited source. Keep both percentage and
absolute-token thresholds; they measure different failure modes.

## Keep harness-specific behavior out of the shared core
Harnesses adapt to the shared resource-state core. Do not add
harness-specific behavior to the core to accommodate one harness. A new
harness should add an adapter rather than modify the shared core.

## Read context limits from the harness/model
Use the actual context window when available. Treat the configured
default as a last-resort fallback, not a value to keep manually
synchronized.

## Avoid new runtime dependencies
Prefer the existing lightweight runtime and test/tooling stack. Add a
runtime dependency only when its benefit clearly justifies the added
complexity.
