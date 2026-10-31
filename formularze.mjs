// Formularze na statycznych stronach. Strona wysyła formularz metodą POST na adres kończący się „__formularz”
// (np. <form action="__formularz" method="post">). Serwer stron:
//   1) sprawdza zgłoszenie (rozmiar, liczba pól, pole-pułapka _gotcha na boty, limit wysyłek z jednego adresu),
//   2) NAJPIERW zapisuje je w projekcie (formularze/RRRR-MM.jsonl) — nic nie ginie, nawet gdy powiadomienie zawiedzie,
//   3) wysyła powiadomienie: e-mail (SMTP z .env) i/lub webhook (np. n8n) ustawione w projekcie.
// Pola zaczynające się od „_” są sterujące: _gotcha (pułapka), _powrot (strona podziękowania, ścieżka liczona od głównego
// katalogu strony, np. „dziekuje/”), _temat (temat powiadomienia), _podziekowanie (tekst na domyślnej stronie podziękowania).
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import nodemailer from "nodemailer";
import { pobierz } from "./siec.mjs";

const LIMIT_CIALA = 32 * 1024;
const LIMIT_POL = 30;
const LIMIT_WARTOSCI = 5000;
const OKNO_LIMITU = 10 * 60 * 1000;
const WYSYLEK_W_OKNIE = 5;
// Bajty zgłoszeń na projekt i miesiąc — chroni dysk przed zalewem spamu (testy ustawiają mniejszą wartość).
const LIMIT_MIESIACA = Number(process.env.EDYTOR_FORMULARZE_LIMIT_KB || 20 * 1024) * 1024;
const MIESIACE_PRZECHOWYWANIA = 24;
const CZYTAJ_KONCOWKE = 2 * 1024 * 1024; // panel czyta najwyżej tyle z końca każdego pliku

// SMTP z .env: EDYTOR_SMTP=smtps://uzytkownik:haslo@smtp.dostawca.pl:465, EDYTOR_SMTP_OD=strona@twojadomena.pl.
// Wartość „json” to tryb testowy (wiadomość tylko składana, nie wysyłana).
const SMTP = process.env.EDYTOR_SMTP || "";
const SMTP_OD = process.env.EDYTOR_SMTP_OD || "";
export const SMTP_SKONFIGUROWANY = Boolean(SMTP && (SMTP_OD || SMTP === "json"));
const transport = SMTP === "json" ? nodemailer.createTransport({ jsonTransport: true }) : SMTP ? nodemailer.createTransport(SMTP) : null;

// Limit wysyłek: stałe okno czasowe na klucz (projekt + adres). Każdy wpis to dwie liczby, więc zalew zapytań
// nie rozdyma pamięci ani nie kosztuje CPU; stare wpisy wygasają pojedynczo (bez kasowania wszystkich blokad).
const wysylki = new Map(); // klucz → { od, ile }
export function przekroczonyLimit(klucz) {
  const teraz = Date.now();
  let wpis = wysylki.get(klucz);
  if (!wpis || teraz - wpis.od > OKNO_LIMITU) {
    wysylki.delete(klucz);
    wpis = { od: teraz, ile: 0 };
    wysylki.set(klucz, wpis);
  }
  if (wpis.ile >= WYSYLEK_W_OKNIE) return true;
  wpis.ile++;
  // Map zachowuje kolejność wstawiania: najstarsze okna są na początku, usuwamy je od przodu.
  if (wysylki.size > 50000) {
    for (const [k, w] of wysylki) {
      if (teraz - w.od <= OKNO_LIMITU || wysylki.size <= 40000) break;
      wysylki.delete(k);
    }
  }
  return false;
}

async function czytajCialo(zadanie) {
  const kawalki = [];
  let rozmiar = 0;
  for await (const kawalek of zadanie) {
    rozmiar += kawalek.length;
    if (rozmiar > LIMIT_CIALA) throw Object.assign(new Error("Formularz jest za duży."), { kod: 413 });
    kawalki.push(kawalek);
  }
  return Buffer.concat(kawalki).toString("utf8");
}

// Zwraca pola formularza jako zwykły obiekt tekst → tekst (wiele wartości o tej samej nazwie łączymy przecinkiem).
async function odczytajPola(zadanie) {
  const typ = (zadanie.headers["content-type"] || "").toLowerCase();
  const tekst = await czytajCialo(zadanie);
  let wpisy;
  if (typ.includes("application/json")) {
    let dane;
    try { dane = JSON.parse(tekst); } catch { throw Object.assign(new Error("Niepoprawne dane formularza."), { kod: 400 }); }
    if (!dane || typeof dane !== "object" || Array.isArray(dane)) throw Object.assign(new Error("Niepoprawne dane formularza."), { kod: 400 });
    wpisy = Object.entries(dane).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]);
  } else if (typ.includes("multipart/form-data")) {
    throw Object.assign(new Error("Formularze z załącznikami nie są obsługiwane. Usuń pole pliku z formularza."), { kod: 415 });
  } else {
    wpisy = [...new URLSearchParams(tekst)];
  }
  const pola = {};
  for (const [klucz, wartosc] of wpisy) {
    // Page buildery opakowują nazwy pól: Breakdance „fields[email]”, Elementor „form_fields[email]” → „email”.
    const nazwa = String(klucz).replace(/^(?:form_)?fields\[([^\]]+)\]$/, "$1").slice(0, 100);
    pola[nazwa] = pola[nazwa] !== undefined ? `${pola[nazwa]}, ${wartosc}` : String(wartosc);
    if (pola[nazwa].length > LIMIT_WARTOSCI) throw Object.assign(new Error(`Pole „${nazwa}” jest za długie.`), { kod: 413 });
  }
  if (Object.keys(pola).length > LIMIT_POL) throw Object.assign(new Error("Formularz ma za dużo pól."), { kod: 413 });
  return pola;
}

const katalogZgloszen = (projekt) => path.join(projekt.katalog, "formularze");
const plikMiesiaca = (projekt, data = new Date()) => path.join(katalogZgloszen(projekt), `${data.toISOString().slice(0, 7)}.jsonl`);
// Dopisanie zgłoszenia. Katalog „formularze” tworzymy bez `recursive`: jeśli projekt został w międzyczasie usunięty
// (katalog przeniesiony do kosza), zapis się nie uda zamiast po cichu odtworzyć porzucony katalog projektu.
async function dopisz(projekt, wpis, { sprawdzLimit = false } = {}) {
  if (projekt.usuniety) throw Object.assign(new Error("Ta strona nie przyjmuje już wiadomości."), { kod: 410 });
  await fs.mkdir(katalogZgloszen(projekt)).catch((e) => { if (e.code !== "EEXIST") throw e; });
  const plik = plikMiesiaca(projekt);
  const linia = `${JSON.stringify(wpis)}\n`;
  if (sprawdzLimit) {
    const rozmiar = (await fs.stat(plik).catch(() => ({ size: 0 }))).size;
    if (rozmiar + linia.length > LIMIT_MIESIACA) throw Object.assign(new Error("Formularz chwilowo nie przyjmuje wiadomości. Spróbuj później."), { kod: 503, limitMiesiaca: true });
  }
  await fs.appendFile(plik, linia);
}

// Usuwa pliki zgłoszeń starsze niż MIESIACE_PRZECHOWYWANIA (wywoływane przy zapisie, najwyżej raz na dobę na projekt).
async function sprzatnijStare(projekt) {
  if (projekt.ostatnieSprzatanie && Date.now() - projekt.ostatnieSprzatanie < 24 * 3600 * 1000) return;
  projekt.ostatnieSprzatanie = Date.now();
  const granica = new Date();
  granica.setMonth(granica.getMonth() - MIESIACE_PRZECHOWYWANIA);
  const najstarszy = granica.toISOString().slice(0, 7);
  for (const plik of await fs.readdir(katalogZgloszen(projekt)).catch(() => [])) {
    if (/^\d{4}-\d{2}\.jsonl$/.test(plik) && plik.slice(0, 7) < najstarszy) await fs.rm(path.join(katalogZgloszen(projekt), plik), { force: true });
  }
}

function trescWiadomosci(projekt, pola, strona) {
  const linie = Object.entries(pola).map(([k, v]) => `${k}:\n${v}\n`);
  return `Nowe zgłoszenie z formularza na stronie „${projekt.stan.nazwa || projekt.id}”${strona ? ` (${strona})` : ""}.\n\n${linie.join("\n")}`;
}

async function powiadom(projekt, wpis) {
  const ustawienia = projekt.stan.formularze || {};
  const wyniki = {};
  if (ustawienia.email) {
    if (!transport) {
      wyniki.email = "pominięto: serwer nie ma skonfigurowanego SMTP (EDYTOR_SMTP)";
    } else {
      try {
        const emailNadawcy = Object.values(wpis.pola).find((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v));
        await transport.sendMail({
          from: SMTP_OD || "edytor@localhost",
          to: ustawienia.email,
          replyTo: emailNadawcy,
          subject: `${wpis.temat || "Formularz"} — ${projekt.stan.nazwa || projekt.id}`,
          text: trescWiadomosci(projekt, wpis.pola, wpis.strona),
        });
        wyniki.email = "wysłano";
      } catch (e) {
        wyniki.email = `błąd: ${e.message.slice(0, 200)}`;
      }
    }
  }
  if (ustawienia.webhook) {
    try {
      const odp = await pobierz(ustawienia.webhook, {
        metoda: "POST", limitBajtow: 64 * 1024, przekierowania: 2,
        naglowki: { "Content-Type": "application/json" },
        cialo: JSON.stringify({ projekt: projekt.id, nazwa: projekt.stan.nazwa, kiedy: wpis.kiedy, strona: wpis.strona, temat: wpis.temat, pola: wpis.pola }),
        sygnal: AbortSignal.timeout(10000),
      });
      wyniki.webhook = odp.status < 400 ? "wysłano" : `błąd: HTTP ${odp.status}`;
    } catch (e) {
      wyniki.webhook = `błąd: ${e.message.slice(0, 200)}`;
    }
  }
  return wyniki;
}

function odpowiedzGotowe(zadanie, odp, { ok, komunikat, powrot, kod = 200 }) {
  const chceJson = (zadanie.headers.accept || "").includes("application/json") || zadanie.headers["x-requested-with"];
  if (chceJson) {
    odp.writeHead(kod, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return odp.end(JSON.stringify({ ok, komunikat }));
  }
  if (ok && powrot) {
    odp.writeHead(303, { Location: powrot, "Cache-Control": "no-store" });
    return odp.end();
  }
  const wstecz = zadanie.headers.referer && /^https?:\/\//.test(zadanie.headers.referer) ? zadanie.headers.referer : "./";
  const bezpieczny = (t) => t.replace(/[&<>"]/g, (z) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[z]);
  odp.writeHead(kod, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  odp.end(`<!DOCTYPE html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${ok ? "Dziękujemy" : "Nie wysłano"}</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;color:#1f2937}main{max-width:460px;padding:24px;text-align:center}a{color:#2563eb}</style></head>
<body><main><h1>${ok ? "Dziękujemy!" : "Nie udało się wysłać"}</h1><p>${bezpieczny(komunikat)}</p><p><a href="${bezpieczny(wstecz)}">Wróć na stronę</a></p></main></body></html>`);
}

// Obsługa POST …/__formularz na opublikowanej stronie. `ip` — adres klienta (do limitu wysyłek, nie jest zapisywany).
// `bazaStrony` — adres głównego katalogu strony („/” na własnej domenie, „/<projekt>/” na wspólnej), od którego liczymy _powrot.
export async function obsluzFormularz(projekt, zadanie, odp, ip, bazaStrony = "/") {
  let pola;
  try {
    pola = await odczytajPola(zadanie);
  } catch (e) {
    return odpowiedzGotowe(zadanie, odp, { ok: false, komunikat: e.message, kod: e.kod || 400 });
  }
  // Bot wypełnił ukryte pole: udajemy sukces, żeby nie uczył się omijać pułapki — ale niczego nie zapisujemy.
  if (pola._gotcha) return odpowiedzGotowe(zadanie, odp, { ok: true, komunikat: "Wiadomość została wysłana." });
  const sciezkaPowrotu = String(pola._powrot || "").replace(/^\/+/, "");
  const powrot = sciezkaPowrotu && /^[A-Za-z0-9._~\/-]+$/.test(sciezkaPowrotu) && !sciezkaPowrotu.split("/").includes("..") ? bazaStrony + sciezkaPowrotu : null;
  const podziekowanie = String(pola._podziekowanie || "").replace(/\s+/g, " ").trim().slice(0, 300);
  const temat = (pola._temat || "").replace(/[\r\n]+/g, " ").slice(0, 150);
  const dane = Object.fromEntries(Object.entries(pola).filter(([k]) => !k.startsWith("_")));
  if (!Object.values(dane).some((v) => v.trim())) {
    return odpowiedzGotowe(zadanie, odp, { ok: false, komunikat: "Formularz jest pusty.", kod: 400 });
  }
  // Limit liczymy dopiero dla poprawnych zgłoszeń: pomyłkowe kliknięcie przy pustym formularzu nie przybliża blokady.
  if (przekroczonyLimit(`${projekt.id}|${ip}`)) {
    return odpowiedzGotowe(zadanie, odp, { ok: false, komunikat: "Wysłano za dużo wiadomości. Spróbuj ponownie za kilka minut.", kod: 429 });
  }
  let strona = null;
  try { strona = new URL(zadanie.headers.referer).pathname; } catch {}
  const wpis = { id: crypto.randomUUID(), kiedy: new Date().toISOString(), strona, temat: temat || null, pola: dane };
  try {
    await dopisz(projekt, wpis, { sprawdzLimit: true });
  } catch (e) {
    if (e.limitMiesiaca) console.error(`Formularze projektu „${projekt.id}”: przekroczony limit ${LIMIT_MIESIACA / 1048576} MB na miesiąc.`);
    return odpowiedzGotowe(zadanie, odp, { ok: false, komunikat: e.kod ? e.message : "Nie udało się zapisać wiadomości.", kod: e.kod || 500 });
  }
  sprzatnijStare(projekt).catch(() => {});
  const wyniki = await powiadom(projekt, wpis);
  if (Object.keys(wyniki).length) await dopisz(projekt, { id: wpis.id, powiadomienie: wyniki }).catch(() => {});
  odpowiedzGotowe(zadanie, odp, { ok: true, komunikat: podziekowanie || "Wiadomość została wysłana. Odpowiemy najszybciej, jak to możliwe.", powrot });
}

// Ostatnie linie pliku — czyta najwyżej CZYTAJ_KONCOWKE bajtów od końca (plik może mieć wiele MB).
async function koncowkaLinii(plik) {
  const uchwyt = await fs.open(plik, "r");
  try {
    const { size } = await uchwyt.stat();
    const ile = Math.min(size, CZYTAJ_KONCOWKE);
    const bufor = Buffer.alloc(ile);
    await uchwyt.read(bufor, 0, ile, size - ile);
    const linie = bufor.toString("utf8").split("\n").filter(Boolean);
    if (ile < size) linie.shift(); // pierwsza linia mogła zostać ucięta w połowie
    return linie;
  } finally {
    await uchwyt.close();
  }
}

// Ostatnie zgłoszenia projektu (najnowsze pierwsze), ze statusem powiadomień dołączonym po id.
export async function listaZgloszen(projekt, ile = 200) {
  const pliki = (await fs.readdir(katalogZgloszen(projekt)).catch(() => [])).filter((n) => n.endsWith(".jsonl")).sort().reverse();
  const zgloszenia = [];
  const statusy = new Map();
  for (const plik of pliki) {
    for (const linia of (await koncowkaLinii(path.join(katalogZgloszen(projekt), plik))).reverse()) {
      let wpis;
      try { wpis = JSON.parse(linia); } catch { continue; }
      if (wpis.powiadomienie) statusy.set(wpis.id, wpis.powiadomienie);
      else zgloszenia.push(wpis);
    }
    if (zgloszenia.length >= ile) break;
  }
  return zgloszenia.slice(0, ile).map((z) => ({ ...z, powiadomienie: statusy.get(z.id) || null }));
}
