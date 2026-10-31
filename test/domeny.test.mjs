// Własne domeny: decyzja na podstawie DNS i konfiguracja dla Traefika.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sprawdzDomene, konfiguracjaTraefika, zapiszKonfiguracje, PLIK_TRAEFIKA } from "../domeny.mjs";

const dns = (adresy) => async () => adresy;
const IP = ["203.0.113.10"];

test("stan domeny zależy od tego, dokąd wskazuje DNS", async () => {
  assert.equal((await sprawdzDomene("a.pl", IP, dns(["203.0.113.10"]))).stan, "aktywna");
  assert.equal((await sprawdzDomene("a.pl", IP, dns([]))).stan, "brak-dns");
  assert.equal((await sprawdzDomene("a.pl", IP, dns(["1.2.3.4"]))).stan, "inny-serwer");
  // Część rekordów na starym hostingu: ruch i walidacja certyfikatu trafiałyby losowo — jeszcze nie aktywna.
  assert.equal((await sprawdzDomene("a.pl", IP, dns(["203.0.113.10", "1.2.3.4"]))).stan, "inny-serwer");
});

test("konfiguracja Traefika: router na domenę, usługa i middleware z providera docker, certyfikat", () => {
  const yml = konfiguracjaTraefika(["www.klient.pl"], { usluga: "edytor-strony@docker", middleware: "edytor-kompresja@docker" });
  assert.match(yml, /edytor-www-klient-pl:\n {6}rule: "Host\(`www\.klient\.pl`\)"/);
  assert.match(yml, /service: edytor-strony@docker/);
  assert.match(yml, /middlewares: \[edytor-kompresja@docker\]/);
  assert.match(yml, /certResolver: letsencrypt/);
  assert.match(konfiguracjaTraefika([], { usluga: "x" }), /routers: \{\}/);
  assert.throws(() => konfiguracjaTraefika(["zla`domena"], { usluga: "x" }), /Niepoprawna/);
});

test("zapis atomowy i bez zbędnych zapisów (Traefik przeładowuje się przy każdej zmianie pliku)", async (t) => {
  const k = await fs.mkdtemp(path.join(os.tmpdir(), "traefik-"));
  t.after(() => fs.rm(k, { recursive: true, force: true }));
  assert.equal(await zapiszKonfiguracje(k, "a"), true);
  assert.equal(await zapiszKonfiguracje(k, "a"), false);
  assert.equal(await fs.readFile(path.join(k, PLIK_TRAEFIKA), "utf8"), "a");
  assert.deepEqual(await fs.readdir(k), [PLIK_TRAEFIKA]);
});
