// Import istniejącej strony (np. WordPressa) z adresu URL do statycznych plików projektu.
//
// Faza 1 — pobieranie: strony HTML z tej samej witryny (linki + mapa strony sitemap.xml) oraz zasoby
// (CSS, JS, obrazki, fonty), także te wskazane w CSS (url(), @import) i w leniwym ładowaniu (data-src, srcset).
// Faza 2 — przepisanie: linki do pobranych plików stają się względne (strona działa też w podkatalogu /<projekt>/),
// leniwe obrazki dostają zwykłe src, znikają śmieci WordPressa, a formularze (Contact Form 7 i podobne)
// zaczynają wysyłać dane do formularzy edytora (`__formularz`).
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import * as cheerio from "cheerio";
import { pobierz, sprawdzAdres } from "./siec.mjs";
import { plikStrony } from "./projekty.mjs";

const LIMITY = {
  strony: 300, pliki: 4000, bajty: 300 * 1024 * 1024, czasMs: 10 * 60 * 1000, rownolegle: 4,
  plik: 25 * 1024 * 1024, // pojedynczy zasób (zdjęcie, wideo)
  html: 5 * 1024 * 1024, // pojedyncza strona HTML — parsowana w pamięci, więc limit dużo mniejszy
  kolejka: 20000, // ile adresów najwyżej zaplanować
};
const ROZSZERZENIA_TYPOW = {
  "text/css": ".css", "application/javascript": ".js", "text/javascript": ".js", "image/png": ".png", "image/jpeg": ".jpg",
  "image/webp": ".webp", "image/avif": ".avif", "image/gif": ".gif", "image/svg+xml": ".svg", "image/x-icon": ".ico",
  "image/vnd.microsoft.icon": ".ico", "font/woff2": ".woff2", "font/woff": ".woff", "font/ttf": ".ttf", "font/otf": ".otf",
  "application/pdf": ".pdf", "video/mp4": ".mp4", "application/json": ".json",
};
const ATRYBUTY_ZASOBOW = ["src", "data-src", "data-lazy-src", "data-original", "data-bg", "poster", "data-background"];
const ATRYBUTY_SRCSET = ["srcset", "data-srcset", "data-lazy-srcset"];
const META_OBRAZKOW = 'meta[property="og:image"], meta[property="og:image:url"], meta[name="twitter:image"], meta[name="msapplication-TileImage"]';

// ---------- adresy ----------

function kluczAdresu(url, strona) {
  const u = new URL(url);
  u.hash = "";
  if (!strona) u.search = ""; // zasoby: style.css?ver=6.4 i style.css?ver=6.5 to ten sam plik
  return u.href;
}

// Ścieżka lokalna dla pobranego adresu. Strony bez rozszerzenia (/oferta/) → oferta/index.html, .php → .html.
function sciezkaLokalna(url, strona, typ) {
  const u = new URL(url);
  let sciezka;
  try { sciezka = decodeURIComponent(u.pathname); } catch { sciezka = u.pathname; }
  sciezka = sciezka.replace(/[\x00-\x1f\\]/g, "-").replace(/\/{2,}/g, "/").replace(/^\//, "");
  if (strona) {
    if (sciezka === "" || sciezka.endsWith("/")) sciezka += "index.html";
    else if (/\.(php|aspx?|jsp)$/i.test(sciezka)) sciezka = sciezka.replace(/\.(php|aspx?|jsp)$/i, ".html").replace(/(^|\/)index\.html$/, "$1index.html");
    else if (!/\.html?$/i.test(sciezka)) sciezka += "/index.html";
    if (u.search && sciezka !== "index.html") sciezka = sciezka.replace(/\.html?$/i, `-${u.search.slice(1).replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 40)}.html`);
    return sciezka;
  }
  if (!path.extname(sciezka) && ROZSZERZENIA_TYPOW[typ]) sciezka += ROZSZERZENIA_TYPOW[typ];
  return sciezka;
}

function wzgledna(zPliku, doPliku) {
  const wynik = path.posix.relative(path.posix.dirname(zPliku), doPliku);
  // Link do strony głównej katalogu: „kontakt/” zamiast „kontakt/index.html”.
  if (/(^|\/)index\.html$/.test(wynik)) return wynik.replace(/index\.html$/, "") || "./";
  return wynik || path.posix.basename(doPliku);
}

// Kodowanie segmentów ścieżki w atrybutach (spacje, polskie znaki, „?” w nazwach plików).
const zakodowana = (sciezka) => sciezka.split("/").map((c) => (c === ".." || c === "." ? c : encodeURIComponent(c))).join("/");

function rozbierzSrcset(wartosc) {
  return String(wartosc).split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    const [url, ...opis] = s.split(/\s+/);
    return { url, opis: opis.join(" ") };
  });
}

const URL_W_CSS = /url\(\s*(['"]?)([^'")]+)\1\s*\)|@import\s+(['"])([^'"]+)\3/g;

// ---------- import ----------

// Opisy pozycji raportu migracji: co się stanie na statycznej kopii i co z tym zrobić.
export const OPISY_UWAG = {
  wyszukiwarka: { waga: "nie działa", tytul: "Wyszukiwarka", rada: "Usuń pole wyszukiwania albo poproś asystenta o wyszukiwarkę po stronie przeglądarki (np. lista podstron z filtrem)." },
  sklep: { waga: "nie działa", tytul: "Sklep (WooCommerce)", rada: "Koszyk i zamówienia wymagają WordPressa. Zostaw sklep na WordPressie (np. subdomena sklep.) albo podlinkuj zewnętrzną platformę." },
  komentarze: { waga: "nie działa", tytul: "Komentarze", rada: "Usuń formularz komentarzy albo zastąp go formularzem kontaktowym." },
  logowanie: { waga: "nie działa", tytul: "Logowanie i konto użytkownika", rada: "Usuń linki do logowania albo kieruj na system, który nadal działa (np. platforma kursów)." },
  zalaczniki: { waga: "zmienione", tytul: "Formularze z załącznikami", rada: "Pola plików usunięto (formularze edytora przyjmują tylko tekst). Dodaj informację „pliki prosimy wysłać e-mailem”." },
  dynamiczne: { waga: "sprawdź", tytul: "Treści ładowane z WordPressa", rada: "Skrypty odwołują się do admin-ajax lub REST API (np. „wczytaj więcej”, filtry, liczniki). Sprawdź te miejsca w podglądzie." },
  sledzenie: { waga: "sprawdź", tytul: "Skrypty analityczne i reklamowe", rada: "GTM, GA, Pixel itp. zostały przeniesione. Upewnij się, że uruchamiają się dopiero po zgodzie (RODO)." },
  cookies: { waga: "sprawdź", tytul: "Baner zgód (cookies)", rada: "Wtyczka zgód mogła działać przez WordPressa. Sprawdź, czy baner się pokazuje i zapisuje wybór; w razie potrzeby wstaw zewnętrzny CMP." },
  jezyki: { waga: "sprawdź", tytul: "Wersje językowe", rada: "Przełącznik języków (WPML, Polylang) działa tylko, jeśli zaimportowały się wszystkie wersje — sprawdź linki." },
};

export async function importujStrone(adresStartowy, cel, { postep = () => {}, sygnal, limity = {} } = {}) {
  const L = { ...LIMITY, ...limity };
  const start = sprawdzAdres(adresStartowy);
  start.hash = "";
  const hosty = new Set([start.hostname, start.hostname.startsWith("www.") ? start.hostname.slice(4) : `www.${start.hostname}`]);
  const naszaWitryna = (u) => ["http:", "https:"].includes(u.protocol) && hosty.has(u.hostname);
  const koniecCzasu = Date.now() + L.czasMs;

  // Wspólny sygnał: przerwanie przez użytkownika (zamknięcie połączenia) albo koniec czasu importu.
  const termin = AbortSignal.timeout(L.czasMs);
  const sygnalLaczny = sygnal ? AbortSignal.any([sygnal, termin]) : termin;

  const pobrane = new Map(); // klucz → { lokalna, typ: "strona"|"css"|"zasob" }
  const sciezki = new Map(); // lokalna ścieżka → klucz, który ją zajął (różne adresy nie mogą nadpisać jednego pliku)
  const kolejka = [];
  const zaplanowane = new Set();
  const statystyka = { strony: 0, pliki: 0, bajty: 0, pominiete: [], bledy: [], przerwanyCzas: false };
  // Stare adresy WordPressa → nowe ścieżki (dla przekierowań 301): skróty ?p=ID i adresy, które WordPress przekierowywał.
  const przekierowania = {};
  const sciezkaUrl = (lokalna) => lokalna.replace(/(^|\/)index\.html$/, "$1");
  const dodajPrzekierowanie = (stary, lokalna) => {
    let u;
    try { u = new URL(stary); } catch { return; }
    if (!naszaWitryna(u)) return;
    const klucz = u.pathname + u.search;
    const cel = "/" + sciezkaUrl(lokalna);
    if (klucz !== cel && klucz !== "/" && Object.keys(przekierowania).length < 5000) przekierowania[klucz] = sciezkaUrl(lokalna);
  };
  // Rezerwacje: pobierania w toku liczą się do limitów, zanim się skończą (inaczej równoległość przekracza limity).
  const rezerwacje = { strony: 0, pliki: 0 };
  const pominieto = (adres) => { if (statystyka.pominiete.length < 5000) statystyka.pominiete.push(adres); };

  const zaplanuj = (adres, bazowy, strona) => {
    let u;
    try { u = new URL(adres, bazowy); } catch { return; }
    if (!naszaWitryna(u)) return;
    // Skrypty, które i tak usuwamy z HTML (emoji, oEmbed, wtyczki formularzy) — nie ma sensu ich pobierać.
    if (!strona && /wp-emoji|wp-embed|contact-form-7\/includes\/js|wpforms\/assets\/js/.test(u.pathname)) return;
    if (strona && /\/(wp-admin|wp-login\.php|wp-json|feed|xmlrpc\.php)(\/|$)|\/\?replytocom=|[?&](s|p|page_id|attachment_id)=/.test(u.pathname + u.search)) return;
    if (strona && path.extname(u.pathname) && !/\.(html?|php|aspx?)$/i.test(u.pathname)) strona = false; // link do PDF/obrazka
    const klucz = kluczAdresu(u.href, strona);
    if (zaplanowane.has(klucz)) return;
    if (zaplanowane.size >= L.kolejka) { pominieto(u.href); return; }
    zaplanowane.add(klucz);
    kolejka.push({ adres: u.href, klucz, strona });
  };

  // Adres bazowy dokumentu: <base href> zmienia znaczenie wszystkich względnych adresów na stronie.
  const bazaDokumentu = ($, adres) => {
    const base = $("base[href]").first().attr("href");
    if (!base) return adres;
    try { return new URL(base, adres).href; } catch { return adres; }
  };

  // Adres startowy musi być stroną HTML — inaczej literówka w adresie dałaby po cichu import „czegoś” z mapy strony.
  let sprawdzenie;
  try {
    sprawdzenie = await pobierz(start.href, { limitBajtow: L.html, sygnal: sygnalLaczny });
  } catch (e) {
    throw Object.assign(new Error(`Nie udało się pobrać strony: ${e.message}`), { kod: 400 });
  }
  const typStartu = (sprawdzenie.naglowki.get("content-type") || "").split(";")[0].trim();
  if (sprawdzenie.status >= 400) throw Object.assign(new Error(`Nie udało się pobrać strony: pod tym adresem serwer zwraca błąd HTTP ${sprawdzenie.status}.`), { kod: 400 });
  if (!/html/.test(typStartu)) throw Object.assign(new Error(`Nie udało się pobrać strony: pod tym adresem nie ma strony HTML (${typStartu || "nieznany typ"}).`), { kod: 400 });
  // Strona mogła przekierować na inną domenę (np. bez www → z www) — wtedy to jest „nasza” witryna.
  hosty.add(new URL(sprawdzenie.url).hostname);

  zaplanuj(start.href, start.href, true);
  // Mapa strony WordPressa/SEO uzupełnia podstrony, do których nie prowadzi żaden link. Jej bajty liczą się do limitu.
  const licznikMap = {
    mapy: 0, adresy: 0,
    // Mapy mogą zająć najwyżej 20% budżetu — reszta zostaje na strony i zasoby.
    bajty: (n) => { if (statystyka.bajty + n > L.bajty * 0.2) return false; statystyka.bajty += n; return true; },
  };
  for (const mapa of ["/wp-sitemap.xml", "/sitemap_index.xml", "/sitemap.xml"]) {
    await wczytajMape(new URL(mapa, start).href, (adres) => zaplanuj(adres, start.href, true), sygnalLaczny, licznikMap).catch(() => {});
  }

  const pliki = []; // { lokalna, typ, adres } do fazy przepisywania
  async function przetworz(zadanie) {
    const { adres, strona } = zadanie;
    if (sygnalLaczny.aborted || statystyka.bajty >= L.bajty) { pominieto(adres); return; }
    if (statystyka.pliki + rezerwacje.pliki >= L.pliki) { pominieto(adres); return; }
    if (strona && statystyka.strony + rezerwacje.strony >= L.strony) { pominieto(adres); return; }
    rezerwacje.pliki++;
    if (strona) rezerwacje.strony++;
    try {
      await pobierzIZapisz(zadanie);
    } finally {
      rezerwacje.pliki--;
      if (strona) rezerwacje.strony--;
    }
  }
  async function pobierzIZapisz({ adres, klucz, strona }) {
    // Plik nie może być większy niż pozostały budżet bajtów importu.
    const budzet = Math.min(strona ? L.html : L.plik, L.bajty - statystyka.bajty);
    let odp;
    try {
      odp = await pobierz(adres, { limitBajtow: budzet, sygnal: sygnalLaczny });
    } catch (e) {
      // Przerwanie albo wyczerpany budżet importu to „pominięte”, nie błąd strony.
      if (sygnalLaczny.aborted || (e.code === "EZADUZY" && budzet < (strona ? L.html : L.plik))) { pominieto(adres); return; }
      statystyka.bledy.push(`${adres}: ${e.message}`);
      return;
    }
    if (odp.status >= 400) { statystyka.bledy.push(`${adres}: HTTP ${odp.status}`); return; }
    if (!naszaWitryna(new URL(odp.url))) { pominieto(adres); return; }
    const typ = (odp.naglowki.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const html = typ === "text/html" || typ === "application/xhtml+xml";
    // Zasób, który okazał się stroną HTML (np. .js zwracający stronę błędu), też podlega limitom stron.
    if (html && (odp.dane.length > L.html || (!strona && statystyka.strony + rezerwacje.strony >= L.strony))) { pominieto(adres); return; }
    // Sprawdzenie i doliczenie bajtów w jednym, synchronicznym kroku — przed jakimkolwiek await,
    // żeby równoległe pobrania nie przekroczyły budżetu razem.
    if (statystyka.bajty + odp.dane.length > L.bajty) { pominieto(adres); return; }
    statystyka.bajty += odp.dane.length;
    let lokalna = sciezkaLokalna(odp.url, html, typ);
    // Przekierowany adres (np. bez ukośnika → z ukośnikiem) wskazuje na ten sam plik.
    const kluczKoncowy = kluczAdresu(odp.url, html);
    const zbedny = !plikStrony(lokalna) || (kluczKoncowy !== klucz && pobrane.has(kluczKoncowy));
    if (zbedny) {
      statystyka.bajty -= odp.dane.length; // nic nie zapisujemy — zwracamy budżet
      if (pobrane.has(kluczKoncowy)) pobrane.set(klucz, pobrane.get(kluczKoncowy)); else pominieto(adres);
      return;
    }
    // Kolizja: inny adres (np. /x.php i /x.html) zajął już tę ścieżkę — dostajemy sufiks z hasza pełnego adresu.
    if (sciezki.has(lokalna) && sciezki.get(lokalna) !== kluczKoncowy) {
      const sufiks = crypto.createHash("sha1").update(kluczKoncowy).digest("hex").slice(0, 6);
      lokalna = lokalna.replace(/(\.[^./]+)?$/, (roz) => `-${sufiks}${roz}`);
    }
    sciezki.set(lokalna, kluczKoncowy);
    const wpis = { lokalna, typ: html ? "strona" : typ === "text/css" ? "css" : "zasob" };
    pobrane.set(klucz, wpis);
    pobrane.set(kluczKoncowy, wpis);
    if (html && kluczKoncowy !== klucz) dodajPrzekierowanie(adres, lokalna);
    zaplanowane.add(kluczKoncowy);
    const pelna = path.join(cel, lokalna);
    await fs.mkdir(path.dirname(pelna), { recursive: true });
    await fs.writeFile(pelna, odp.dane);
    statystyka.pliki++;
    if (html) statystyka.strony++;
    pliki.push({ lokalna, typ: wpis.typ, adres: odp.url });

    if (html) {
      const $ = cheerio.load(odp.dane.toString("utf8"));
      const baza = bazaDokumentu($, odp.url);
      $("a[href], area[href]").each((_, el) => zaplanuj($(el).attr("href"), baza, true));
      $("link[href]").each((_, el) => {
        const rel = ($(el).attr("rel") || "").toLowerCase();
        if (/stylesheet|icon|preload|manifest|apple-touch-icon/.test(rel)) zaplanuj($(el).attr("href"), baza, false);
      });
      $("script[src]").each((_, el) => zaplanuj($(el).attr("src"), baza, false));
      for (const atr of ATRYBUTY_ZASOBOW) $(`[${atr}]`).each((_, el) => zaplanuj($(el).attr(atr), baza, false));
      for (const atr of ATRYBUTY_SRCSET) $(`[${atr}]`).each((_, el) => rozbierzSrcset($(el).attr(atr)).forEach((s) => zaplanuj(s.url, baza, false)));
      $(META_OBRAZKOW).each((_, el) => zaplanuj($(el).attr("content"), baza, false));
      const css = [$("style").text(), ...$("[style]").map((_, el) => $(el).attr("style")).get()].join("\n");
      for (const m of css.matchAll(URL_W_CSS)) zaplanuj(m[2] || m[4], baza, false);
    } else if (typ === "text/css") {
      for (const m of odp.dane.toString("utf8").matchAll(URL_W_CSS)) zaplanuj(m[2] || m[4], odp.url, false);
    }
    postep({ strony: statystyka.strony, pliki: statystyka.pliki, bajty: statystyka.bajty, kolejka: kolejka.length });
  }

  // Kilka pobrań naraz; kolejka rośnie w trakcie, więc pracownicy kończą, gdy jest pusta i nikt nie pracuje.
  let aktywni = 0;
  await new Promise((ok) => {
    const nastepny = () => {
      while (aktywni < L.rownolegle && kolejka.length) {
        aktywni++;
        przetworz(kolejka.shift()).catch((e) => statystyka.bledy.push(e.message)).finally(() => { aktywni--; nastepny(); });
      }
      if (!aktywni && !kolejka.length) ok();
    };
    nastepny();
  });
  // Przerwanie przez użytkownika: nic nie tworzymy ani nie publikujemy. Koniec czasu: zostaje to, co zdążyło się pobrać.
  if (sygnal?.aborted) throw Object.assign(new Error("Import został przerwany."), { kod: 499 });
  statystyka.przerwanyCzas = termin.aborted;
  if (!statystyka.strony) {
    const powod = statystyka.bledy[0] || (statystyka.bajty >= L.bajty || statystyka.pominiete.length ? "przekroczony limit rozmiaru albo liczby plików importu" : "brak HTML pod tym adresem");
    throw Object.assign(new Error(`Nie udało się pobrać strony: ${powod}.`), { kod: 400 });
  }

  // Strona 404 oryginału — pobierana pod adresem, który na pewno nie istnieje; zapisana jako 404.html.
  try {
    const adres404 = new URL(`/edytor-ai-sprawdzenie-404-${Date.now().toString(36)}/`, start).href;
    const odp404 = await pobierz(adres404, { limitBajtow: L.html, sygnal: sygnalLaczny });
    const typ404 = (odp404.naglowki.get("content-type") || "").split(";")[0].trim();
    if (odp404.status === 404 && /html/.test(typ404) && statystyka.bajty + odp404.dane.length <= L.bajty) {
      await fs.writeFile(path.join(cel, "404.html"), odp404.dane);
      statystyka.bajty += odp404.dane.length;
      pliki.push({ lokalna: "404.html", typ: "strona", adres: adres404 });
    }
  } catch { /* brak strony 404 nie jest błędem importu */ }

  // ---------- faza 2: przepisanie adresów i porządki ----------
  const lokalnyAdres = (adres, bazowy, strona) => {
    let u;
    try { u = new URL(adres, bazowy); } catch { return null; }
    const trafienie = pobrane.get(kluczAdresu(u.href, strona)) || pobrane.get(kluczAdresu(u.href, !strona));
    return trafienie ? { lokalna: trafienie.lokalna, hash: u.hash } : null;
  };
  const przepiszCss = (tekst, zPliku, bazowy) => tekst.replace(URL_W_CSS, (calosc, c1, url1, c2, url2) => {
    const url = url1 || url2;
    if (!url || /^(data:|#)/.test(url)) return calosc;
    const cel = lokalnyAdres(url, bazowy, false);
    if (!cel) return calosc;
    const nowy = zakodowana(wzgledna(zPliku, cel.lokalna));
    return url1 ? `url("${nowy}")` : `@import "${nowy}"`;
  });

  let formularze = 0;
  let formularzeBezZalacznikow = 0;
  // Raport migracji: elementy, które na statycznej kopii nie zadziałają albo wymagają decyzji (do 5 przykładowych stron).
  const uwagi = new Map();
  const zauwaz = (rodzaj, strona) => {
    const lista = uwagi.get(rodzaj) || [];
    if (lista.length < 5 && !lista.includes(strona)) lista.push(strona);
    uwagi.set(rodzaj, lista);
    (uwagi.liczniki ??= {})[rodzaj] = (uwagi.liczniki[rodzaj] || 0) + 1;
  };
  for (const plik of pliki) {
    const pelna = path.join(cel, plik.lokalna);
    if (plik.typ === "css") {
      await fs.writeFile(pelna, przepiszCss(await fs.readFile(pelna, "utf8"), plik.lokalna, plik.adres));
      continue;
    }
    if (plik.typ !== "strona") continue;
    const $ = cheerio.load(await fs.readFile(pelna, "utf8"));
    const baza = bazaDokumentu($, plik.adres); // liczona przed usunięciem <base>
    const przepisz = (wartosc, strona) => {
      if (!wartosc || /^(data:|mailto:|tel:|javascript:|#)/i.test(wartosc)) return wartosc;
      const cel = lokalnyAdres(wartosc, baza, strona);
      if (cel) return zakodowana(wzgledna(plik.lokalna, cel.lokalna)) + (cel.hash || "");
      // Niepobrany adres naszej witryny zostawiamy jako pełny adres (działał przed importem).
      try { return new URL(wartosc, baza).href; } catch { return wartosc; }
    };

    // Wykrywanie przed porządkami (później znikają np. skrypty wtyczek).
    if (plik.lokalna !== "404.html") {
      const strona = "/" + plik.lokalna.replace(/(^|\/)index\.html$/, "$1");
      const skrypty = $("script").map((_, el) => ($(el).attr("src") || "") + " " + $(el).text().slice(0, 20000)).get().join("\n");
      if ($('form[role="search"], form.search-form, .wp-block-search, input[name="s"]').length) zauwaz("wyszukiwarka", strona);
      if ($("body.woocommerce, body.woocommerce-page, .add_to_cart_button, .woocommerce-cart-form, form.cart").length) zauwaz("sklep", strona);
      if ($("#respond, form.comment-form, #commentform").length) zauwaz("komentarze", strona);
      if ($('a[href*="wp-login.php"], a[href*="/my-account"], a[href*="/moje-konto"], form#loginform').length) zauwaz("logowanie", strona);
      if (/googletagmanager\.com|gtag\(|google-analytics\.com|connect\.facebook\.net|fbq\(|hotjar|clarity\.ms/.test(skrypty)) zauwaz("sledzenie", strona);
      if (/cookie-law-info|cookieyes|complianz|cookiebot|cookie-notice|borlabs|moove_gdpr|iubenda/i.test(skrypty + $.html("[id*=cookie],[class*=cookie]").slice(0, 2000))) zauwaz("cookies", strona);
      if (/admin-ajax\.php|wp-json\//.test(skrypty.replace(/breakdanceForm[\s\S]{0,400}/g, ""))) zauwaz("dynamiczne", strona);
      if ($('a[href*="lang="], .wpml-ls, .pll-switcher, .trp-language-switcher').length) zauwaz("jezyki", strona);
    }

    // Skrót WordPressa (?p=ID) tej strony staje się przekierowaniem 301 na nowy adres.
    const skrot = $('link[rel="shortlink"]').attr("href");
    if (skrot && plik.lokalna !== "404.html") { try { dodajPrzekierowanie(new URL(skrot, baza).href, plik.lokalna); } catch {} }

    // Śmieci WordPressa: emoji, oEmbed, REST API, feed, generator, pasek admina.
    $('script[src*="wp-emoji"], script[src*="wp-embed"], #wp-emoji-styles-inline-css, #wpadminbar, base').remove();
    $("script:not([src])").filter((_, el) => /_wpemojiSettings|wp-emoji/.test($(el).text())).remove();
    $('link[rel="https://api.w.org/"], link[rel="EditURI"], link[rel="wlwmanifest"], link[rel="shortlink"], link[rel="pingback"]').remove();
    $('link[type="application/json+oembed"], link[type="text/xml+oembed"], link[rel="alternate"][type*="rss"], meta[name="generator"]').remove();

    // Leniwe ładowanie: prawdziwy adres z data-src trafia do src (inaczej statyczna strona pokaże puste obrazki).
    $("img[data-src], img[data-lazy-src], img[data-original]").each((_, el) => {
      const prawdziwy = $(el).attr("data-src") || $(el).attr("data-lazy-src") || $(el).attr("data-original");
      const src = $(el).attr("src") || "";
      if (!src || src.startsWith("data:") || /lazy|placeholder|blank\.gif/i.test(src)) $(el).attr("src", prawdziwy);
    });
    $("img[data-srcset], img[data-lazy-srcset], source[data-srcset]").each((_, el) => {
      if (!$(el).attr("srcset")) $(el).attr("srcset", $(el).attr("data-srcset") || $(el).attr("data-lazy-srcset"));
    });

    // Formularze: Contact Form 7, Breakdance, Elementor i inne wysyłane do WordPressa → formularze edytora.
    let formularzeNaStronie = 0;
    $("form").each((_, el) => {
      const form = $(el);
      const akcja = form.attr("action") || "";
      const opcjeTekst = form.attr("data-options") || "";
      const doWordpressa = form.hasClass("wpcf7-form") || form.hasClass("breakdance-form") || form.hasClass("elementor-form")
        || /admin-ajax|wp-json|admin-post|wpforms|elementor/.test(akcja) || /admin-ajax/.test(opcjeTekst)
        || form.find('[name^="_wpcf7"], input[name="action"][value*="form"]').length;
      if (!doWordpressa) return;
      // Breakdance trzyma ustawienia w data-options: strona podziękowania i komunikat sukcesu przechodzą do pól _powrot/_podziekowanie.
      let opcje = {};
      try { opcje = JSON.parse(opcjeTekst || "{}"); } catch {}
      const ukryte = [];
      if (opcje.redirect && opcje.redirectUrl) {
        const cel = lokalnyAdres(opcje.redirectUrl, baza, true);
        if (cel) ukryte.push(["_powrot", cel.lokalna.replace(/(^|\/)index\.html$/, "$1")]);
      }
      if (opcje.successMessage) ukryte.push(["_podziekowanie", String(opcje.successMessage).slice(0, 300)]);
      // Formularze edytora przyjmują zwykły POST (bez załączników): pola plików znikają, kodowanie urlencoded.
      const polaPlikow = form.find('input[type="file"]');
      if (polaPlikow.length) {
        polaPlikow.closest("p, label, .wpcf7-form-control-wrap, .breakdance-form-field, .elementor-field-group").remove();
        polaPlikow.remove();
        formularzeBezZalacznikow++;
        zauwaz("zalaczniki", "/" + plik.lokalna.replace(/(^|\/)index\.html$/, "$1"));
      }
      form.attr("action", "__formularz").attr("method", "post").attr("enctype", "application/x-www-form-urlencoded").removeAttr("novalidate").removeAttr("data-options");
      form.find('[name^="_wpcf7"], [name="action"], [name="_wpnonce"], [name="_wp_http_referer"], [name="post_id"], [name="form_id"], [name="referer_title"], [name="queried_id"]').remove();
      for (const [nazwa, wartosc] of ukryte) form.prepend($("<input>").attr({ type: "hidden", name: nazwa, value: wartosc }));
      if (!form.find('[name="_gotcha"]').length) form.prepend('<input type="text" name="_gotcha" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true">');
      formularze++;
      formularzeNaStronie++;
    });
    if (formularzeNaStronie) {
      // Breakdance podpina obsługę każdego formularza osobnym skryptem inline — bez niego działa zwykła wysyłka.
      $("script:not([src])").filter((_, el) => /breakdanceForm\.init\(/.test($(el).text())).remove();
      // Bezpiecznik dla page builderów, których skryptów nie da się usunąć (np. Elementor): w fazie przechwytywania
      // na window zatrzymujemy ich obsługę wysyłki formularzy edytora, więc przeglądarka wysyła formularz zwyczajnie.
      $("body").append('<script>window.addEventListener("submit",function(e){var f=e.target;if(f&&f.getAttribute&&/(^|\\/)__formularz$/.test(f.getAttribute("action")||""))e.stopImmediatePropagation();},true);</script>');
    }
    // Skrypty wtyczek formularzy przechwytują wysyłkę i wysyłają ją do WordPressa — bez nich zadziała zwykły POST.
    $('script[src*="contact-form-7"], script[src*="wpforms"]').remove();

    $("a[href], area[href]").each((_, el) => $(el).attr("href", przepisz($(el).attr("href"), true)));
    $("link[href]").each((_, el) => $(el).attr("href", przepisz($(el).attr("href"), false)));
    $("script[src]").each((_, el) => $(el).attr("src", przepisz($(el).attr("src"), false)));
    for (const atr of ATRYBUTY_ZASOBOW) $(`[${atr}]`).each((_, el) => $(el).attr(atr, przepisz($(el).attr(atr), false)));
    for (const atr of ATRYBUTY_SRCSET) {
      $(`[${atr}]`).each((_, el) => {
        $(el).attr(atr, rozbierzSrcset($(el).attr(atr)).map((s) => [przepisz(s.url, false), s.opis].filter(Boolean).join(" ")).join(", "));
      });
    }
    $(META_OBRAZKOW).each((_, el) => $(el).attr("content", przepisz($(el).attr("content"), false)));
    $("style").each((_, el) => { $(el).text(przepiszCss($(el).text(), plik.lokalna, baza)); });
    $("[style]").each((_, el) => $(el).attr("style", przepiszCss($(el).attr("style"), plik.lokalna, baza)));
    await fs.writeFile(pelna, $.html());
  }
  if (!(await fs.access(path.join(cel, "index.html")).then(() => true, () => false))) {
    // Strona startowa mogła się przekierować w głąb (np. /pl/) — dorabiamy index.html z przekierowaniem.
    const pierwsza = pliki.find((p) => p.typ === "strona").lokalna;
    await fs.writeFile(path.join(cel, "index.html"), `<!DOCTYPE html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${zakodowana(pierwsza)}"><a href="${zakodowana(pierwsza)}">Przejdź do strony</a>\n`);
  }
  const raport = [...uwagi.entries()].map(([rodzaj, strony]) => ({ rodzaj, ...OPISY_UWAG[rodzaj], liczba: uwagi.liczniki[rodzaj], strony }));
  return { ...statystyka, formularze, formularzeBezZalacznikow, przekierowania, uwagi: raport, adres: start.href };
}

// Mapa strony XML (także indeks map WordPressa). Najwyżej 20 plików map i 500 adresów.
async function wczytajMape(adres, dodaj, sygnal, licznik) {
  if (++licznik.mapy > 20) return;
  const odp = await pobierz(adres, { limitBajtow: 5 * 1024 * 1024, sygnal });
  if (!licznik.bajty(odp.dane.length) || odp.status !== 200) return;
  const $ = cheerio.load(odp.dane.toString("utf8"), { xml: true });
  for (const el of $("sitemap > loc").toArray()) await wczytajMape($(el).text().trim(), dodaj, sygnal, licznik).catch(() => {});
  for (const el of $("url > loc").toArray()) {
    if (++licznik.adresy > 500) break;
    dodaj($(el).text().trim());
  }
}
