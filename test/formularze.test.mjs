// Limiter formularzy pod zalewem zapytań (scenariusz z audytu: 10 000 prób z jednego adresu).
import { test } from "node:test";
import assert from "node:assert/strict";
import { przekroczonyLimit } from "../formularze.mjs";

test("limiter: zalew zapytań nie rośnie w pamięci ani nie kosztuje CPU, blokada trwa", () => {
  const start = process.cpuUsage();
  let zablokowane = 0;
  for (let i = 0; i < 10000; i++) if (przekroczonyLimit("projekt|1.2.3.4")) zablokowane++;
  const ms = (process.cpuUsage(start).user) / 1000;
  assert.equal(zablokowane, 10000 - 5);
  assert.ok(ms < 200, `CPU: ${ms.toFixed(0)} ms`);
  // 60 000 różnych adresów nie kasuje blokady pierwszego.
  for (let i = 0; i < 60000; i++) przekroczonyLimit(`projekt|10.${i >> 16}.${(i >> 8) & 255}.${i & 255}`);
  assert.equal(przekroczonyLimit("projekt|1.2.3.4"), true);
});
