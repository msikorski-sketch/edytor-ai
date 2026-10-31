// Projekty (strony) edytora. Każdy ma własny katalog w DANE/projekty/<id>/:
//   strona/    wersja robocza, repozytorium git,
//   wydania/   opublikowane wersje (każda w osobnym katalogu),
//   produkcja  dowiązanie do aktualnego wydania,
//   stan.json  nazwa, domena, sesja agenta, ostatnia publikacja.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const blad = (kod, tekst) => Object.assign(new Error(tekst), { kod });

export const WZOR_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

// Typy plików, które strona może zawierać i które serwer pokazuje publicznie.
const ROZSZERZENIA = new Set([
  ".html", ".htm", ".css", ".js", ".mjs", ".json", ".txt", ".xml", ".webmanifest",
  ".png", ".jpg", ".jpeg", ".webp", ".avif", ".gif", ".svg", ".ico",
  ".woff", ".woff2", ".ttf", ".otf", ".mp4", ".webm", ".mp3", ".pdf",
]);

// Czy plik może być częścią strony (podgląd, publikacja, import)? Bez ukrytych plików i katalogów
// (.env, .git, .htpasswd…) — z wyjątkiem .well-known — i tylko typy z białej listy.
export function plikStrony(sciezka) {
  const czesci = String(sciezka).split("/");
  if (czesci.some((c) => c === "" || c === "." || c === ".." || (c.startsWith(".") && c !== ".well-known"))) return false;
  return ROZSZERZENIA.has(path.extname(sciezka).toLowerCase());
}

// Ostrzejsza reguła dla plików wgrywanych przez panel: tylko bezpieczne znaki w nazwach.
export function sprawdzNazwePliku(sciezka) {
  if (typeof sciezka !== "string" || sciezka.length > 200) return "Zła nazwa pliku.";
  if (sciezka.split("/").some((c) => !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(c))) {
    return "Nazwa może zawierać tylko litery, cyfry, kropki, myślniki i podkreślenia (bez polskich znaków i spacji).";
  }
  if (!plikStrony(sciezka)) return `Niedozwolony typ pliku: ${path.extname(sciezka) || "brak rozszerzenia"}.`;
  return null;
}

const losowy = () => `${process.pid}-${crypto.randomBytes(4).toString("hex")}`;

async function zapiszJsonAtomowo(plik, dane) {
  const tymczasowy = `${plik}.${losowy()}.tmp`;
  await fs.writeFile(tymczasowy, JSON.stringify(dane, null, 2));
  await fs.rename(tymczasowy, plik);
}

export class Projekt {
  constructor(dane, id, katalog = path.join(dane, "projekty", id)) {
    this.id = id;
    this.katalog = katalog;
    this.strona = path.join(katalog, "strona");
    this.wydania = path.join(katalog, "wydania");
    this.produkcja = path.join(katalog, "produkcja");
    this.plikStanu = path.join(katalog, "stan.json");
    this.stan = {};
    this.zajete = null; // nazwa trwającej operacji albo null
    this.przerwanie = null; // AbortController pracującego agenta
    this.kolejkaZapisow = Promise.resolve();
  }

  git(...argumenty) {
    return exec("git", ["-C", this.strona, ...argumenty], { maxBuffer: 20 * 1024 * 1024 }).then((w) => w.stdout.trim());
  }

  async wczytajStan() {
    try { this.stan = JSON.parse(await fs.readFile(this.plikStanu, "utf8")); } catch { this.stan = {}; }
  }

  // Zapisy stanu idą po kolei (kolejka), a każdy przez unikalny plik tymczasowy i rename —
  // równoległe operacje nie zgubią nawzajem swoich zmian ani nie zostawią uciętego JSON-a.
  zapiszStan(zmiany) {
    Object.assign(this.stan, zmiany);
    const zapis = this.kolejkaZapisow.then(() => zapiszJsonAtomowo(this.plikStanu, this.stan));
    this.kolejkaZapisow = zapis.catch(() => {});
    return zapis;
  }

  // Blokada zajmowana synchronicznie: dwie operacje zmieniające ten projekt nie pójdą naraz.
  zajmij(nazwa) {
    if (this.zajete) return false;
    this.zajete = nazwa;
    return true;
  }
  zwolnij() {
    this.zajete = null;
    this.przerwanie = null;
  }

  async zatwierdz(opis) {
    await this.git("add", "-A");
    if (!(await this.git("status", "--porcelain"))) return null;
    await this.git("commit", "-q", "-m", opis.slice(0, 200));
    return this.git("rev-parse", "--short", "HEAD");
  }

  // Publikacja = nowy katalog wydania z plików śledzonych przez git + atomowa podmiana dowiązania `produkcja`.
  // Do wydania trafiają tylko pliki strony (bez ukrytych i spoza białej listy) i bez dowiązań.
  // Poprzednie wydanie zostaje na dysku, więc strona nie znika w żadnym momencie.
  async opublikuj(ktory = "HEAD") {
    const commit = await this.git("rev-parse", "--short", `${ktory}^{commit}`);
    await fs.mkdir(this.wydania, { recursive: true });
    const nazwa = `${new Date().toISOString().replace(/[:.]/g, "-")}-${commit}`;
    const katalog = path.join(this.wydania, nazwa);
    await fs.mkdir(katalog);
    try {
      await potok(["git", "-C", this.strona, "archive", "--format=tar", commit], ["tar", "-x", "-C", katalog]);
      await oczyscKatalog(katalog);
      await uzupelnijSeo(katalog, this.adresStrony?.());
    } catch (e) {
      await fs.rm(katalog, { recursive: true, force: true });
      throw e;
    }
    // Stary układ (zwykły katalog zamiast dowiązania) zamieniamy jednorazowo.
    const obecna = await fs.lstat(this.produkcja).catch(() => null);
    if (obecna && !obecna.isSymbolicLink()) await fs.rm(this.produkcja, { recursive: true, force: true });
    const tymczasowe = `${this.produkcja}.${losowy()}.tmp`;
    await fs.symlink(path.join("wydania", nazwa), tymczasowe);
    await fs.rename(tymczasowe, this.produkcja);

    const aktualne = path.basename(await fs.readlink(this.produkcja));
    const stare = (await fs.readdir(this.wydania)).filter((s) => s !== aktualne).sort().slice(0, -2);
    await Promise.all(stare.map((s) => fs.rm(path.join(this.wydania, s), { recursive: true, force: true })));
    await this.zapiszStan({ opublikowano: commit, opublikowanoKiedy: new Date().toISOString() });
    return commit;
  }

  async historia(ile = 30) {
    const wynik = await this.git("log", `-${ile}`, "--pretty=format:%h%x1f%s%x1f%cI");
    return wynik.split("\n").filter(Boolean).map((linia) => {
      const [commit, opis, kiedy] = linia.split("\x1f");
      return { commit, opis, kiedy };
    });
  }

  async sledzone() {
    return (await this.git("ls-files", "-z")).split("\0").filter(Boolean);
  }

  async podstrony() {
    const pliki = (await this.sledzone()).filter((p) => /\.html?$/i.test(p) && plikStrony(p));
    return pliki.sort((a, b) => (a === "index.html" ? -1 : b === "index.html" ? 1 : a.localeCompare(b)));
  }

  async pliki() {
    return Promise.all((await this.sledzone()).filter(plikStrony).map(async (sciezka) => {
      const info = await fs.lstat(path.join(this.strona, sciezka)).catch(() => null);
      return { sciezka, rozmiar: info?.size ?? 0 };
    }));
  }

  async wgrajPlik(sciezka, dane) {
    const problem = sprawdzNazwePliku(sciezka);
    if (problem) throw blad(400, problem);
    const cel = path.join(this.strona, sciezka);
    await fs.mkdir(path.dirname(cel), { recursive: true });
    // Katalog docelowy po rozwinięciu dowiązań musi leżeć w stronie (np. „obrazy” nie może być symlinkiem na zewnątrz).
    const korzen = await fs.realpath(this.strona);
    const katalogCelu = await fs.realpath(path.dirname(cel));
    if (katalogCelu !== korzen && !katalogCelu.startsWith(korzen + path.sep)) throw blad(400, "Tej ścieżki nie można użyć.");
    const istniejacy = await fs.lstat(cel).catch(() => null);
    if (istniejacy?.isSymbolicLink() || istniejacy?.isDirectory()) throw blad(400, "Tej ścieżki nie można nadpisać.");
    await fs.writeFile(cel, dane);
    return this.zatwierdz(`${istniejacy ? "Podmieniono" : "Dodano"} plik ${sciezka}`);
  }

  // Usunąć można każdy śledzony plik strony — także z nazwą ze spacją czy polskimi znakami (np. z importu).
  async usunPlik(sciezka) {
    if (typeof sciezka !== "string" || !plikStrony(sciezka)) throw blad(400, "Zła nazwa pliku.");
    if (!(await this.sledzone()).includes(sciezka)) throw blad(404, "Nie ma takiego pliku.");
    await this.git("rm", "-q", "--", sciezka);
    return this.zatwierdz(`Usunięto plik ${sciezka}`);
  }

  // Proces `git archive` tworzący ZIP z wybranej wersji — tylko pliki śledzone przez git.
  eksportuj(ktory = "HEAD") {
    return spawn("git", ["-C", this.strona, "archive", "--format=zip", ktory]);
  }
}

// sitemap.xml i robots.txt dla wydania, jeśli strona ich nie ma (adres publiczny potrzebny do pełnych URL-i).
// Wydanie dostaje je przy publikacji — nie trafiają do repozytorium, więc zawsze odpowiadają aktualnym podstronom.
export async function uzupelnijSeo(katalog, adres) {
  if (!adres) return;
  const istnieje = (n) => fs.access(path.join(katalog, n)).then(() => true, () => false);
  if (!(await istnieje("sitemap.xml"))) {
    const strony = (await fs.readdir(katalog, { recursive: true }))
      .map((p) => String(p).split(path.sep).join("/"))
      .filter((p) => /\.html?$/i.test(p) && p !== "404.html" && plikStrony(p))
      .sort();
    const ucieczka = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const adresy = strony.map((p) => `  <url><loc>${ucieczka(adres + p.replace(/(^|\/)index\.html?$/i, "$1").split("/").map(encodeURIComponent).join("/"))}</loc></url>`);
    await fs.writeFile(path.join(katalog, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${adresy.join("\n")}\n</urlset>\n`);
  }
  if (!(await istnieje("robots.txt"))) {
    await fs.writeFile(path.join(katalog, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${adres}sitemap.xml\n`);
  }
}

// Uruchamia `a | b` i czeka na zakończenie obu procesów; błąd, jeśli którykolwiek zwróci kod różny od 0.
function potok(a, b) {
  const pierwszy = spawn(a[0], a.slice(1));
  const drugi = spawn(b[0], b.slice(1));
  pierwszy.stdout.pipe(drugi.stdin);
  let bledy = "";
  for (const proces of [pierwszy, drugi]) proces.stderr.on("data", (d) => { bledy += d; });
  const koniec = (proces) => new Promise((ok) => proces.on("close", ok));
  return Promise.all([koniec(pierwszy), koniec(drugi)]).then(([k1, k2]) => {
    if (k1 !== 0 || k2 !== 0) throw new Error(`Polecenie nie powiodło się: ${bledy.trim()}`);
  });
}

// Usuwa z katalogu dowiązania i wszystko, co nie jest plikiem strony. Zwraca listę usuniętych ścieżek.
export async function oczyscKatalog(katalog) {
  const usuniete = [];
  const wpisy = await fs.readdir(katalog, { withFileTypes: true, recursive: true });
  // Najpierw najgłębsze wpisy, żeby usunięcie katalogu nie psuło dalszej iteracji.
  wpisy.sort((a, b) => b.parentPath.length - a.parentPath.length);
  for (const wpis of wpisy) {
    const pelna = path.join(wpis.parentPath, wpis.name);
    const wzgledna = path.relative(katalog, pelna).split(path.sep).join("/");
    const ukryty = wzgledna.split("/").some((c) => c.startsWith(".") && c !== ".well-known");
    if (wpis.isSymbolicLink() || (wpis.isDirectory() && ukryty) || (wpis.isFile() && !plikStrony(wzgledna)) || (!wpis.isFile() && !wpis.isDirectory())) {
      await fs.rm(pelna, { recursive: true, force: true });
      usuniete.push(wzgledna);
    }
  }
  return usuniete;
}

export async function wczytajProjekty(dane) {
  const katalog = path.join(dane, "projekty");
  await fs.mkdir(katalog, { recursive: true });
  const projekty = new Map();
  for (const wpis of await fs.readdir(katalog, { withFileTypes: true })) {
    if (!wpis.isDirectory() || !WZOR_ID.test(wpis.name)) continue;
    const projekt = new Projekt(dane, wpis.name);
    await projekt.wczytajStan();
    projekty.set(projekt.id, projekt);
  }
  return projekty;
}

// Usunięcie projektu = przeniesienie całego katalogu do DANE/kosz/<id>-<czas>; odzyskanie to przeniesienie z powrotem.
export async function przeniesDoKosza(dane, projekt) {
  projekt.usuniety = true; // formularze przestają przyjmować wiadomości, zanim katalog zniknie
  const kosz = path.join(dane, "kosz");
  await fs.mkdir(kosz, { recursive: true });
  const cel = path.join(kosz, `${projekt.id}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await fs.rename(projekt.katalog, cel);
  return cel;
}

// Identyfikatory projektów w trakcie tworzenia — rezerwowane synchronicznie, przed pierwszym `await`.
const rezerwacje = new Set();

// Nowy projekt z szablonu albo z archiwum ZIP. Cały projekt (pliki, repozytorium, pierwsze wydanie) powstaje
// w unikalnym katalogu tymczasowym i dopiero na końcu trafia pod docelową nazwę — nieudana próba nic nie zostawia.
// `wypelnij(katalogStrony)` — własne źródło plików (np. import z adresu URL); zwraca listę pominiętych plików.
export async function utworzProjekt(dane, { id, nazwa, szablon, zip, wypelnij, opisCommita, katalogSzablonow }) {
  if (!WZOR_ID.test(id || "")) throw blad(400, "Identyfikator: małe litery, cyfry i myślniki (np. salon-fryzjerski).");
  if (rezerwacje.has(id)) throw blad(409, "Projekt o takim identyfikatorze właśnie powstaje.");
  rezerwacje.add(id);
  const katalogProjektow = path.join(dane, "projekty");
  let roboczy = null;
  try {
    const docelowy = path.join(katalogProjektow, id);
    if (await fs.access(docelowy).then(() => true, () => false)) throw blad(409, "Projekt o takim identyfikatorze już istnieje.");
    roboczy = await fs.mkdtemp(path.join(katalogProjektow, `.nowy-${id}-`));
    const tymczasowy = new Projekt(dane, id, roboczy);
    await fs.mkdir(tymczasowy.strona);
    let pominiete = [];
    if (wypelnij) {
      pominiete = await wypelnij(tymczasowy.strona);
      pominiete = [...pominiete, ...(await oczyscKatalog(tymczasowy.strona))];
    } else if (zip) {
      pominiete = await rozpakujZip(zip, tymczasowy.strona);
    } else {
      if (!/^[a-z0-9-]+$/.test(szablon || "")) throw blad(400, "Nieznany szablon.");
      await fs.cp(path.join(katalogSzablonow, szablon), tymczasowy.strona, { recursive: true });
    }
    // .gitignore z importu mógłby ukryć pliki przed commitem; strona nie potrzebuje własnych reguł gita.
    await fs.rm(path.join(tymczasowy.strona, ".gitignore"), { force: true });
    await tymczasowy.zapiszStan({ nazwa: nazwa || id });
    await tymczasowy.git("init", "-q", "-b", "main");
    await tymczasowy.git("add", "-A");
    await tymczasowy.git("commit", "-q", "-m", opisCommita || (zip ? "Import z archiwum ZIP" : `Nowa strona z szablonu ${szablon}`));
    await tymczasowy.opublikuj();
    await fs.rename(roboczy, docelowy);
    roboczy = null;
    const projekt = new Projekt(dane, id);
    await projekt.wczytajStan();
    projekt.pominiete = pominiete;
    return projekt;
  } catch (e) {
    if (e.kod) throw e;
    throw blad(400, `Nie udało się utworzyć projektu: ${e.message.slice(0, 300)}`);
  } finally {
    if (roboczy) await fs.rm(roboczy, { recursive: true, force: true });
    rezerwacje.delete(id);
  }
}

// Limity importu: chronią dysk i proces przed „bombą ZIP” (małe archiwum, ogromna zawartość).
const LIMIT_ROZPAKOWANYCH = 300 * 1024 * 1024;
const LIMIT_WPISOW = 5000;
let importTrwa = false;

// Rozpakowanie ZIP-a przez bsdtar (domyślnie odrzuca ścieżki z `..` i bezwzględne). Najpierw spis zawartości
// i sprawdzenie limitów, potem rozpakowanie z limitem czasu, na końcu sprzątanie (dowiązania, ukryte i obce pliki).
// Jeśli wszystko leży w jednym folderze, jego zawartość trafia na główny poziom. Zwraca listę pominiętych plików.
async function rozpakujZip(zip, cel) {
  if (importTrwa) throw blad(429, "Trwa inny import. Spróbuj za chwilę.");
  importTrwa = true;
  // ZIP ma spis zawartości na końcu pliku, więc bsdtar potrzebuje pliku na dysku, a nie strumienia.
  const plikZip = `${cel}.zip`;
  try {
    await fs.writeFile(plikZip, zip);
    let spis;
    try {
      spis = (await exec("bsdtar", ["-tvf", plikZip], { maxBuffer: 50 * 1024 * 1024, timeout: 30000 })).stdout;
    } catch (e) {
      throw blad(400, `To nie jest poprawne archiwum ZIP: ${String(e.stderr || e.message).trim().slice(0, 200)}`);
    }
    const wiersze = spis.split("\n").filter(Boolean);
    if (wiersze.length > LIMIT_WPISOW) throw blad(400, `Archiwum ma za dużo plików (${wiersze.length}, limit ${LIMIT_WPISOW}).`);
    // Format `bsdtar -tv` jak `ls -l`: rozmiar to piąta kolumna.
    const suma = wiersze.reduce((s, w) => s + (Number(w.trim().split(/\s+/)[4]) || 0), 0);
    if (suma > LIMIT_ROZPAKOWANYCH) throw blad(400, `Archiwum po rozpakowaniu ma ${Math.round(suma / 1024 / 1024)} MB (limit ${LIMIT_ROZPAKOWANYCH / 1024 / 1024} MB).`);
    try {
      await exec("bsdtar", ["-x", "-f", plikZip, "-C", cel], { timeout: 120000 });
    } catch (e) {
      throw blad(400, `Nie udało się rozpakować archiwum: ${String(e.stderr || e.message).trim().slice(0, 300)}`);
    }
  } finally {
    await fs.rm(plikZip, { force: true });
    importTrwa = false;
  }
  for (const nazwa of ["__MACOSX"]) await fs.rm(path.join(cel, nazwa), { recursive: true, force: true });
  const zawartosc = (await fs.readdir(cel, { withFileTypes: true })).filter((w) => !w.name.startsWith("."));
  if (zawartosc.length === 1 && zawartosc[0].isDirectory()) {
    const srodek = path.join(cel, zawartosc[0].name);
    const tymczasowy = `${cel}-srodek`;
    await fs.rename(srodek, tymczasowy);
    for (const nazwa of await fs.readdir(tymczasowy)) await fs.rename(path.join(tymczasowy, nazwa), path.join(cel, nazwa)).catch(() => {});
    await fs.rm(tymczasowy, { recursive: true, force: true });
  }
  const pominiete = await oczyscKatalog(cel);
  const html = (await fs.readdir(cel, { recursive: true })).some((p) => /\.html?$/i.test(String(p)));
  if (!html) throw blad(400, "W archiwum nie ma żadnego pliku .html.");
  return pominiete;
}

// Przejście ze starego układu (jedna strona w DANE/strona) na projekty. Wszystko trafia najpierw do katalogu
// „.migracja-<id>”, a pod docelową nazwę dopiero po skompletowaniu — przerwaną migrację następny start dokończy.
// Opublikowane wydanie przenosimy 1:1, więc publiczna strona się nie zmienia.
export async function przeniesStaryUklad(dane, { id, nazwa, domena }) {
  const etap = path.join(dane, "projekty", `.migracja-${id}`);
  const stara = path.join(dane, "strona");
  const istnieje = (p) => fs.lstat(p).then(() => true, () => false);
  if (!(await istnieje(path.join(stara, ".git"))) && !(await istnieje(etap))) return false;
  if (await istnieje(path.join(dane, "projekty", id))) throw new Error(`Migracja: projekt „${id}” już istnieje, a stary układ wciąż jest w ${dane}. Rozwiąż ręcznie.`);

  await fs.mkdir(etap, { recursive: true });
  const projekt = new Projekt(dane, id, etap);
  for (const [skad, dokad] of [[stara, projekt.strona], [path.join(dane, "wydania"), projekt.wydania], [path.join(dane, "produkcja"), projekt.produkcja]]) {
    if ((await istnieje(skad)) && !(await istnieje(dokad))) await fs.rename(skad, dokad);
  }
  if (!(await istnieje(path.join(projekt.strona, ".git")))) throw new Error("Migracja: brak repozytorium strony w katalogu migracji.");
  // Dowiązanie produkcji musi prowadzić do istniejącego wydania; inaczej opublikujemy zapisany commit od nowa.
  const produkcja = await fs.stat(projekt.produkcja).catch(() => null);
  if (!produkcja?.isDirectory()) await fs.rm(projekt.produkcja, { force: true, recursive: true });

  await projekt.wczytajStan();
  if (!projekt.stan.nazwa) {
    let stary = {};
    try { stary = JSON.parse(await fs.readFile(path.join(dane, "stan.json"), "utf8")); } catch {}
    await projekt.zapiszStan({ nazwa, domena, opublikowano: stary.opublikowano, opublikowanoKiedy: stary.opublikowanoKiedy });
  }
  await fs.rename(etap, path.join(dane, "projekty", id));
  return true;
}
