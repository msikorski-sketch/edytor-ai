// Biblioteka integracji: gotowe zamienniki popularnych wtyczek WordPressa (analityka, baner zgód, czat, przycisk
// kontaktu, dane firmy dla Google, weryfikacja Search Console). Włącza się je w panelu, bez edycji plików strony.
//
// Fragmenty są wstawiane do każdej strony HTML dopiero przy publikacji (do katalogu wydania, nie do repozytorium),
// więc agent ich nie widzi, nie zmieni przypadkiem, a wyłączenie integracji usuwa je w całości.
// Skrypty śledzące (Google Analytics, Tag Manager, Clarity, Meta Pixel) mają type="text/plain" i data-zgoda:
// przeglądarka ich nie wykonuje, dopóki odwiedzający nie zgodzi się na daną kategorię w banerze (RODO i prawo
// telekomunikacyjne wymagają zgody PRZED zapisaniem cookies analitycznych i marketingowych). Baner dokłada się sam,
// gdy włączona jest choć jedna taka integracja.
import fs from "node:fs/promises";
import path from "node:path";

const ID_GA4 = /^G-[A-Z0-9]{4,12}$/;
const ADRES = /^(https:\/\/[^\s"'<>]{3,300}|\/?[A-Za-z0-9._~\/-]{1,200})$/; // adres https albo ścieżka na stronie

export const KATALOG = [
  {
    id: "zgody", nazwa: "Baner zgód na cookies", kategoria: "Zgody i RODO", wPodgladzie: true,
    opis: "Pyta odwiedzających o zgodę na statystyki i marketing. Przyciski „Akceptuję” i „Odrzucam” są równorzędne, a wybór można zmienić w każdej chwili (link „Cookies” w rogu). Włącza się sam, gdy włączysz integrację wymagającą zgody.",
    pola: [
      { klucz: "polityka", etykieta: "Adres polityki prywatności", wzor: ADRES, przyklad: "polityka-prywatnosci.html" },
      { klucz: "tekst", etykieta: "Tekst banera (opcjonalnie)", typ: "obszar", maks: 600, przyklad: "Używamy plików cookies, żeby…" },
    ],
  },
  {
    id: "ga4", nazwa: "Google Analytics 4", kategoria: "Analityka", zgoda: "analityka",
    opis: "Statystyki odwiedzin. Uruchamia się dopiero po zgodzie na statystyki.",
    pola: [{ klucz: "id", etykieta: "Identyfikator pomiaru", wzor: ID_GA4, wymagane: true, przyklad: "G-AB12CD34EF" }],
  },
  {
    id: "gtm", nazwa: "Google Tag Manager", kategoria: "Analityka", zgoda: "analityka",
    opis: "Kontener tagów Google. Uruchamia się po zgodzie na statystyki — tagi marketingowe w kontenerze ustaw dodatkowo na zgodę w GTM.",
    pola: [{ klucz: "id", etykieta: "Identyfikator kontenera", wzor: /^GTM-[A-Z0-9]{4,10}$/, wymagane: true, przyklad: "GTM-AB12CD3" }],
  },
  {
    id: "plausible", nazwa: "Plausible Analytics", kategoria: "Analityka",
    opis: "Statystyki bez cookies i bez danych osobowych — nie wymagają zgody w banerze.",
    pola: [
      { klucz: "domena", etykieta: "Domena w Plausible", wzor: /^([a-z0-9-]+\.)+[a-z]{2,}$/, wymagane: true, przyklad: "salon-ewa.pl" },
      // Dowolny adres skryptu = dowolny kod na stronie, więc ustawia go tylko administrator (jak „Własny kod”).
      { klucz: "skrypt", etykieta: "Adres skryptu (własna instancja, opcjonalnie; tylko administrator)", wzor: /^https:\/\/[^\s"'<>]{3,300}$/, przyklad: "https://plausible.io/js/script.js", tylkoAdmin: true },
    ],
  },
  {
    id: "clarity", nazwa: "Microsoft Clarity", kategoria: "Analityka", zgoda: "analityka",
    opis: "Mapy cieplne i nagrania sesji. Uruchamia się po zgodzie na statystyki.",
    pola: [{ klucz: "id", etykieta: "Identyfikator projektu", wzor: /^[a-z0-9]{6,14}$/, wymagane: true, przyklad: "abcd1234ef" }],
  },
  {
    id: "meta-pixel", nazwa: "Meta Pixel (Facebook)", kategoria: "Marketing", zgoda: "marketing",
    opis: "Mierzenie skuteczności reklam na Facebooku i Instagramie. Uruchamia się po zgodzie na marketing.",
    pola: [{ klucz: "id", etykieta: "Identyfikator piksela", wzor: /^\d{10,20}$/, wymagane: true, przyklad: "123456789012345" }],
  },
  {
    id: "smartsupp", nazwa: "Czat Smartsupp", kategoria: "Kontakt",
    opis: "Okno czatu na żywo. Smartsupp zapisuje cookies potrzebne do działania czatu — opisz go w polityce prywatności.",
    pola: [{ klucz: "klucz", etykieta: "Klucz (z kodu instalacyjnego)", wzor: /^[a-f0-9]{40}$/, wymagane: true, przyklad: "0123456789abcdef0123456789abcdef01234567" }],
  },
  {
    id: "tawk", nazwa: "Czat Tawk.to", kategoria: "Kontakt",
    opis: "Darmowy czat na żywo. Identyfikatory są w adresie z kodu instalacyjnego: embed.tawk.to/<strona>/<widżet>.",
    pola: [
      { klucz: "strona", etykieta: "Identyfikator strony", wzor: /^[a-f0-9]{24}$/, wymagane: true, przyklad: "0123456789abcdef01234567" },
      { klucz: "widzet", etykieta: "Identyfikator widżetu", wzor: /^[a-z0-9]{4,12}$/, przyklad: "default" },
    ],
  },
  {
    id: "przycisk-kontaktu", nazwa: "Pływający przycisk: telefon lub WhatsApp", kategoria: "Kontakt", wPodgladzie: true,
    opis: "Okrągły przycisk w prawym dolnym rogu każdej strony. Bez zewnętrznych skryptów i cookies.",
    pola: [
      { klucz: "rodzaj", etykieta: "Rodzaj", typ: "wybor", opcje: { telefon: "Zadzwoń", whatsapp: "WhatsApp" }, wymagane: true },
      { klucz: "numer", etykieta: "Numer telefonu (z kierunkowym)", wzor: /^\+?[0-9 ]{9,18}$/, wymagane: true, przyklad: "+48 600 100 200" },
      { klucz: "kolor", etykieta: "Kolor (opcjonalnie)", wzor: /^#[0-9a-fA-F]{6}$/, przyklad: "#16a34a" },
    ],
  },
  {
    id: "dane-firmy", nazwa: "Dane firmy dla Google (schema.org)", kategoria: "SEO", tylkoGlowna: true,
    opis: "Opis firmy w formacie, który rozumieją wyszukiwarki (LocalBusiness): pomaga w wynikach lokalnych i w Mapach. Trafia na stronę główną.",
    pola: [
      { klucz: "nazwa", etykieta: "Nazwa firmy", maks: 120, wymagane: true, przyklad: "Salon fryzjerski Ewa" },
      { klucz: "telefon", etykieta: "Telefon", wzor: /^\+?[0-9 ]{9,18}$/, przyklad: "+48 600 100 200" },
      { klucz: "email", etykieta: "E-mail", wzor: /^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i, przyklad: "kontakt@salon-ewa.pl" },
      { klucz: "ulica", etykieta: "Ulica i numer", maks: 120, przyklad: "ul. Długa 5" },
      { klucz: "kod", etykieta: "Kod pocztowy", wzor: /^\d{2}-\d{3}$/, przyklad: "00-001" },
      { klucz: "miasto", etykieta: "Miasto", maks: 80, przyklad: "Warszawa" },
    ],
  },
  {
    id: "search-console", nazwa: "Weryfikacja Google Search Console", kategoria: "SEO", tylkoGlowna: true,
    opis: "Potwierdza w Search Console, że strona jest Twoja (metoda „Tag HTML” — wklej samą wartość content).",
    pola: [{ klucz: "kod", etykieta: "Kod weryfikacyjny", wzor: /^[A-Za-z0-9_-]{20,90}$/, wymagane: true, przyklad: "AbCdEf123…" }],
  },
  {
    id: "wlasny-kod", nazwa: "Własny kod", kategoria: "Zaawansowane", tylkoAdmin: true,
    opis: "Dowolny HTML/JS w <head> i na końcu <body> każdej strony (np. inny piksel). Bez kontroli zgód — skrypty śledzące oznacz sam: <script type=\"text/plain\" data-zgoda=\"analityka\">.",
    pola: [
      { klucz: "head", etykieta: "Kod w <head>", typ: "obszar", maks: 20000 },
      { klucz: "body", etykieta: "Kod przed </body>", typ: "obszar", maks: 20000 },
    ],
  },
];

const PO_ID = new Map(KATALOG.map((i) => [i.id, i]));
const KATEGORIE_ZGOD = { analityka: "Statystyki — pomagają nam zrozumieć, jak korzystasz ze strony", marketing: "Marketing — mierzenie skuteczności reklam" };

// Katalog dla przeglądarki (wzory jako tekst — tylko do podpowiedzi, sprawdza serwer).
export function katalogDlaPanelu({ administrator = false } = {}) {
  return KATALOG.filter((i) => administrator || !i.tylkoAdmin).map(({ pola, ...i }) => ({
    ...i, pola: pola.map(({ wzor, ...p }) => ({ ...p, ...(wzor ? { wzor: wzor.source } : {}) })),
  }));
}

// Sprawdza ustawienia jednej integracji z panelu. Zwraca { wlaczona, ...pola } albo rzuca błąd z komunikatem.
// `poprzednie` — zapisane ustawienia: pole tylko dla administratora inna rola może zostawić bez zmian.
export function sprawdzIntegracje(id, { wlaczona, wartosci = {} } = {}, { administrator = false, poprzednie = {} } = {}) {
  const def = PO_ID.get(id);
  if (!def) throw new Error("Nie ma takiej integracji.");
  if (def.tylkoAdmin && !administrator) throw new Error("Tę integrację może ustawić tylko administrator.");
  const wynik = { wlaczona: Boolean(wlaczona) };
  for (const p of def.pola) {
    const v = String(wartosci?.[p.klucz] ?? "").trim();
    if (!v) {
      if (p.wymagane && wynik.wlaczona) throw new Error(`${def.nazwa}: uzupełnij pole „${p.etykieta}”.`);
      continue;
    }
    if (p.tylkoAdmin && !administrator && v !== poprzednie?.[p.klucz]) throw new Error(`${def.nazwa}: pole „${p.etykieta}” może ustawić tylko administrator.`);
    if (p.opcje && !Object.hasOwn(p.opcje, v)) throw new Error(`${def.nazwa}: niepoprawna wartość pola „${p.etykieta}”.`);
    if (p.wzor && !p.wzor.test(v)) throw new Error(`${def.nazwa}: niepoprawne pole „${p.etykieta}” (np. ${p.przyklad}).`);
    if (v.length > (p.maks || 300)) throw new Error(`${def.nazwa}: pole „${p.etykieta}” jest za długie.`);
    wynik[p.klucz] = v;
  }
  return wynik;
}

// ---------- fragmenty HTML ----------

const html = (t) => String(t).replace(/[&<>"']/g, (z) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[z]);
// JSON w <script>: bez „</script>” i komentarzy HTML w środku.
const json = (v) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
const zablokowany = (zgoda, kod, src) => `<script type="text/plain" data-zgoda="${zgoda}"${src ? ` data-src="${html(src)}"` : ""}>${kod}</script>`;

const FRAGMENTY = {
  ga4: (k) => ({
    head: zablokowany("analityka", "", `https://www.googletagmanager.com/gtag/js?id=${k.id}`)
      + zablokowany("analityka", `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag("js",new Date());gtag("config",${json(k.id)});`),
  }),
  gtm: (k) => ({
    head: zablokowany("analityka", `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({"gtm.start":new Date().getTime(),event:"gtm.js"});var f=d.getElementsByTagName(s)[0],j=d.createElement(s);j.async=true;j.src="https://www.googletagmanager.com/gtm.js?id="+i;f.parentNode.insertBefore(j,f);})(window,document,"script","dataLayer",${json(k.id)});`),
  }),
  plausible: (k) => ({ head: `<script defer data-domain="${html(k.domena)}" src="${html(k.skrypt || "https://plausible.io/js/script.js")}"></script>` }),
  clarity: (k) => ({
    head: zablokowany("analityka", `(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window,document,"clarity","script",${json(k.id)});`),
  }),
  "meta-pixel": (k) => ({
    head: zablokowany("marketing", `!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version="2.0";n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,"script","https://connect.facebook.net/en_US/fbevents.js");fbq("init",${json(k.id)});fbq("track","PageView");`),
  }),
  smartsupp: (k) => ({
    body: `<script>var _smartsupp=_smartsupp||{};_smartsupp.key=${json(k.klucz)};window.smartsupp||(function(d){var s,c,o=smartsupp=function(){o._.push(arguments)};o._=[];s=d.getElementsByTagName("script")[0];c=d.createElement("script");c.type="text/javascript";c.charset="utf-8";c.async=true;c.src="https://www.smartsuppchat.com/loader.js?";s.parentNode.insertBefore(c,s);})(document);</script>`,
  }),
  tawk: (k) => ({
    body: `<script>var Tawk_API=Tawk_API||{},Tawk_LoadStart=new Date();(function(){var s1=document.createElement("script"),s0=document.getElementsByTagName("script")[0];s1.async=true;s1.src=${json(`https://embed.tawk.to/${k.strona}/${k.widzet || "default"}`)};s1.charset="UTF-8";s1.setAttribute("crossorigin","*");s0.parentNode.insertBefore(s1,s0);})();</script>`,
  }),
  "przycisk-kontaktu": (k) => {
    const cyfry = k.numer.replace(/[^0-9+]/g, "");
    const whatsapp = k.rodzaj === "whatsapp";
    const adres = whatsapp ? `https://wa.me/${cyfry.replace(/^\+/, "")}` : `tel:${cyfry}`;
    const ikona = whatsapp
      ? '<path d="M12 3a9 9 0 0 0-7.8 13.5L3 21l4.6-1.2A9 9 0 1 0 12 3z" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>'
      : '<path d="M6.6 10.8a15 15 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z" fill="#fff"/>';
    return {
      body: `<a data-edytor-integracja="przycisk-kontaktu" href="${html(adres)}"${whatsapp ? ' target="_blank" rel="noopener"' : ""} aria-label="${whatsapp ? "Napisz na WhatsApp" : "Zadzwoń"}: ${html(k.numer)}" style="position:fixed;right:20px;bottom:20px;z-index:2147483000;width:56px;height:56px;border-radius:50%;background:${k.kolor || (whatsapp ? "#16a34a" : "#2563eb")};display:flex;align-items:center;justify-content:center;box-shadow:0 4px 14px rgba(0,0,0,.25)"><svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true">${ikona}</svg></a>`,
    };
  },
  "dane-firmy": (k, { adres }) => {
    const dane = { "@context": "https://schema.org", "@type": "LocalBusiness", name: k.nazwa, ...(adres ? { url: adres } : {}) };
    if (k.telefon) dane.telephone = k.telefon;
    if (k.email) dane.email = k.email;
    if (k.ulica || k.miasto) dane.address = { "@type": "PostalAddress", ...(k.ulica ? { streetAddress: k.ulica } : {}), ...(k.kod ? { postalCode: k.kod } : {}), ...(k.miasto ? { addressLocality: k.miasto } : {}), addressCountry: "PL" };
    return { head: `<script type="application/ld+json">${json(dane)}</script>` };
  },
  "search-console": (k) => ({ head: `<meta name="google-site-verification" content="${html(k.kod)}">` }),
  "wlasny-kod": (k) => ({ head: k.head || "", body: k.body || "" }),
};

// Skrypt banera zgód — funkcja wykonywana w przeglądarce odwiedzającego (wstawiana jako tekst, bez zależności).
function banerZgod(k) {
  var KLUCZ = "edytor-zgody", ROK = 365 * 24 * 3600 * 1000;
  var zapis = null;
  try { zapis = JSON.parse(localStorage.getItem(KLUCZ)); } catch (e) { /* brak dostępu do localStorage */ }
  if (zapis && (Date.now() - zapis.kiedy > ROK || zapis.wersja !== k.wersja)) zapis = null; // nowe kategorie albo rok minął — pytamy znowu
  function uruchom(zgody) {
    document.querySelectorAll('script[type="text/plain"][data-zgoda]').forEach(function (s) {
      if (!zgody[s.getAttribute("data-zgoda")] || s.getAttribute("data-uruchomiony")) return;
      s.setAttribute("data-uruchomiony", "1");
      var n = document.createElement("script");
      if (s.getAttribute("data-src")) { n.src = s.getAttribute("data-src"); n.async = true; } else n.text = s.text;
      document.head.appendChild(n);
    });
  }
  var okno, przycisk;
  function el(tag, styl, tekst) { var e = document.createElement(tag); if (styl) e.style.cssText = styl; if (tekst) e.textContent = tekst; return e; }
  var PRZYCISK = "font:inherit;padding:10px 16px;border-radius:8px;border:1px solid #1f2937;cursor:pointer;";
  function zapisz(zgody) {
    var cofnieto = zapis && Object.keys(k.kategorie).some(function (c) { return zapis[c] && !zgody[c]; });
    zgody.kiedy = Date.now(); zgody.wersja = k.wersja; zapis = zgody;
    try { localStorage.setItem(KLUCZ, JSON.stringify(zgody)); } catch (e) { /* zgoda tylko na tę wizytę */ }
    if (cofnieto) return location.reload(); // uruchomionych skryptów nie da się „wyłączyć” — przeładowanie strony
    okno.remove(); okno = null; pokazPrzycisk(); uruchom(zgody);
  }
  function wszystkie(wartosc) { var z = {}; Object.keys(k.kategorie).forEach(function (c) { z[c] = wartosc; }); return z; }
  function pokazOkno() {
    if (okno) return;
    if (przycisk) { przycisk.remove(); przycisk = null; }
    okno = el("div", "position:fixed;left:16px;right:16px;bottom:16px;max-width:560px;margin:0 auto;z-index:2147483001;background:#fff;color:#1f2937;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.25);padding:20px;font:15px/1.5 system-ui,sans-serif");
    okno.setAttribute("data-edytor-integracja", "zgody");
    okno.setAttribute("role", "dialog");
    okno.setAttribute("aria-label", "Zgoda na pliki cookies");
    okno.appendChild(el("strong", "display:block;font-size:17px;margin-bottom:6px", "Pliki cookies"));
    var opis = el("p", "margin:0 0 12px", k.tekst);
    if (k.polityka) { var a = el("a", "color:inherit", "Polityka prywatności"); a.href = k.polityka; opis.appendChild(document.createTextNode(" ")); opis.appendChild(a); }
    okno.appendChild(opis);
    var wybory = el("div", "display:none;margin:0 0 12px");
    var pola = {};
    Object.keys(k.kategorie).forEach(function (c) {
      var l = el("label", "display:flex;gap:8px;align-items:flex-start;margin:6px 0");
      pola[c] = el("input"); pola[c].type = "checkbox"; pola[c].checked = Boolean(zapis && zapis[c]);
      l.appendChild(pola[c]); l.appendChild(el("span", "", k.kategorie[c])); wybory.appendChild(l);
    });
    okno.appendChild(wybory);
    var akcje = el("div", "display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end");
    var odrzuc = el("button", PRZYCISK + "background:#fff;color:#1f2937", "Odrzucam");
    var ustawienia = el("button", PRZYCISK + "background:#fff;color:#1f2937", "Wybieram");
    var akceptuj = el("button", PRZYCISK + "background:#1f2937;color:#fff", "Akceptuję wszystkie");
    odrzuc.onclick = function () { zapisz(wszystkie(false)); };
    akceptuj.onclick = function () { zapisz(wszystkie(true)); };
    ustawienia.onclick = function () {
      if (wybory.style.display === "none") { wybory.style.display = "block"; ustawienia.textContent = "Zapisz wybór"; return; }
      var z = {}; Object.keys(pola).forEach(function (c) { z[c] = pola[c].checked; }); zapisz(z);
    };
    [odrzuc, ustawienia, akceptuj].forEach(function (b) { b.type = "button"; akcje.appendChild(b); });
    okno.appendChild(akcje);
    document.body.appendChild(okno);
  }
  // Wycofanie zgody musi być równie łatwe jak jej wyrażenie — stały, mały przycisk w rogu.
  function pokazPrzycisk() {
    przycisk = el("button", "position:fixed;left:12px;bottom:12px;z-index:2147483000;font:12px system-ui,sans-serif;padding:6px 10px;border-radius:999px;border:1px solid #d1d5db;background:#fff;color:#374151;cursor:pointer;opacity:.85", "Cookies");
    przycisk.type = "button";
    przycisk.setAttribute("data-edytor-integracja", "zgody");
    przycisk.onclick = pokazOkno;
    document.body.appendChild(przycisk);
  }
  window.edytorZgody = { otworz: pokazOkno };
  function start() { if (zapis) { pokazPrzycisk(); uruchom(zapis); } else pokazOkno(); }
  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);
}

const TEKST_BANERA = "Używamy plików cookies, żeby strona działała, a za Twoją zgodą także do statystyk odwiedzin i mierzenia reklam. Możesz zaakceptować wszystkie, odrzucić albo wybrać kategorie. Zgodę zmienisz w każdej chwili przyciskiem „Cookies” w rogu strony.";

// Fragmenty do wstawienia na jedną stronę. `podglad` — tylko integracje widoczne w edytorze (bez analityki i czatów),
// `glowna` — strona główna (dane firmy, weryfikacja), `adres` — adres strony (do danych firmy).
export function fragmentyStrony(ustawienia = {}, { podglad = false, glowna = false, adres = null } = {}) {
  const head = [], body = [];
  const wlaczone = KATALOG.filter((d) => ustawienia[d.id]?.wlaczona && (!podglad || d.wPodgladzie) && (glowna || !d.tylkoGlowna));
  for (const d of wlaczone) {
    if (d.id === "zgody") continue;
    const f = FRAGMENTY[d.id](ustawienia[d.id], { adres });
    if (f.head) head.push(f.head);
    if (f.body) body.push(f.body);
  }
  // Baner, gdy jest włączony, albo gdy jakaś integracja (także we własnym kodzie) czeka na zgodę.
  const kategorie = {};
  for (const d of KATALOG) if (d.zgoda && ustawienia[d.id]?.wlaczona) kategorie[d.zgoda] = KATEGORIE_ZGOD[d.zgoda];
  const wlasny = ustawienia["wlasny-kod"]?.wlaczona ? `${ustawienia["wlasny-kod"].head || ""}${ustawienia["wlasny-kod"].body || ""}` : "";
  for (const c of Object.keys(KATEGORIE_ZGOD)) if (wlasny.includes(`data-zgoda="${c}"`)) kategorie[c] = KATEGORIE_ZGOD[c];
  const baner = ustawienia.zgody?.wlaczona || (!podglad && Object.keys(kategorie).length);
  if (baner) {
    if (!Object.keys(kategorie).length) Object.assign(kategorie, KATEGORIE_ZGOD); // baner włączony ręcznie, bez integracji: pełna lista
    // Ścieżkę polityki liczymy od głównego katalogu strony, żeby link działał z każdej podstrony.
    let polityka = ustawienia.zgody?.polityka || "";
    if (polityka && !polityka.startsWith("https://") && adres) polityka = new URL(polityka.replace(/^\/+/, ""), adres).href;
    const k = { kategorie, wersja: Object.keys(kategorie).sort().join(","), tekst: ustawienia.zgody?.tekst || TEKST_BANERA, polityka };
    body.push(`<script data-edytor-integracja="zgody">(${banerZgod.toString()})(${json(k)});</script>`);
  }
  return { head: head.join("\n"), body: body.join("\n") };
}

export function wstawDoHtml(tresc, { head, body }) {
  let wynik = tresc;
  // Zamiana przez funkcję: w tekście zamiany `$&`, `$'` itp. byłyby wzorcami (np. „$'” w nazwie firmy wkleiłoby resztę strony).
  if (head) wynik = /<\/head>/i.test(wynik) ? wynik.replace(/<\/head>/i, () => `${head}\n</head>`) : head + wynik;
  if (body) wynik = /<\/body>/i.test(wynik) ? wynik.replace(/<\/body>(?![\s\S]*<\/body>)/i, () => `${body}\n</body>`) : wynik + body;
  return wynik;
}

// Wstawia integracje do wszystkich stron HTML w katalogu wydania. Bez włączonych integracji — nic nie zmienia.
export async function wstawIntegracje(katalog, ustawienia, adres) {
  if (!Object.values(ustawienia || {}).some((u) => u?.wlaczona)) return;
  const strony = (await fs.readdir(katalog, { recursive: true })).map(String).filter((p) => /\.html?$/i.test(p));
  for (const strona of strony) {
    const plik = path.join(katalog, strona);
    const glowna = /^index\.html?$/i.test(strona);
    const f = fragmentyStrony(ustawienia, { glowna, adres });
    if (f.head || f.body) await fs.writeFile(plik, wstawDoHtml(await fs.readFile(plik, "utf8"), f));
  }
}
