// Własne domeny projektów bez ręcznej edycji docker-compose: edytor zapisuje plik konfiguracji dla Traefika
// (file provider z obserwacją katalogu), a Traefik w locie dodaje routery i sam pobiera certyfikaty Let's Encrypt.
// Router powstaje dopiero, gdy DNS domeny wskazuje na ten serwer — inaczej walidacja HTTP-01 by się nie udała,
// a nieudane próby zużywają limit Let's Encrypt (5 nieudanych walidacji na godzinę na domenę).
import dns from "node:dns/promises";
import fs from "node:fs/promises";
import path from "node:path";

export const PLIK_TRAEFIKA = "edytor-domeny.yml";

// Adresy IP, na które wskazuje domena (A i AAAA). Brak rekordów to pusta lista, nie błąd.
async function adresyDomeny(domena) {
  const [v4, v6] = await Promise.all([dns.resolve4(domena).catch(() => []), dns.resolve6(domena).catch(() => [])]);
  return [...v4, ...v6];
}

// { stan: "aktywna" | "brak-dns" | "inny-serwer", adresy } — „aktywna”, gdy którykolwiek rekord wskazuje na serwer
// i żaden nie wskazuje gdzie indziej (część ruchu trafiałaby wtedy na stary hosting, a certyfikat losowo by się nie wystawił).
export async function sprawdzDomene(domena, ipSerwera, rozwiaz = adresyDomeny) {
  const adresy = await rozwiaz(domena);
  if (!adresy.length) return { stan: "brak-dns", adresy };
  if (!ipSerwera.length) return { stan: "aktywna", adresy }; // bez listy IP serwera nie sprawdzamy, dokąd wskazuje
  const nasze = adresy.filter((a) => ipSerwera.includes(a));
  return { stan: nasze.length && nasze.length === adresy.length ? "aktywna" : "inny-serwer", adresy };
}

// YAML dla Traefika. Domeny są już zwalidowane (tylko [a-z0-9.-]), więc wstawiamy je wprost w regułę Host().
export function konfiguracjaTraefika(domeny, { usluga, middleware, resolver = "letsencrypt" }) {
  if (!domeny.length) return "# Wygenerowane przez Edytor AI — brak aktywnych domen projektów.\nhttp:\n  routers: {}\n";
  const routery = domeny.map((d) => {
    if (!/^[a-z0-9.-]+$/.test(d)) throw new Error(`Niepoprawna domena: ${d}`);
    return [
      `    edytor-${d.replace(/\./g, "-")}:`,
      `      rule: "Host(\`${d}\`)"`,
      "      entryPoints: [websecure]",
      `      service: ${usluga}`,
      ...(middleware ? [`      middlewares: [${middleware}]`] : []),
      `      tls:\n        certResolver: ${resolver}`,
    ].join("\n");
  });
  return `# Wygenerowane przez Edytor AI — nie edytuj ręcznie (plik jest nadpisywany).\nhttp:\n  routers:\n${routery.join("\n")}\n`;
}

// Zapis atomowy (plik tymczasowy + rename), żeby Traefik nigdy nie przeczytał połowy pliku. Bez zmian — bez zapisu.
export async function zapiszKonfiguracje(katalog, tresc) {
  const cel = path.join(katalog, PLIK_TRAEFIKA);
  if ((await fs.readFile(cel, "utf8").catch(() => null)) === tresc) return false;
  const tymczasowy = path.join(katalog, `.${PLIK_TRAEFIKA}.tmp`);
  await fs.writeFile(tymczasowy, tresc);
  await fs.rename(tymczasowy, cel);
  return true;
}
