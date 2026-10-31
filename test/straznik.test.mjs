// Testy strażnika agenta: które wywołania narzędzi wolno wykonać w katalogu strony.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { powodOdmowy, komunikatBledu } from "../agent.mjs";

let strona;

before(async () => {
  strona = await fs.mkdtemp(path.join(os.tmpdir(), "straznik-"));
  await fs.mkdir(path.join(strona, ".git"));
  await fs.writeFile(path.join(strona, "index.html"), "x");
  await fs.symlink("/etc", path.join(strona, "dowiazanie"));
});
after(() => fs.rm(strona, { recursive: true, force: true }));

const dozwolone = [
  ["Read", { file_path: "index.html" }],
  ["Read", { file_path: "STRONA/index.html" }],
  ["Write", { file_path: "nowy/plik.css" }],
  ["Edit", { file_path: "index.html" }],
  ["Glob", { pattern: "**/*.css" }],
  ["Grep", { pattern: "x" }],
  ["Grep", { pattern: "x", glob: "*.html" }],
];
const zabronione = [
  ["Read", { file_path: ".git/config" }],
  ["Read", { file_path: "STRONA/.git/HEAD" }],
  ["Read", { file_path: "../stan.json" }],
  ["Read", { file_path: "/etc/passwd" }],
  ["Read", { file_path: "dowiazanie/passwd" }],
  ["Edit", { file_path: "a/../../x" }],
  ["Glob", { pattern: "../../claude/**" }],
  ["Glob", { pattern: "/etc/*" }],
  ["Glob", { pattern: "**/*", path: ".git" }],
  ["Grep", { pattern: "x", glob: "../*.json" }],
  ["Grep", { pattern: "x", path: "/" }],
  ["Bash", { command: "ls" }],
  ["WebFetch", { url: "https://example.com" }],
];

for (const [narzedzie, wejscie] of dozwolone) {
  test(`dozwolone: ${narzedzie} ${JSON.stringify(wejscie)}`, () => {
    const w = JSON.parse(JSON.stringify(wejscie).replace("STRONA", strona));
    assert.equal(powodOdmowy(strona, narzedzie, w), null);
  });
}
for (const [narzedzie, wejscie] of zabronione) {
  test(`zabronione: ${narzedzie} ${JSON.stringify(wejscie)}`, () => {
    const w = JSON.parse(JSON.stringify(wejscie).replace("STRONA", strona));
    assert.ok(powodOdmowy(strona, narzedzie, w));
  });
}

test("komunikaty błędów API są zrozumiałe", () => {
  assert.match(komunikatBledu("Claude Code returned an error result: Not logged in · Please run /login"), /klucz/);
  assert.match(komunikatBledu("429 Too Many Requests: rate limit exceeded"), /limit/);
  assert.match(komunikatBledu("No endpoints found for model x"), /model/i);
  // Format prawdziwego OpenRoutera dla złej nazwy modelu (sprawdzony 30.10.2026):
  assert.match(komunikatBledu("API Error: 400 nie-ma/takiego-modelu:free is not a valid model ID"), /Wybrany model nie istnieje/);
});
