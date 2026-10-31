// Atrapa strony WordPressa do testów importu: typowe pułapki prawdziwych stron w jednym miejscu.
import http from "node:http";

export function uruchomAtrapeWp() {
  let adres;
  // Każda strona WordPressa ma skrót ?p=ID (link rel="shortlink") — importer zamienia go na przekierowanie 301.
  const ID = { Start: 2, "O nas": 7, Kontakt: 9, Ukryta: 11 };
  const strona = (tytul, tresc) => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${tytul}</title>
<link rel="shortlink" href="${adres}/?p=${ID[tytul] ?? 99}">
<meta name="generator" content="WordPress 6.6">
<link rel="https://api.w.org/" href="${adres}/wp-json/">
<link rel="stylesheet" href="${adres}/wp-content/themes/motyw/style.css?ver=6.6">
<script src="${adres}/wp-includes/js/wp-emoji-release.min.js?ver=6.6"></script>
<script>window._wpemojiSettings = {};</script>
<script src="${adres}/wp-content/plugins/contact-form-7/includes/js/index.js"></script>
<meta property="og:image" content="${adres}/wp-content/uploads/2024/05/logo.png">
</head><body>
<nav><a href="${adres}/">Start</a> <a href="${adres}/o-nas/">O nas</a> <a href="/kontakt">Kontakt</a> <a href="${adres}/wp-admin/">Admin</a> <a href="https://facebook.com/firma">FB</a></nav>
${tresc}</body></html>`;
  const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
  const serwer = http.createServer((z, o) => {
    const u = new URL(z.url, adres);
    const html = (t) => { o.writeHead(200, { "content-type": "text/html; charset=utf-8" }); o.end(t); };
    if (u.pathname === "/") return html(strona("Start", `<h1>Firma Testowa</h1>
<img src="data:image/gif;base64,R0lGOD" data-src="${adres}/wp-content/uploads/2024/05/zespol.jpg" class="lazyload" alt="Zespół">
<img src="${adres}/wp-content/uploads/2024/05/biuro-300x200.jpg" srcset="${adres}/wp-content/uploads/2024/05/biuro-300x200.jpg 300w, ${adres}/wp-content/uploads/2024/05/biuro.jpg 1200w">
<div style="background-image:url('${adres}/wp-content/uploads/2024/05/tlo.webp')">tło</div>`));
    if (u.pathname === "/o-nas/") return html(strona("O nas", `<h1>O nas</h1><p><a href="${adres}/wp-content/uploads/cennik.pdf">Cennik PDF</a></p>
<form role="search" class="search-form" action="${adres}/"><input name="s"></form>
<script>(function(w){w.dataLayer=w.dataLayer||[];})(window);</script><script async src="https://www.googletagmanager.com/gtm.js?id=GTM-TEST"></script>`));
    if (u.pathname === "/kontakt") { o.writeHead(301, { location: `${adres}/kontakt/` }); return o.end(); }
    if (u.pathname === "/kontakt/") return html(strona("Kontakt", `<h1>Kontakt</h1>
<form action="/kontakt/#wpcf7-f12-o1" method="post" class="wpcf7-form init" novalidate>
<input type="hidden" name="_wpcf7" value="12"><input type="hidden" name="_wpcf7_unit_tag" value="x">
<input name="your-name"><input name="your-email" type="email"><textarea name="your-message"></textarea><input type="submit" value="Wyślij"></form>`));
    if (u.pathname === "/ukryta-podstrona/") return html(strona("Ukryta", "<h1>Tylko w mapie strony</h1>"));
    // Przypadki z audytu: <base href>, kolizja /x.php i /x.html, zasób .js zwracający HTML, formularz z plikiem.
    if (u.pathname === "/trudne/") return html(`<!DOCTYPE html><html><head><base href="/assets/"><link rel="stylesheet" href="styl.css"><script src="/udawany.js"></script></head>
<body><a href="/x.php">php</a> <a href="/x.html">html</a>
<form class="wpcf7-form" action="/trudne/" method="post" enctype="multipart/form-data"><input name="imie"><p><input type="file" name="cv"></p><input type="submit"></form></body></html>`);
    if (u.pathname === "/assets/styl.css") { o.writeHead(200, { "content-type": "text/css" }); return o.end("body{color:red}"); }
    if (u.pathname === "/udawany.js") return html("<html><body>strona błędu zamiast skryptu</body></html>");
    if (u.pathname === "/x.php") return html("<h1>Strona PHP</h1>");
    if (u.pathname === "/x.html") return html("<h1>Strona HTML</h1>");
    // Formularz Breakdance odwzorowany z prawdziwej strony na Breakdance (30.10.2026): data-options z redirectUrl, pola fields[…],
    // obsługa podpinana skryptem inline breakdanceForm.init, która przechwytuje wysyłkę (preventDefault + AJAX).
    if (u.pathname === "/kontakt-bd/") {
      const opcje = { slug: "custom", name: "Contact Form", ajaxUrl: `${adres}/wp-admin/admin-ajax.php`, redirect: true, redirectUrl: `${adres}/dziekuje/`, successMessage: "Dzięki, odezwiemy się!", honeypot_enabled: true };
      return html(`<!DOCTYPE html><html><head><meta charset="utf-8"><script src="${adres}/wp-content/plugins/breakdance/plugin/global-scripts/breakdance-form.js"></script></head><body class="breakdance">
<div class="bde-form-builder-1-2"><form id="contact-form" class="breakdance-form breakdance-form--vertical " data-options="${JSON.stringify(opcje).replace(/"/g, "&quot;")}" data-steps="0">
<div class="breakdance-form-field"><label for="name">Nazwa firmy</label><input class="breakdance-form-field__input" id="name" type="text" name="fields[name]" required></div>
<div class="breakdance-form-field"><input id="email" type="email" name="fields[email]"></div>
<div class="breakdance-form-field"><textarea name="fields[message]"></textarea></div>
<input type="hidden" name="form_id" value="325"><input type="hidden" name="post_id" value="13">
<button type="submit">Wyślij</button></form></div>
<a href="${adres}/dziekuje/">dzięki</a>
<script>document.addEventListener('DOMContentLoaded', function(){ breakdanceForm.init('.breakdance .bde-form-builder-1-2 .breakdance-form') })</script>
</body></html>`);
    }
    if (u.pathname === "/wp-content/plugins/breakdance/plugin/global-scripts/breakdance-form.js") {
      o.writeHead(200, { "content-type": "text/javascript" });
      return o.end(`window.breakdanceForm = { init: function (sel) { document.querySelectorAll(sel).forEach(function (f) {
        f.addEventListener("submit", function (e) { e.preventDefault(); document.title = "BREAKDANCE PRZECHWYCIŁ"; }); }); } };`);
    }
    if (u.pathname === "/dziekuje/") return html("<h1>Dziękujemy za wiadomość</h1>");
    if (u.pathname === "/wolna/") { setTimeout(() => html("<h1>wolno</h1>"), 2000); return; }
    if (u.pathname === "/z-wolna/") return html('<h1>Start</h1><a href="/wolna/">wolna podstrona</a>');
    if (u.pathname === "/wp-sitemap.xml") { o.writeHead(200, { "content-type": "application/xml" }); return o.end(`<?xml version="1.0"?><sitemapindex><sitemap><loc>${adres}/wp-sitemap-posts-page-1.xml</loc></sitemap></sitemapindex>`); }
    if (u.pathname === "/wp-sitemap-posts-page-1.xml") { o.writeHead(200, { "content-type": "application/xml" }); return o.end(`<?xml version="1.0"?><urlset><url><loc>${adres}/ukryta-podstrona/</loc></url><url><loc>${adres}/o-nas/</loc></url></urlset>`); }
    if (u.pathname === "/wp-content/themes/motyw/style.css") { o.writeHead(200, { "content-type": "text/css" }); return o.end(`@import url("fonts.css");\nbody{background:url(../../uploads/2024/05/wzor.png)}\n.ikona{background:url("data:image/png;base64,AAAA")}`); }
    if (u.pathname === "/wp-content/themes/motyw/fonts.css") { o.writeHead(200, { "content-type": "text/css" }); return o.end(`@font-face{font-family:F;src:url(fonts/f.woff2) format("woff2")}`); }
    if (u.pathname.startsWith("/wp-content/") || u.pathname.startsWith("/wp-includes/")) {
      const typy = { ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2", ".pdf": "application/pdf", ".js": "text/javascript" };
      const typ = typy[u.pathname.slice(u.pathname.lastIndexOf("."))] || "application/octet-stream";
      o.writeHead(200, { "content-type": typ }); return o.end(PNG);
    }
    if (u.pathname === "/wp-admin/") { o.writeHead(500); return o.end("NIE POWINNO BYĆ POBRANE"); }
    o.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    o.end(`<!DOCTYPE html><html><head><title>Nie znaleziono</title><link rel="stylesheet" href="${adres}/wp-content/themes/motyw/style.css"></head><body><h1>Strona nie istnieje (404 motywu)</h1><a href="${adres}/">Wróć na start</a></body></html>`);
  });
  return new Promise((ok) => serwer.listen(0, "127.0.0.1", () => { adres = `http://127.0.0.1:${serwer.address().port}`; ok({ adres, zamknij: () => serwer.close() }); }));
}
