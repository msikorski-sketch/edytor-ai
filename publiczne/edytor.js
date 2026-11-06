// Panel edytora: projekty, podgląd w ramce (osobny origin), zaznaczanie elementów, czat z agentem, pliki i publikacja.
const $ = (id) => document.getElementById(id);
const ramka = $("ramka");
const wiadomosci = $("wiadomosci");

let projekt = null; // id bieżącego projektu
let trybZaznaczania = false;
let zaznaczony = null; // { selektor, html, tekst }
let zalaczniki = []; // { typ, dane (base64), url (podgląd) }
let ogladanaWersja = null; // commit pokazywany w trybie „przed”
let pracuje = false;
let tury = [];
let ja = null; // zalogowane konto: { login, nazwa, rola, mozliwosci }

// ---------- pomocnicze ----------

function utworz(nazwa, wlasciwosci = {}, ...dzieci) {
  const el = Object.assign(document.createElement(nazwa), wlasciwosci);
  el.append(...dzieci.filter((d) => d != null));
  return el;
}
function ikona(nazwa, klasa) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${nazwa}`);
  svg.append(use);
  if (klasa) svg.setAttribute("class", klasa);
  return svg;
}
// Tosty są „popoverem” w warstwie top layer: ponowne pokazanie przenosi je nad otwarte okno dialogowe,
// inaczej komunikat (np. błąd w ustawieniach) chowałby się pod modalem.
function tost(tekst, blad = false) {
  const kontener = $("tosty");
  const el = utworz("div", { className: `tost${blad ? " blad" : ""}`, textContent: tekst, role: blad ? "alert" : "status" });
  kontener.append(el);
  if (kontener.matches(":popover-open")) kontener.hidePopover();
  kontener.showPopover();
  setTimeout(() => {
    el.remove();
    if (!kontener.childElementCount && kontener.matches(":popover-open")) kontener.hidePopover();
  }, blad ? 7000 : 4000);
}
const rozmiar = (b) => (b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);

// Wszystkie zapytania API przez jedno miejsce: wygasła sesja → ekran logowania, błędy → wyjątek z komunikatem.
async function api(sciezka, opcje = {}) {
  const odp = await fetch(sciezka, opcje);
  if (odp.status === 401) { location.reload(); throw new Error("Sesja wygasła."); }
  const dane = (odp.headers.get("content-type") || "").includes("json") ? await odp.json() : null;
  if (!odp.ok) throw new Error(dane?.blad || `Błąd ${odp.status}`);
  return dane;
}
const apiProjektu = (akcja, opcje) => api(`/api/p/${projekt}/${akcja}`, opcje);
const wyslijJson = (cialo) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cialo ?? {}) });

// ---------- projekty ----------

async function wczytajProjekty(wybrany) {
  const { projekty } = await api("/api/projekty");
  const zapamietany = wybrany || localStorage.getItem("edytor-projekt");
  projekt = projekty.some((p) => p.id === zapamietany) ? zapamietany : projekty[0]?.id;
  $("projekt").replaceChildren(...[
    ...projekty.map((p) => new Option(p.nazwa, p.id, false, p.id === projekt)),
    ja?.mozliwosci.administrator ? new Option("＋ Nowy projekt…", "__nowy") : null,
  ].filter(Boolean));
}

async function przelaczProjekt(id) {
  if (pracuje) { tost("Poczekaj, aż asystent skończy, albo go zatrzymaj.", true); $("projekt").value = projekt; return; }
  projekt = id;
  ostatniStatus = null;
  localStorage.setItem("edytor-projekt", id);
  ogladanaWersja = null;
  $("baner-wersji").hidden = true;
  zalaczniki = [];
  pokazZalaczniki();
  zaznaczony = null;
  $("zaznaczony").hidden = true;
  wczytajTury();
  rysujCzat();
  await wczytajPodstrony();
  zaladujPodglad({ zachowajPrzewiniecie: false });
  odswiezStatus();
}

$("projekt").addEventListener("change", (e) => {
  if (e.target.value === "__nowy") { e.target.value = projekt; return otworzNowyProjekt(); }
  przelaczProjekt(e.target.value);
});

// ---------- podgląd ----------

// Podgląd stoi na osobnej domenie (inny origin), więc panel nie sięga do jego DOM.
// Zaznaczaniem steruje skrypt wybieracz.js wewnątrz podglądu, a rozmowa idzie przez postMessage.
let podglad = null; // { adres, wejscie, pobrano }
let przewiniecie = 0;
let ladowanie = null; // { przewin } — co zrobić, gdy podgląd zgłosi gotowość

const aktualnaStrona = () => $("podstrona").value || "index.html";
// Każdy segment ścieżki kodujemy osobno: nazwy z importu mogą mieć spacje, „?” czy „#”.
const kodujSciezke = (sciezka) => sciezka.split("/").map(encodeURIComponent).join("/");

// Podgląd działa w piaskownicy (pusty origin „null”), więc wiadomości do niego idą z celem „*”. To tylko polecenia
// interfejsu (tryb zaznaczania, przewinięcie) — nic poufnego. Odbiorcę wyznacza ramka (contentWindow).
function doPodgladu(wiadomosc) {
  if (podglad) ramka.contentWindow?.postMessage({ edytor: true, ...wiadomosc }, "*");
}

async function zaladujPodglad({ zachowajPrzewiniecie = true } = {}) {
  ladowanie = { przewin: zachowajPrzewiniecie ? przewiniecie : 0 };
  if (!zachowajPrzewiniecie) przewiniecie = 0;
  const sciezka = `/${projekt}/${ogladanaWersja ? `__wersja/${ogladanaWersja}/` : ""}${kodujSciezke(aktualnaStrona())}`;
  // Pierwsze wejście (i przed wygaśnięciem klucza) idzie przez /__wejscie, które ustawia ciasteczko podglądu.
  if (!podglad || Date.now() - podglad.pobrano > 6 * 3600 * 1000) {
    podglad = { ...(await api("/api/podglad")), pobrano: Date.now() };
    ramka.src = `${podglad.wejscie}&dalej=${encodeURIComponent(sciezka)}`;
  } else {
    ramka.src = `${podglad.adres}${sciezka}${ogladanaWersja ? "" : `?t=${Date.now()}`}`;
  }
}

async function wczytajPodstrony() {
  const { strony } = await apiProjektu("strony");
  const wybrana = aktualnaStrona();
  $("podstrona").replaceChildren(...strony.map((s) => new Option(s, s, false, s === wybrana)));
  if (!strony.includes(wybrana) && strony.length) $("podstrona").value = strony[0];
}

$("podstrona").addEventListener("change", () => { odznacz(); zaladujPodglad({ zachowajPrzewiniecie: false }); });

addEventListener("message", (e) => {
  // Nadawcę rozpoznajemy po ramce; origin to „null” (piaskownica) albo adres podglądu.
  if (!podglad || !["null", podglad.adres].includes(e.origin) || e.source !== ramka.contentWindow || !e.data?.edytor) return;
  const z = e.data;
  if (z.typ === "gotowy") {
    // Kliknięcie linku w podglądzie zmienia podstronę w selektorze.
    const plik = String(z.sciezka).replace(/^\/[a-z0-9-]+\/(__wersja\/[0-9a-f]+\/)?/, "") || "index.html"; // wybieracz zgłasza już zdekodowaną ścieżkę
    if ([...$("podstrona").options].some((o) => o.value === plik)) $("podstrona").value = plik;
    if (ladowanie?.przewin) doPodgladu({ typ: "przewin", y: ladowanie.przewin });
    ladowanie = null;
    if (trybZaznaczania) doPodgladu({ typ: "tryb", wlaczony: true });
  }
  if (z.typ === "przewiniecie") przewiniecie = Number(z.y) || 0;
  if (z.typ === "zaznaczono") pokazZaznaczenie(z.element);
  if (z.typ === "klawisz") obsluzSkroty({ key: z.klawisz, target: document.body, preventDefault() {} });
});

// Szerokość podglądu: komputer / tablet / telefon.
document.querySelectorAll(".urzadzenia button").forEach((przycisk) => {
  przycisk.addEventListener("click", () => {
    document.querySelectorAll(".urzadzenia button").forEach((b) => b.setAttribute("aria-checked", String(b === przycisk)));
    const szerokosc = przycisk.dataset.szerokosc;
    $("obudowa").style.width = szerokosc;
    $("obudowa").classList.toggle("waska", szerokosc !== "100%");
  });
});

// Widok „przed”: ta sama podstrona z wybranej wersji w gicie.
function pokazWersje(commit) {
  ogladanaWersja = commit;
  ustawTryb(false);
  odznacz();
  $("baner-wersji").hidden = !commit;
  $("baner-commit").textContent = commit || "";
  document.querySelectorAll("[data-przed]").forEach((b) => {
    const wcisniety = b.dataset.przed === commit;
    b.setAttribute("aria-pressed", String(wcisniety));
    b.textContent = wcisniety ? "Pokaż po" : "Pokaż przed";
  });
  zaladujPodglad();
}
$("baner-wroc").addEventListener("click", () => pokazWersje(null));

// ---------- zaznaczanie elementu ----------

function ustawTryb(wlaczony) {
  if (wlaczony && ogladanaWersja) pokazWersje(null);
  trybZaznaczania = wlaczony;
  $("zaznacz").setAttribute("aria-pressed", String(wlaczony));
  doPodgladu({ typ: "tryb", wlaczony });
}

function pokazZaznaczenie(element) {
  zaznaczony = { selektor: String(element.selektor), html: String(element.html), tekst: String(element.tekst) };
  ustawTryb(false);
  $("zaznaczony-tag").textContent = element.tag;
  $("zaznaczony-opis").textContent = zaznaczony.tekst.replace(/\s+/g, " ").slice(0, 80) || zaznaczony.selektor;
  $("zaznaczony").hidden = false;
  $("tresc").focus();
}

function odznacz() {
  zaznaczony = null;
  $("zaznaczony").hidden = true;
  doPodgladu({ typ: "odznacz" });
}

$("zaznacz").addEventListener("click", () => ustawTryb(!trybZaznaczania));
$("odznacz").addEventListener("click", odznacz);
$("rodzic").addEventListener("click", () => doPodgladu({ typ: "rodzic" }));

function obsluzSkroty(e) {
  if (e.key === "Escape") return ustawTryb(false);
  const wPolu = ["TEXTAREA", "INPUT", "SELECT"].includes(e.target.tagName);
  if (!wPolu && (e.key === "s" || e.key === "S") && !e.ctrlKey && !e.metaKey && !document.querySelector("dialog[open]")) {
    e.preventDefault();
    ustawTryb(!trybZaznaczania);
  }
}
document.addEventListener("keydown", obsluzSkroty);

// ---------- załączniki (obrazek jako wzór) ----------

async function dodajObrazy(pliki) {
  for (const plik of pliki) {
    if (!plik.type.startsWith("image/")) continue;
    if (zalaczniki.length >= 3) { tost("Maksymalnie 3 obrazki na polecenie.", true); break; }
    if (plik.size > 4 * 1024 * 1024) { tost(`${plik.name || "Obrazek"} ma ponad 4 MB.`, true); continue; }
    const dane = await new Promise((ok) => {
      const czytnik = new FileReader();
      czytnik.onload = () => ok(String(czytnik.result).split(",")[1]);
      czytnik.readAsDataURL(plik);
    });
    zalaczniki.push({ typ: plik.type, dane, url: URL.createObjectURL(plik) });
  }
  pokazZalaczniki();
}

function pokazZalaczniki() {
  $("zalaczniki").hidden = !zalaczniki.length;
  $("zalaczniki").replaceChildren(...zalaczniki.map((z, i) => {
    const usun = utworz("button", { type: "button", textContent: "×", title: "Usuń" });
    usun.addEventListener("click", () => { zalaczniki.splice(i, 1); pokazZalaczniki(); });
    return utworz("div", { className: "zalacznik" }, utworz("img", { src: z.url, alt: "" }), usun);
  }));
}

$("plik").addEventListener("change", (e) => { dodajObrazy([...e.target.files]); e.target.value = ""; });
$("tresc").addEventListener("paste", (e) => {
  const obrazy = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
  if (obrazy.length) { e.preventDefault(); dodajObrazy(obrazy); }
});
const pole = document.querySelector(".pole");
pole.addEventListener("dragover", (e) => { e.preventDefault(); pole.classList.add("upuszczanie"); });
pole.addEventListener("dragleave", () => pole.classList.remove("upuszczanie"));
pole.addEventListener("drop", (e) => { e.preventDefault(); pole.classList.remove("upuszczanie"); dodajObrazy([...e.dataTransfer.files]); });

// ---------- czat: zapis tur i rysowanie ----------

// Tura: { typ: "uzytkownik", tekst, element, obrazy } albo { typ: "asystent", kroki, teksty, bledy, commit, poprzedni, czas, cofnieta }.
const kluczCzatu = () => `edytor-czat-${projekt}`;
function wczytajTury() {
  try { tury = JSON.parse(localStorage.getItem(kluczCzatu()) || "[]"); } catch { tury = []; }
  // Tury przerwane odświeżeniem strony oznaczamy jako zakończone.
  tury.forEach((t) => { if (t.typ === "asystent" && !t.koniec) { t.koniec = true; t.bledy.push("Przerwano (odświeżono stronę)."); } });
}
const zapiszTury = () => localStorage.setItem(kluczCzatu(), JSON.stringify(tury.slice(-60), (klucz, wartosc) => (klucz === "obrazy" || klucz === "zrzuty" ? undefined : wartosc)));

// Bezpieczne formatowanie odpowiedzi: najpierw ucieczka HTML, potem `kod`, **pogrubienie** i listy.
function formatuj(tekst) {
  const bezpieczny = tekst.replace(/[&<>"]/g, (z) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[z]);
  const wiersz = (w) => w.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  const bloki = [];
  let lista = null;
  for (const linia of bezpieczny.split("\n")) {
    const punkt = linia.match(/^\s*[-*•]\s+(.*)/);
    if (punkt) { (lista ??= []).push(`<li>${wiersz(punkt[1])}</li>`); continue; }
    if (lista) { bloki.push(`<ul>${lista.join("")}</ul>`); lista = null; }
    if (linia.trim() && !/^```/.test(linia.trim())) bloki.push(`<p>${wiersz(linia)}</p>`);
  }
  if (lista) bloki.push(`<ul>${lista.join("")}</ul>`);
  return bloki.join("");
}

function powitanie() {
  const przyklady = [
    "Zmień kolor przycisku na granatowy i zaokrąglij go mocniej",
    "Dodaj pod nagłówkiem sekcję z trzema opiniami klientów",
    "Na telefonie zmniejsz nagłówek, bo się nie mieści",
  ];
  return utworz("div", { className: "powitanie" },
    ikona("iskra", "ikona-duza"),
    utworz("h3", { textContent: "Co zmieniamy?" }),
    utworz("p", { textContent: "Kliknij „Zaznacz element” (albo S), wskaż fragment strony i opisz zmianę. Zdjęcia wgrasz w „Pliki”, a obrazek-wzór wkleisz do pola poniżej." }),
    utworz("div", { className: "przyklady" }, ...przyklady.map((tekst) => {
      const b = utworz("button", { className: "przyklad", type: "button", textContent: tekst });
      b.addEventListener("click", () => { $("tresc").value = tekst; dopasujWysokosc(); $("tresc").focus(); });
      return b;
    })),
  );
}

function rysujUzytkownika(tura) {
  const el = utworz("div", { className: "dymek-uzytkownika" });
  if (tura.element) {
    el.append(utworz("div", { className: "kontekst" },
      utworz("span", { className: "tag", textContent: tura.element.tag }),
      utworz("span", { textContent: tura.element.opis })));
  }
  // Miniatury żyją tylko do odświeżenia strony (adresy blob:); potem zostaje sama liczba obrazków.
  if (tura.obrazy?.length) el.append(utworz("div", { className: "miniatury" }, ...tura.obrazy.map((src) => utworz("img", { src, alt: "" }))));
  else if (tura.liczbaObrazow) el.append(utworz("div", { className: "kontekst", textContent: `Dołączone obrazki: ${tura.liczbaObrazow}` }));
  if (tura.globalne) el.append(utworz("div", { className: "kontekst" }, utworz("span", { className: "tag tag-globalny", textContent: "cała strona" })));
  el.append(utworz("div", { className: "tekst", textContent: tura.tekst }));
  return el;
}

function rysujAsystenta(tura) {
  const tresc = utworz("div", { className: "odpowiedz-tresc" });
  if (tura.kroki.length) {
    tresc.append(utworz("details", { className: "kroki", open: !tura.koniec },
      utworz("summary", { textContent: `${tura.koniec ? "Wykonane kroki" : "Pracuję"} (${tura.kroki.length})` }),
      utworz("ol", {}, ...tura.kroki.map((k) => utworz("li", { textContent: k })))));
  }
  // Zrzuty, które obejrzał asystent (tylko w bieżącej sesji przeglądarki — nie trafiają do localStorage).
  if (tura.zrzuty?.length) {
    tresc.append(utworz("div", { className: "zrzuty" }, ...tura.zrzuty.map((z) => {
      const img = utworz("img", { src: `data:image/jpeg;base64,${z.dane}`, alt: `Zrzut: ${z.opis}`, title: z.opis });
      img.addEventListener("click", () => window.open().document.body.append(img.cloneNode()));
      return img;
    })));
  }
  for (const t of tura.teksty) tresc.append(utworz("div", { className: "tekst-asystenta", innerHTML: formatuj(t) }));
  for (const b of tura.bledy) tresc.append(utworz("div", { className: "blad-odp", textContent: b }));
  if (tura.plan) {
    const plan = utworz("div", { className: "plan" },
      utworz("strong", { textContent: `Plan: ${tura.plan.kroki.length} ${odmiana(tura.plan.kroki.length, "krok", "kroki", "kroków")}` }),
      utworz("ol", {}, ...tura.plan.kroki.map((k) => utworz("li", {}, utworz("b", { textContent: k.tytul }), k.opis ? utworz("div", { className: "opis-kroku", textContent: k.opis }) : null))));
    if (!tura.planObsluzony && tura.koniec) {
      const wykonaj = utworz("button", { className: "przycisk glowny", type: "button", textContent: "Wykonaj plan" });
      wykonaj.addEventListener("click", () => { if (!pracuje) wykonajPlan(tura); });
      const anuluj = utworz("button", { className: "przycisk", type: "button", textContent: "Anuluj" });
      anuluj.addEventListener("click", () => { tura.planObsluzony = "anulowany"; zapiszTury(); rysujCzat(); });
      plan.append(utworz("div", { className: "akcje-zmiany" }, wykonaj, anuluj));
    } else if (tura.planObsluzony) {
      plan.append(utworz("div", { className: "systemowa", textContent: tura.planObsluzony === "wykonany" ? "Plan przekazany do wykonania." : "Plan anulowany." }));
    }
    tresc.append(plan);
  }
  if (tura.weryfikacja) {
    const { strony, bledy } = tura.weryfikacja;
    tresc.append(utworz("div", { className: bledy.length ? "blad-odp" : "systemowa", textContent: bledy.length
      ? `Sprawdzenie ${strony} podstron: ${bledy.length} problemów, np. ${bledy.slice(0, 3).map((b) => `${b.strona} — ${b.problem}`).join("; ")}`
      : `Sprawdzono ${strony} podstron: wszystkie linki i obrazki prowadzą do istniejących plików.` }));
  }

  if (!tura.koniec) {
    const sekundy = Math.round((Date.now() - tura.start) / 1000);
    tresc.append(utworz("div", { className: "pracuje" }, utworz("span", { className: "kolko" }), utworz("span", { textContent: `Asystent pracuje… ${sekundy} s` })));
  } else if (tura.commit) {
    const meta = utworz("span", { className: "meta", textContent: `Zmiana ${tura.commit}${tura.czas ? ` · ${Math.round(tura.czas / 1000)} s` : ""}${tura.cofnieta ? " · cofnięta" : ""}` });
    const akcje = utworz("div", { className: "akcje-zmiany" }, meta);
    if (tura.poprzedni && !tura.cofnieta) {
      const przed = utworz("button", { className: "przycisk", type: "button", textContent: ogladanaWersja === tura.poprzedni ? "Pokaż po" : "Pokaż przed" });
      przed.dataset.przed = tura.poprzedni;
      przed.setAttribute("aria-pressed", String(ogladanaWersja === tura.poprzedni));
      przed.addEventListener("click", () => pokazWersje(ogladanaWersja === tura.poprzedni ? null : tura.poprzedni));
      const cofnij = utworz("button", { className: "przycisk", type: "button", textContent: tura.zadanie ? "Cofnij całe zadanie" : "Cofnij" });
      cofnij.addEventListener("click", () => (tura.zadanie ? cofnijZadanie(tura) : cofnijZmiane(tura.commit, tura)));
      akcje.append(przed, cofnij);
    }
    tresc.append(akcje);
  } else if (!tura.bledy.length) {
    tresc.append(utworz("div", { className: "systemowa", textContent: "Bez zmian w plikach." }));
  }
  return utworz("div", { className: "odpowiedz" }, utworz("div", { className: "awatar" }, ikona("iskra")), tresc);
}

function rysujCzat() {
  const naDole = wiadomosci.scrollHeight - wiadomosci.scrollTop - wiadomosci.clientHeight < 60;
  if (!tury.length) return wiadomosci.replaceChildren(powitanie());
  wiadomosci.replaceChildren(...tury.map((t) => (t.typ === "uzytkownik" ? rysujUzytkownika(t) : rysujAsystenta(t))));
  if (naDole) wiadomosci.scrollTop = wiadomosci.scrollHeight;
}

// ---------- wysyłanie polecenia ----------

function ustawPrace(wlaczona) {
  pracuje = wlaczona;
  $("wyslij").hidden = wlaczona;
  $("zatrzymaj").hidden = !wlaczona;
}

async function wyslijPolecenie(tresc) {
  const globalne = $("tryb-globalny").checked;
  tury.push({
    typ: "uzytkownik",
    tekst: tresc,
    globalne,
    element: !globalne && zaznaczony ? { tag: $("zaznaczony-tag").textContent, opis: $("zaznaczony-opis").textContent } : null,
    obrazy: globalne ? [] : zalaczniki.map((z) => z.url),
    liczbaObrazow: globalne ? 0 : zalaczniki.length,
  });
  const tura = { typ: "asystent", kroki: [], teksty: [], bledy: [], start: Date.now(), koniec: false, rodzaj: globalne ? "plan" : "polecenie" };
  tury.push(tura);
  const cialo = globalne
    ? { tresc }
    : { tresc, element: zaznaczony, strona: aktualnaStrona(), obrazy: zalaczniki.map(({ typ, dane }) => ({ typ, dane })) };
  if (!globalne) { zalaczniki = []; pokazZalaczniki(); }
  await prowadzTure(globalne ? "plan" : "polecenie", cialo, tura);
}

// Zatwierdzony plan: wykonanie krok po kroku w nowej turze czatu.
async function wykonajPlan(turaPlanu) {
  turaPlanu.planObsluzony = "wykonany";
  const tura = { typ: "asystent", kroki: [], teksty: [], bledy: [], start: Date.now(), koniec: false, rodzaj: "zadanie" };
  tury.push(tura);
  await prowadzTure("zadanie", { id: turaPlanu.plan.id }, tura);
}

// Wspólny przebieg tury: zapytanie do API projektu, odczyt strumienia zdarzeń SSE i odświeżenie widoku na końcu.
async function prowadzTure(akcja, cialo, tura) {
  const projektPolecenia = projekt;
  ustawPrace(true);
  if (ogladanaWersja) pokazWersje(null);
  zapiszTury();
  rysujCzat();
  wiadomosci.scrollTop = wiadomosci.scrollHeight;
  const zegar = setInterval(rysujCzat, 1000);

  try {
    const odp = await fetch(`/api/p/${projektPolecenia}/${akcja}`, wyslijJson(cialo));
    if (odp.status === 401) return location.reload();
    if (!odp.ok) {
      tura.bledy.push((await odp.json().catch(() => ({}))).blad || `Błąd ${odp.status}`);
      return;
    }
    // Odpowiedź to strumień zdarzeń SSE ("data: {...}\n\n"), czytany w miarę jak agent pracuje.
    const czytnik = odp.body.pipeThrough(new TextDecoderStream()).getReader();
    let bufor = "";
    for (;;) {
      const { value, done } = await czytnik.read();
      if (done) break;
      bufor += value;
      const zdarzenia = bufor.split("\n\n");
      bufor = zdarzenia.pop();
      for (const surowe of zdarzenia) {
        if (surowe.startsWith("data: ")) obsluzZdarzenie(tura, JSON.parse(surowe.slice(6)));
      }
      rysujCzat();
    }
    // Strumień skończył się bez zdarzenia końcowego: serwer albo sieć przerwały pracę w połowie.
    if (!tura.zakonczona) tura.bledy.push("Połączenie urwało się przed końcem pracy. Sprawdź Historię, czy zmiana została zapisana.");
  } catch (e) {
    tura.bledy.push(`Połączenie przerwane: ${e.message}`);
  } finally {
    clearInterval(zegar);
    tura.koniec = true;
    tura.czas ??= Date.now() - tura.start;
    ustawPrace(false);
    zapiszTury();
    if (projekt === projektPolecenia) {
      odznacz();
      rysujCzat();
      wczytajPodstrony().then(() => zaladujPodglad());
      odswiezStatus();
    }
  }
}

function obsluzZdarzenie(tura, z) {
  if (z.typ === "tekst") tura.teksty.push(z.tekst);
  if (z.typ === "narzedzie") tura.kroki.push(z.tekst);
  if (z.typ === "zrzut") (tura.zrzuty ??= []).push({ dane: z.dane, opis: z.opis });
  if (z.typ === "blad") {
    tura.bledy.push(z.tekst);
    tura.zakonczona = true;
    if (z.commit) { tura.commit = z.commit; tura.poprzedni = z.poprzedni; tura.zadanie = Boolean(z.zadanie); }
  }
  if (z.typ === "wynik") {
    tura.czas = z.czas;
    if (!z.ok) tura.bledy.push("Asystent nie dokończył zadania.");
  }
  if (z.typ === "koniec") { tura.commit = z.commit; tura.poprzedni = z.poprzedni; tura.zakonczona = true; tura.zadanie = Boolean(z.zadanie); }
  if (z.typ === "plan") { tura.plan = { id: z.id, kroki: z.kroki }; tura.zakonczona = true; }
  if (z.typ === "krok") tura.kroki.push(`▸ Krok ${z.nr}/${z.z}: ${z.tytul}`);
  if (z.typ === "weryfikacja") tura.weryfikacja = { strony: z.strony, bledy: z.bledy };
}

function dopasujWysokosc() {
  const t = $("tresc");
  t.style.height = "auto";
  t.style.height = `${Math.min(t.scrollHeight, 180)}px`;
}
$("tresc").addEventListener("input", dopasujWysokosc);
$("tresc").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("formularz").requestSubmit(); }
});
$("formularz").addEventListener("submit", (e) => {
  e.preventDefault();
  const tresc = $("tresc").value.trim();
  if (!tresc || pracuje) return;
  $("tresc").value = "";
  dopasujWysokosc();
  wyslijPolecenie(tresc);
});
$("tryb-globalny").addEventListener("change", () => {
  const globalne = $("tryb-globalny").checked;
  if (globalne) odznacz();
  $("tresc").placeholder = globalne
    ? "Zadanie dla całej strony, np. „dodaj 5 podstron usług według wzoru strony O nas”. Najpierw zobaczysz plan."
    : "Opisz zmianę… (możesz wkleić obrazek jako wzór)";
});

$("zatrzymaj").addEventListener("click", async () => {
  $("zatrzymaj").disabled = true;
  try { await apiProjektu("zatrzymaj", wyslijJson()); } catch (e) { tost(e.message, true); }
  $("zatrzymaj").disabled = false;
});

$("nowa-rozmowa").addEventListener("click", async () => {
  if (pracuje) return tost("Poczekaj, aż asystent skończy.", true);
  try { await apiProjektu("nowa-rozmowa", wyslijJson()); } catch (e) { return tost(e.message, true); }
  tury = [];
  zapiszTury();
  rysujCzat();
  tost("Nowa rozmowa. Asystent nie pamięta wcześniejszych poleceń.");
});

// ---------- cofanie, historia i publikacja ----------

// Polska odmiana po liczebniku: 1 krok, 2–4 kroki (bez 12–14), 5+ kroków.
function odmiana(n, jeden, kilka, wiele) {
  if (n === 1) return jeden;
  return n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? kilka : wiele;
}

async function cofnijZadanie(tura) {
  try { await apiProjektu("cofnij-zadanie", wyslijJson({ od: tura.poprzedni })); } catch (e) { tost(e.message, true); return; }
  tura.cofnieta = true;
  zapiszTury();
  if (ogladanaWersja) pokazWersje(null); else zaladujPodglad();
  wczytajPodstrony();
  rysujCzat();
  odswiezStatus();
  tost("Cofnięto całe zadanie.");
}

async function cofnijZmiane(commit, tura) {
  try { await apiProjektu("cofnij", wyslijJson({ commit })); } catch (e) { tost(e.message, true); return false; }
  const doOznaczenia = tura || tury.find((t) => t.commit === commit);
  if (doOznaczenia) { doOznaczenia.cofnieta = true; zapiszTury(); }
  if (ogladanaWersja) pokazWersje(null); else zaladujPodglad();
  rysujCzat();
  odswiezStatus();
  tost(`Cofnięto zmianę ${commit}.`);
  return true;
}

let ostatniStatus = null;
async function odswiezStatus() {
  const projektZapytania = projekt;
  const h = await apiProjektu("historia");
  if (projektZapytania !== projekt) return h; // użytkownik w międzyczasie przełączył projekt — nie nadpisujemy widoku
  ostatniStatus = h;
  const najnowszy = h.wpisy[0]?.commit;
  const opublikowane = najnowszy && najnowszy === h.opublikowano;
  const indeks = h.wpisy.findIndex((w) => w.commit === h.opublikowano);
  const ile = indeks === -1 ? h.wpisy.length : indeks;
  const status = $("status-publikacji");
  status.className = `znaczek ${opublikowane ? "ok" : "zmiany"}`;
  status.textContent = opublikowane ? "Opublikowano" : `${ile} ${ile === 1 ? "zmiana" : ile % 10 >= 2 && ile % 10 <= 4 && (ile % 100 < 12 || ile % 100 > 14) ? "zmiany" : "zmian"} do publikacji`;
  $("opublikuj").disabled = opublikowane;
  $("link-strony").hidden = !h.adres;
  if (h.adres) $("link-strony").href = h.adres;
  $("model").textContent = `Model: ${h.model.replace(/:free$/, " (darmowy)")}`;
  $("model").classList.toggle("ostrzezenie", /:free$/.test(h.model));
  $("model").title = /:free$/.test(h.model)
    ? "Darmowy model: dostawca może zapisywać zapytania i używać ich do trenowania. Do stron klientów użyj płatnego modelu (klucz API)."
    : "";
  pokazZuzycie();
  return h;
}

// Zużycie modelu: dzisiaj i prognoza na miesiąc (22 dni robocze) z ostatnich 30 dni, w cenach Claude Sonnet 5.5.
async function pokazZuzycie() {
  if (!ja?.mozliwosci.administrator) return; // koszty widzi tylko administrator
  try {
    const z = await api("/api/zuzycie?dni=30");
    const usd = (v) => `${(v || 0).toFixed(2).replace(".", ",")} $`;
    const sredniaDzienna = z.dniZPoleceniami ? (z.okres.szacunekUsd["claude-sonnet-5-5"] || 0) / z.dniZPoleceniami : 0;
    $("zuzycie").textContent = `Dziś: ${z.dzis.polecenia} polec. · ≈ ${usd(z.dzis.szacunekUsd["claude-sonnet-5-5"])} na Sonnet 5.5`;
    $("zuzycie").title = [
      `Ostatnie ${z.dni} dni: ${z.okres.polecenia} poleceń w ${z.dniZPoleceniami} dniach.`,
      `Tokeny: wejście ${z.okres.tokeny.wejscie.toLocaleString("pl-PL")}, z cache ${z.okres.tokeny.odczytCache.toLocaleString("pl-PL")}, wyjście ${z.okres.tokeny.wyjscie.toLocaleString("pl-PL")}.`,
      `Szacunek za ten okres: Haiku 5.5 ${usd(z.okres.szacunekUsd["claude-haiku-5-5"])}, Sonnet 5.5 ${usd(z.okres.szacunekUsd["claude-sonnet-5-5"])}, Opus 5.5 ${usd(z.okres.szacunekUsd["claude-opus-5-5"])}.`,
      `Prognoza miesięczna na Sonnet 5.5 (22 dni robocze): ${usd(sredniaDzienna * 22)}.`,
    ].join("\n");
  } catch { /* zużycie jest pomocnicze — brak danych nie blokuje panelu */ }
}

$("historia-przycisk").addEventListener("click", async () => {
  const h = await odswiezStatus();
  $("historia-blad").hidden = true;
  $("lista-historii").replaceChildren(...h.wpisy.map((w, i) => {
    const opis = utworz("div", { className: "opis" },
      utworz("div", { textContent: w.opis }),
      utworz("small", { textContent: `${w.commit} · ${new Date(w.kiedy).toLocaleString("pl-PL")}${w.autor ? ` · ${w.autor}` : ""}` }));
    if (w.commit === h.opublikowano) opis.querySelector("small").append(utworz("span", { className: "opublikowana", textContent: "na stronie" }));
    const podglad = utworz("button", { className: "przycisk maly", textContent: "Podgląd" });
    podglad.addEventListener("click", () => { $("okno-historii").close(); pokazWersje(i === 0 ? null : w.commit); });
    const publikuj = utworz("button", { className: "przycisk maly", textContent: "Opublikuj tę", title: "Przywróć tę wersję na stronie publicznej" });
    publikuj.addEventListener("click", async () => {
      try {
        await apiProjektu("opublikuj", wyslijJson({ commit: w.commit }));
        $("okno-historii").close();
        tost(`Na stronie jest teraz wersja ${w.commit}.`);
        odswiezStatus();
      } catch (e) { tost(e.message, true); }
    });
    const cofnij = utworz("button", { className: "przycisk maly", textContent: "Cofnij" });
    cofnij.addEventListener("click", async () => { if (await cofnijZmiane(w.commit)) $("okno-historii").close(); });
    return utworz("li", {}, opis, podglad, w.commit === h.opublikowano || !ja.mozliwosci.publikacja ? null : publikuj, i === h.wpisy.length - 1 ? null : cofnij);
  }));
  $("okno-historii").showModal();
});
document.querySelectorAll("[data-zamknij]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));

$("opublikuj").addEventListener("click", async () => {
  $("opublikuj").disabled = true;
  try {
    const { commit } = await apiProjektu("opublikuj", wyslijJson());
    tost(`Opublikowano wersję ${commit}.`);
  } catch (e) { tost(e.message, true); }
  odswiezStatus();
});

// ---------- pliki strony ----------

const OBRAZY = /\.(png|jpe?g|webp|avif|gif|svg|ico)$/i;

async function pokazPliki() {
  const projektListy = projekt;
  const { pliki } = await apiProjektu("pliki");
  pliki.sort((a, b) => Number(OBRAZY.test(b.sciezka)) - Number(OBRAZY.test(a.sciezka)) || a.sciezka.localeCompare(b.sciezka));
  $("lista-plikow").replaceChildren(...pliki.map((p) => {
    const miniatura = OBRAZY.test(p.sciezka) && podglad
      ? utworz("img", { className: "miniatura", src: `${podglad.adres}/${projekt}/${kodujSciezke(p.sciezka)}`, alt: "", loading: "lazy" })
      : utworz("span", { className: "miniatura", textContent: (p.sciezka.split(".").pop() || "").slice(0, 4) });
    const nazwa = utworz("button", { className: "nazwa", type: "button", textContent: p.sciezka, title: "Kliknij, żeby skopiować ścieżkę" });
    nazwa.addEventListener("click", async () => {
      await navigator.clipboard?.writeText(p.sciezka).catch(() => {});
      $("tresc").value = `${$("tresc").value}${$("tresc").value ? " " : ""}${p.sciezka}`;
      dopasujWysokosc();
      tost(`Wstawiono „${p.sciezka}” do polecenia.`);
    });
    const usun = utworz("button", { className: "ikona", type: "button", textContent: "×", title: "Usuń plik" });
    usun.addEventListener("click", async () => {
      if (!confirmWOknie(usun, `Usunąć ${p.sciezka}?`)) return;
      try { await api(`/api/p/${projektListy}/usun-plik`, wyslijJson({ sciezka: p.sciezka })); tost(`Usunięto ${p.sciezka}.`); } catch (e) { tost(e.message, true); }
      pokazPliki();
      odswiezStatus();
    });
    return utworz("li", {}, miniatura, nazwa, utworz("small", { textContent: rozmiar(p.rozmiar) }), ja.mozliwosci.pliki ? usun : null);
  }));
}

// Potwierdzenie dwuklikiem zamiast okna confirm(): pierwszy klik uzbraja przycisk, drugi wykonuje.
function confirmWOknie(przycisk, pytanie) {
  if (przycisk.dataset.uzbrojony) return true;
  przycisk.dataset.uzbrojony = "1";
  przycisk.textContent = "?";
  przycisk.title = `${pytanie} Kliknij ponownie, żeby potwierdzić.`;
  tost(`${pytanie} Kliknij × jeszcze raz, żeby potwierdzić.`);
  setTimeout(() => { delete przycisk.dataset.uzbrojony; przycisk.textContent = "×"; }, 4000);
  return false;
}

// Nazwa pliku do bezpiecznej postaci: bez polskich znaków i spacji; zdjęcia do katalogu obrazy/.
function bezpiecznaNazwa(nazwa) {
  const [rdzen, ...reszta] = nazwa.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ł/g, "l").replace(/Ł/g, "L").split(".");
  const rozszerzenie = reszta.pop()?.toLowerCase();
  const czysta = [rdzen, ...reszta].join("-").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "plik";
  const pelna = rozszerzenie ? `${czysta}.${rozszerzenie}` : czysta;
  return OBRAZY.test(pelna) ? `obrazy/${pelna}` : pelna;
}

async function wgrajPliki(pliki) {
  const projektWgrywania = projekt; // wszystkie pliki trafiają do projektu, w którym zaczęto wgrywanie
  for (const plik of pliki) {
    const sciezka = bezpiecznaNazwa(plik.name);
    try {
      await api(`/api/p/${projektWgrywania}/pliki?sciezka=${encodeURIComponent(sciezka)}`, { method: "POST", body: plik });
      tost(`Wgrano ${sciezka}.`);
    } catch (e) { tost(`${plik.name}: ${e.message}`, true); }
  }
  if (projektWgrywania !== projekt) return;
  pokazPliki();
  wczytajPodstrony();
  odswiezStatus();
}

$("pliki-przycisk").addEventListener("click", () => { pokazPliki(); $("okno-plikow").showModal(); });
$("plik-do-wgrania").addEventListener("change", (e) => { wgrajPliki([...e.target.files]); e.target.value = ""; });
const strefa = $("strefa-wgrywania");
strefa.addEventListener("dragover", (e) => { e.preventDefault(); strefa.classList.add("upuszczanie"); });
strefa.addEventListener("dragleave", () => strefa.classList.remove("upuszczanie"));
strefa.addEventListener("drop", (e) => { e.preventDefault(); strefa.classList.remove("upuszczanie"); wgrajPliki([...e.dataTransfer.files]); });

// ---------- ustawienia projektu ----------

let projektUstawien = null;
$("ustawienia-przycisk").addEventListener("click", async () => {
  projektUstawien = projekt;
  const h = await odswiezStatus();
  if (projektUstawien !== projekt) return;
  $("ust-nazwa").value = h.nazwa;
  $("ust-domena").value = h.adres?.startsWith("https://") && !h.adres.includes(`/${h.id}/`) ? new URL(h.adres).host : "";
  pokazStanDomeny(h.domena);
  $("ust-adres").textContent = h.adres || "(brak — ustaw domenę albo EDYTOR_ADRES_STRON)";
  $("ust-adres").href = h.adres || "#";
  $("ust-eksport").href = `/api/p/${projekt}/eksport`;
  $("ust-usun-potwierdzenie").value = "";
  $("ust-usun-potwierdzenie").placeholder = `wpisz: ${projekt}`;
  document.querySelector(".strefa-usuwania").open = false;
  $("ust-domena").placeholder = "np. www.salon-ewa.pl";
  $("ust-form-email").value = h.formularze?.email || "";
  $("ust-form-webhook").value = h.formularze?.webhook || "";
  $("ust-smtp-info").textContent = h.formularze?.smtp
    ? "Serwer ma skonfigurowaną wysyłkę e-maili."
    : "Uwaga: serwer nie ma jeszcze skonfigurowanej wysyłki e-maili (EDYTOR_SMTP w .env) — wiadomości będą zapisywane i wysyłane webhookiem, ale nie e-mailem.";
  $("ust-raport").hidden = true;
  apiProjektu("raport-importu").then(() => { if (projektUstawien === projekt) $("ust-raport").hidden = false; }, () => {});
  $("okno-ustawien").showModal();
});
// Stan własnej domeny: czy DNS już wskazuje na serwer (wtedy Traefik ma router i pobiera certyfikat).
function pokazStanDomeny(d) {
  const el = $("ust-domena-stan");
  el.classList.remove("blad-odp", "ok-odp");
  if (!d) {
    el.textContent = "Ustaw u rejestratora rekord A domeny na adres IP serwera. Gdy DNS zacznie wskazywać na serwer, edytor sam doda domenę i certyfikat HTTPS (sprawdza co 5 minut). Bez domeny strona działa pod adresem poniżej.";
    return;
  }
  const opisy = {
    aktywna: d.automatycznie ? `✓ ${d.nazwa} wskazuje na serwer — strona działa pod tą domeną (certyfikat HTTPS pojawia się w ciągu minuty od ustawienia).` : `✓ ${d.nazwa} wskazuje na serwer.`,
    "brak-dns": `${d.nazwa} nie ma jeszcze rekordu A. Ustaw go u rejestratora na adres IP serwera — zmiana DNS może potrwać do kilku godzin.`,
    "inny-serwer": `${d.nazwa} wskazuje na inny serwer (${(d.adresy || []).join(", ")}). Zmień rekord A na adres IP tego serwera.`,
    sprawdzam: `Sprawdzam DNS domeny ${d.nazwa}…`,
    blad: `Nie udało się sprawdzić DNS domeny ${d.nazwa}.`,
  };
  el.textContent = opisy[d.stan] || opisy.blad;
  el.classList.add(d.stan === "aktywna" ? "ok-odp" : "blad-odp");
}

$("ust-raport").addEventListener("click", async () => {
  try { pokazRaport(await apiProjektu("raport-importu")); } catch (e) { tost(e.message, true); }
});

// Raport migracji: liczby, a pod nimi to, co na statycznej kopii nie działa albo wymaga sprawdzenia, z radą.
function pokazRaport(r) {
  const tresc = $("tresc-raportu");
  const fakty = [
    `${r.strony} podstron, ${r.pliki} plików (${rozmiar(r.bajty)}) z ${r.adres}`,
    `Przekierowania 301 ze starych adresów: ${r.przekierowania}`,
    `Formularze przerobione na formularze edytora: ${r.formularze}`,
    r.pominiete ? `Pominięte adresy (limit, inna domena, nieobsługiwany typ): ${r.pominiete}` : null,
    r.bledy?.length ? `Nie udało się pobrać: ${r.bledy.length}, np. ${r.bledy.slice(0, 3).join(", ")}` : null,
  ].filter(Boolean);
  const uwagi = r.uwagi || [];
  tresc.replaceChildren(
    utworz("ul", { className: "fakty-raportu" }, ...fakty.map((f) => utworz("li", { textContent: f }))),
    uwagi.length
      ? utworz("ol", { className: "uwagi-raportu" }, ...uwagi.map((u) => utworz("li", { className: `waga-${u.waga === "nie działa" ? "wysoka" : u.waga === "zmienione" ? "srednia" : "niska"}` },
          utworz("div", {}, utworz("span", { className: "tag", textContent: u.waga }), " ", utworz("b", { textContent: `${u.tytul} (${u.liczba} ${odmiana(u.liczba, "strona", "strony", "stron")})` })),
          utworz("div", { className: "rada", textContent: u.rada }),
          utworz("div", { className: "strony-raportu", textContent: `Np.: ${u.strony.join(", ")}` }))))
      : utworz("p", { textContent: "Nie wykryto elementów, które przestaną działać po migracji." }),
  );
  $("okno-raportu").showModal();
}
$("formularz-ustawien").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const opis = await api(`/api/p/${projektUstawien}/ustawienia`, wyslijJson({
      nazwa: $("ust-nazwa").value, domena: $("ust-domena").value,
      formularzeEmail: $("ust-form-email").value, formularzeWebhook: $("ust-form-webhook").value,
    }));
    if (opis.domena && opis.domena.stan !== "aktywna") {
      // Domena zapisana, ale jeszcze nie działa — zostawiamy okno otwarte z instrukcją, co ustawić w DNS.
      pokazStanDomeny(opis.domena);
      tost("Zapisano. Domena zacznie działać, gdy DNS wskaże na serwer.");
      return;
    }
    $("okno-ustawien").close();
    tost("Zapisano ustawienia projektu.");
    await wczytajProjekty(projekt);
    odswiezStatus();
  } catch (blad) { tost(blad.message, true); }
});

$("ust-usun").addEventListener("click", async () => {
  const id = projektUstawien;
  try {
    await api(`/api/p/${id}/usun`, wyslijJson({ potwierdzenie: $("ust-usun-potwierdzenie").value.trim() }));
    $("okno-ustawien").close();
    localStorage.removeItem(`edytor-czat-${id}`);
    tost(`Projekt „${id}” przeniesiono do kosza.`);
    await wczytajProjekty();
    await przelaczProjekt(projekt);
  } catch (blad) { tost(blad.message, true); }
});

// ---------- wiadomości z formularzy ----------

$("formularze-przycisk").addEventListener("click", async () => {
  const projektListy = projekt;
  const lista = $("lista-zgloszen");
  lista.replaceChildren(utworz("li", { className: "pusto", textContent: "Wczytuję…" }));
  $("zgloszenia-csv").href = `/api/p/${projektListy}/formularze?format=csv`;
  $("okno-formularzy").showModal();
  try {
    const { zgloszenia } = await apiProjektu("formularze");
    if (projektListy !== projekt) return;
    if (!zgloszenia.length) return lista.replaceChildren(utworz("li", { className: "pusto", textContent: "Brak wiadomości. Pojawią się tu, gdy ktoś wyśle formularz na opublikowanej stronie." }));
    lista.replaceChildren(...zgloszenia.map((z) => {
      const pola = utworz("dl", {}, ...Object.entries(z.pola).flatMap(([k, v]) => [utworz("dt", { textContent: k }), utworz("dd", { textContent: v })]));
      const naglowek = utworz("div", { className: "naglowek-zgloszenia" },
        utworz("span", { textContent: `${new Date(z.kiedy).toLocaleString("pl-PL")}${z.temat ? ` · ${z.temat}` : ""}` }),
        utworz("span", { textContent: z.strona || "" }));
      const statusy = Object.entries(z.powiadomienie || {}).map(([kanal, wynik]) => `${kanal}: ${wynik}`).join(" · ");
      const status = statusy ? utworz("div", { className: `status${/błąd/.test(statusy) ? " blad" : ""}`, textContent: statusy }) : null;
      // Usunięcie na żądanie osoby, która wysłała formularz (RODO) — dwuklik jak przy plikach.
      const usun = ja.mozliwosci.usuwanieZgloszen ? utworz("button", { className: "ikona", type: "button", textContent: "×", title: "Usuń to zgłoszenie" }) : null;
      usun?.addEventListener("click", async () => {
        if (!confirmWOknie(usun, "Usunąć to zgłoszenie na stałe?")) return;
        try { await api(`/api/p/${projektListy}/usun-zgloszenie`, wyslijJson({ id: z.id })); usun.closest("li").remove(); tost("Usunięto zgłoszenie."); } catch (e) { tost(e.message, true); }
      });
      naglowek.append(usun ?? "");
      return utworz("li", {}, naglowek, pola, status);
    }));
  } catch (e) {
    lista.replaceChildren(utworz("li", { className: "pusto", textContent: e.message }));
  }
});

// ---------- nowy projekt ----------

function otworzNowyProjekt() {
  $("formularz-nowego").reset();
  $("nowy-blad").hidden = true;
  $("nowy-postep").hidden = true;
  $("nowy-url-pole").hidden = true;
  $("nowy-url").required = false;
  delete $("nowy-id").dataset.reczny;
  $("okno-nowego").showModal();
  $("nowy-nazwa").focus();
}
$("nowy-nazwa").addEventListener("input", () => {
  if ($("nowy-id").dataset.reczny) return;
  $("nowy-id").value = bezpiecznaNazwa(`${$("nowy-nazwa").value}.x`).replace(/\.x$/, "").replace(/_/g, "-").slice(0, 40).replace(/-+$/, "");
});
$("nowy-id").addEventListener("input", () => { $("nowy-id").dataset.reczny = "1"; });
$("formularz-nowego").addEventListener("change", (e) => {
  if (e.target.name !== "zrodlo") return;
  $("nowy-url-pole").hidden = e.target.value !== "url";
  $("nowy-url").required = e.target.value === "url";
  if (e.target.value === "url") $("nowy-url").focus();
  if (e.target.value === "zip") $("nowy-zip").click();
});
$("nowy-zip").addEventListener("change", () => {
  const plik = $("nowy-zip").files[0];
  document.querySelector('input[name=zrodlo][value=zip]').parentElement.lastChild.textContent = plik ? ` Import z archiwum: ${plik.name}` : " Import z archiwum ZIP";
});
$("formularz-nowego").addEventListener("submit", async (e) => {
  e.preventDefault();
  const zrodlo = document.querySelector("input[name=zrodlo]:checked").value;
  const parametry = new URLSearchParams({ id: $("nowy-id").value, nazwa: $("nowy-nazwa").value });
  let opcje = { method: "POST" };
  if (zrodlo === "zip") {
    const plik = $("nowy-zip").files[0];
    if (!plik) { $("nowy-zip").click(); return; }
    opcje = { method: "POST", headers: { "Content-Type": "application/zip" }, body: plik };
  } else {
    parametry.set("szablon", zrodlo);
  }
  $("nowy-utworz").disabled = true;
  $("nowy-blad").hidden = true;
  if (zrodlo === "url") {
    parametry.set("url", $("nowy-url").value.trim());
    try { await importujZAdresu(parametry); } finally { $("nowy-utworz").disabled = false; }
    return;
  }
  try {
    const nowy = await api(`/api/projekty?${parametry}`, opcje);
    $("okno-nowego").close();
    await wczytajProjekty(nowy.id);
    await przelaczProjekt(nowy.id);
    tost(`Utworzono projekt „${nowy.nazwa}”.`);
    if (nowy.pominiete?.length) tost(`Pominięto ${nowy.pominiete.length} plików spoza strony (ukryte lub nieobsługiwane typy), np. ${nowy.pominiete.slice(0, 3).join(", ")}.`);
  } catch (blad) {
    $("nowy-blad").textContent = blad.message;
    $("nowy-blad").hidden = false;
  } finally {
    $("nowy-utworz").disabled = false;
  }
});

// Import z adresu: serwer pobiera stronę i odsyła postęp strumieniem SSE (jak praca asystenta).
async function importujZAdresu(parametry) {
  const postep = $("nowy-postep");
  postep.hidden = false;
  postep.textContent = "Łączę się ze stroną…";
  const pokazBlad = (tekst) => { postep.hidden = true; $("nowy-blad").textContent = tekst; $("nowy-blad").hidden = false; };
  const odp = await fetch(`/api/projekty/import-url?${parametry}`, { method: "POST" });
  if (odp.status === 401) return location.reload();
  if (!odp.ok) return pokazBlad((await odp.json().catch(() => ({}))).blad || `Błąd ${odp.status}`);
  const czytnik = odp.body.pipeThrough(new TextDecoderStream()).getReader();
  let bufor = "";
  let wynik = null;
  for (;;) {
    const { value, done } = await czytnik.read();
    if (done) break;
    bufor += value;
    const zdarzenia = bufor.split("\n\n");
    bufor = zdarzenia.pop();
    for (const surowe of zdarzenia) {
      if (!surowe.startsWith("data: ")) continue;
      const z = JSON.parse(surowe.slice(6));
      if (z.typ === "postep") postep.textContent = `Pobrano ${z.strony} stron i ${z.pliki} plików (${rozmiar(z.bajty)}), w kolejce: ${z.kolejka}…`;
      if (z.typ === "blad") return pokazBlad(z.tekst);
      if (z.typ === "koniec") wynik = z;
    }
  }
  if (!wynik) return pokazBlad("Połączenie urwało się w trakcie importu. Sprawdź listę projektów albo spróbuj ponownie.");
  $("okno-nowego").close();
  await wczytajProjekty(wynik.projekt.id);
  await przelaczProjekt(wynik.projekt.id);
  tost(`Zaimportowano „${wynik.projekt.nazwa}”: ${wynik.strony} stron, ${wynik.pliki} plików${wynik.formularze ? `, przerobione formularze: ${wynik.formularze}` : ""}.`);
  if (wynik.bledy.length) tost(`Nie udało się pobrać ${wynik.bledy.length} adresów, np. ${wynik.bledy[0]}`, true);
  if (wynik.pominiete) tost(`Pominięto ${wynik.pominiete} adresów (limit, inna domena albo nieobsługiwany typ pliku).`);
  if (wynik.uwagi?.length) apiProjektu("raport-importu").then(pokazRaport, () => {});
}

// ---------- integracje ----------

$("integracje-przycisk").addEventListener("click", async () => {
  const lista = $("lista-integracji");
  lista.replaceChildren(utworz("p", { className: "pusto", textContent: "Wczytuję…" }));
  $("okno-integracji").showModal();
  try { pokazIntegracje(projekt, await apiProjektu("integracje")); } catch (e) { lista.replaceChildren(utworz("p", { className: "pusto", textContent: e.message })); }
});

function pokazIntegracje(projektListy, { katalog, ustawienia }) {
  const kategorie = [...new Set(katalog.map((i) => i.kategoria))];
  $("lista-integracji").replaceChildren(...kategorie.map((kat) => utworz("section", {},
    utworz("h3", { textContent: kat }),
    ...katalog.filter((i) => i.kategoria === kat).map((i) => kartaIntegracji(projektListy, i, ustawienia[i.id] || {})))));
}

function kartaIntegracji(projektListy, i, wartosci) {
  const wlacznik = utworz("input", { type: "checkbox", checked: Boolean(wartosci.wlaczona) });
  const pola = i.pola.map((p) => {
    const pole = p.typ === "wybor"
      ? utworz("select", { className: "wybor" }, ...Object.entries(p.opcje).map(([v, t]) => new Option(t, v, false, wartosci[p.klucz] === v)))
      : utworz(p.typ === "obszar" ? "textarea" : "input", { value: wartosci[p.klucz] || "", placeholder: p.przyklad || "", rows: 3, autocomplete: "off", spellcheck: false });
    pole.dataset.klucz = p.klucz;
    pole.disabled = Boolean(p.tylkoAdmin && !ja.mozliwosci.administrator);
    return utworz("label", {}, `${p.etykieta}${p.wymagane ? " *" : ""}`, pole);
  });
  const zapisz = utworz("button", { type: "submit", className: "przycisk maly glowny", textContent: "Zapisz" });
  const karta = utworz("form", { className: `karta-integracji${wartosci.wlaczona ? " wlaczona" : ""}` },
    utworz("label", { className: "naglowek-integracji" }, wlacznik, utworz("b", { textContent: i.nazwa })),
    utworz("p", { className: "opis-integracji", textContent: i.opis }),
    ...pola,
    utworz("div", { className: "okno-akcje" }, utworz("span", { className: "odstep" }), zapisz));
  karta.addEventListener("submit", async (e) => {
    e.preventDefault();
    zapisz.disabled = true;
    const dane = Object.fromEntries([...karta.querySelectorAll("[data-klucz]")].map((el) => [el.dataset.klucz, el.value]));
    try {
      const wynik = await api(`/api/p/${projektListy}/integracje`, wyslijJson({ id: i.id, wlaczona: wlacznik.checked, wartosci: dane }));
      tost(`${i.nazwa}: ${wlacznik.checked ? "włączono" : "wyłączono"}. Strona opublikowana na nowo.`);
      if (projektListy === projekt) { pokazIntegracje(projektListy, wynik); zaladujPodglad(); }
    } catch (blad) { tost(blad.message, true); zapisz.disabled = false; }
  });
  return karta;
}

// ---------- konto i konta użytkowników ----------

const NAZWY_ROL = { administrator: "Administrator", redaktor: "Redaktor", klient: "Klient" };

// Ukrywa to, czego rola nie może zrobić (serwer i tak sprawdza każde zapytanie).
function zastosujUprawnienia() {
  const m = ja.mozliwosci;
  $("konto-nazwa").textContent = ja.nazwa;
  $("opublikuj").hidden = !m.publikacja;
  $("ustawienia-przycisk").hidden = !m.ustawienia;
  $("integracje-przycisk").hidden = !m.integracje;
  $("strefa-wgrywania").hidden = !m.pliki;
  $("zuzycie").hidden = !m.administrator;
  document.querySelector(".tryb-globalny").hidden = !m.zadaniaGlobalne;
}

$("konto-przycisk").addEventListener("click", () => {
  $("konto-opis").textContent = `${ja.nazwa} (${ja.login}) · ${NAZWY_ROL[ja.rola]}${ja.glowne ? " · konto główne z pliku .env" : ""}`;
  $("formularz-hasla").hidden = !ja.mozliwosci.zmianaHasla;
  $("formularz-hasla").reset();
  $("konta-przycisk").hidden = !ja.mozliwosci.administrator;
  $("okno-konta").showModal();
});

$("formularz-hasla").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/konto/haslo", wyslijJson({ stare: $("haslo-stare").value, nowe: $("haslo-nowe").value }));
    $("okno-konta").close();
    tost("Zmieniono hasło. Inne zalogowane przeglądarki zostały wylogowane.");
  } catch (blad) { tost(blad.message, true); }
});

$("konta-przycisk").addEventListener("click", () => { $("okno-konta").close(); otworzKonta(); });

let edytowaneKonto = null;
async function otworzKonta() {
  const { konta, projekty } = await api("/api/uzytkownicy");
  $("lista-kont").replaceChildren(...konta.map((k) => {
    const opis = utworz("div", { className: "opis" },
      utworz("b", { textContent: `${k.nazwa} (${k.login})` }),
      utworz("small", { textContent: `${NAZWY_ROL[k.rola]} · ${k.projekty === "*" ? "wszystkie projekty" : k.projekty.length ? k.projekty.join(", ") : "brak projektów"}${k.glowne ? " · konto główne (.env)" : ""}` }));
    if (k.glowne) return utworz("li", {}, opis);
    const edytuj = utworz("button", { className: "przycisk maly", type: "button", textContent: "Edytuj" });
    edytuj.addEventListener("click", () => formularzKonta(projekty, k));
    const haslo = utworz("button", { className: "przycisk maly", type: "button", textContent: "Nowe hasło" });
    haslo.addEventListener("click", async () => {
      try { pokazNoweHaslo(k.login, (await api("/api/uzytkownicy/haslo", wyslijJson({ login: k.login }))).haslo); } catch (e) { tost(e.message, true); }
    });
    const usun = utworz("button", { className: "ikona", type: "button", textContent: "×", title: "Usuń konto" });
    usun.addEventListener("click", async () => {
      if (!confirmWOknie(usun, `Usunąć konto ${k.login}?`)) return;
      try { await api("/api/uzytkownicy/usun", wyslijJson({ login: k.login })); tost(`Usunięto konto ${k.login}.`); otworzKonta(); } catch (e) { tost(e.message, true); }
    });
    return utworz("li", {}, opis, edytuj, haslo, usun);
  }));
  formularzKonta(projekty, null);
  if (!$("okno-kont").open) $("okno-kont").showModal();
}

function formularzKonta(projekty, k) {
  edytowaneKonto = k;
  $("formularz-konta").reset();
  $("k-haslo").hidden = true;
  $("konto-tryb").textContent = k ? `Edycja konta ${k.login}` : "Nowe konto";
  $("k-zapisz").textContent = k ? "Zapisz zmiany" : "Utwórz konto";
  $("k-anuluj").hidden = !k;
  $("k-login").value = k?.login || "";
  $("k-login").readOnly = Boolean(k);
  $("k-nazwa").value = k?.nazwa || "";
  $("k-rola").value = k?.rola || "redaktor";
  const wybrane = new Set(Array.isArray(k?.projekty) ? k.projekty : []);
  $("k-projekty").replaceChildren(utworz("legend", { textContent: "Projekty" }), ...projekty.map((p) =>
    utworz("label", {}, utworz("input", { type: "checkbox", value: p.id, checked: wybrane.has(p.id) }), ` ${p.nazwa}`)));
  $("k-projekty").hidden = $("k-rola").value === "administrator";
}
$("k-rola").addEventListener("change", () => { $("k-projekty").hidden = $("k-rola").value === "administrator"; });
$("k-anuluj").addEventListener("click", () => otworzKonta());

// Hasło startowe pokazujemy raz — serwer przechowuje tylko jego skrót.
function pokazNoweHaslo(login, haslo) {
  $("k-haslo").hidden = false;
  $("k-haslo").replaceChildren(`Hasło dla ${login} (pokazywane tylko teraz — przekaż je bezpiecznie, np. osobnym kanałem): `, utworz("code", { textContent: haslo }));
}

$("formularz-konta").addEventListener("submit", async (e) => {
  e.preventDefault();
  const dane = {
    nowe: !edytowaneKonto, login: $("k-login").value, nazwa: $("k-nazwa").value, rola: $("k-rola").value,
    projekty: [...$("k-projekty").querySelectorAll("input:checked")].map((c) => c.value),
  };
  try {
    const wynik = await api("/api/uzytkownicy", wyslijJson(dane));
    await otworzKonta();
    tost(dane.nowe ? `Utworzono konto ${wynik.konto.login}.` : "Zapisano konto.");
    if (wynik.haslo) pokazNoweHaslo(wynik.konto.login, wynik.haslo);
  } catch (blad) { tost(blad.message, true); }
});

// ---------- start ----------

(async () => {
  ja = await api("/api/ja");
  zastosujUprawnienia();
  await wczytajProjekty();
  if (!projekt) {
    wiadomosci.replaceChildren(utworz("p", { className: "pusto", textContent: "Nie masz jeszcze dostępu do żadnego projektu. Poproś administratora o przypisanie projektu do Twojego konta." }));
    return;
  }
  await przelaczProjekt(projekt);
})().catch((e) => tost(`Nie udało się wczytać panelu: ${e.message}`, true));
