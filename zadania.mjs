// Zadania globalne (zmiany na wielu podstronach naraz, np. „dodaj 6 podstron usług według wzoru”).
// Przebieg: 1) agent tylko-do-odczytu przygotowuje plan (lista kroków w JSON), 2) użytkownik go zatwierdza,
// 3) każdy krok wykonuje osobne, krótkie uruchomienie agenta (świeży kontekst, commit po kroku),
// 4) na końcu deterministyczne sprawdzenie strony: każda podstrona się parsuje, linki i obrazki prowadzą do plików.
import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";

export const MAKS_KROKOW = 30;

export const INSTRUKCJE_PLANU = `
Teraz tylko PLANUJESZ zadanie obejmujące całą stronę — niczego nie zmieniaj (masz wyłącznie narzędzia do czytania).
Przejrzyj pliki strony, a potem odpowiedz WYŁĄCZNIE blokiem:
\`\`\`json
[{"tytul": "krótki tytuł kroku", "opis": "co dokładnie zrobić w tym kroku: które pliki utworzyć/zmienić, na jakim wzorze"}]
\`\`\`
Zasady planu:
- Jeden krok = jedna podstrona albo jeden spójny element wspólny (np. „menu na wszystkich podstronach”). Najwyżej ${MAKS_KROKOW} kroków.
- Kroki mają być możliwie niezależne i wykonalne po kolei bez pamięci poprzednich rozmów (każdy dostanie cały plan jako kontekst).
- Jeśli nowe podstrony mają mieć wspólny wzór, pierwszy krok tworzy wzorcową podstronę, kolejne kopiują jej strukturę.
- Uwzględnij linki w menu i odnośniki między stronami, jeśli zadanie tego wymaga.`.trim();

export function polecenieKroku(zadanie, kroki, nr) {
  const lista = kroki.map((k, i) => `${i + 1}. ${k.tytul}${i === nr ? "   ← TEN KROK" : ""}`).join("\n");
  return [
    `Zadanie dla całej strony: ${zadanie}`,
    `Plan zatwierdzony przez użytkownika:\n${lista}`,
    `Wykonaj TERAZ tylko krok ${nr + 1}/${kroki.length}: ${kroki[nr].tytul}`,
    `Szczegóły kroku: ${kroki[nr].opis}`,
    "Poprzednie kroki są już zrobione (sprawdź pliki, jeśli potrzebujesz ich wyniku). Nie wykonuj kolejnych kroków. Na koniec napisz jedno zdanie, co zrobiłeś.",
  ].join("\n\n");
}

// Plan z odpowiedzi agenta: blok ```json``` albo pierwsza tablica JSON w tekście. Zwraca listę kroków albo rzuca błąd.
export function wyciagnijPlan(tekst) {
  const kandydaci = [];
  for (const m of String(tekst).matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) kandydaci.push(m[1]);
  const tablica = String(tekst).match(/\[[\s\S]*\]/);
  if (tablica) kandydaci.push(tablica[0]);
  for (const kandydat of kandydaci) {
    let dane;
    try { dane = JSON.parse(kandydat); } catch { continue; }
    if (!Array.isArray(dane) || !dane.length) continue;
    const kroki = dane
      .filter((k) => k && typeof k === "object" && typeof (k.tytul ?? k.title) === "string")
      .map((k) => ({ tytul: String(k.tytul ?? k.title).trim().slice(0, 150), opis: String(k.opis ?? k.description ?? "").trim().slice(0, 2000) }))
      .filter((k) => k.tytul);
    if (!kroki.length) continue;
    if (kroki.length > MAKS_KROKOW) throw new Error(`Plan ma ${kroki.length} kroków — najwyżej ${MAKS_KROKOW}. Podziel zadanie na mniejsze.`);
    return kroki;
  }
  throw new Error("Asystent nie przygotował planu w oczekiwanym formacie. Spróbuj opisać zadanie dokładniej.");
}

// Sprawdzenie strony po zadaniu: każdy plik HTML się parsuje, a odnośniki i zasoby lokalne prowadzą do istniejących plików.
export async function sprawdzStrone(katalog) {
  const pliki = (await fs.readdir(katalog, { recursive: true })).map((p) => String(p).split(path.sep).join("/")).filter((p) => !p.startsWith(".git"));
  const istniejace = new Set(pliki);
  const strony = pliki.filter((p) => /\.html?$/i.test(p));
  const bledy = [];
  for (const strona of strony) {
    let $;
    try {
      $ = cheerio.load(await fs.readFile(path.join(katalog, strona), "utf8"));
    } catch (e) {
      bledy.push({ strona, problem: `nie da się odczytać: ${e.message}` });
      continue;
    }
    const odnosniki = [
      ...$("a[href]").map((_, el) => $(el).attr("href")).get(),
      ...$("img[src], script[src], source[src], video[src], audio[src]").map((_, el) => $(el).attr("src")).get(),
      ...$('link[rel="stylesheet"][href], link[rel="icon"][href]').map((_, el) => $(el).attr("href")).get(),
    ];
    for (const link of odnosniki) {
      if (!link || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(link) || link.includes("__formularz")) continue;
      let cel;
      try { cel = decodeURIComponent(link.split(/[?#]/)[0]); } catch { cel = link.split(/[?#]/)[0]; }
      if (!cel) continue;
      const pelna = path.posix.normalize(cel.startsWith("/") ? cel.slice(1) : path.posix.join(path.posix.dirname(strona), cel));
      const kandydaci = [pelna, `${pelna.replace(/\/$/, "")}/index.html`, `${pelna}index.html`];
      if (!kandydaci.some((k) => istniejace.has(k)) && !pelna.startsWith("..")) {
        if (bledy.length < 50) bledy.push({ strona, problem: `nie istnieje: ${link}` });
      }
    }
  }
  return { strony: strony.length, bledy };
}
