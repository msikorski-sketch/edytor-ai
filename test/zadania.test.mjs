// Zadania globalne: odczyt planu z odpowiedzi modelu i sprawdzenie strony po zadaniu.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { wyciagnijPlan, sprawdzStrone, polecenieKroku, MAKS_KROKOW } from "../zadania.mjs";

test("plan z bloku ```json```, z gołej tablicy i z angielskimi kluczami", () => {
  assert.deepEqual(wyciagnijPlan('Oto plan:\n```json\n[{"tytul":"Strona A","opis":"utwórz a.html"}]\n```'), [{ tytul: "Strona A", opis: "utwórz a.html" }]);
  assert.equal(wyciagnijPlan('Plan: [{"tytul":"X"},{"tytul":"Y","opis":"y"}] koniec').length, 2);
  assert.equal(wyciagnijPlan('```\n[{"title":"Page","description":"d"}]\n```')[0].tytul, "Page");
});

test("plan: brak JSON, pusta lista i za dużo kroków dają czytelny błąd", () => {
  assert.throws(() => wyciagnijPlan("Nie mam planu."), /oczekiwanym formacie/);
  assert.throws(() => wyciagnijPlan("```json\n[]\n```"), /oczekiwanym formacie/);
  const duzo = JSON.stringify(Array.from({ length: MAKS_KROKOW + 1 }, (_, i) => ({ tytul: `k${i}` })));
  assert.throws(() => wyciagnijPlan(duzo), /najwyżej/);
});

test("polecenie kroku zawiera cały plan i wskazuje bieżący krok", () => {
  const t = polecenieKroku("Dodaj usługi", [{ tytul: "A", opis: "a" }, { tytul: "B", opis: "b" }], 1);
  assert.match(t, /2\. B {3}← TEN KROK/);
  assert.match(t, /krok 2\/2: B/);
});

test("sprawdzenie strony wykrywa zepsute linki i obrazki (próba kontrolna) i przepuszcza poprawne", async (t) => {
  const k = await fs.mkdtemp(path.join(os.tmpdir(), "spr-"));
  t.after(() => fs.rm(k, { recursive: true, force: true }));
  await fs.mkdir(path.join(k, "uslugi"), { recursive: true });
  await fs.writeFile(path.join(k, "index.html"), '<a href="uslugi/">ok</a><a href="https://x.pl">zewn</a><a href="#g">kotwica</a><img src="logo.png"><form action="__formularz"></form>');
  await fs.writeFile(path.join(k, "logo.png"), "x");
  await fs.writeFile(path.join(k, "uslugi/index.html"), '<a href="../index.html">wstecz</a><a href="../brak.html">zły</a><img src="zdjecie%20nowe.jpg">');
  const wynik = await sprawdzStrone(k);
  assert.equal(wynik.strony, 2);
  assert.deepEqual(wynik.bledy.map((b) => b.problem).sort(), ["nie istnieje: ../brak.html", "nie istnieje: zdjecie%20nowe.jpg"]);
  await fs.writeFile(path.join(k, "uslugi/zdjecie nowe.jpg"), "x");
  await fs.writeFile(path.join(k, "brak.html"), "x");
  assert.deepEqual((await sprawdzStrone(k)).bledy, []);
});
