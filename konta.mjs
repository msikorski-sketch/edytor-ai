// Konta i role panelu. Konto główne (administrator) pochodzi z .env (EDYTOR_LOGIN, EDYTOR_HASLO) i zawsze działa —
// to wejście awaryjne, którego nie da się usunąć z panelu. Pozostałe konta zakłada administrator; leżą w stan.json
// (`uzytkownicy`), z hasłem jako skrótem scrypt (sól + koszt), nigdy jawnie.
//
// Role:
//   administrator — wszystko: wszystkie projekty, nowe projekty i import, konta, zużycie modelu, domeny, własny kod;
//   redaktor      — przypisane projekty: polecenia, zadania globalne, publikacja, pliki, formularze, integracje;
//   klient        — przypisane projekty: polecenia i cofanie zmian w wersji roboczej, podgląd, wiadomości z formularzy.
//                   Nie publikuje — publikację zatwierdza redaktor albo administrator.
import crypto from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);
const DLUGOSC_SKROTU = 32;
const KOSZT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

// Bez kropek: login jest częścią żetonu sesji, którego pola rozdziela kropka.
export const WZOR_LOGINU = /^[a-z0-9](?:[a-z0-9_-]{1,30}[a-z0-9])$/;
export const ROLE = ["administrator", "redaktor", "klient"];
export const MIN_DLUGOSC_HASLA = 10;

// Akcje API projektu (/api/p/<projekt>/<akcja>) dozwolone dla ról innych niż administrator.
// „pliki-odczyt” to GET listy plików; „pliki” (wgrywanie) jest osobno.
const AKCJE = {
  redaktor: new Set([
    "polecenie", "plan", "zadanie", "cofnij-zadanie", "zatrzymaj", "historia", "strony", "pliki-odczyt", "pliki", "usun-plik",
    "eksport", "cofnij", "opublikuj", "nowa-rozmowa", "raport-importu", "formularze", "usun-zgloszenie", "ustawienia", "integracje",
  ]),
  klient: new Set(["polecenie", "zatrzymaj", "historia", "strony", "pliki-odczyt", "cofnij", "nowa-rozmowa", "formularze"]),
};

export async function haszuj(haslo) {
  const sol = crypto.randomBytes(16);
  const skrot = await scrypt(String(haslo), sol, DLUGOSC_SKROTU, KOSZT);
  return `scrypt$${sol.toString("base64url")}$${skrot.toString("base64url")}`;
}

// Porównanie w stałym czasie. Dla nieistniejącego konta też liczymy scrypt (na fikcyjnym zapisie),
// żeby czas odpowiedzi nie zdradzał, które loginy istnieją.
const FIKCYJNY = "scrypt$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
export async function hasloZgodne(haslo, zapis) {
  const [rodzaj, sol, skrot] = String(zapis || FIKCYJNY).split("$");
  if (rodzaj !== "scrypt" || !sol || !skrot) return false;
  const oczekiwany = Buffer.from(skrot, "base64url");
  const policzony = await scrypt(String(haslo), Buffer.from(sol, "base64url"), oczekiwany.length || DLUGOSC_SKROTU, KOSZT);
  return Boolean(zapis) && oczekiwany.length === policzony.length && crypto.timingSafeEqual(oczekiwany, policzony);
}

// Hasło startowe nowego konta: 16 znaków bez łatwych do pomylenia (0/O, 1/l/I).
export function noweHaslo() {
  const znaki = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.randomBytes(16), (b) => znaki[b % znaki.length]).join("");
}

export const administrator = (u) => u?.rola === "administrator";

export function widziProjekt(u, id) {
  if (!u) return false;
  return administrator(u) || (Array.isArray(u.projekty) && u.projekty.includes(id));
}

export function mozeAkcje(u, akcja) {
  if (administrator(u)) return true;
  return Boolean(AKCJE[u?.rola]?.has(akcja));
}

// Konto bez skrótu hasła i wewnętrznych pól — tak trafia do przeglądarki.
export function opisKonta(login, u, { glowne = false } = {}) {
  return { login, nazwa: u.nazwa || login, rola: u.rola, projekty: administrator(u) ? "*" : u.projekty || [], glowne, utworzono: u.utworzono || null };
}

// Walidacja danych konta z formularza administratora. Zwraca poprawione pola albo rzuca błąd z komunikatem.
export function sprawdzKonto({ login, nazwa, rola, projekty }, istniejaceProjekty) {
  const czystyLogin = String(login || "").trim().toLowerCase();
  if (!WZOR_LOGINU.test(czystyLogin)) throw new Error("Login: 3–32 znaki, małe litery, cyfry, myślnik lub podkreślnik.");
  if (!ROLE.includes(rola)) throw new Error("Nieznana rola.");
  const lista = rola === "administrator" ? [] : [...new Set(Array.isArray(projekty) ? projekty.map(String) : [])];
  const nieznane = lista.filter((p) => !istniejaceProjekty.has(p));
  if (nieznane.length) throw new Error(`Nie ma projektów: ${nieznane.join(", ")}.`);
  return { login: czystyLogin, nazwa: String(nazwa || "").trim().slice(0, 80) || czystyLogin, rola, projekty: lista };
}
