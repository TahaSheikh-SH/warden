'use strict';

// Central pricing table for all cost calculations. Rates are per-token
// (converted from official $/MTok). Cache write assumed 5-minute breakpoint
// (1.25x base input); cache read is 0.1x base input across all models.
// Fetched 2026-08-22 from platform.anthropic.com/docs/about-claude/pricing.
const PRICING = {
  'claude-sonnet-5': {
    input: 2 / 1e6,
    output: 10 / 1e6,
    cacheWrite: 2.5 / 1e6,
    cacheRead: 0.2 / 1e6,
  },
  'claude-opus-5': {
    input: 5 / 1e6,
    output: 25 / 1e6,
    cacheWrite: 6.25 / 1e6,
    cacheRead: 0.5 / 1e6,
  },
  'claude-haiku-4-5-20251001': {
    input: 1 / 1e6,
    output: 5 / 1e6,
    cacheWrite: 1.25 / 1e6,
    cacheRead: 0.1 / 1e6,
  },
  // fallback for older/unlisted model strings seen in real transcripts
  default: { input: 3 / 1e6, output: 15 / 1e6, cacheWrite: 3.75 / 1e6, cacheRead: 0.3 / 1e6 },
};

// Resolve model ID to its pricing row (fallback to default if unrecognized).
function priceFor(modelId) {
  if (!modelId) return PRICING.default;
  const key = Object.keys(PRICING).find((pricingKey) => modelId.includes(pricingKey));
  return key ? PRICING[key] : PRICING.default;
}

module.exports = { PRICING, priceFor };
