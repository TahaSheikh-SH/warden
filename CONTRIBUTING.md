# Contributing

## Before changing code

Read `AGENTS.md` — it lists the design invariants this repo enforces
(decision-pipeline shape, purity of `decide.js`, threshold change rules,
harness/core separation). Changes that conflict with it need a stated reason
in the PR description, not a silent workaround.

## Workflow

```
npm install
npm test
npm run lint
npm run format:check
```

All four must pass before opening a PR. `npm run deps:unused` and
`npm run deps:circular` are also run in CI.

## Adding a decision rule

Rules live in `decide.js` as named predicates evaluated in priority order.
Add the predicate, add it to the pipeline, and cover it in
`test/decide.test.js` — don't special-case behavior with ad-hoc branching
elsewhere.

## Changing thresholds

`THRESHOLDS` and `RISK_MULTIPLIER` in `decide.js` are evidence-backed, not
tunable by feel. A PR that changes them needs either a backtest against a
real transcript (`scripts/backtest.js`) or a cited source, referenced in the
PR description.

## Adding a harness

Add an adapter under `harnesses/<name>/`; don't modify `core/resourceStateCore.js`
or `decide.js` to accommodate one harness's quirks.

## Runtime dependencies

Warden ships with zero runtime dependencies. Adding one needs a clear
justification in the PR — prefer the existing lightweight stack.
