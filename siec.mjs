// Bezpieczne pobieranie z internetu (import stron, webhooki formularzy) — ochrona przed SSRF:
// serwer nie może zostać użyty do odpytania samego siebie ani usług w sieci prywatnej (n8n, bazy, Docker).
// Kontrola działa na dwóch poziomach: adres IP po rozwiązaniu DNS przy KAŻDYM połączeniu (także po przekierowaniu,
// co chroni przed DNS rebinding) oraz adres podany wprost jako IP (Node wtedy nie pyta DNS, więc sprawdzamy sami).
import dns from "node:dns";
import net from "node:net";
import { Agent, fetch } from "undici";

// Testy pozwalają na adresy lokalne, bo atrapy serwerów działają na 127.0.0.1.
const ZEZWOL_LOKALNE = process.env.EDYTOR_SIEC_LOKALNA === "1";

// Zakresy, do których serwer nie może się łączyć. net.BlockList porównuje adresy binarnie, więc każdy zapis
// (np. [::ffff:7f00:1] = 127.0.0.1 w IPv6) trafia we właściwy zakres — ręczne porównywanie tekstu tego nie gwarantuje.
// Dwie osobne listy: BlockList dopasowuje IPv4 także do reguł IPv6 dla adresów mapowanych (::ffff:0:0/96),
// więc wspólna lista uznałaby każde IPv4 za zakazane.
const ZABRONIONE_V4 = new net.BlockList();
const ZABRONIONE_V6 = new net.BlockList();
for (const [adres, prefiks] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
]) ZABRONIONE_V4.addSubnet(adres, prefiks, "ipv4");
for (const [adres, prefiks] of [
  ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001:db8::", 32],
  ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
]) ZABRONIONE_V6.addSubnet(adres, prefiks, "ipv6");

export function adresPrywatny(ip) {
  const czysty = String(ip).replace(/^\[|\]$/g, "");
  const typ = net.isIP(czysty);
  if (!typ) return true; // nie-adres traktujemy jako zakazany
  return typ === 4 ? ZABRONIONE_V4.check(czysty, "ipv4") : ZABRONIONE_V6.check(czysty, "ipv6");
}

function bezpiecznyLookup(nazwa, opcje, oddzwon) {
  dns.lookup(nazwa, { ...opcje, all: true }, (blad, adresy) => {
    if (blad) return oddzwon(blad);
    const zly = adresy.find((a) => adresPrywatny(a.address));
    if (zly && !ZEZWOL_LOKALNE) return oddzwon(Object.assign(new Error(`Adres ${nazwa} wskazuje na sieć prywatną (${zly.address}).`), { code: "EPRYWATNY" }));
    if (opcje?.all) return oddzwon(null, adresy);
    oddzwon(null, adresy[0].address, adresy[0].family);
  });
}

const agent = new Agent({ connect: { lookup: bezpiecznyLookup, timeout: 10000 }, headersTimeout: 20000, bodyTimeout: 30000 });

export function sprawdzAdres(adres) {
  let url;
  try { url = new URL(adres); } catch { throw Object.assign(new Error("Niepoprawny adres URL."), { kod: 400 }); }
  if (!["http:", "https:"].includes(url.protocol)) throw Object.assign(new Error("Obsługiwane są tylko adresy http i https."), { kod: 400 });
  const host = url.hostname.replace(/^\[|\]$/g, "");
  // Sprawdzamy adres PO normalizacji przez URL (tak, jak naprawdę zostanie użyty do połączenia).
  if (net.isIP(host) && adresPrywatny(host) && !ZEZWOL_LOKALNE) throw Object.assign(new Error("Adres wskazuje na sieć prywatną."), { kod: 400 });
  if (/^localhost$|\.localhost$|\.internal$|\.local$/i.test(host) && !ZEZWOL_LOKALNE) throw Object.assign(new Error("Adres wskazuje na sieć prywatną."), { kod: 400 });
  return url;
}

// fetch z ręcznym prowadzeniem przekierowań (każdy adres sprawdzany) i limitem rozmiaru odpowiedzi.
// Zwraca { url (końcowy), status, naglowki, dane: Buffer } albo rzuca błąd.
export async function pobierz(adres, { metoda = "GET", cialo, naglowki = {}, limitBajtow = 25 * 1024 * 1024, przekierowania = 5, sygnal } = {}) {
  let url = sprawdzAdres(adres);
  for (let i = 0; i <= przekierowania; i++) {
    let odp;
    try {
      odp = await fetch(url, {
        method: metoda, body: cialo, redirect: "manual", dispatcher: agent, signal: sygnal,
        headers: { "User-Agent": `EdytorAI-Import/1.0${process.env.EDYTOR_ADRES_PANELU ? ` (+${process.env.EDYTOR_ADRES_PANELU})` : ""}`, ...naglowki },
      });
    } catch (e) {
      // undici opakowuje przyczynę w „fetch failed” — wyciągamy ją, żeby komunikat był zrozumiały.
      const przyczyna = e.cause;
      if (przyczyna?.code === "EPRYWATNY") throw Object.assign(new Error(przyczyna.message), { kod: 400 });
      if (przyczyna?.code === "ENOTFOUND") throw Object.assign(new Error(`Nie ma takiej domeny: ${url.hostname}.`), { kod: 400 });
      throw Object.assign(new Error(`Nie udało się połączyć z ${url.hostname}: ${przyczyna?.message || e.message}`), { kod: 502 });
    }
    if ([301, 302, 303, 307, 308].includes(odp.status) && odp.headers.get("location")) {
      await odp.body?.cancel();
      url = sprawdzAdres(new URL(odp.headers.get("location"), url).href);
      if (odp.status === 303) { metoda = "GET"; cialo = undefined; }
      continue;
    }
    const czesci = [];
    let rozmiar = 0;
    for await (const kawalek of odp.body ?? []) {
      rozmiar += kawalek.length;
      if (rozmiar > limitBajtow) {
        await odp.body.cancel().catch(() => {});
        const limit = limitBajtow >= 1048576 ? `${Math.round(limitBajtow / 1048576)} MB` : `${Math.max(1, Math.round(limitBajtow / 1024))} KB`;
        throw Object.assign(new Error(`Plik większy niż ${limit}.`), { code: "EZADUZY" });
      }
      czesci.push(kawalek);
    }
    return { url: url.href, status: odp.status, naglowki: odp.headers, dane: Buffer.concat(czesci) };
  }
  throw new Error("Za dużo przekierowań.");
}
