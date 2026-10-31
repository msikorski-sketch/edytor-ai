// Zachowanie agenta przy błędach dostawcy modelu — na atrapie API (lokalny serwer HTTP), bez prawdziwych wywołań.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let katalog, atrapa, odpowiedz;

before(async () => {
  katalog = await fs.mkdtemp(path.join(os.tmpdir(), "model-"));
  const strona = path.join(katalog, "strona");
  await fs.mkdir(strona);
  await fs.writeFile(path.join(strona, "index.html"), "<h1>x</h1>");
  execFileSync("sh", ["-c", "git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm s"], { cwd: strona });
  atrapa = http.createServer((zadanie, odp) => {
    zadanie.resume();
    const { kod, typ, tekst } = odpowiedz;
    odp.writeHead(kod, { "content-type": "application/json", "retry-after": "0" });
    odp.end(JSON.stringify({ type: "error", error: { type: typ, message: tekst } }));
  });
  await new Promise((ok) => atrapa.listen(0, "127.0.0.1", ok));
  // Izolacja: żadnych prawdziwych danych logowania ani prawdziwego API.
  Object.assign(process.env, {
    HOME: path.join(katalog, "dom"), CLAUDE_CONFIG_DIR: path.join(katalog, "claude"),
    ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "atrapa", ANTHROPIC_BASE_URL: `http://127.0.0.1:${atrapa.address().port}`,
    EDYTOR_ZRZUTY: "0", EDYTOR_MODEL: "model-testowy",
  });
});

after(async () => {
  atrapa.close();
  await fs.rm(katalog, { recursive: true, force: true });
});

async function uruchom() {
  const { uruchomAgenta } = await import("../agent.mjs");
  const zdarzenia = [];
  const start = Date.now();
  let wyjatek = null;
  try {
    await uruchomAgenta({ katalog: path.join(katalog, "strona"), polecenie: "test", wyslij: (z) => zdarzenia.push(z) });
  } catch (e) {
    wyjatek = e;
  }
  return { zdarzenia, wyjatek, sekundy: (Date.now() - start) / 1000 };
}

test("wyczerpany limit (429): zrozumiały komunikat w rozsądnym czasie, bez surowego „API Error”", { timeout: 120000 }, async () => {
  odpowiedz = { kod: 429, typ: "rate_limit_error", tekst: "Rate limit exceeded: free-models-per-day" };
  const { zdarzenia, wyjatek, sekundy } = await uruchom();
  assert.match(wyjatek?.message || "", /limit zapytań/);
  assert.ok(zdarzenia.some((z) => z.typ === "blad" && /limit zapytań/.test(z.tekst)));
  assert.ok(!zdarzenia.some((z) => z.typ === "tekst" && /API Error/.test(z.tekst)), "surowy komunikat SDK nie trafia do czatu");
  assert.ok(sekundy < 60, `czekanie ${sekundy.toFixed(0)} s — za długo`);
});

for (const [kod, typ, tekst] of [
  [404, "not_found_error", "No endpoints found for model-testowy"],
  [400, "invalid_request_error", "model-testowy is not a valid model ID"], // tak odpowiada OpenRouter
]) {
  test(`nieistniejący model (${kod}): komunikat o modelu w czacie i w wyjątku`, { timeout: 120000 }, async () => {
    odpowiedz = { kod, typ, tekst };
    const { zdarzenia, wyjatek, sekundy } = await uruchom();
    assert.match(wyjatek?.message || "", /Wybrany model nie istnieje/);
    assert.ok(zdarzenia.some((z) => z.typ === "blad" && /Wybrany model nie istnieje/.test(z.tekst)), JSON.stringify(zdarzenia));
    assert.ok(sekundy < 60);
  });
}
