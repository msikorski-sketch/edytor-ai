// Ochrona przed SSRF — ten plik działa BEZ EDYTOR_SIEC_LOKALNA, więc sprawdza prawdziwe zachowanie produkcyjne.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { pobierz, adresPrywatny } from "../siec.mjs";

test("adresy prywatne są rozpoznawane", () => {
  for (const ip of ["127.0.0.1", "10.0.0.5", "172.17.0.2", "192.168.0.1", "169.254.169.254", "100.64.0.1", "::1", "fd12::1", "fe80::1", "febf::1",
    "::ffff:10.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "64:ff9b::7f00:1", "::", "0.0.0.0"]) assert.ok(adresPrywatny(ip), ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) assert.ok(!adresPrywatny(ip), ip);
});

test("pobieranie odmawia adresów lokalnych, także po DNS i po przekierowaniu", async () => {
  // Lokalny serwer udający „usługę wewnętrzną” — nie może zostać odpytany.
  let odpytany = false;
  const wewnetrzny = http.createServer((z, o) => { odpytany = true; o.end("tajne"); });
  await new Promise((ok) => wewnetrzny.listen(0, "::", ok)); // nasłuch na IPv4 i IPv6
  const port = wewnetrzny.address().port;
  for (const adres of [`http://127.0.0.1:${port}/`, `http://localhost:${port}/`, `http://[::1]:${port}/`, `http://[::ffff:127.0.0.1]:${port}/`,
    `http://[::ffff:7f00:1]:${port}/`, `http://0x7f.1:${port}/`, `http://2130706433:${port}/`, `http://0:${port}/`, "file:///etc/passwd", "ftp://example.com/"]) {
    await assert.rejects(pobierz(adres), /prywatn|http i https/, adres);
  }
  await assert.rejects(pobierz(`http://127.0.0.1.nip.io:${port}/`), /prywatn|domeny/); // DNS → 127.0.0.1
  assert.equal(odpytany, false);
  wewnetrzny.close();
});
