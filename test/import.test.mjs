// Importer bezpośrednio (bez serwera): limity i przypadki brzegowe.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.EDYTOR_SIEC_LOKALNA = "1"; // atrapa działa na 127.0.0.1
const { importujStrone } = await import("../importer.mjs");
const { uruchomAtrapeWp } = await import("./atrapa-wp.mjs");

test("limit stron jest dokładny mimo równoległego pobierania", async (t) => {
  const wp = await uruchomAtrapeWp();
  const cel = await fs.mkdtemp(path.join(os.tmpdir(), "import-limit-"));
  t.after(async () => { wp.zamknij(); await fs.rm(cel, { recursive: true, force: true }); });
  const wynik = await importujStrone(`${wp.adres}/`, cel, { limity: { strony: 2, rownolegle: 4 } });
  assert.equal(wynik.strony, 2);
  assert.ok(wynik.pominiete.length > 0);
});

test("adres bez HTML kończy się czytelnym błędem", async (t) => {
  const wp = await uruchomAtrapeWp();
  const cel = await fs.mkdtemp(path.join(os.tmpdir(), "import-404-"));
  t.after(async () => { wp.zamknij(); await fs.rm(cel, { recursive: true, force: true }); });
  await assert.rejects(importujStrone(`${wp.adres}/nie-ma-takiej/`, cel), /Nie udało się pobrać strony/);
});

async function importuj(t, adres, limity) {
  const wp = await uruchomAtrapeWp();
  const cel = await fs.mkdtemp(path.join(os.tmpdir(), "import-"));
  t.after(async () => { wp.zamknij(); await fs.rm(cel, { recursive: true, force: true }); });
  return { wynik: await importujStrone(`${wp.adres}${adres}`, cel, limity), cel, wp };
}

test("<base href>, kolizja /x.php i /x.html, formularz z plikiem", async (t) => {
  const { wynik, cel } = await importuj(t, "/trudne/", { limity: { strony: 20 } });
  const trudne = await fs.readFile(path.join(cel, "trudne/index.html"), "utf8");
  assert.match(trudne, /href="\.\.\/assets\/styl\.css"/, "styl pobrany spod adresu z <base>");
  assert.ok(await fs.access(path.join(cel, "assets/styl.css")).then(() => true, () => false));
  assert.doesNotMatch(trudne, /<base/);
  const strony = (await fs.readdir(cel)).filter((n) => /^x.*\.html$/.test(n));
  const tresci = await Promise.all(strony.map((n) => fs.readFile(path.join(cel, n), "utf8")));
  assert.ok(tresci.some((x) => /Strona PHP/.test(x)) && tresci.some((x) => /Strona HTML/.test(x)), `obie strony zachowane: ${strony}`);
  assert.match(trudne, /enctype="application\/x-www-form-urlencoded"/);
  assert.doesNotMatch(trudne, /type="file"/);
  assert.equal(wynik.formularzeBezZalacznikow, 1);
  assert.ok(wynik.uwagi.some((u) => u.rodzaj === "zalaczniki"), "raport migracji wspomina o usuniętym polu pliku");
});

test("zasób .js zwracający HTML liczy się do limitu stron", async (t) => {
  const { wynik } = await importuj(t, "/trudne/", { limity: { strony: 1 } });
  assert.equal(wynik.strony, 1);
});

test("limity plików i bajtów są twarde, także dla map strony", async (t) => {
  const { wynik } = await importuj(t, "/", { limity: { pliki: 2 } });
  assert.ok(wynik.pliki <= 2, `pliki: ${wynik.pliki}`);
  const { wynik: w2 } = await importuj(t, "/", { limity: { bajty: 3000 } });
  assert.ok(w2.bajty <= 3000, `bajty: ${w2.bajty}`);
  // Budżet mniejszy niż sama strona startowa: czytelny błąd zamiast pustego projektu.
  await assert.rejects(importuj(t, "/", { limity: { bajty: 100 } }), /limit rozmiaru/);
});

test("koniec czasu kończy import z tym, co zdążyło się pobrać; przerwanie użytkownika nic nie zwraca", async (t) => {
  // Podstrona odpowiada po 2 s, a limit czasu to 300 ms — wynik nie zależy od szybkości komputera.
  const start = Date.now();
  const { wynik, cel } = await importuj(t, "/z-wolna/", { limity: { czasMs: 300 } });
  assert.equal(wynik.przerwanyCzas, true);
  assert.ok(await fs.access(path.join(cel, "z-wolna/index.html")).then(() => true, () => false), "szybkie strony zapisane");
  assert.ok(!(await fs.access(path.join(cel, "wolna/index.html")).then(() => true, () => false)), "wolna podstrona pominięta");
  assert.ok(Date.now() - start < 1500, "import nie czekał na wolną podstronę");
  const wp = await uruchomAtrapeWp();
  const celStop = await fs.mkdtemp(path.join(os.tmpdir(), "import-stop-"));
  t.after(async () => { wp.zamknij(); await fs.rm(celStop, { recursive: true, force: true }); });
  const przerwanie = new AbortController();
  setTimeout(() => przerwanie.abort(), 200); // import czeka wtedy na wolną podstronę (2 s), więc na pewno jeszcze trwa
  await assert.rejects(importujStrone(`${wp.adres}/z-wolna/`, celStop, { sygnal: przerwanie.signal }), /przerwany/);
});

test("formularz Breakdance: action edytora, strona podziękowania, komunikat, bez breakdanceForm.init", async (t) => {
  const { wynik, cel } = await importuj(t, "/kontakt-bd/", { limity: { strony: 10 } });
  assert.ok(wynik.formularze >= 1, "z mapy strony dochodzi też formularz CF7 z /kontakt/");
  const html = await fs.readFile(path.join(cel, "kontakt-bd/index.html"), "utf8");
  assert.match(html, /<form id="contact-form" class="breakdance-form[^"]*" data-steps="0" action="__formularz" method="post"/);
  assert.match(html, /name="_powrot" value="dziekuje\/"/, "strona podziękowania z redirectUrl, liczona od głównego katalogu");
  assert.match(html, /name="_podziekowanie" value="Dzięki, odezwiemy się!"/);
  assert.doesNotMatch(html, /breakdanceForm\.init|data-options|name="form_id"|name="post_id"/);
  assert.match(html, /addEventListener\("submit"/, "bezpiecznik dla skryptów page builderów");
  assert.ok(await fs.access(path.join(cel, "dziekuje/index.html")).then(() => true, () => false));
});
