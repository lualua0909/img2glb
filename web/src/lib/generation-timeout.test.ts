import assert from "node:assert/strict";
import { test } from "node:test";
import { generationTimeoutMinutes } from "./generation-timeout";

test("ten models receive ten per-model time budgets", () => {
  assert.equal(generationTimeoutMinutes(120, { queueSlots: 10 }), 1200);
});

test("queue draining and lower settings do not shorten the saved deadline", () => {
  assert.equal(generationTimeoutMinutes(60, { queueSlots: 1, timeoutMinutes: 1200 }), 1200);
});

test("legacy jobs and invalid metadata get a finite base timeout", () => {
  for (const state of [null, {}, { queueSlots: -1 }, { queueSlots: NaN, timeoutMinutes: Infinity }]) {
    assert.equal(generationTimeoutMinutes(120, state), 120);
  }
});
