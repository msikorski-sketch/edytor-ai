// Szacowanie kosztu polecenia na modelach Claude z tokenów zwróconych przez SDK.
import { test } from "node:test";
import assert from "node:assert/strict";
import { policzZuzycie } from "../agent.mjs";

test("sumuje tokeny z wielu modeli i liczy koszt według cennika", () => {
  const wynik = {
    num_turns: 6,
    modelUsage: {
      "thinkingmachines/inkling:free": { inputTokens: 10000, outputTokens: 2000, cacheReadInputTokens: 100000, cacheCreationInputTokens: 20000 },
      "thinkingmachines/inkling-small:free": { inputTokens: 1000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    },
  };
  const z = policzZuzycie(wynik);
  assert.deepEqual(z.tokeny, { wejscie: 11000, wyjscie: 2000, odczytCache: 100000, zapisCache: 20000 });
  assert.equal(z.tury, 6);
  // Sonnet 5.5: 11000×2 + 20000×2,5 + 100000×0,10 + 2000×10 = 22000 + 50000 + 10000 + 20000 = 102000 → 0,102 $
  assert.equal(z.szacunekUsd["claude-sonnet-5-5"], 0.102);
  assert.equal(z.szacunekUsd["claude-opus-5-5"], 0.204);
  // Haiku 5.5: 1100 + 2500 + 1000 + 1000 = 5600 → 0,0056 $
  assert.equal(z.szacunekUsd["claude-haiku-5-5"], 0.0056);
});
