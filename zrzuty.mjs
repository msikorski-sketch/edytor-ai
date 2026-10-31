// Zrzuty ekranu wersji roboczej dla agenta: dzięki nim model widzi efekt swojej zmiany i może go poprawić.
//
// Izolacja: strona NIE jest otwierana przez file:// (mogłaby wtedy osadzić dowolny plik serwera, np. /proc/1/environ
// z kluczem API). Każdy zrzut dostaje tymczasowy serwer HTTP na 127.0.0.1, który zna tylko pliki tej strony;
// przeglądarka może poza nim pobierać wyłącznie publiczne zasoby HTTPS (fonty, CDN). Chromium startuje z pustym
// środowiskiem. Jedna przeglądarka współdzielona przez wszystkie zrzuty, najwyżej 2 zrzuty naraz.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright-core";
import { plikStrony } from "./projekty.mjs";

const CHROMIUM = process.env.EDYTOR_CHROMIUM || "/usr/bin/chromium";
export const ZRZUTY_DOSTEPNE = process.env.EDYTOR_ZRZUTY !== "0" && fs.existsSync(CHROMIUM);

const URZADZENIA = {
  komputer: { viewport: { width: 1280, height: 860 } },
  telefon: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
};
const TYPY = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
  ".mjs": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".webp": "image/webp", ".avif": "image/avif", ".gif": "image/gif", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
};

// ---------- jedna przeglądarka, uruchamiana raz (współdzielona obietnica) ----------

let uruchamianie = null;
let zamykanie = null;

function dajPrzegladarke() {
  clearTimeout(zamykanie);
  zamykanie = setTimeout(zamknijPrzegladarke, 5 * 60 * 1000).unref();
  if (!uruchamianie) {
    // Bez piaskownicy Chromium (kontener nie ma przestrzeni nazw użytkownika) — dlatego izolujemy sieć i środowisko.
    uruchamianie = chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox", "--disable-dev-shm-usage"], env: {} });
    uruchamianie.then((p) => p.on("disconnected", () => { uruchamianie = null; }), () => { uruchamianie = null; });
  }
  return uruchamianie;
}

async function zamknijPrzegladarke() {
  const p = uruchamianie;
  uruchamianie = null;
  if (p) await (await p).close().catch(() => {});
}

// ---------- semafor: najwyżej 2 zrzuty naraz ----------

let wolne = 2;
const czekajacy = [];
async function zajmij() {
  if (wolne > 0) { wolne--; return; }
  await new Promise((ok) => czekajacy.push(ok));
}
function zwolnij() {
  const nastepny = czekajacy.shift();
  if (nastepny) nastepny(); else wolne++;
}

// ---------- tymczasowy serwer z plikami jednej strony ----------

function serwerStrony(korzen) {
  const serwer = http.createServer((zadanie, odp) => {
    let wzgledna;
    try { wzgledna = decodeURIComponent(new URL(zadanie.url, "http://x").pathname).replace(/^\/+/, ""); } catch { wzgledna = ""; }
    if (wzgledna === "" || wzgledna.endsWith("/")) wzgledna += "index.html";
    const pelna = path.join(korzen, path.posix.normalize("/" + wzgledna));
    let prawdziwa;
    try { prawdziwa = fs.realpathSync(pelna); } catch { prawdziwa = null; }
    if (!prawdziwa || !prawdziwa.startsWith(korzen + path.sep) || !plikStrony(path.relative(korzen, prawdziwa).split(path.sep).join("/"))) {
      odp.writeHead(404).end();
      return;
    }
    odp.writeHead(200, { "Content-Type": TYPY[path.extname(prawdziwa).toLowerCase()] || "application/octet-stream" });
    fs.createReadStream(prawdziwa).on("error", () => odp.destroy()).pipe(odp);
  });
  return new Promise((ok) => serwer.listen(0, "127.0.0.1", () => ok(serwer)));
}

// Adresy sieci lokalnej i prywatnej — przeglądarka nie może do nich sięgać (poza serwerem strony).
const PRYWATNY = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?$|\[?f[cd]|\[?fe80)/i;

// Zwraca JPEG (base64) podstrony `plik`. `selektor` zawęża zrzut do jednego elementu.
export async function zrobZrzut(katalog, { plik = "index.html", urzadzenie = "komputer", selektor } = {}) {
  const korzen = fs.realpathSync(katalog);
  if (!plikStrony(String(plik)) || !/\.html?$/i.test(plik)) throw new Error("Zrzut można zrobić tylko podstronie .html tej strony.");
  const sciezka = fs.realpathSync(path.resolve(korzen, plik));
  if (!sciezka.startsWith(korzen + path.sep)) throw new Error("Zrzut można zrobić tylko podstronie .html tej strony.");

  await zajmij();
  const serwer = await serwerStrony(korzen);
  const adres = `http://127.0.0.1:${serwer.address().port}`;
  let kontekst;
  try {
    kontekst = await (await dajPrzegladarke()).newContext({ ...(URZADZENIA[urzadzenie] ?? URZADZENIA.komputer) });
    await kontekst.route("**/*", (trasa) => {
      const url = new URL(trasa.request().url());
      const dozwolony = url.origin === adres || ["data:", "blob:"].includes(url.protocol) || (url.protocol === "https:" && !PRYWATNY.test(url.hostname));
      return dozwolony ? trasa.continue() : trasa.abort();
    });
    const strona = await kontekst.newPage();
    await strona.goto(`${adres}/${path.relative(korzen, sciezka).split(path.sep).map(encodeURIComponent).join("/")}`, { waitUntil: "load", timeout: 15000 });
    await strona.waitForTimeout(400); // animacje wejścia i fonty
    const opcje = { type: "jpeg", quality: 70, timeout: 15000 };
    if (selektor) {
      const element = strona.locator(selektor).first();
      if (!(await element.count())) throw new Error(`Na stronie nie ma elementu „${selektor}”.`);
      await element.scrollIntoViewIfNeeded();
      return (await element.screenshot(opcje)).toString("base64");
    }
    return (await strona.screenshot(opcje)).toString("base64");
  } finally {
    await kontekst?.close().catch(() => {});
    serwer.close();
    zwolnij();
  }
}
