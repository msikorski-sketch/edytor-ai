// Skrypt zaznaczania wstrzykiwany do podglądu (osobny origin). Z panelem rozmawia tylko przez postMessage:
// panel → podgląd: { typ: "tryb" | "rodzic" | "odznacz" | "przewin" }, podgląd → panel: { typ: "gotowy" | "zaznaczono" | "klawisz" | "przewiniecie" }.
(() => {
  const PANEL = document.currentScript.dataset.panel;
  if (window.parent === window) return;
  const doPanelu = (wiadomosc) => window.parent.postMessage({ edytor: true, ...wiadomosc }, PANEL);

  let tryb = false;
  let najechany = null;
  let zaznaczony = null;

  const styl = document.createElement("style");
  styl.textContent = `
    .edytor-najechany { outline: 2px solid #4f46e5 !important; outline-offset: 2px; cursor: crosshair !important; }
    .edytor-zaznaczony { outline: 3px solid #f59e0b !important; outline-offset: 2px; }
    #edytor-etykieta { position: absolute; z-index: 2147483647; pointer-events: none; font: 600 11px/1 ui-monospace, Menlo, monospace;
      background: #4f46e5; color: #fff; padding: 4px 6px; border-radius: 4px; white-space: nowrap; display: none; }`;
  document.head.append(styl);
  const etykieta = document.createElement("div");
  etykieta.id = "edytor-etykieta";
  document.body.append(etykieta);

  // Elementy dodawane przez integracje (baner zgód, przycisk kontaktu) nie leżą w plikach strony — nie da się ich zaznaczyć.
  const pomocnicze = (el) => el === etykieta || el === styl || Boolean(el.closest?.("[data-edytor-integracja]"));
  function tag(el) {
    const klasa = [...el.classList].find((k) => !k.startsWith("edytor-"));
    return el.tagName.toLowerCase() + (klasa ? `.${klasa}` : "");
  }

  // Krótki selektor: id, jeśli jest; inaczej ścieżka tag.klasa:nth-of-type od najbliższego przodka z id.
  function selektor(el) {
    const czesci = [];
    while (el && el.nodeType === 1 && el.tagName !== "HTML") {
      if (el.id) { czesci.unshift(`#${CSS.escape(el.id)}`); break; }
      let czesc = el.tagName.toLowerCase();
      const klasy = [...el.classList].filter((k) => !k.startsWith("edytor-")).slice(0, 2);
      if (klasy.length) czesc += "." + klasy.map((k) => CSS.escape(k)).join(".");
      const rodzenstwo = el.parentElement ? [...el.parentElement.children].filter((r) => r.tagName === el.tagName && !pomocnicze(r)) : [];
      if (rodzenstwo.length > 1) czesc += `:nth-of-type(${rodzenstwo.indexOf(el) + 1})`;
      czesci.unshift(czesc);
      el = el.parentElement;
    }
    return czesci.join(" > ");
  }

  function schowajNajechanie() {
    najechany?.classList.remove("edytor-najechany");
    najechany = null;
    etykieta.style.display = "none";
  }

  function zaznacz(el) {
    if (!el || pomocnicze(el) || el === document.body || el === document.documentElement) return;
    zaznaczony?.classList.remove("edytor-zaznaczony");
    schowajNajechanie();
    // HTML bierzemy z kopii bez naszych klas pomocniczych.
    const kopia = el.cloneNode(true);
    for (const x of [kopia, ...kopia.querySelectorAll("*")]) {
      x.classList.remove("edytor-najechany", "edytor-zaznaczony");
      if (!x.classList.length) x.removeAttribute("class");
    }
    zaznaczony = el;
    el.classList.add("edytor-zaznaczony");
    tryb = false;
    doPanelu({ typ: "zaznaczono", element: { selektor: selektor(el), html: kopia.outerHTML.slice(0, 20000), tekst: (el.innerText || "").trim().slice(0, 2000), tag: tag(el) } });
  }

  document.addEventListener("mouseover", (e) => {
    if (!tryb || pomocnicze(e.target)) return;
    najechany?.classList.remove("edytor-najechany");
    najechany = e.target;
    najechany.classList.add("edytor-najechany");
    const r = najechany.getBoundingClientRect();
    etykieta.textContent = `${tag(najechany)}  ${Math.round(r.width)}×${Math.round(r.height)}`;
    etykieta.style.display = "block";
    etykieta.style.left = `${r.left + scrollX}px`;
    etykieta.style.top = `${Math.max(0, r.top + scrollY - 22)}px`;
  });
  document.addEventListener("click", (e) => {
    if (!tryb) return;
    e.preventDefault();
    e.stopPropagation();
    zaznacz(e.target);
  }, true);
  document.addEventListener("keydown", (e) => {
    const wPolu = ["TEXTAREA", "INPUT", "SELECT"].includes(e.target.tagName) || e.target.isContentEditable;
    if (e.key === "Escape" || (!wPolu && e.key.toLowerCase() === "s" && !e.ctrlKey && !e.metaKey)) {
      e.preventDefault();
      doPanelu({ typ: "klawisz", klawisz: e.key });
    }
  });
  let czasomierz;
  addEventListener("scroll", () => {
    clearTimeout(czasomierz);
    czasomierz = setTimeout(() => doPanelu({ typ: "przewiniecie", y: scrollY }), 150);
  });

  addEventListener("message", (e) => {
    if (e.origin !== PANEL || e.source !== window.parent || !e.data?.edytor) return;
    const { typ } = e.data;
    if (typ === "tryb") { tryb = Boolean(e.data.wlaczony); if (!tryb) schowajNajechanie(); }
    if (typ === "rodzic" && zaznaczony?.parentElement) zaznacz(zaznaczony.parentElement);
    if (typ === "odznacz") { zaznaczony?.classList.remove("edytor-zaznaczony"); zaznaczony = null; }
    if (typ === "przewin") scrollTo(0, Number(e.data.y) || 0);
  });

  doPanelu({ typ: "gotowy", sciezka: decodeURIComponent(location.pathname) });
})();
