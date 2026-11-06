// Edytor AI — trzy serwery w jednym procesie:
//   panel (8080, za logowaniem): interfejs i API,
//   podgląd (8082, osobna domena, za kluczem podglądu): wersje robocze stron z wstrzykniętym skryptem zaznaczania,
//   strony (8081, publicznie): opublikowane wersje — po domenie projektu albo pod /<projekt>/ na wspólnej domenie.
// Podgląd ma inny origin niż panel, więc JavaScript edytowanej strony nie może wywołać API panelu.
import http from "node:http";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { uruchomAgenta, zbudujPolecenie } from "./agent.mjs";
import { plikStrony, wczytajProjekty, utworzProjekt, przeniesStaryUklad, przeniesDoKosza } from "./projekty.mjs";
import { obsluzFormularz, listaZgloszen, usunZgloszenie, csvZgloszen, SMTP_SKONFIGUROWANY } from "./formularze.mjs";
import { importujStrone } from "./importer.mjs";
import { sprawdzAdres } from "./siec.mjs";
import { sprawdzDomene, konfiguracjaTraefika, zapiszKonfiguracje } from "./domeny.mjs";
import { INSTRUKCJE_PLANU, polecenieKroku, wyciagnijPlan, sprawdzStrone } from "./zadania.mjs";
import { katalogDlaPanelu, sprawdzIntegracje, fragmentyStrony, wstawDoHtml } from "./integracje.mjs";
import { haszuj, hasloZgodne, noweHaslo, widziProjekt, mozeAkcje, administrator, opisKonta, sprawdzKonto, MIN_DLUGOSC_HASLA } from "./konta.mjs";

const exec = promisify(execFile);

const KATALOG_APLIKACJI = path.dirname(new URL(import.meta.url).pathname);
const PUBLICZNE = path.join(KATALOG_APLIKACJI, "publiczne");
const SZABLONY = path.join(KATALOG_APLIKACJI, "szablony");
const DANE = process.env.EDYTOR_DANE || "/dane";
const STAN = path.join(DANE, "stan.json");

const URUCHOMIONO = new Date().toISOString();
const HASLO = process.env.EDYTOR_HASLO;
const LOGIN_GLOWNY = (process.env.EDYTOR_LOGIN || "admin").trim().toLowerCase();
const SEKRET = process.env.EDYTOR_SEKRET;
const ADRES_PANELU = process.env.EDYTOR_ADRES_PANELU;
const ADRES_PODGLADU = process.env.EDYTOR_ADRES_PODGLADU;
const ADRES_STRON = (process.env.EDYTOR_ADRES_STRON || "").replace(/\/$/, ""); // wspólna domena: <adres>/<projekt>/
const CZAS_AGENTA = Number(process.env.EDYTOR_LIMIT_CZASU_S || 600) * 1000;
// Każdy agent to osobny proces Claude Code (+ Chromium do zrzutów); limit chroni pamięć serwera.
const MAX_AGENTOW = Number(process.env.EDYTOR_MAX_AGENTOW || 2);
let aktywniAgenci = 0;
if (!HASLO || !SEKRET) throw new Error("Brak EDYTOR_HASLO lub EDYTOR_SEKRET w środowisku.");
// Hasło konta głównego też sprawdzamy przez scrypt: ten sam czas odpowiedzi co dla innych loginów,
// więc pomiar czasu nie zdradza, który login jest kontem głównym.
const SKROT_GLOWNY = await haszuj(HASLO);
if (!ADRES_PANELU || !ADRES_PODGLADU) throw new Error("Brak EDYTOR_ADRES_PANELU lub EDYTOR_ADRES_PODGLADU w środowisku.");

const TYPY = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".xml": "application/xml", ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".avif": "image/avif", ".gif": "image/gif", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".pdf": "application/pdf",
};
const BEZPIECZNE = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin" };

// ---------- stan globalny i projekty ----------

let stan = {};
let kolejkaStanu = Promise.resolve();
// Zapisy po kolei, każdy przez unikalny plik tymczasowy i rename (jak w projektach).
function zapiszStan(zmiany) {
  Object.assign(stan, zmiany);
  const zapis = kolejkaStanu.then(async () => {
    const tymczasowy = `${STAN}.${process.pid}-${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tymczasowy, JSON.stringify(stan, null, 2));
    await fs.rename(tymczasowy, STAN);
  });
  kolejkaStanu = zapis.catch(() => {});
  return zapis;
}

let projekty = new Map();

// Domeny samego narzędzia nie mogą zostać przypisane projektom (inaczej np. wspólna domena stron przestałaby działać).
const DOMENY_ZAREZERWOWANE = new Set([ADRES_PANELU, ADRES_PODGLADU, ADRES_STRON].filter(Boolean).map((a) => new URL(a).hostname));

function adresStrony(projekt) {
  if (projekt.stan.domena) return `https://${projekt.stan.domena}/`;
  return ADRES_STRON ? `${ADRES_STRON}/${projekt.id}/` : null;
}

// `u` — konto, któremu pokazujemy opis: bez prawa do ustawień nie widzi adresu powiadomień ani webhooka
// (adres webhooka działa jak hasło — kto go zna, może wysyłać fałszywe zgłoszenia).
function opisProjektu(projekt, u = null) {
  return {
    id: projekt.id,
    nazwa: projekt.stan.nazwa || projekt.id,
    adres: adresStrony(projekt),
    opublikowano: projekt.stan.opublikowano || null,
    opublikowanoKiedy: projekt.stan.opublikowanoKiedy || null,
    zajete: projekt.zajete,
    formularze: u && !mozeAkcje(u, "ustawienia") ? { smtp: SMTP_SKONFIGUROWANY }
      : { email: projekt.stan.formularze?.email || "", webhook: projekt.stan.formularze?.webhook || "", smtp: SMTP_SKONFIGUROWANY },
    domena: projekt.stan.domena ? { nazwa: projekt.stan.domena, ...(stanDomen.get(projekt.stan.domena) || { stan: "sprawdzam" }), automatycznie: Boolean(TRAEFIK_KATALOG) } : null,
  };
}

// ---------- własne domeny (Traefik file provider) ----------

const TRAEFIK_KATALOG = process.env.EDYTOR_TRAEFIK_KATALOG || "";
const IP_SERWERA = (process.env.EDYTOR_IP_SERWERA || "").split(/[\s,]+/).filter(Boolean);
const stanDomen = new Map(); // domena → { stan, adresy, sprawdzono }
let odswiezanieDomen = Promise.resolve();

// Sprawdza DNS domen wszystkich projektów i przepisuje konfigurację Traefika (tylko domeny wskazujące na serwer).
// Wywołania są kolejkowane, żeby dwa równoległe zapisy nie nadpisały się nawzajem starszym stanem.
function odswiezDomeny() {
  odswiezanieDomen = odswiezanieDomen.then(async () => {
    const domeny = [...new Set([...projekty.values()].map((p) => p.stan.domena).filter(Boolean))].sort();
    for (const d of [...stanDomen.keys()]) if (!domeny.includes(d)) stanDomen.delete(d);
    for (const d of domeny) {
      try { stanDomen.set(d, { ...(await sprawdzDomene(d, IP_SERWERA)), sprawdzono: new Date().toISOString() }); }
      catch (e) { stanDomen.set(d, { stan: "blad", blad: e.message, sprawdzono: new Date().toISOString() }); }
    }
    if (!TRAEFIK_KATALOG) return;
    const aktywne = domeny.filter((d) => stanDomen.get(d)?.stan === "aktywna");
    const tresc = konfiguracjaTraefika(aktywne, { usluga: "edytor-strony@docker", middleware: "edytor-kompresja@docker" });
    if (await zapiszKonfiguracje(TRAEFIK_KATALOG, tresc)) console.log(`Traefik: domeny projektów → ${aktywne.join(", ") || "(brak)"}`);
  }).catch((e) => console.error("Odświeżanie domen:", e.message));
  return odswiezanieDomen;
}

async function przygotuj() {
  try {
    await fs.access(DANE, fs.constants.W_OK);
  } catch {
    throw new Error(`Brak prawa zapisu do ${DANE}. Na hoście: mkdir -p dane && chown 1000:1000 dane`);
  }
  try { stan = JSON.parse(await fs.readFile(STAN, "utf8")); } catch { stan = {}; }
  // Stary układ (jedna strona) staje się projektem „glina” z tą samą domeną i tym samym wydaniem.
  const domenaStara = process.env.EDYTOR_ADRES_PRODUKCJI ? new URL(process.env.EDYTOR_ADRES_PRODUKCJI).hostname : null;
  if (await przeniesStaryUklad(DANE, { id: "glina", nazwa: "Pracownia Glina", domena: domenaStara })) {
    console.log("Przeniesiono dotychczasową stronę do projektu „glina”.");
  }
  projekty = await wczytajProjekty(DANE);
  for (const projekt of projekty.values()) projekt.adresStrony = () => adresStrony(projekt);
  // Pierwszy start: jeden projekt przykładowy, żeby panel nie był pusty.
  if (!projekty.size) {
    const projekt = await utworzProjekt(DANE, { id: "glina", nazwa: "Pracownia Glina (przykład)", szablon: "glina", katalogSzablonow: SZABLONY });
    projekt.adresStrony = () => adresStrony(projekt);
    projekty.set(projekt.id, projekt);
  }
  // Uszkodzony projekt (np. bez repozytorium) nie może zatrzymać startu pozostałych — pomijamy go i logujemy.
  for (const projekt of [...projekty.values()]) {
    try {
      await projekt.git("rev-parse", "--verify", "HEAD");
      const produkcja = await fs.stat(projekt.produkcja).catch(() => null);
      if (!produkcja?.isDirectory()) {
        await projekt.opublikuj(projekt.stan.opublikowano || "HEAD").catch(() => projekt.opublikuj("HEAD"));
      }
    } catch (e) {
      console.error(`Projekt „${projekt.id}” pominięty — uszkodzony: ${e.message}`);
      projekty.delete(projekt.id);
    }
  }
}

// ---------- logowanie: konta i podpisane żetony, bez bazy sesji ----------

// Żeton: rodzaj.login.wygasa.wersja.podpis. Klucz podpisu zależy od hasła z .env, a wersja to licznik konta
// (konto główne: `wersjaSesji`, pozostałe: `uzytkownicy[login].wersja`). Wylogowanie, zmiana hasła czy roli
// podnosi licznik i unieważnia wszystkie żetony tego konta, także skopiowane. Zmiana EDYTOR_HASLO — wszystkie.
const kluczPodpisu = crypto.createHash("sha256").update(`${SEKRET}\0${HASLO}`).digest();
const podpis = (wartosc) => crypto.createHmac("sha256", kluczPodpisu).update(wartosc).digest("base64url");
const DLUGOSC_SESJI = 7 * 24 * 3600 * 1000;
const DLUGOSC_PODGLADU = 12 * 3600 * 1000;

// Konto po loginie: główne z .env albo zapisane w stan.json. Zwraca { login, nazwa, rola, projekty, wersja, glowne }.
// Wersja żetonu = „epoka-licznik”. Epoka jest losowa dla każdego założonego konta, więc konto usunięte i założone
// ponownie pod tym samym loginem (albo dawny login konta głównego) nie przyjmie starych żetonów.
function konto(login) {
  if (login === LOGIN_GLOWNY) return { login, nazwa: "Administrator", rola: "administrator", projekty: "*", wersja: `g-${stan.wersjaSesji || 0}`, glowne: true };
  const u = Object.hasOwn(stan.uzytkownicy || {}, login) ? stan.uzytkownicy[login] : null;
  return u ? { ...u, login, wersja: `${u.epoka || "0"}-${u.wersja || 0}`, glowne: false } : null;
}

// Unieważnia wszystkie żetony konta (wylogowanie, zmiana hasła, roli lub projektów). Stan czytamy w chwili wywołania
// (po wszystkich await wywołującego) i zapisujemy synchronicznie — równoległe zmiany kont nie nadpiszą się nawzajem.
// Konto usunięte w międzyczasie nie wraca.
function podniesWersje(login, zmiany = {}) {
  if (login === LOGIN_GLOWNY) return zapiszStan({ wersjaSesji: (stan.wersjaSesji || 0) + 1 });
  const konta = stan.uzytkownicy || {};
  if (!Object.hasOwn(konta, login)) return Promise.resolve();
  const u = konta[login];
  return zapiszStan({ uzytkownicy: { ...konta, [login]: { ...u, ...zmiany, wersja: (u.wersja || 0) + 1 } } });
}

function wydajZeton(rodzaj, dlugosc, u) {
  const tresc = `${rodzaj}.${u.login}.${Date.now() + dlugosc}.${u.wersja}`;
  return `${tresc}.${podpis(tresc)}`;
}

// Konto z ważnego żetonu albo null.
function kontoZetonu(zeton, rodzaj) {
  const czesci = String(zeton || "").split(".");
  if (czesci.length !== 5) return null;
  const [r, login, wygasa, wersja, sygnatura] = czesci;
  if (r !== rodzaj || Number(wygasa) < Date.now()) return null;
  const oczekiwana = Buffer.from(podpis(`${r}.${login}.${wygasa}.${wersja}`));
  const podana = Buffer.from(sygnatura);
  if (oczekiwana.length !== podana.length || !crypto.timingSafeEqual(oczekiwana, podana)) return null;
  const u = konto(login);
  return u && wersja === u.wersja ? u : null;
}

function ciasteczko(zadanie, nazwa) {
  const wpis = (zadanie.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith(`${nazwa}=`));
  return wpis ? decodeURIComponent(wpis.slice(nazwa.length + 1)) : null;
}


// Traefik dopisuje adres klienta na KOŃCU X-Forwarded-For; wcześniejsze wartości może podać sam klient.
function adresKlienta(zadanie) {
  const lancuch = (zadanie.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  return lancuch.at(-1) || zadanie.socket.remoteAddress;
}

// Blokada zgadywania hasła: 10 prób na 15 minut z jednego adresu.
const proby = new Map();
function zablokowany(ip) {
  const teraz = Date.now();
  const wpis = proby.get(ip) || { ile: 0, od: teraz };
  if (teraz - wpis.od > 15 * 60 * 1000) { wpis.ile = 0; wpis.od = teraz; }
  wpis.ile += 1;
  proby.set(ip, wpis);
  return wpis.ile > 10;
}

// ---------- pomocnicze HTTP ----------

const blad = (kod, tekst) => Object.assign(new Error(tekst), { kod });

function odpowiedz(odp, kod, tresc, typ = "application/json") {
  odp.writeHead(kod, { "Content-Type": typ, "Cache-Control": "no-store", ...BEZPIECZNE });
  odp.end(typeof tresc === "string" ? tresc : JSON.stringify(tresc));
}

async function cialoSurowe(zadanie, limit) {
  const kawalki = [];
  let rozmiar = 0;
  for await (const kawalek of zadanie) {
    rozmiar += kawalek.length;
    if (rozmiar > limit) throw blad(413, `Za duży plik lub zapytanie (limit ${Math.round(limit / 1024 / 1024)} MB).`);
    kawalki.push(kawalek);
  }
  return Buffer.concat(kawalki);
}

async function cialoJson(zadanie, limit = 64 * 1024) {
  try {
    return JSON.parse((await cialoSurowe(zadanie, limit)).toString("utf8") || "{}");
  } catch (e) {
    throw e.kod ? e : blad(400, "Niepoprawny JSON.");
  }
}

// Rozwiązuje ścieżkę z adresu do pliku w katalogu głównym. Sprawdza ścieżkę po rozwinięciu dowiązań (realpath),
// więc ani `../`, ani symlink nie wyprowadzą poza katalog. Zwraca null, gdy pliku nie wolno pokazać.
async function znajdzPlik(katalog, sciezkaUrl, { tylkoPlikiStrony = false } = {}) {
  let wzgledna;
  try { wzgledna = decodeURIComponent(sciezkaUrl.split("?")[0]); } catch { return null; }
  if (wzgledna === "" || wzgledna.endsWith("/")) wzgledna += "index.html";
  const korzen = await fs.realpath(katalog).catch(() => null);
  if (!korzen) return null;
  let prawdziwa = await fs.realpath(path.join(korzen, path.posix.normalize("/" + wzgledna))).catch(() => null);
  // Adres katalogu bez ukośnika (np. /oferta) → oferta/index.html.
  if (prawdziwa && (await fs.stat(prawdziwa)).isDirectory()) prawdziwa = await fs.realpath(path.join(prawdziwa, "index.html")).catch(() => null);
  if (!prawdziwa || !prawdziwa.startsWith(korzen + path.sep) || prawdziwa.split(path.sep).includes(".git")) return null;
  if (tylkoPlikiStrony && !plikStrony(path.relative(korzen, prawdziwa).split(path.sep).join("/"))) return null;
  const info = await fs.stat(prawdziwa).catch(() => null);
  return info?.isFile() ? { sciezka: prawdziwa, rozmiar: info.size, zmieniono: info.mtimeMs } : null;
}

// Strumieniuje plik zamiast wczytywać go w całości do pamięci.
async function serwujPlik(odp, katalog, sciezkaUrl, naglowki = {}, opcje = {}) {
  const plik = await znajdzPlik(katalog, sciezkaUrl, opcje);
  if (!plik) return odpowiedz(odp, 404, "Nie ma takiej strony", "text/plain; charset=utf-8");
  // ETag z rozmiaru i czasu zmiany: przeglądarka po upływie max-age pyta „czy się zmieniło?” i dostaje
  // 304 bez treści, dopóki plik jest ten sam. Każda publikacja to nowe wydanie, więc nowy ETag.
  const etag = `W/"${plik.rozmiar.toString(36)}-${Math.floor(plik.zmieniono).toString(36)}"`;
  if (opcje.zadanie?.headers["if-none-match"] === etag) {
    odp.writeHead(304, { ETag: etag, ...naglowki });
    return odp.end();
  }
  odp.writeHead(200, {
    ETag: etag,
    "Content-Type": TYPY[path.extname(plik.sciezka).toLowerCase()] || "application/octet-stream",
    "Content-Length": plik.rozmiar,
    ...BEZPIECZNE,
    ...naglowki,
  });
  // pipeline zamyka plik także wtedy, gdy klient rozłączy się w trakcie pobierania.
  pipeline(createReadStream(plik.sciezka), odp, () => {});
}

const opakuj = (obsluga) => (zadanie, odp) =>
  obsluga(zadanie, odp).catch((e) => {
    if (!e.kod || e.kod >= 500) console.error(e);
    if (!odp.headersSent) odpowiedz(odp, e.kod || 500, { blad: e.kod ? e.message : "Błąd serwera." });
    else odp.end();
  });

// ---------- panel: API projektu ----------

async function obsluzPolecenie(projekt, zadanie, odp) {
  // Najpierw odczyt i walidacja zapytania — dopiero poprawne zajmuje blokadę i miejsce agenta.
  const dane = await cialoJson(zadanie, 12 * 1024 * 1024);
  if (!dane || typeof dane !== "object" || typeof dane.tresc !== "string" || !dane.tresc.trim()) return odpowiedz(odp, 400, { blad: "Puste polecenie." });
  const obrazy = (Array.isArray(dane.obrazy) ? dane.obrazy : []).slice(0, 3)
    .filter((o) => o && /^image\/(png|jpeg|webp|gif)$/.test(o.typ) && typeof o.dane === "string");
  const element = dane.element && typeof dane.element === "object"
    ? { selektor: String(dane.element.selektor ?? ""), tekst: String(dane.element.tekst ?? ""), html: String(dane.element.html ?? "") }
    : null;
  const polecenie = { tresc: dane.tresc.trim().slice(0, 8000), element, strona: String(dane.strona || "index.html") };

  if (aktywniAgenci >= MAX_AGENTOW) {
    return odpowiedz(odp, 429, { blad: `Asystent pracuje już nad ${aktywniAgenci} poleceniami w innych projektach. Spróbuj za chwilę.` });
  }
  if (!projekt.zajmij("polecenie", zadanie.uzytkownik)) return odpowiedz(odp, 409, { blad: "Asystent pracuje nad poprzednim poleceniem w tym projekcie." });
  aktywniAgenci++;
  try {
    await wykonajPolecenie(projekt, polecenie, obrazy, odp);
  } finally {
    projekt.zwolnij();
    aktywniAgenci--;
  }
}

async function wykonajPolecenie(projekt, dane, obrazy, odp) {
  odp.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no", ...BEZPIECZNE });
  const wyslijDoPrzegladarki = (zdarzenie) => { if (!odp.writableEnded) odp.write(`data: ${JSON.stringify(zdarzenie)}\n\n`); };
  // Zużycie tokenów każdego polecenia trafia też do dziennika projektu — dane do decyzji „API czy abonament”.
  const wyslij = (zdarzenie) => {
    if (zdarzenie.typ === "wynik" && zdarzenie.zuzycie) zapiszZuzycie(projekt, { ...zdarzenie.zuzycie, czas: zdarzenie.czas, ok: zdarzenie.ok, rodzaj: dane.rodzaj || "polecenie" });
    wyslijDoPrzegladarki(zdarzenie);
  };
  // Przerwanie: rozłączenie przeglądarki, przycisk „Zatrzymaj” albo limit czasu.
  const przerwanie = new AbortController();
  projekt.przerwanie = przerwanie;
  odp.on("close", () => przerwanie.abort("rozlaczono"));
  const limit = setTimeout(() => przerwanie.abort("czas"), CZAS_AGENTA);
  const pulsuj = setInterval(() => { if (!odp.writableEnded) odp.write(": puls\n\n"); }, 20000); // pośrednicy nie zamkną cichego połączenia

  let poprzedni = null;
  try {
    poprzedni = await projekt.git("rev-parse", "--short", "HEAD");
    const sesja = await uruchomAgenta({
      katalog: projekt.strona,
      polecenie: zbudujPolecenie(dane),
      obrazy,
      sesja: projekt.stan.sesja,
      wyslij,
      sygnal: przerwanie.signal,
    });
    await projekt.zapiszStan({ sesja });
    const commit = await projekt.zatwierdz(dane.tresc.trim());
    bledyAgentaZRzedu = 0;
    wyslij({ typ: "koniec", commit, poprzedni });
  } catch (e) {
    const powod = przerwanie.signal.reason;
    const tekst = powod === "czas" ? `Przekroczono limit czasu (${CZAS_AGENTA / 60000} min). Zapisano to, co asystent zdążył zmienić.`
      : powod === "zatrzymano" ? "Zatrzymano. Zapisano to, co asystent zdążył zmienić."
      : powod === "restart" ? "Serwer edytora był restartowany (aktualizacja) i przerwał pracę. Zapisano to, co asystent zdążył zmienić — wyślij polecenie ponownie."
      : e.message;
    if (!powod) { console.error(e); odnotujBladAgenta(e.message); }
    // Niedokończone zmiany zostają w drzewie roboczym; zapisujemy je, żeby dało się je cofnąć z historii.
    const commit = await projekt.zatwierdz(`(przerwane) ${dane.tresc.trim()}`).catch(() => null);
    wyslij({ typ: "blad", tekst, commit, poprzedni });
  } finally {
    clearTimeout(limit);
    clearInterval(pulsuj);
    odp.end();
  }
}

// ---------- dziennik zużycia modelu ----------

async function zapiszZuzycie(projekt, wpis) {
  try {
    await fs.appendFile(path.join(projekt.katalog, "zuzycie.jsonl"), `${JSON.stringify({ kiedy: new Date().toISOString(), ...wpis })}\n`);
  } catch (e) {
    console.error("Zapis zużycia:", e.message);
  }
}

// Podsumowanie z ostatnich `dni` dla wszystkich projektów: liczba poleceń, tokeny, szacowany koszt na modelach Claude.
async function podsumowanieZuzycia(dni = 30) {
  const od = Date.now() - dni * 24 * 3600 * 1000;
  const dzisiaj = new Date().toISOString().slice(0, 10);
  const suma = () => ({ polecenia: 0, tokeny: { wejscie: 0, wyjscie: 0, odczytCache: 0, zapisCache: 0 }, szacunekUsd: {}, czasMs: 0 });
  const wynik = { dni, dzis: suma(), okres: suma(), dniZPoleceniami: 0 };
  const dniAktywne = new Set();
  for (const projekt of projekty.values()) {
    let tekst = "";
    try { tekst = await fs.readFile(path.join(projekt.katalog, "zuzycie.jsonl"), "utf8"); } catch { continue; }
    for (const linia of tekst.split("\n")) {
      let w;
      try { w = JSON.parse(linia); } catch { continue; }
      if (new Date(w.kiedy).getTime() < od) continue;
      dniAktywne.add(w.kiedy.slice(0, 10));
      for (const cel of w.kiedy.startsWith(dzisiaj) ? [wynik.dzis, wynik.okres] : [wynik.okres]) {
        cel.polecenia++;
        cel.czasMs += w.czas || 0;
        for (const k of Object.keys(cel.tokeny)) cel.tokeny[k] += w.tokeny?.[k] || 0;
        for (const [m, usd] of Object.entries(w.szacunekUsd || {})) cel.szacunekUsd[m] = Number(((cel.szacunekUsd[m] || 0) + usd).toFixed(4));
      }
    }
  }
  wynik.dniZPoleceniami = dniAktywne.size;
  return wynik;
}

// ---------- zadania globalne: plan → akceptacja → kroki → weryfikacja ----------

// Wspólna obsługa długich operacji agenta ze strumieniem SSE: limit agentów, blokada projektu, przerwanie
// (rozłączenie, „Zatrzymaj”), puls podtrzymujący połączenie. `praca({ wyslij, sygnal })` robi właściwą robotę.
async function strumienAgenta(projekt, odp, nazwa, praca) {
  if (aktywniAgenci >= MAX_AGENTOW) return odpowiedz(odp, 429, { blad: `Asystent pracuje już nad ${aktywniAgenci} poleceniami. Spróbuj za chwilę.` });
  if (!projekt.zajmij(nazwa, odp.req.uzytkownik)) return odpowiedz(odp, 409, { blad: "W tym projekcie trwa inna operacja (np. asystent pracuje)." });
  aktywniAgenci++;
  odp.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no", ...BEZPIECZNE });
  const wyslij = (z) => { if (!odp.writableEnded) odp.write(`data: ${JSON.stringify(z)}\n\n`); };
  const przerwanie = new AbortController();
  projekt.przerwanie = przerwanie;
  odp.on("close", () => przerwanie.abort("rozlaczono"));
  const pulsuj = setInterval(() => { if (!odp.writableEnded) odp.write(": puls\n\n"); }, 20000);
  try {
    await praca({ wyslij, sygnal: przerwanie.signal });
  } catch (e) {
    const powod = przerwanie.signal.reason;
    if (!powod && !e.kod) console.error(e);
    const tekst = powod === "zatrzymano" ? "Zatrzymano." : powod === "restart" ? "Serwer edytora był restartowany (aktualizacja) i przerwał pracę." : e.message;
    wyslij({ typ: "blad", tekst, ...(e.dodatkowo || {}) });
  } finally {
    clearInterval(pulsuj);
    projekt.zwolnij();
    aktywniAgenci--;
    odp.end();
  }
}

// Przekazuje zdarzenia agenta do przeglądarki i zapisuje zużycie.
const przekazujac = (projekt, wyslij, rodzaj, dodatkowo = () => {}) => (z) => {
  if (z.typ === "wynik" && z.zuzycie) zapiszZuzycie(projekt, { ...z.zuzycie, czas: z.czas, ok: z.ok, rodzaj });
  dodatkowo(z);
  wyslij(z);
};

async function obsluzPlan(projekt, zadanie, odp) {
  const { tresc } = (await cialoJson(zadanie)) || {};
  if (typeof tresc !== "string" || !tresc.trim()) return odpowiedz(odp, 400, { blad: "Opisz zadanie." });
  return strumienAgenta(projekt, odp, "planowanie", async ({ wyslij, sygnal }) => {
    const teksty = [];
    await uruchomAgenta({
      katalog: projekt.strona, polecenie: tresc.trim().slice(0, 4000), tylkoOdczyt: true, instrukcje: INSTRUKCJE_PLANU, maxTurns: 30, sygnal,
      // Treść planu (JSON) nie trafia do czatu jako zwykły tekst — panel pokaże ją jako listę kroków.
      wyslij: przekazujac(projekt, (z) => { if (z.typ !== "tekst") wyslij(z); }, "plan", (z) => { if (z.typ === "tekst") teksty.push(z.tekst); }),
    });
    const kroki = wyciagnijPlan(teksty.join("\n"));
    projekt.planZadania = { id: crypto.randomUUID(), tresc: tresc.trim().slice(0, 4000), kroki };
    wyslij({ typ: "plan", id: projekt.planZadania.id, kroki });
  });
}

async function obsluzZadanie(projekt, zadanie, odp) {
  const { id } = (await cialoJson(zadanie)) || {};
  const plan = projekt.planZadania;
  if (!plan || plan.id !== id) return odpowiedz(odp, 409, { blad: "Ten plan jest nieaktualny. Przygotuj plan jeszcze raz." });
  return strumienAgenta(projekt, odp, "zadanie", async ({ wyslij, sygnal }) => {
    projekt.planZadania = null;
    const poprzedni = await projekt.git("rev-parse", "--short", "HEAD");
    let wykonane = 0;
    for (const [nr, krok] of plan.kroki.entries()) {
      if (sygnal.aborted) break;
      wyslij({ typ: "krok", nr: nr + 1, z: plan.kroki.length, tytul: krok.tytul });
      // Każdy krok: świeża rozmowa (mały kontekst), własny limit czasu i commit — błąd zatrzymuje dalsze kroki.
      const limit = AbortSignal.timeout(CZAS_AGENTA);
      try {
        await uruchomAgenta({
          katalog: projekt.strona, polecenie: polecenieKroku(plan.tresc, plan.kroki, nr), maxTurns: 40,
          sygnal: AbortSignal.any([sygnal, limit]), wyslij: przekazujac(projekt, wyslij, "zadanie"),
        });
      } catch (e) {
        await projekt.zatwierdz(`[zadanie ${nr + 1}/${plan.kroki.length}] (przerwane) ${krok.tytul}`).catch(() => {});
        // Panel dostaje zakres zmian, żeby mimo błędu dało się cofnąć wszystkie dotychczasowe kroki naraz.
        const commit = await projekt.git("rev-parse", "--short", "HEAD");
        throw Object.assign(new Error(limit.aborted ? `Krok ${nr + 1} przekroczył limit czasu. Zapisano to, co zdążył zmienić.` : `Krok ${nr + 1} nie powiódł się: ${e.message}`), {
          kod: 500, dodatkowo: commit !== poprzedni ? { commit, poprzedni, zadanie: true } : {},
        });
      }
      await projekt.zatwierdz(`[zadanie ${nr + 1}/${plan.kroki.length}] ${krok.tytul}`);
      wykonane++;
    }
    const weryfikacja = await sprawdzStrone(projekt.strona);
    wyslij({ typ: "weryfikacja", ...weryfikacja });
    const commit = await projekt.git("rev-parse", "--short", "HEAD");
    wyslij({ typ: "koniec", commit: commit !== poprzedni ? commit : null, poprzedni, zadanie: true, wykonane, z: plan.kroki.length });
  });
}

// Wspólna otoczka dla krótkich operacji zmieniających projekt (publikacja, cofanie, pliki, nowa rozmowa).
async function wylacznie(projekt, odp, nazwa, operacja) {
  if (!projekt.zajmij(nazwa, odp.req.uzytkownik)) return odpowiedz(odp, 409, { blad: "W tym projekcie trwa inna operacja (np. asystent pracuje). Spróbuj za chwilę." });
  try {
    return await operacja();
  } finally {
    projekt.zwolnij();
  }
}

async function obsluzProjekt(projekt, akcja, zadanie, odp, url) {
  const metoda = zadanie.method;
  if (akcja === "polecenie" && metoda === "POST") return obsluzPolecenie(projekt, zadanie, odp);
  if (akcja === "plan" && metoda === "POST") return obsluzPlan(projekt, zadanie, odp);
  if (akcja === "zadanie" && metoda === "POST") return obsluzZadanie(projekt, zadanie, odp);
  if (akcja === "cofnij-zadanie" && metoda === "POST") {
    // Cofnięcie całego zadania: jeden commit odwracający wszystkie kroki od `od` (stan sprzed zadania) do HEAD.
    const { od } = (await cialoJson(zadanie)) || {};
    if (!/^[0-9a-f]{4,40}$/.test(typeof od === "string" ? od : "")) return odpowiedz(odp, 400, { blad: "Zły identyfikator wersji." });
    return wylacznie(projekt, odp, "cofanie zadania", async () => {
      try {
        await projekt.git("merge-base", "--is-ancestor", od, "HEAD");
        await projekt.git("revert", "--no-edit", "--no-commit", `${od}..HEAD`);
        await projekt.git("commit", "-q", "-m", `Cofnięto zadanie globalne (powrót do ${od})`);
      } catch {
        await projekt.git("revert", "--abort").catch(() => {});
        return odpowiedz(odp, 409, { blad: "Nie da się cofnąć tego zadania (późniejsze zmiany go dotyczą albo wersja nie istnieje)." });
      }
      return odpowiedz(odp, 200, { ok: true });
    });
  }
  if (akcja === "zatrzymaj" && metoda === "POST") {
    projekt.przerwanie?.abort("zatrzymano");
    return odpowiedz(odp, 200, { ok: Boolean(projekt.przerwanie) });
  }
  if (akcja === "historia") {
    return odpowiedz(odp, 200, { ...opisProjektu(projekt, zadanie.uzytkownik), wpisy: await projekt.historia(), model: process.env.EDYTOR_MODEL || "claude-opus-5-5" });
  }
  if (akcja === "strony") return odpowiedz(odp, 200, { strony: await projekt.podstrony() });
  if (akcja === "pliki" && metoda === "GET") return odpowiedz(odp, 200, { pliki: await projekt.pliki() });
  if (akcja === "pliki" && metoda === "POST") {
    const sciezka = url.searchParams.get("sciezka");
    const dane = await cialoSurowe(zadanie, 15 * 1024 * 1024);
    return wylacznie(projekt, odp, "wgrywanie", async () => odpowiedz(odp, 200, { commit: await projekt.wgrajPlik(sciezka, dane), sciezka }));
  }
  if (akcja === "usun-plik" && metoda === "POST") {
    const { sciezka } = (await cialoJson(zadanie)) || {};
    return wylacznie(projekt, odp, "usuwanie", async () => odpowiedz(odp, 200, { commit: await projekt.usunPlik(sciezka) }));
  }
  if (akcja === "eksport") {
    const nazwa = `${projekt.id}-${new Date().toISOString().slice(0, 10)}.zip`;
    odp.writeHead(200, { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${nazwa}"`, ...BEZPIECZNE });
    const git = projekt.eksportuj();
    return pipeline(git.stdout, odp, () => git.kill());
  }
  if (akcja === "cofnij" && metoda === "POST") {
    const { commit } = (await cialoJson(zadanie)) || {};
    if (!/^[0-9a-f]{4,40}$/.test(typeof commit === "string" ? commit : "")) return odpowiedz(odp, 400, { blad: "Zły identyfikator zmiany." });
    return wylacznie(projekt, odp, "cofanie", async () => {
      try {
        await projekt.git("revert", "--no-edit", commit);
      } catch {
        await projekt.git("revert", "--abort").catch(() => {});
        return odpowiedz(odp, 409, { blad: "Tej zmiany nie da się cofnąć osobno (późniejsze zmiany jej dotyczą). Cofnij najpierw nowsze." });
      }
      return odpowiedz(odp, 200, { ok: true });
    });
  }
  if (akcja === "opublikuj" && metoda === "POST") {
    const { commit } = (await cialoJson(zadanie)) || {};
    if (commit !== undefined && !/^[0-9a-f]{4,40}$/.test(typeof commit === "string" ? commit : "")) return odpowiedz(odp, 400, { blad: "Zły identyfikator wersji." });
    return wylacznie(projekt, odp, "publikacja", async () => odpowiedz(odp, 200, { commit: await projekt.opublikuj(commit || "HEAD") }));
  }
  if (akcja === "nowa-rozmowa" && metoda === "POST") {
    return wylacznie(projekt, odp, "nowa rozmowa", async () => {
      await projekt.zapiszStan({ sesja: null });
      return odpowiedz(odp, 200, { ok: true });
    });
  }
  if (akcja === "usun" && metoda === "POST") {
    // Potwierdzenie: identyfikator projektu wpisany przez użytkownika. Projekt trafia do kosza (do odzyskania na serwerze).
    const { potwierdzenie } = (await cialoJson(zadanie)) || {};
    if (potwierdzenie !== projekt.id) return odpowiedz(odp, 400, { blad: `Wpisz identyfikator „${projekt.id}”, żeby potwierdzić.` });
    return wylacznie(projekt, odp, "usuwanie projektu", async () => {
      await przeniesDoKosza(DANE, projekt);
      projekty.delete(projekt.id);
      // Projekt o tym samym identyfikatorze utworzony w przyszłości nie może odziedziczyć dawnych uprawnień.
      const konta = Object.entries(stan.uzytkownicy || {});
      if (konta.some(([, k]) => k.projekty?.includes(projekt.id))) {
        await zapiszStan({ uzytkownicy: Object.fromEntries(konta.map(([l, k]) => [l, { ...k, projekty: (k.projekty || []).filter((p) => p !== projekt.id) }])) });
      }
      if (projekt.stan.domena) odswiezDomeny();
      return odpowiedz(odp, 200, { ok: true });
    });
  }
  if (akcja === "raport-importu" && metoda === "GET") {
    const raport = await fs.readFile(path.join(projekt.katalog, "raport-importu.json"), "utf8").catch(() => null);
    return raport ? odpowiedz(odp, 200, JSON.parse(raport)) : odpowiedz(odp, 404, { blad: "Ten projekt nie powstał z importu." });
  }
  if (akcja === "integracje") {
    const admin = administrator(zadanie.uzytkownik);
    const widoczne = (ust) => Object.fromEntries(Object.entries(ust || {}).filter(([id]) => admin || id !== "wlasny-kod"));
    if (metoda === "POST") {
      const { id, wlaczona, wartosci } = (await cialoJson(zadanie)) || {};
      let wpis;
      try { wpis = sprawdzIntegracje(String(id || ""), { wlaczona, wartosci }, { administrator: admin, poprzednie: projekt.stan.integracje?.[id] }); } catch (e) { return odpowiedz(odp, 400, { blad: e.message }); }
      // Integracje wstawia publikacja, więc od razu publikujemy na nowo bieżącą wersję strony (bez zmian w treści).
      return wylacznie(projekt, odp, "integracje", async () => {
        await projekt.zapiszStan({ integracje: { ...(projekt.stan.integracje || {}), [id]: wpis } });
        if (projekt.stan.opublikowano) await projekt.opublikuj(projekt.stan.opublikowano);
        return odpowiedz(odp, 200, { katalog: katalogDlaPanelu({ administrator: admin }), ustawienia: widoczne(projekt.stan.integracje) });
      });
    }
    return odpowiedz(odp, 200, { katalog: katalogDlaPanelu({ administrator: admin }), ustawienia: widoczne(projekt.stan.integracje) });
  }
  if (akcja === "formularze" && metoda === "GET") {
    if (url.searchParams.get("format") === "csv") {
      const nazwa = `zgloszenia-${projekt.id}-${new Date().toISOString().slice(0, 10)}.csv`;
      odp.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${nazwa}"`, "Cache-Control": "no-store", ...BEZPIECZNE });
      return odp.end(csvZgloszen(await listaZgloszen(projekt, Infinity, { wszystkie: true })));
    }
    return odpowiedz(odp, 200, { zgloszenia: await listaZgloszen(projekt) });
  }
  if (akcja === "usun-zgloszenie" && metoda === "POST") {
    const { id } = (await cialoJson(zadanie)) || {};
    return (await usunZgloszenie(projekt, id)) ? odpowiedz(odp, 200, { ok: true }) : odpowiedz(odp, 404, { blad: "Nie ma takiego zgłoszenia." });
  }
  if (akcja === "ustawienia" && metoda === "POST") {
    const { nazwa, domena, formularzeEmail, formularzeWebhook } = (await cialoJson(zadanie)) || {};
    const zmiany = {};
    if (formularzeEmail !== undefined || formularzeWebhook !== undefined) {
      const email = String(formularzeEmail ?? projekt.stan.formularze?.email ?? "").trim();
      const webhook = String(formularzeWebhook ?? projekt.stan.formularze?.webhook ?? "").trim();
      if (email && !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(email)) return odpowiedz(odp, 400, { blad: "Niepoprawny adres e-mail do powiadomień." });
      if (webhook) {
        try { sprawdzAdres(webhook); } catch (e) { return odpowiedz(odp, 400, { blad: `Webhook: ${e.message}` }); }
      }
      zmiany.formularze = { email: email || null, webhook: webhook || null };
    }
    if (typeof nazwa === "string" && nazwa.trim()) zmiany.nazwa = nazwa.trim().slice(0, 80);
    if (domena !== undefined && String(domena || "").trim().toLowerCase() !== (projekt.stan.domena || "") && !administrator(zadanie.uzytkownik)) {
      return odpowiedz(odp, 403, { blad: "Domenę projektu może zmienić tylko administrator." });
    }
    if (domena !== undefined) {
      const czysta = String(domena || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      if (czysta && !/^(?=.{4,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/.test(czysta)) return odpowiedz(odp, 400, { blad: "Niepoprawna domena." });
      if (DOMENY_ZAREZERWOWANE.has(czysta)) return odpowiedz(odp, 400, { blad: "Ta domena należy do samego edytora i nie może być domeną projektu." });
      if (czysta && [...projekty.values()].some((p) => p !== projekt && p.stan.domena === czysta)) return odpowiedz(odp, 409, { blad: "Ta domena jest już przypisana do innego projektu." });
      zmiany.domena = czysta || null;
    }
    await projekt.zapiszStan(zmiany);
    if ("domena" in zmiany) await odswiezDomeny();
    return odpowiedz(odp, 200, opisProjektu(projekt));
  }
  return odpowiedz(odp, 404, { blad: "Nie ma takiego adresu." });
}

// Import strony z adresu URL — długa operacja, więc postęp idzie strumieniem SSE (jak praca agenta).
let importUrlTrwa = false;
async function obsluzImportUrl(url, odp) {
  const id = url.searchParams.get("id");
  const nazwa = (url.searchParams.get("nazwa") || "").trim().slice(0, 80);
  const adres = (url.searchParams.get("url") || "").trim();
  try { sprawdzAdres(adres); } catch (e) { return odpowiedz(odp, 400, { blad: e.message }); }
  if (projekty.has(id)) return odpowiedz(odp, 409, { blad: "Projekt o takim identyfikatorze już istnieje." });
  if (importUrlTrwa) return odpowiedz(odp, 429, { blad: "Trwa inny import. Spróbuj za chwilę." });
  importUrlTrwa = true;
  odp.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no", ...BEZPIECZNE });
  const wyslij = (z) => { if (!odp.writableEnded) odp.write(`data: ${JSON.stringify(z)}\n\n`); };
  const przerwanie = new AbortController();
  odp.on("close", () => przerwanie.abort());
  let ostatni = 0;
  try {
    let wynik;
    const projekt = await utworzProjekt(DANE, {
      id, nazwa, katalogSzablonow: SZABLONY, opisCommita: `Import strony z ${adres}`,
      wypelnij: async (katalog) => {
        wynik = await importujStrone(adres, katalog, {
          sygnal: przerwanie.signal,
          postep: (p) => { if (Date.now() - ostatni > 500) { ostatni = Date.now(); wyslij({ typ: "postep", ...p }); } },
        });
        return [];
      },
    });
    projekt.adresStrony = () => adresStrony(projekt);
    projekty.set(projekt.id, projekt);
    if (Object.keys(wynik.przekierowania || {}).length) await projekt.zapiszStan({ przekierowania: wynik.przekierowania });
    // Raport migracji zostaje w projekcie (poza stroną, niepublikowany) — panel pokazuje go w ustawieniach.
    const raport = {
      adres: wynik.adres, kiedy: new Date().toISOString(), strony: wynik.strony, pliki: wynik.pliki, bajty: wynik.bajty,
      formularze: wynik.formularze, przekierowania: Object.keys(wynik.przekierowania || {}).length,
      bledy: wynik.bledy.slice(0, 50), pominiete: wynik.pominiete.length + (projekt.pominiete?.length || 0), uwagi: wynik.uwagi || [],
    };
    await fs.writeFile(path.join(projekt.katalog, "raport-importu.json"), JSON.stringify(raport, null, 2));
    // Pierwsza publikacja odbyła się w katalogu tymczasowym (bez adresu) — publikujemy jeszcze raz z sitemap.xml i robots.txt.
    await projekt.opublikuj();
    wyslij({
      typ: "koniec", projekt: opisProjektu(projekt), przekierowania: Object.keys(wynik.przekierowania || {}).length,
      strony: wynik.strony, pliki: wynik.pliki, bajty: wynik.bajty, formularze: wynik.formularze,
      bledy: wynik.bledy.slice(0, 20), pominiete: wynik.pominiete.length + (projekt.pominiete?.length || 0), uwagi: wynik.uwagi || [],
    });
  } catch (e) {
    if (!e.kod) console.error(e);
    wyslij({ typ: "blad", tekst: e.message });
  } finally {
    importUrlTrwa = false;
    odp.end();
  }
}

// ---------- panel ----------

const NAGLOWKI_PANELU = {
  "Content-Security-Policy": `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: ${ADRES_PODGLADU}; frame-src ${ADRES_PODGLADU}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
  "Cache-Control": "no-store",
};

// Co pokazać w panelu danej roli (serwer i tak sprawdza każde zapytanie osobno).
function mozliwosci(u) {
  return {
    publikacja: mozeAkcje(u, "opublikuj"), pliki: mozeAkcje(u, "pliki"), ustawienia: mozeAkcje(u, "ustawienia"),
    zadaniaGlobalne: mozeAkcje(u, "plan"), integracje: mozeAkcje(u, "integracje"), eksport: mozeAkcje(u, "eksport"),
    usuwanieZgloszen: mozeAkcje(u, "usun-zgloszenie"),
    administrator: administrator(u), zmianaHasla: !u.glowne,
  };
}

async function zmienWlasneHaslo(u, zadanie, odp) {
  if (u.glowne) return odpowiedz(odp, 400, { blad: "Hasło konta głównego zmienia się w pliku .env na serwerze (EDYTOR_HASLO)." });
  // Ten sam limit prób co przy logowaniu: przejęta sesja nie pozwala zgadywać obecnego hasła bez końca.
  if (zablokowany(adresKlienta(zadanie))) return odpowiedz(odp, 429, { blad: "Za dużo prób. Spróbuj za 15 minut." });
  const { stare, nowe } = (await cialoJson(zadanie)) || {};
  if (!(await hasloZgodne(String(stare || ""), u.haslo))) return odpowiedz(odp, 400, { blad: "Obecne hasło jest niepoprawne." });
  if (String(nowe || "").length < MIN_DLUGOSC_HASLA) return odpowiedz(odp, 400, { blad: `Nowe hasło musi mieć co najmniej ${MIN_DLUGOSC_HASLA} znaków.` });
  await podniesWersje(u.login, { haslo: await haszuj(nowe) });
  // Nowy żeton dla bieżącej przeglądarki; pozostałe sesje tego konta wygasły razem ze starą wersją.
  const zeton = wydajZeton("panel", DLUGOSC_SESJI, konto(u.login));
  odp.writeHead(200, { "Set-Cookie": `edytor=${zeton}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${DLUGOSC_SESJI / 1000}`, "Content-Type": "application/json", ...BEZPIECZNE });
  return odp.end("{}");
}

// Konta (tylko administrator): GET lista, POST zapis (nowe konto dostaje wygenerowane hasło, pokazywane raz),
// POST …/haslo — nowe hasło dla konta, POST …/usun.
// Stan kont czytamy zawsze PO ostatnim await i zapisujemy w tym samym synchronicznym kroku (zapiszStan od razu
// zmienia `stan`), inaczej równoległe wylogowanie czy zmiana hasła zostałyby nadpisane starszą kopią.
async function obsluzKonta(sciezka, zadanie, odp) {
  const konta = () => stan.uzytkownicy || {};
  if (sciezka === "/api/uzytkownicy" && zadanie.method === "GET") {
    const lista = [opisKonta(LOGIN_GLOWNY, konto(LOGIN_GLOWNY), { glowne: true }), ...Object.entries(konta()).map(([l, k]) => opisKonta(l, k))];
    return odpowiedz(odp, 200, { konta: lista, projekty: [...projekty.values()].map((p) => ({ id: p.id, nazwa: p.stan.nazwa || p.id })) });
  }
  if (zadanie.method !== "POST") return odpowiedz(odp, 404, { blad: "Nie ma takiego adresu." });
  const dane = (await cialoJson(zadanie)) || {};
  const login = String(dane.login || "").trim().toLowerCase();
  if (login === LOGIN_GLOWNY) return odpowiedz(odp, 400, { blad: "Konto główne jest ustawione w .env na serwerze i nie da się go zmienić z panelu." });
  if (sciezka === "/api/uzytkownicy") {
    let k;
    try { k = sprawdzKonto(dane, new Set(projekty.keys())); } catch (e) { return odpowiedz(odp, 400, { blad: e.message }); }
    const haslo = dane.nowe ? noweHaslo() : null;
    const skrot = haslo ? await haszuj(haslo) : null;
    // Od tego miejsca bez await aż do zapisu.
    const aktualne = konta();
    const istniejace = Object.hasOwn(aktualne, k.login) ? aktualne[k.login] : null;
    if (dane.nowe && istniejace) return odpowiedz(odp, 409, { blad: "Konto o takim loginie już istnieje." });
    if (!dane.nowe && !istniejace) return odpowiedz(odp, 404, { blad: "Nie ma takiego konta." });
    const wpis = istniejace
      // Zmiana roli albo listy projektów wylogowuje konto — nowe uprawnienia obowiązują od następnego logowania.
      ? { ...istniejace, nazwa: k.nazwa, rola: k.rola, projekty: k.projekty, wersja: (istniejace.wersja || 0) + 1 }
      : { utworzono: new Date().toISOString(), epoka: crypto.randomBytes(6).toString("hex"), wersja: 0, nazwa: k.nazwa, rola: k.rola, projekty: k.projekty, haslo: skrot };
    await zapiszStan({ uzytkownicy: { ...aktualne, [k.login]: wpis } });
    return odpowiedz(odp, 200, { konto: opisKonta(k.login, wpis), ...(haslo ? { haslo } : {}) });
  }
  if (!Object.hasOwn(konta(), login)) return odpowiedz(odp, 404, { blad: "Nie ma takiego konta." });
  if (sciezka === "/api/uzytkownicy/haslo") {
    const haslo = noweHaslo();
    const skrot = await haszuj(haslo);
    if (!Object.hasOwn(konta(), login)) return odpowiedz(odp, 404, { blad: "Nie ma takiego konta." }); // usunięte w trakcie
    await podniesWersje(login, { haslo: skrot });
    return odpowiedz(odp, 200, { haslo });
  }
  if (sciezka === "/api/uzytkownicy/usun") {
    const { [login]: _, ...reszta } = konta();
    await zapiszStan({ uzytkownicy: reszta });
    return odpowiedz(odp, 200, { ok: true });
  }
  return odpowiedz(odp, 404, { blad: "Nie ma takiego adresu." });
}

async function obsluzPanel(zadanie, odp) {
  const url = new URL(zadanie.url, "http://x");
  const sciezka = url.pathname;

  if (sciezka === "/zdrowie") {
    // Publiczne minimum do monitoringu: bez nazw projektów i bez danych użytkownika.
    const liczbaKopii = await fs.readdir(KOPIE).then((l) => l.filter((n) => /^edytor-ai-.*\.tgz$/.test(n)).length, () => null);
    return odpowiedz(odp, 200, { ok: true, projekty: projekty.size, aktywniAgenci, uruchomiono: URUCHOMIONO, ostatniaKopia, liczbaKopii, ...(await stanZasobow()) });
  }

  if (sciezka === "/zaloguj" && zadanie.method === "POST") {
    const ip = adresKlienta(zadanie);
    if (zablokowany(ip)) return odpowiedz(odp, 429, { blad: "Za dużo prób. Spróbuj za 15 minut." });
    const dane = (await cialoJson(zadanie)) || {};
    const login = String(dane.login || "").trim().toLowerCase() || LOGIN_GLOWNY;
    const haslo = String(dane.haslo || "");
    const poprawne = await hasloZgodne(haslo, login === LOGIN_GLOWNY ? SKROT_GLOWNY : konto(login)?.haslo);
    if (!poprawne) return odpowiedz(odp, 401, { blad: "Zły login lub hasło." });
    proby.delete(ip);
    const zeton = wydajZeton("panel", DLUGOSC_SESJI, konto(login));
    odp.writeHead(200, {
      "Set-Cookie": `edytor=${zeton}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${DLUGOSC_SESJI / 1000}`,
      "Content-Type": "application/json",
      ...BEZPIECZNE,
    });
    return odp.end("{}");
  }

  const zalogowany = kontoZetonu(ciasteczko(zadanie, "edytor"), "panel");
  zadanie.uzytkownik = zalogowany;

  if (sciezka === "/wyloguj") {
    // Wylogowanie podnosi licznik wersji konta: nieważne stają się wszystkie jego żetony, także skopiowane.
    if (zalogowany) await podniesWersje(zalogowany.login);
    odp.writeHead(302, { "Set-Cookie": "edytor=; Path=/; Max-Age=0", Location: "/", ...BEZPIECZNE });
    return odp.end();
  }

  if (!zalogowany) {
    if (sciezka.startsWith("/api/")) return odpowiedz(odp, 401, { blad: "Sesja wygasła. Zaloguj się ponownie." });
    if (["/edytor.css", "/logowanie.js"].includes(sciezka)) return serwujPlik(odp, PUBLICZNE, sciezka, NAGLOWKI_PANELU);
    return serwujPlik(odp, PUBLICZNE, "/logowanie.html", NAGLOWKI_PANELU);
  }

  if (sciezka === "/") return serwujPlik(odp, PUBLICZNE, "/edytor.html", NAGLOWKI_PANELU);

  // Zapisy tylko z tej samej domeny. Podgląd ma inny origin, więc jego skrypty też tu nie przejdą.
  if (zadanie.method === "POST" && zadanie.headers["sec-fetch-site"] && zadanie.headers["sec-fetch-site"] !== "same-origin") {
    return odpowiedz(odp, 403, { blad: "Zapytanie z obcej strony." });
  }

  const u = zalogowany;
  if (sciezka === "/api/ja") return odpowiedz(odp, 200, { ...opisKonta(u.login, u, { glowne: u.glowne }), mozliwosci: mozliwosci(u) });
  if (sciezka === "/api/konto/haslo" && zadanie.method === "POST") return zmienWlasneHaslo(u, zadanie, odp);
  if (sciezka === "/api/podglad") {
    return odpowiedz(odp, 200, { adres: ADRES_PODGLADU, wejscie: `${ADRES_PODGLADU}/__wejscie?klucz=${wydajZeton("podglad", DLUGOSC_PODGLADU, u)}` });
  }
  if (sciezka === "/api/projekty" && zadanie.method === "GET") {
    const lista = [...projekty.values()].filter((p) => widziProjekt(u, p.id)).map((p) => opisProjektu(p, u)).sort((a, b) => a.nazwa.localeCompare(b.nazwa, "pl"));
    const szablony = (await fs.readdir(SZABLONY)).sort();
    return odpowiedz(odp, 200, { projekty: lista, szablony });
  }
  // Dalej tylko administrator: zużycie modelu (koszty), konta, nowe projekty i import.
  const tylkoAdmin = sciezka === "/api/zuzycie" || sciezka.startsWith("/api/uzytkownicy") || (sciezka.startsWith("/api/projekty") && zadanie.method === "POST");
  if (tylkoAdmin && !administrator(u)) return odpowiedz(odp, 403, { blad: "Tę operację może wykonać tylko administrator." });
  if (sciezka === "/api/zuzycie") return odpowiedz(odp, 200, await podsumowanieZuzycia(Number(url.searchParams.get("dni")) || 30));
  if (sciezka.startsWith("/api/uzytkownicy")) return obsluzKonta(sciezka, zadanie, odp);
  if (sciezka === "/api/projekty/import-url" && zadanie.method === "POST") return obsluzImportUrl(url, odp);
  if (sciezka === "/api/projekty" && zadanie.method === "POST") {
    const id = url.searchParams.get("id");
    const nazwa = (url.searchParams.get("nazwa") || "").trim().slice(0, 80);
    const zZipa = (zadanie.headers["content-type"] || "").includes("zip");
    const zip = zZipa ? await cialoSurowe(zadanie, 60 * 1024 * 1024) : null;
    const szablon = zZipa ? null : url.searchParams.get("szablon") || "pusta";
    if (projekty.has(id)) return odpowiedz(odp, 409, { blad: "Projekt o takim identyfikatorze już istnieje." });
    const projekt = await utworzProjekt(DANE, { id, nazwa, szablon, zip, katalogSzablonow: SZABLONY });
    projekt.adresStrony = () => adresStrony(projekt);
    projekty.set(projekt.id, projekt);
    return odpowiedz(odp, 200, { ...opisProjektu(projekt), pominiete: projekt.pominiete || [] });
  }

  const trasa = sciezka.match(/^\/api\/p\/([a-z0-9-]+)\/([a-z-]+)$/);
  if (trasa) {
    const projekt = projekty.get(trasa[1]);
    // Projekt spoza uprawnień wygląda jak nieistniejący — nie zdradzamy, jakie projekty są na serwerze.
    if (!projekt || !widziProjekt(u, projekt.id)) return odpowiedz(odp, 404, { blad: "Nie ma takiego projektu." });
    const akcja = trasa[2] === "pliki" && zadanie.method === "GET" ? "pliki-odczyt" : trasa[2];
    if (!mozeAkcje(u, akcja)) return odpowiedz(odp, 403, { blad: "Twoja rola nie pozwala na tę operację. Poproś redaktora albo administratora." });
    return obsluzProjekt(projekt, trasa[2], zadanie, odp, url);
  }

  if (sciezka.startsWith("/api/")) return odpowiedz(odp, 404, { blad: "Nie ma takiego adresu." });
  return serwujPlik(odp, PUBLICZNE, sciezka, NAGLOWKI_PANELU);
}

// ---------- podgląd (osobny origin): /<projekt>/<plik> i /<projekt>/__wersja/<commit>/<plik> ----------

// Piaskownica (CSP sandbox bez allow-same-origin): każda strona podglądu dostaje unikalny, „pusty” origin. Wszystkie
// projekty dzielą domenę podglądu, więc bez tego skrypt wstawiony do wersji roboczej projektu A (np. przez klienta)
// mógłby, gdy podgląd otworzy administrator, odczytać fetch-em wersje robocze projektu B. Z pustego originu takie
// zapytanie jest między originami: bez CORS odpowiedzi nie da się odczytać.
const NAGLOWKI_PODGLADU = {
  "Content-Security-Policy": `sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads; frame-ancestors ${ADRES_PANELU}`,
  "Cache-Control": "no-store",
};
const SKRYPT_ZAZNACZANIA = `<script src="/__edytor/wybieracz.js" data-panel="${ADRES_PANELU}"></script>`;

// Podgląd dostaje też widoczne integracje (baner zgód, przycisk kontaktu), żeby było widać, jak będzie wyglądać strona.
function wyslijHtml(odp, tresc, projekt) {
  const html = wstawDoHtml(tresc, fragmentyStrony(projekt.stan.integracje, { podglad: true }));
  const z = /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${SKRYPT_ZAZNACZANIA}</body>`) : html + SKRYPT_ZAZNACZANIA;
  odp.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...BEZPIECZNE, ...NAGLOWKI_PODGLADU });
  odp.end(z);
}

async function serwujPodgladPliku(odp, projekt, sciezkaUrl) {
  const plik = await znajdzPlik(projekt.strona, sciezkaUrl, { tylkoPlikiStrony: true });
  if (!plik) return odpowiedz(odp, 404, "Nie ma takiego pliku", "text/plain; charset=utf-8");
  if (!/\.html?$/i.test(plik.sciezka)) return serwujPlik(odp, projekt.strona, sciezkaUrl, NAGLOWKI_PODGLADU, { tylkoPlikiStrony: true });
  return wyslijHtml(odp, await fs.readFile(plik.sciezka, "utf8"), projekt);
}

// Wersja historyczna: plik prosto z gita (`git show commit:plik`).
async function serwujPodgladWersji(odp, projekt, commit, sciezkaUrl) {
  let plik;
  try { plik = decodeURIComponent(sciezkaUrl); } catch { plik = ""; }
  if (plik === "" || plik.endsWith("/")) plik += "index.html";
  if (!plikStrony(plik)) return odpowiedz(odp, 404, "Nie ma", "text/plain");
  try {
    const { stdout } = await exec("git", ["-C", projekt.strona, "show", `${commit}:${plik}`], { encoding: "buffer", maxBuffer: 50 * 1024 * 1024 });
    if (/\.html?$/i.test(plik)) return wyslijHtml(odp, stdout.toString("utf8"), projekt);
    odp.writeHead(200, { "Content-Type": TYPY[path.extname(plik).toLowerCase()] || "application/octet-stream", ...BEZPIECZNE, ...NAGLOWKI_PODGLADU });
    odp.end(stdout);
  } catch {
    odpowiedz(odp, 404, "Nie ma takiego pliku w tej wersji", "text/plain; charset=utf-8");
  }
}

async function obsluzPodglad(zadanie, odp) {
  const url = new URL(zadanie.url, "http://x");
  const sciezka = url.pathname;

  // Wejście z panelu: klucz z adresu zamieniamy na ciasteczko tej domeny.
  if (sciezka === "/__wejscie") {
    const klucz = url.searchParams.get("klucz");
    if (!kontoZetonu(klucz, "podglad")) return odpowiedz(odp, 401, "Klucz podglądu wygasł. Odśwież panel.", "text/plain; charset=utf-8");
    const dalej = url.searchParams.get("dalej") || "/";
    odp.writeHead(302, {
      // SameSite=None: zapytania o CSS i obrazki wychodzą ze strony w piaskownicy (pusty origin), dla przeglądarki
      // to zapytania z innej witryny — ciasteczko Lax by w nich nie poszło i podgląd straciłby style.
      "Set-Cookie": `podglad=${klucz}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${DLUGOSC_PODGLADU / 1000}`,
      Location: dalej.startsWith("/") && !dalej.startsWith("//") ? dalej : "/",
      ...BEZPIECZNE,
    });
    return odp.end();
  }
  const ogladajacy = kontoZetonu(ciasteczko(zadanie, "podglad"), "podglad");
  if (!ogladajacy) {
    return odpowiedz(odp, 401, "Brak dostępu do podglądu. Otwórz go z panelu edytora.", "text/plain; charset=utf-8");
  }
  if (sciezka === "/__edytor/wybieracz.js") return serwujPlik(odp, PUBLICZNE, "/wybieracz.js", { "Cache-Control": "no-cache" });

  const trasa = sciezka.match(/^\/([a-z0-9-]+)(\/.*)?$/);
  const projekt = trasa && projekty.get(trasa[1]);
  if (!projekt || !widziProjekt(ogladajacy, projekt.id)) return odpowiedz(odp, 404, "Nie ma takiego projektu", "text/plain; charset=utf-8");
  if (!trasa[2]) { odp.writeHead(302, { Location: `/${projekt.id}/` }); return odp.end(); }
  if (zadanie.method === "POST" && /\/__formularz$/.test(sciezka)) {
    zadanie.resume();
    return odpowiedz(odp, 200, "<!DOCTYPE html><meta charset=utf-8><body style='font-family:system-ui;padding:40px'><h1>Formularz działa</h1><p>To podgląd: wiadomość nie została zapisana ani wysłana. Na opublikowanej stronie trafi do zakładki „Formularze” w panelu.</p></body>", "text/html; charset=utf-8");
  }
  const wersja = trasa[2].match(/^\/__wersja\/([0-9a-f]{4,40})\/(.*)$/);
  if (wersja) return serwujPodgladWersji(odp, projekt, wersja[1], wersja[2]);
  return serwujPodgladPliku(odp, projekt, trasa[2].slice(1));
}

// ---------- strony publiczne ----------

// Plik opublikowanej strony; gdy go nie ma: przekierowanie 301 ze starego adresu (np. WordPressowe ?p=ID),
// a dopiero potem strona 404 (z oryginału, jeśli import ją pobrał) z <base>, żeby jej względne linki działały z każdej głębokości.
// Czas cache w przeglądarce: HTML krótko (zmiana po publikacji widoczna w minutę), CSS/JS/obrazy trochę dłużej,
// fonty najdłużej (prawie nigdy się nie zmieniają). Po upływie czasu ETag i tak oszczędza transfer (304).
function cacheDla(sciezka) {
  const roz = path.extname(sciezka.split("?")[0]).toLowerCase();
  if ([".woff", ".woff2", ".ttf", ".otf"].includes(roz)) return "public, max-age=604800";
  if ([".css", ".js", ".mjs", ".png", ".jpg", ".jpeg", ".webp", ".avif", ".gif", ".svg", ".ico"].includes(roz)) return "public, max-age=300";
  return "public, max-age=60";
}

async function serwujStrone(zadanie, odp, projekt, sciezka, szukaj, baza, naglowki) {
  const przekierowania = projekt.stan.przekierowania || {};
  const cel = przekierowania[sciezka + szukaj] ?? (szukaj ? undefined : przekierowania[sciezka.replace(/\/$/, "")] ?? przekierowania[`${sciezka}/`]);
  // Adresy z zapytaniem (?p=123) sprawdzamy przed plikiem — inaczej serwer pokazałby stronę główną z kodem 200.
  if (cel !== undefined && (szukaj || !(await znajdzPlik(projekt.produkcja, sciezka, { tylkoPlikiStrony: true })))) {
    odp.writeHead(301, { Location: baza + cel, "Cache-Control": "public, max-age=3600", ...BEZPIECZNE });
    return odp.end();
  }
  if (await znajdzPlik(projekt.produkcja, sciezka, { tylkoPlikiStrony: true })) {
    return serwujPlik(odp, projekt.produkcja, sciezka, { ...naglowki, "Cache-Control": cacheDla(sciezka) }, { tylkoPlikiStrony: true, zadanie });
  }
  const strona404 = await znajdzPlik(projekt.produkcja, "/404.html", { tylkoPlikiStrony: true });
  if (!strona404) return odpowiedz(odp, 404, "Nie ma takiej strony", "text/plain; charset=utf-8");
  const html = (await fs.readFile(strona404.sciezka, "utf8")).replace(/<head([^>]*)>/i, `<head$1><base href="${baza}">`);
  odp.writeHead(404, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...BEZPIECZNE, ...naglowki });
  odp.end(html);
}

async function obsluzStrony(zadanie, odp) {
  const url = new URL(zadanie.url, "http://x");
  const host = (zadanie.headers.host || "").toLowerCase().replace(/:\d+$/, "");
  const formularz = /(^|\/)__formularz$/.test(url.pathname);
  if (zadanie.method === "POST" && !formularz) return odpowiedz(odp, 405, "Metoda niedozwolona", "text/plain; charset=utf-8");
  // 1) projekt z własną domeną — strona produkcyjna, indeksowana normalnie
  const poDomenie = !DOMENY_ZAREZERWOWANE.has(host) && [...projekty.values()].find((p) => p.stan.domena === host);
  if (poDomenie && formularz && zadanie.method === "POST") return obsluzFormularz(poDomenie, zadanie, odp, adresKlienta(zadanie), "/");
  if (poDomenie) return serwujStrone(zadanie, odp, poDomenie, url.pathname, url.search, "/", { "Cache-Control": "public, max-age=60" });
  // 2) wspólna domena: /<projekt>/... — to kopie robocze i stagingi, więc zakaz indeksowania (nie konkurują z prawdziwą stroną klienta)
  const trasa = url.pathname.match(/^\/([a-z0-9-]+)(\/.*)?$/);
  const projekt = trasa && projekty.get(trasa[1]);
  if (!projekt) return odpowiedz(odp, 404, "Nie ma takiej strony", "text/plain; charset=utf-8");
  if (formularz && zadanie.method === "POST") return obsluzFormularz(projekt, zadanie, odp, adresKlienta(zadanie), `/${projekt.id}/`);
  if (!trasa[2]) { odp.writeHead(301, { Location: `/${projekt.id}/${url.search}` }); return odp.end(); }
  return serwujStrone(zadanie, odp, projekt, trasa[2], url.search, `/${projekt.id}/`, { "Cache-Control": "public, max-age=60", "X-Robots-Tag": "noindex" });
}

// ---------- kopie zapasowe ----------

// Raz na dobę: tar.gz z danymi (bez pamięci rozmów agenta) na osobny wolumen. Zostaje 14 ostatnich kopii.
const KOPIE = process.env.EDYTOR_KOPIE || "/kopie";
const ILE_KOPII = 14;
let ostatniaKopia = null;

async function zrobKopie() {
  const nazwa = `edytor-ai-${new Date().toISOString().replace(/[:.]/g, "-")}.tgz`;
  const tymczasowy = path.join(KOPIE, `.${nazwa}.tmp`);
  try {
    await exec("tar", ["czf", tymczasowy, "-C", DANE, "--exclude=./claude", "."], { timeout: 10 * 60 * 1000 });
    await fs.rename(tymczasowy, path.join(KOPIE, nazwa));
    const kopie = (await fs.readdir(KOPIE)).filter((n) => /^edytor-ai-.*\.tgz$/.test(n)).sort();
    await Promise.all(kopie.slice(0, -ILE_KOPII).map((n) => fs.rm(path.join(KOPIE, n), { force: true })));
    ostatniaKopia = { nazwa, kiedy: new Date().toISOString() };
    console.log(`Kopia zapasowa: ${nazwa}`);
  } catch (e) {
    await fs.rm(tymczasowy, { force: true });
    ostatniaKopia = { blad: e.message.slice(0, 200), kiedy: new Date().toISOString() };
    console.error("Kopia zapasowa nie powiodła się:", e.message);
  }
}

async function planujKopie() {
  if (!(await fs.access(KOPIE, fs.constants.W_OK).then(() => true, () => false))) {
    console.log(`Kopie zapasowe wyłączone: brak zapisywalnego katalogu ${KOPIE}.`);
    return;
  }
  const kopie = (await fs.readdir(KOPIE)).filter((n) => /^edytor-ai-.*\.tgz$/.test(n)).sort();
  if (kopie.length) ostatniaKopia = { nazwa: kopie.at(-1), kiedy: (await fs.stat(path.join(KOPIE, kopie.at(-1)))).mtime.toISOString() };
  const sprawdz = async () => {
    const wiek = ostatniaKopia?.nazwa ? Date.now() - new Date(ostatniaKopia.kiedy).getTime() : Infinity;
    if (wiek > 23 * 3600 * 1000) await zrobKopie();
  };
  await sprawdz();
  setInterval(sprawdz, 3600 * 1000).unref();
}

// ---------- alerty ----------

// Serwer sam zgłasza problemy na webhook (EDYTOR_ALERT_WEBHOOK, np. n8n albo https://ntfy.sh/<temat>): treść idzie
// jako zwykły tekst w POST. Ten sam problem najwyżej raz na 6 godzin. Awarii całego serwera ten mechanizm nie zgłosi —
// do tego służy monitor zewnętrzny (EDYTOR_MONITOR_URL, niżej).
const ALERT_WEBHOOK = process.env.EDYTOR_ALERT_WEBHOOK || "";
const PROG_MIEJSCA = Number(process.env.EDYTOR_ALERT_MIEJSCE_PROCENT || 10);
const ostatnieAlerty = new Map();
let bledyAgentaZRzedu = 0;

async function alert(rodzaj, tekst) {
  console.error(`ALERT [${rodzaj}] ${tekst}`);
  if (!ALERT_WEBHOOK || Date.now() - (ostatnieAlerty.get(rodzaj) || 0) < 6 * 3600 * 1000) return;
  ostatnieAlerty.set(rodzaj, Date.now());
  // ntfy przyjmuje zwykły tekst (treść powiadomienia), reszta (n8n, Make, własne skrypty) dostaje JSON z polami.
  const ntfy = /(^|\.)ntfy\.sh$/.test(new URL(ALERT_WEBHOOK).hostname);
  const tresc = `Edytor AI (${ADRES_PANELU || "serwer"}): ${tekst}`;
  try {
    const odp = await fetch(ALERT_WEBHOOK, ntfy
      ? { method: "POST", body: tresc, headers: { "Content-Type": "text/plain; charset=utf-8", Title: `Edytor AI: ${rodzaj}` }, signal: AbortSignal.timeout(10000) }
      : { method: "POST", body: JSON.stringify({ rodzaj, tekst, tresc, serwer: ADRES_PANELU || null, kiedy: new Date().toISOString() }),
          headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(10000) });
    if (!odp.ok) console.error(`Alert: webhook odpowiedział ${odp.status}.`);
  } catch (e) {
    console.error("Alert nie został wysłany:", e.message);
  }
}

function odnotujBladAgenta(komunikat) {
  bledyAgentaZRzedu++;
  // Trzy nieudane polecenia z rzędu to zwykle problem z modelem (limit, klucz, awaria dostawcy), a nie z poleceniem.
  if (bledyAgentaZRzedu >= 3) alert("asystent", `${bledyAgentaZRzedu} polecenia z rzędu zakończyły się błędem. Ostatni: ${komunikat.slice(0, 200)}`);
}

async function stanZasobow() {
  const dysk = await fs.statfs(DANE).catch(() => null);
  return { wolneMiejsceProcent: dysk ? Math.round((dysk.bavail / dysk.blocks) * 1000) / 10 : null };
}

// Problemy widoczne z wnętrza procesu: mało miejsca, nieudana lub stara kopia. `zZewnatrz` — dodatkowo panel przez
// publiczny adres (Traefik, certyfikat, DNS), bo proces może działać, a strona być niedostępna dla ludzi.
async function wykryjProblemy({ zZewnatrz = false } = {}) {
  const problemy = [];
  const { wolneMiejsceProcent } = await stanZasobow();
  if (wolneMiejsceProcent !== null && wolneMiejsceProcent < PROG_MIEJSCA) problemy.push({ rodzaj: "dysk", tekst: `zostało ${wolneMiejsceProcent}% wolnego miejsca na dysku z danymi.` });
  if (ostatniaKopia?.blad) problemy.push({ rodzaj: "kopia", tekst: `ostatnia kopia zapasowa nie powiodła się: ${ostatniaKopia.blad}` });
  else if (ostatniaKopia?.kiedy && Date.now() - new Date(ostatniaKopia.kiedy).getTime() > 26 * 3600 * 1000) {
    problemy.push({ rodzaj: "kopia", tekst: `ostatnia kopia zapasowa jest z ${ostatniaKopia.kiedy} (starsza niż 26 godzin).` });
  }
  if (zZewnatrz && ADRES_PANELU) {
    const odp = await fetch(`${ADRES_PANELU}/zdrowie`, { signal: AbortSignal.timeout(10000) }).catch((e) => ({ ok: false, status: e.message }));
    if (!odp.ok) problemy.push({ rodzaj: "panel", tekst: `panel nie odpowiada pod ${ADRES_PANELU} (${odp.status}).` });
  }
  return problemy;
}

async function sprawdzAlerty() {
  for (const { rodzaj, tekst } of await wykryjProblemy()) alert(rodzaj, tekst);
}

// ---------- monitor zewnętrzny (np. Healthchecks.io) ----------

// „Dead man's switch”: co 5 minut serwer melduje się pod EDYTOR_MONITOR_URL. Gdy meldunki ustaną (padł VPS, Docker
// albo proces) albo przyjdzie meldunek …/fail z opisem problemu, monitor wysyła powiadomienie. Działa także wtedy,
// gdy leży cały serwer razem z n8n — czego alerty wysyłane stąd nie potrafią.
const MONITOR_URL = (process.env.EDYTOR_MONITOR_URL || "").replace(/\/$/, "");
async function meldujMonitorowi() {
  const problemy = await wykryjProblemy({ zZewnatrz: true });
  const tresc = problemy.length ? problemy.map((p) => `${p.rodzaj}: ${p.tekst}`).join("\n") : `ok · projekty: ${projekty.size} · agenci: ${aktywniAgenci}`;
  try {
    const odp = await fetch(problemy.length ? `${MONITOR_URL}/fail` : MONITOR_URL, { method: "POST", body: tresc, signal: AbortSignal.timeout(10000) });
    if (!odp.ok) console.error(`Monitor: meldunek odrzucony (${odp.status}).`);
  } catch (e) {
    console.error("Monitor: meldunek nie dotarł:", e.message);
  }
}

// ---------- start ----------

await przygotuj();
planujKopie();
odswiezDomeny();
// Co 5 minut: domena, której DNS właśnie przestawiono, sama „wskoczy” bez ponownego zapisu ustawień.
setInterval(odswiezDomeny, 5 * 60 * 1000).unref();
setInterval(sprawdzAlerty, 10 * 60 * 1000).unref();
setTimeout(sprawdzAlerty, Number(process.env.EDYTOR_ALERT_OPOZNIENIE_MS || 60 * 1000)).unref();
if (MONITOR_URL) {
  setInterval(meldujMonitorowi, 5 * 60 * 1000).unref();
  setTimeout(meldujMonitorowi, Number(process.env.EDYTOR_ALERT_OPOZNIENIE_MS || 60 * 1000)).unref();
}

const PORT_PANELU = Number(process.env.EDYTOR_PORT_PANELU || 8080);
const PORT_STRONY = Number(process.env.EDYTOR_PORT_STRONY || 8081);
const PORT_PODGLADU = Number(process.env.EDYTOR_PORT_PODGLADU || 8082);
http.createServer(opakuj(obsluzPanel)).listen(PORT_PANELU, () => console.log(`Panel: :${PORT_PANELU}`));
http.createServer(opakuj(obsluzPodglad)).listen(PORT_PODGLADU, () => console.log(`Podgląd: :${PORT_PODGLADU}`));
http.createServer(opakuj(obsluzStrony)).listen(PORT_STRONY, () => console.log(`Strony: :${PORT_STRONY} (projekty: ${projekty.size})`));

// Docker zatrzymuje kontener sygnałem SIGTERM: przerywamy pracujących agentów, żeby zapisali stan.
process.on("SIGTERM", () => {
  for (const projekt of projekty.values()) projekt.przerwanie?.abort("restart");
  setTimeout(() => process.exit(0), 3000).unref();
});
