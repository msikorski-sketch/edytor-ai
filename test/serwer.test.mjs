// Testy integracyjne: uruchamiają prawdziwy serwer na tymczasowym katalogu danych (bez wywołań modelu).
// Uruchomienie: npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import http from "node:http";
import { uruchomAtrapeWp } from "./atrapa-wp.mjs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const APLIKACJA = path.resolve(import.meta.dirname, "..");
const PORTY = { panel: 28080, strony: 28081, podglad: 28082 };
const PANEL = `http://localhost:${PORTY.panel}`;
const PODGLAD = `http://localhost:${PORTY.podglad}`;
const STRONY = `http://localhost:${PORTY.strony}`;
let dane, serwer, ciastko;

async function uruchomSerwer() {
  serwer = spawn("node", ["serwer.mjs"], {
    cwd: APLIKACJA,
    env: {
      ...process.env,
      // Izolacja od lokalnego konta: agent w testach nie może użyć niczyich danych logowania ani prawdziwego API.
      HOME: path.join(dane, "dom"), CLAUDE_CONFIG_DIR: path.join(dane, "claude"),
      ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_BASE_URL: "http://127.0.0.1:9", EDYTOR_ZRZUTY: "0",
      // Atrapy (WordPress, webhook) działają na 127.0.0.1 — w produkcji te adresy są blokowane (test/siec.test.mjs).
      EDYTOR_SIEC_LOKALNA: "1", EDYTOR_SMTP: "json", EDYTOR_SMTP_OD: "strona@test.pl", EDYTOR_FORMULARZE_LIMIT_KB: "8",
      EDYTOR_DANE: dane, EDYTOR_HASLO: "haslo-testowe", EDYTOR_SEKRET: "sekret",
      EDYTOR_PORT_PANELU: PORTY.panel, EDYTOR_PORT_STRONY: PORTY.strony, EDYTOR_PORT_PODGLADU: PORTY.podglad,
      EDYTOR_ADRES_PANELU: PANEL, EDYTOR_ADRES_PODGLADU: PODGLAD, EDYTOR_ADRES_STRON: STRONY,
      EDYTOR_ADRES_PRODUKCJI: "http://stara-strona.test", EDYTOR_KOPIE: path.join(dane, "..", path.basename(dane) + "-kopie"),
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((ok, blad) => {
    let wyjscie = "";
    serwer.stdout.on("data", (d) => { wyjscie += d; if (wyjscie.includes("Strony:")) ok(); });
    serwer.stderr.on("data", (d) => { wyjscie += d; });
    serwer.on("exit", (kod) => blad(new Error(`Serwer zakończył się (${kod}):\n${wyjscie}`)));
  });
}

async function zatrzymajSerwer() {
  if (!serwer || serwer.exitCode !== null) return;
  const koniec = new Promise((ok) => serwer.on("exit", ok));
  serwer.kill("SIGKILL");
  await koniec;
}

const api = (sciezka, opcje = {}) => fetch(`${PANEL}${sciezka}`, { ...opcje, headers: { Cookie: ciastko, ...opcje.headers } });
const json = (cialo) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cialo) });

before(async () => {
  dane = await fs.mkdtemp(path.join(os.tmpdir(), "edytor-test-"));
  await fs.mkdir(`${dane}-kopie`);
  // 15 starych kopii sprzed dwóch dni: start ma dorobić nową (najnowsza ma > 23 h) i zostawić 14 najnowszych.
  const dwaDniTemu = new Date(Date.now() - 48 * 3600 * 1000);
  for (let i = 1; i <= 15; i++) {
    const plik = path.join(`${dane}-kopie`, `edytor-ai-2026-01-${String(i).padStart(2, "0")}T03-15-00-000Z.tgz`);
    await fs.writeFile(plik, "stara");
    await fs.utimes(plik, dwaDniTemu, dwaDniTemu);
  }
  // Stary układ jednej strony: migracja ma go przenieść do projektu bez zmiany strony publicznej.
  const strona = path.join(dane, "strona");
  await fs.cp(path.join(APLIKACJA, "szablony/glina"), strona, { recursive: true });
  const git = (...a) => execFileSync("git", ["-C", strona, ...a], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  git("init", "-q", "-b", "main"); git("add", "-A"); git("commit", "-qm", "start");
  await fs.mkdir(path.join(dane, "wydania/stare"), { recursive: true });
  await fs.writeFile(path.join(dane, "wydania/stare/index.html"), "<h1>OPUBLIKOWANA</h1>");
  await fs.symlink("wydania/stare", path.join(dane, "produkcja"));
  await fs.writeFile(path.join(strona, "index.html"), "<h1>ROBOCZA</h1>"); // nieopublikowana zmiana
  git("commit", "-qam", "robocza");
  await fs.writeFile(path.join(dane, "stan.json"), JSON.stringify({ opublikowano: "stare" }));
  await uruchomSerwer();
  const odp = await fetch(`${PANEL}/zaloguj`, json({ haslo: "haslo-testowe" }));
  ciastko = odp.headers.get("set-cookie").split(";")[0];
});

after(async () => {
  await zatrzymajSerwer();
  await fs.rm(dane, { recursive: true, force: true });
  await fs.rm(`${dane}-kopie`, { recursive: true, force: true });
});

test("migracja zachowuje opublikowaną wersję strony", async () => {
  assert.equal(await pobierzZHostem("stara-strona.test"), "<h1>OPUBLIKOWANA</h1>");
  const wspolna = await fetch(`${STRONY}/glina/`);
  assert.equal(await wspolna.text(), "<h1>OPUBLIKOWANA</h1>");
});

test("logowanie: złe hasło, brak ciasteczka, limit prób", async () => {
  assert.equal((await fetch(`${PANEL}/zaloguj`, json({ haslo: "zle" }))).status, 401);
  assert.equal((await fetch(`${PANEL}/api/projekty`)).status, 401);
  assert.equal((await api("/api/projekty")).status, 200);
  let ostatni;
  for (let i = 0; i < 11; i++) {
    ostatni = await fetch(`${PANEL}/zaloguj`, { ...json({ haslo: "zle" }), headers: { "Content-Type": "application/json", "X-Forwarded-For": `10.0.0.${i}, 9.9.9.9` } });
  }
  assert.equal(ostatni.status, 429, "podrobiony pierwszy adres w X-Forwarded-For nie omija limitu");
});

test("zapytania POST z obcej strony są odrzucane", async () => {
  const odp = await api("/api/p/glina/opublikuj", { method: "POST", headers: { "Sec-Fetch-Site": "same-site" } });
  assert.equal(odp.status, 403);
});

test("podgląd: osobny origin, wymaga klucza, wstrzykuje skrypt zaznaczania", async () => {
  assert.equal((await fetch(`${PODGLAD}/glina/`)).status, 401);
  assert.equal((await api("/podglad/index.html")).status, 404, "panel nie serwuje plików strony");
  const { wejscie } = await (await api("/api/podglad")).json();
  const przekierowanie = await fetch(`${wejscie}&dalej=/glina/`, { redirect: "manual" });
  assert.equal(przekierowanie.status, 302);
  const podglad = przekierowanie.headers.get("set-cookie").split(";")[0];
  const html = await (await fetch(`${PODGLAD}/glina/`, { headers: { Cookie: podglad } })).text();
  assert.match(html, /ROBOCZA/);
  assert.match(html, /wybieracz\.js/);
  assert.equal((await fetch(`${PODGLAD}/glina/.git/config`, { headers: { Cookie: podglad } })).status, 404);
  assert.equal((await fetch(`${PODGLAD}/glina/../../stan.json`, { headers: { Cookie: podglad } })).status, 404);
});

test("dowiązania symboliczne nie wyprowadzają poza stronę", async () => {
  const strona = path.join(dane, "projekty/glina/strona");
  await fs.symlink("/etc/passwd", path.join(strona, "wyciek.txt"));
  const { wejscie } = await (await api("/api/podglad")).json();
  const podglad = (await fetch(`${wejscie}&dalej=/`, { redirect: "manual" })).headers.get("set-cookie").split(";")[0];
  assert.equal((await fetch(`${PODGLAD}/glina/wyciek.txt`, { headers: { Cookie: podglad } })).status, 404);
  await fs.rm(path.join(strona, "wyciek.txt"));
});

test("projekty: tworzenie z szablonu, walidacja identyfikatora, duplikat", async () => {
  const odp = await api("/api/projekty?id=salon-test&nazwa=Salon&szablon=pusta", { method: "POST" });
  assert.equal(odp.status, 200);
  assert.equal((await odp.json()).adres, `${STRONY}/salon-test/`);
  assert.equal((await api("/api/projekty?id=salon-test&nazwa=X", { method: "POST" })).status, 409);
  assert.equal((await api("/api/projekty?id=../zle&nazwa=X", { method: "POST" })).status, 400);
  assert.match(await (await fetch(`${STRONY}/salon-test/`)).text(), /Witaj na nowej stronie/);
});

test("import ZIP: dobry, ze ścieżką ../ i bez HTML", async () => {
  const katalog = await fs.mkdtemp(path.join(os.tmpdir(), "zip-"));
  await fs.mkdir(path.join(katalog, "strona/obrazy"), { recursive: true });
  await fs.writeFile(path.join(katalog, "strona/index.html"), "<h1>Z ZIPA</h1>");
  await fs.writeFile(path.join(katalog, "strona/obrazy/a.png"), "x");
  execFileSync("bsdtar", ["-a", "-cf", "dobry.zip", "strona"], { cwd: katalog });
  await fs.writeFile(path.join(katalog, "a.txt"), "x");
  execFileSync("bsdtar", ["-a", "-cf", "bezhtml.zip", "a.txt"], { cwd: katalog });
  execFileSync("python3", ["-c", "import zipfile;z=zipfile.ZipFile('zly.zip','w');z.writestr('index.html','x');z.writestr('../../uciekinier.html','x');z.close()"], { cwd: katalog });
  const zip = (plik) => ({ method: "POST", headers: { "Content-Type": "application/zip" }, body: fsSync(path.join(katalog, plik)) });

  const dobry = await api("/api/projekty?id=z-zipa&nazwa=Zip", zip("dobry.zip"));
  assert.equal(dobry.status, 200);
  assert.match(await (await fetch(`${STRONY}/z-zipa/`)).text(), /Z ZIPA/);
  assert.equal((await fetch(`${STRONY}/z-zipa/obrazy/a.png`)).status, 200, "zawartość jedynego folderu trafia na główny poziom");
  assert.equal((await api("/api/projekty?id=zly-zip&nazwa=Z", zip("zly.zip"))).status, 400);
  assert.equal((await api("/api/projekty?id=bez-html&nazwa=Z", zip("bezhtml.zip"))).status, 400);
  const lista = (await (await api("/api/projekty")).json()).projekty.map((p) => p.id);
  assert.ok(!lista.includes("zly-zip") && !lista.includes("bez-html"), "nieudany import nie zostawia projektu");
  await fs.rm(katalog, { recursive: true, force: true });
});

test("pliki: wgrywanie, walidacja nazw, usuwanie, eksport ZIP", async () => {
  const wgraj = (sciezka) => api(`/api/p/salon-test/pliki?sciezka=${encodeURIComponent(sciezka)}`, { method: "POST", body: "PNG" });
  assert.equal((await wgraj("obrazy/zespol.png")).status, 200);
  for (const zla of ["../x.png", ".env", "obrazy/a b.png", "skrypt.php", "obrazy/.ukryty.png"]) {
    assert.equal((await wgraj(zla)).status, 400, zla);
  }
  const { pliki } = await (await api("/api/p/salon-test/pliki")).json();
  assert.ok(pliki.some((p) => p.sciezka === "obrazy/zespol.png"));
  assert.equal((await api("/api/p/salon-test/usun-plik", json({ sciezka: "obrazy/zespol.png" }))).status, 200);
  assert.equal((await api("/api/p/salon-test/usun-plik", json({ sciezka: "nie-ma.png" }))).status, 404);
  const eksport = await api("/api/p/salon-test/eksport");
  assert.equal(eksport.headers.get("content-type"), "application/zip");
  assert.equal(Buffer.from(await eksport.arrayBuffer()).subarray(0, 2).toString(), "PK");
});

test("publikacja: tylko pliki śledzone przez git, wybór wersji, cofanie", async () => {
  const strona = path.join(dane, "projekty/salon-test/strona");
  await fs.writeFile(path.join(strona, ".gitignore"), "prywatne.env\n");
  await fs.writeFile(path.join(strona, "prywatne.env"), "SEKRET");
  await api("/api/p/salon-test/pliki?sciezka=nowa.html", { method: "POST", body: "<p>nowa</p>" });
  const pierwsza = (await (await api("/api/p/salon-test/historia")).json()).wpisy.at(-1).commit;
  assert.equal((await api("/api/p/salon-test/opublikuj", json({}))).status, 200);
  assert.equal((await fetch(`${STRONY}/salon-test/nowa.html`)).status, 200);
  assert.equal((await fetch(`${STRONY}/salon-test/prywatne.env`)).status, 404);
  // przywrócenie starszej wersji na stronie publicznej
  assert.equal((await api("/api/p/salon-test/opublikuj", json({ commit: pierwsza }))).status, 200);
  assert.equal((await fetch(`${STRONY}/salon-test/nowa.html`)).status, 404);
  const { wpisy } = await (await api("/api/p/salon-test/historia")).json();
  assert.equal((await api("/api/p/salon-test/cofnij", json({ commit: wpisy[0].commit }))).status, 200);
  assert.equal((await api("/api/p/salon-test/cofnij", json({ commit: "zly;rm" }))).status, 400);
});

test("ustawienia: domena projektu kieruje ruch na jego stronę", async () => {
  assert.equal((await api("/api/p/salon-test/ustawienia", json({ domena: "zła domena" }))).status, 400);
  assert.equal((await api("/api/p/salon-test/ustawienia", json({ domena: "https://www.salon-test.pl/" }))).status, 200);
  assert.equal((await api("/api/p/z-zipa/ustawienia", json({ domena: "www.salon-test.pl" }))).status, 409, "jedna domena = jeden projekt");
  assert.match(await pobierzZHostem("www.salon-test.pl"), /Witaj na nowej stronie/);
});

test("polecenie: złe zapytania nie zostawiają blokady ani zajętego miejsca agenta", async () => {
  for (const cialo of ["null", '{"tresc":42}', '{"tresc":"x","obrazy":{}}', "nie-json"]) {
    const odp = await api("/api/p/salon-test/polecenie", { method: "POST", headers: { "Content-Type": "application/json" }, body: cialo });
    assert.ok([400].includes(odp.status) || odp.status === 200, `${cialo} → ${odp.status}`);
    if (odp.status === 200) await odp.text(); // obrazy:{} jest ignorowane, polecenie rusza — czekamy na koniec
  }
  const zdrowie = await (await fetch(`${PANEL}/zdrowie`)).json();
  assert.equal(zdrowie.aktywniAgenci, 0);
  assert.equal((await api("/api/p/salon-test/historia").then((r) => r.json())).zajete, null);
  assert.equal((await api("/api/p/salon-test/opublikuj", json({}))).status, 200, "projekt nie jest zablokowany");
});

test("import ZIP: ukryte pliki i .gitignore nie trafiają na stronę; nazwy ze spacją działają", async () => {
  const katalog = await fs.mkdtemp(path.join(os.tmpdir(), "zip2-"));
  execFileSync("python3", ["-c", `
import zipfile
z = zipfile.ZipFile("sekrety.zip", "w")
z.writestr("index.html", "<h1>ok</h1>")
z.writestr(".env", "KLUCZ=tajny")
z.writestr(".gitignore", "*")
z.writestr("baza.sql", "dump")
z.writestr("Moje zdjecie.jpg", "jpg")
z.close()`], { cwd: katalog });
  const odp = await api("/api/projekty?id=sekrety&nazwa=S", { method: "POST", headers: { "Content-Type": "application/zip" }, body: fsSync(path.join(katalog, "sekrety.zip")) });
  assert.equal(odp.status, 200);
  const { pominiete } = await odp.json();
  assert.ok(pominiete.includes(".env") && pominiete.includes("baza.sql"));
  assert.equal((await fetch(`${STRONY}/sekrety/.env`)).status, 404);
  assert.equal((await fetch(`${STRONY}/sekrety/`)).status, 200, ".gitignore z „*” nie blokuje pierwszego commita");
  assert.equal((await fetch(`${STRONY}/sekrety/Moje%20zdjecie.jpg`)).status, 200);
  assert.equal((await api("/api/p/sekrety/usun-plik", json({ sciezka: "Moje zdjecie.jpg" }))).status, 200);
  await fs.rm(katalog, { recursive: true, force: true });
});

test("równoległe tworzenie projektu o tym samym id: jeden sukces, jeden konflikt", async () => {
  const [a, b] = await Promise.all([1, 2].map(() => api("/api/projekty?id=rownolegly&nazwa=R&szablon=pusta", { method: "POST" })));
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const lista = await fs.readdir(path.join(dane, "projekty"));
  assert.ok(!lista.some((n) => n.startsWith(".nowy-")), "nie zostają katalogi robocze");
});

test("wgrywanie nie przechodzi przez dowiązany katalog", async () => {
  const zewnetrzny = await fs.mkdtemp(path.join(os.tmpdir(), "poza-"));
  await fs.symlink(zewnetrzny, path.join(dane, "projekty/salon-test/strona/grafiki"));
  const odp = await api(`/api/p/salon-test/pliki?sciezka=${encodeURIComponent("grafiki/a.png")}`, { method: "POST", body: "x" });
  assert.equal(odp.status, 400);
  assert.deepEqual(await fs.readdir(zewnetrzny), []);
  await fs.rm(path.join(dane, "projekty/salon-test/strona/grafiki"));
  await fs.rm(zewnetrzny, { recursive: true, force: true });
});

test("domeny edytora są zarezerwowane, a wspólna domena zawsze trasuje po ścieżce", async () => {
  for (const domena of ["localhost"]) {
    assert.equal((await api("/api/p/z-zipa/ustawienia", json({ domena }))).status, 400);
  }
  assert.match(await pobierzZHostem("localhost", "/z-zipa/"), /Z ZIPA/);
});

test("kopie: po dobie powstaje nowa, rotacja zostawia 14 najnowszych, kopia zawiera projekty", async () => {
  const kopie = () => fs.readdir(`${dane}-kopie`).then((l) => l.filter((n) => n.endsWith(".tgz")).sort());
  let lista = await kopie();
  for (let i = 0; i < 50 && !lista.some((n) => !n.includes("2026-01-")); i++) {
    await new Promise((ok) => setTimeout(ok, 100));
    lista = await kopie();
  }
  const nowa = lista.find((n) => !n.includes("2026-01-"));
  assert.ok(nowa, "powstała nowa kopia");
  assert.equal(lista.length, 14, "rotacja: 14 kopii");
  assert.ok(!lista.includes("edytor-ai-2026-01-01T03-15-00-000Z.tgz") && !lista.includes("edytor-ai-2026-01-02T03-15-00-000Z.tgz"), "usunięto dwie najstarsze");
  const zawartosc = execFileSync("tar", ["tzf", path.join(`${dane}-kopie`, nowa)]).toString();
  assert.match(zawartosc, /projekty\/glina\/strona\/\.git\/HEAD/);
  assert.doesNotMatch(zawartosc, /(^|\/)claude\//m, "bez pamięci rozmów agenta");
  assert.equal((await (await fetch(`${PANEL}/zdrowie`)).json()).ostatniaKopia.nazwa, nowa);
});

test("usuwanie projektu: wymaga potwierdzenia, przenosi do kosza, strona przestaje działać", async () => {
  assert.equal((await api("/api/p/rownolegly/usun", json({ potwierdzenie: "zle" }))).status, 400);
  assert.equal((await fetch(`${STRONY}/rownolegly/`)).status, 200);
  assert.equal((await api("/api/p/rownolegly/usun", json({ potwierdzenie: "rownolegly" }))).status, 200);
  assert.equal((await fetch(`${STRONY}/rownolegly/`)).status, 404);
  assert.ok(!(await (await api("/api/projekty")).json()).projekty.some((p) => p.id === "rownolegly"));
  const kosz = await fs.readdir(path.join(dane, "kosz"));
  assert.ok(kosz.some((n) => n.startsWith("rownolegly-")), "projekt jest w koszu");
  // ten sam identyfikator można użyć ponownie
  assert.equal((await api("/api/projekty?id=rownolegly&nazwa=R2&szablon=pusta", { method: "POST" })).status, 200);
});

// Odczyt strumienia SSE z importu: lista zdarzeń.
async function zdarzeniaSse(odp) {
  const tekst = await odp.text();
  return tekst.split("\n\n").filter((b) => b.startsWith("data: ")).map((b) => JSON.parse(b.slice(6)));
}

test("import z adresu: strona WordPressa staje się projektem ze względnymi linkami i działającym formularzem", { timeout: 60000 }, async (t) => {
  const wp = await uruchomAtrapeWp();
  t.after(() => wp.zamknij());
  const odp = await api(`/api/projekty/import-url?id=z-wp&nazwa=Z%20WP&url=${encodeURIComponent(wp.adres + "/")}`, { method: "POST" });
  const zdarzenia = await zdarzeniaSse(odp);
  const koniec = zdarzenia.find((z) => z.typ === "koniec");
  assert.ok(koniec, JSON.stringify(zdarzenia));
  assert.equal(koniec.strony, 4);
  assert.equal(koniec.formularze, 1);
  const glowna = await (await fetch(`${STRONY}/z-wp/`)).text();
  assert.doesNotMatch(glowna, /127\.0\.0\.1:\d+\/wp-content/, "brak bezwzględnych adresów do starej strony");
  assert.doesNotMatch(glowna, /wp-emoji|_wpemojiSettings|api\.w\.org|generator/);
  assert.match(glowna, /src="wp-content\/uploads\/2024\/05\/zespol\.jpg"/, "leniwy obrazek ma prawdziwe src");
  assert.match(glowna, /href="o-nas\/"/);
  for (const plik of ["wp-content/uploads/2024/05/biuro.jpg", "wp-content/themes/motyw/fonts/f.woff2", "ukryta-podstrona/", "o-nas/", "kontakt/"]) {
    assert.equal((await fetch(`${STRONY}/z-wp/${plik}`)).status, 200, plik);
  }
  const kontakt = await (await fetch(`${STRONY}/z-wp/kontakt/`)).text();
  assert.match(kontakt, /<form action="__formularz" method="post"/);
  assert.doesNotMatch(kontakt, /_wpcf7/);
});

test("migracja SEO: 301 ze starych adresów, strona 404 z oryginału, sitemap/robots, noindex tylko na wspólnej domenie", async () => {
  // Przekierowanie ze skrótu WordPressa ?p=ID na nową ścieżkę (dodane przez import z adresu).
  const p7 = await fetch(`${STRONY}/z-wp/?p=7`, { redirect: "manual" });
  assert.equal(p7.status, 301);
  assert.equal(p7.headers.get("location"), "/z-wp/o-nas/");
  // Adres przekierowany przez WordPress (/kontakt → /kontakt/) — plik istnieje, więc bez pętli przekierowań.
  assert.equal((await fetch(`${STRONY}/z-wp/kontakt/`)).status, 200);
  // Strona 404 z oryginału: kod 404, treść motywu i <base>, żeby linki działały z każdej głębokości.
  const brak = await fetch(`${STRONY}/z-wp/a/b/c/nie-ma/`);
  assert.equal(brak.status, 404);
  const html404 = await brak.text();
  assert.match(html404, /404 motywu/);
  assert.match(html404, /<base href="\/z-wp\/">/);
  // sitemap.xml i robots.txt wygenerowane przy publikacji (z pełnymi adresami).
  const mapa = await (await fetch(`${STRONY}/z-wp/sitemap.xml`)).text();
  assert.match(mapa, new RegExp(`<loc>${STRONY}/z-wp/o-nas/</loc>`));
  assert.doesNotMatch(mapa, /404\.html/);
  assert.match(await (await fetch(`${STRONY}/z-wp/robots.txt`)).text(), /Sitemap: .*\/z-wp\/sitemap\.xml/);
  // Kopia na wspólnej domenie nie jest indeksowana; na własnej domenie — jest.
  assert.equal((await fetch(`${STRONY}/z-wp/`)).headers.get("x-robots-tag"), "noindex");
  const zDomeny = await new Promise((ok) => http.get({ host: "localhost", port: PORTY.strony, path: "/", headers: { Host: "stara-strona.test" } }, ok));
  assert.equal(zDomeny.headers["x-robots-tag"], undefined);
  zDomeny.resume();
});

test("raport migracji: wykryte elementy wymagające uwagi, brak raportu dla projektu spoza importu", async () => {
  const odp = await api("/api/p/z-wp/raport-importu");
  assert.equal(odp.status, 200);
  const raport = await odp.json();
  assert.ok(raport.strony > 0 && raport.przekierowania > 0);
  const rodzaje = Object.fromEntries(raport.uwagi.map((u) => [u.rodzaj, u]));
  assert.deepEqual(rodzaje.wyszukiwarka?.strony, ["/o-nas/"]);
  assert.equal(rodzaje.wyszukiwarka.waga, "nie działa");
  assert.ok(rodzaje.sledzenie?.strony.includes("/o-nas/"), "GTM wykryty");
  assert.equal(rodzaje.sklep, undefined, "bez fałszywych alarmów");
  assert.equal((await api("/api/p/salon-test/raport-importu")).status, 404);
});

test("strony publiczne: ETag i 304, czas cache zależny od typu pliku", async () => {
  const pierwsza = await fetch(`${STRONY}/z-wp/`);
  const etag = pierwsza.headers.get("etag");
  assert.match(etag, /^W\/"/);
  assert.equal(pierwsza.headers.get("cache-control"), "public, max-age=60");
  const ponowna = await fetch(`${STRONY}/z-wp/`, { headers: { "If-None-Match": etag } });
  assert.equal(ponowna.status, 304);
  assert.equal(await ponowna.text(), "");
  // Inny ETag (np. po publikacji nowej wersji) → pełna odpowiedź.
  assert.equal((await fetch(`${STRONY}/z-wp/`, { headers: { "If-None-Match": 'W/"stary"' } })).status, 200);
  const css = (await (await fetch(`${STRONY}/z-wp/`)).text()).match(/href="([^"]+\.css)"/)?.[1];
  assert.ok(css, "strona z importu ma arkusz CSS");
  assert.equal((await fetch(`${STRONY}/z-wp/${css}`)).headers.get("cache-control"), "public, max-age=300");
});

test("import z adresu: zły adres i zajęty identyfikator", async () => {
  assert.equal((await api("/api/projekty/import-url?id=x1&nazwa=X&url=ftp%3A%2F%2Fexample.com", { method: "POST" })).status, 400);
  assert.equal((await api("/api/projekty/import-url?id=z-wp&nazwa=X&url=https%3A%2F%2Fexample.com", { method: "POST" })).status, 409);
});

test("formularze: zapis, pułapka na boty, limit, powiadomienia (webhook i e-mail), podgląd", { timeout: 30000 }, async (t) => {
  const odebrane = [];
  const webhook = http.createServer((z, o) => { let t = ""; z.on("data", (d) => { t += d; }); z.on("end", () => { odebrane.push(JSON.parse(t)); o.end("ok"); }); });
  await new Promise((ok) => webhook.listen(0, "127.0.0.1", ok));
  t.after(() => webhook.close()); // zamknięcie także po nieudanej asercji — inaczej otwarty serwer wiesza cały przebieg testów
  assert.equal((await api("/api/p/z-wp/ustawienia", json({ formularzeEmail: "zly-adres" }))).status, 400);
  assert.equal((await api("/api/p/z-wp/ustawienia", json({ formularzeWebhook: "ftp://x" }))).status, 400);
  const ust = await api("/api/p/z-wp/ustawienia", json({ formularzeEmail: "wlasciciel@test.pl", formularzeWebhook: `http://127.0.0.1:${webhook.address().port}/hook` }));
  assert.equal(ust.status, 200);
  assert.equal((await ust.json()).formularze.smtp, true);

  const wyslij = (pola, naglowki = {}) => fetch(`${STRONY}/z-wp/kontakt/__formularz`, {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: `${STRONY}/z-wp/kontakt/`, "X-Forwarded-For": "203.0.113.7", ...naglowki },
    body: new URLSearchParams(pola),
  });
  const ok = await wyslij({ "your-name": "Jan", "your-email": "jan@example.com", "your-message": "Dzień dobry", _gotcha: "", _temat: "Kontakt" });
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /Dziękujemy/);
  const json2 = await wyslij({ imie: "Ala", _powrot: "dziekujemy.html" }, { Accept: "application/json" });
  assert.deepEqual(await json2.json(), { ok: true, komunikat: "Wiadomość została wysłana. Odpowiemy najszybciej, jak to możliwe." });
  const przekierowanie = await wyslij({ imie: "Ola", _powrot: "dziekujemy.html" });
  assert.equal(przekierowanie.status, 303);
  assert.equal(przekierowanie.headers.get("location"), "/z-wp/dziekujemy.html", "_powrot liczony od głównego katalogu strony");
  const bot = await wyslij({ imie: "Spam", _gotcha: "http://spam" });
  assert.equal(bot.status, 200, "bot dostaje udawany sukces");
  assert.equal((await wyslij({ _gotcha: "" })).status, 400, "pusty formularz");
  assert.equal((await wyslij({ x: "a".repeat(6000) })).status, 413);
  for (let i = 0; i < 3; i++) await wyslij({ imie: `limit${i}` });
  assert.equal((await wyslij({ imie: "za dużo" })).status, 429, "limit 5 wysyłek na 10 minut z jednego adresu");

  const { zgloszenia } = await (await api("/api/p/z-wp/formularze")).json();
  assert.equal(zgloszenia.length, 5, "zapisane prawdziwe zgłoszenia (bez bota, pustego i ponad limit)");
  const jan = zgloszenia.find((z) => z.pola["your-name"] === "Jan");
  assert.equal(jan.temat, "Kontakt");
  assert.equal(jan.strona, "/z-wp/kontakt/");
  assert.deepEqual(jan.powiadomienie, { email: "wysłano", webhook: "wysłano" });
  assert.ok(!zgloszenia.some((z) => z.pola.imie === "Spam"));
  assert.ok(odebrane.some((o) => o.pola["your-name"] === "Jan" && o.projekt === "z-wp"));

  // Podgląd: formularz „działa”, ale nic nie zapisuje.
  const { wejscie } = await (await api("/api/podglad")).json();
  const podglad = (await fetch(`${wejscie}&dalej=/`, { redirect: "manual" })).headers.get("set-cookie").split(";")[0];
  const zPodgladu = await fetch(`${PODGLAD}/z-wp/kontakt/__formularz`, { method: "POST", headers: { Cookie: podglad }, body: "imie=Podglad" });
  assert.match(await zPodgladu.text(), /podgląd/i);
  assert.equal((await (await api("/api/p/z-wp/formularze")).json()).zgloszenia.length, 5);
  // Inne POST-y na stronach publicznych są odrzucane.
  assert.equal((await fetch(`${STRONY}/z-wp/`, { method: "POST", body: "x" })).status, 405);
});

test("formularze: limit miejsca na zgłoszenia w miesiącu", async () => {
  let ostatni;
  for (let i = 0; i < 12; i++) {
    ostatni = await fetch(`${STRONY}/z-wp/__formularz`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": `198.51.100.${i}` },
      body: new URLSearchParams({ wiadomosc: "x".repeat(4000) }),
    });
    if (ostatni.status === 503) break;
  }
  assert.equal(ostatni.status, 503, "po przekroczeniu limitu miesięcznego formularz odmawia zamiast zapełniać dysk");
});

test("formularze: usunięty projekt nie przyjmuje zgłoszeń i nie odtwarza katalogu", async () => {
  assert.equal((await api("/api/projekty?id=do-usuniecia&nazwa=U&szablon=pusta", { method: "POST" })).status, 200);
  assert.equal((await api("/api/p/do-usuniecia/usun", json({ potwierdzenie: "do-usuniecia" }))).status, 200);
  const odp = await fetch(`${STRONY}/do-usuniecia/__formularz`, { method: "POST", body: "imie=x", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  assert.equal(odp.status, 404);
  assert.equal(await fs.access(path.join(dane, "projekty/do-usuniecia")).then(() => true, () => false), false);
});

test("zadania globalne: walidacja planu i wykonania, cofnięcie zakresu zmian", async () => {
  assert.equal((await api("/api/p/salon-test/plan", json({ tresc: "" }))).status, 400);
  assert.equal((await api("/api/p/salon-test/zadanie", json({ id: "nie-ma" }))).status, 409, "bez aktualnego planu nie ma wykonania");
  // Cofnięcie zakresu: dwa commity „zadania”, potem powrót do stanu sprzed nich jednym commitem.
  const { wpisy: przed } = await (await api("/api/p/salon-test/historia")).json();
  await api(`/api/p/salon-test/pliki?sciezka=${encodeURIComponent("zadanie-a.html")}`, { method: "POST", body: "<p>a</p>" });
  await api(`/api/p/salon-test/pliki?sciezka=${encodeURIComponent("zadanie-b.html")}`, { method: "POST", body: "<p>b</p>" });
  assert.equal((await api("/api/p/salon-test/cofnij-zadanie", json({ od: przed[0].commit }))).status, 200);
  const pliki = (await (await api("/api/p/salon-test/pliki")).json()).pliki.map((p) => p.sciezka);
  assert.ok(!pliki.includes("zadanie-a.html") && !pliki.includes("zadanie-b.html"));
  assert.equal((await api("/api/p/salon-test/cofnij-zadanie", json({ od: "zle;rm" }))).status, 400);
  assert.equal((await api("/api/p/salon-test/cofnij-zadanie", json({ od: "abcdef1" }))).status, 409);
});

test("wylogowanie unieważnia skopiowane ciasteczko", async () => {
  const kopia = ciastko;
  await api("/wyloguj", { redirect: "manual" });
  assert.equal((await fetch(`${PANEL}/api/projekty`, { headers: { Cookie: kopia } })).status, 401);
});

// fetch pomija nagłówek Host (zabroniony w specyfikacji fetch), więc do testów domen używamy node:http.
function pobierzZHostem(host, sciezka = "/") {
  return new Promise((ok, blad) => {
    http.get({ host: "localhost", port: PORTY.strony, path: sciezka, headers: { Host: host } }, (odp) => {
      let tresc = "";
      odp.on("data", (d) => { tresc += d; });
      odp.on("end", () => ok(tresc));
    }).on("error", blad);
  });
}

function fsSync(plik) {
  return execFileSync("cat", [plik]);
}
