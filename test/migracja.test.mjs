// Migracja ze starego układu (jedna strona) na projekty — także wznowienie po przerwaniu.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { przeniesStaryUklad } from "../projekty.mjs";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

async function staryUklad() {
  const dane = await fs.mkdtemp(path.join(os.tmpdir(), "migracja-"));
  const strona = path.join(dane, "strona");
  await fs.mkdir(strona);
  await fs.writeFile(path.join(strona, "index.html"), "x");
  execFileSync("sh", ["-c", "git init -q -b main && git add -A && git commit -qm s"], { cwd: strona, env: ENV });
  await fs.mkdir(path.join(dane, "wydania/w1"), { recursive: true });
  await fs.writeFile(path.join(dane, "wydania/w1/index.html"), "OPUBLIKOWANA");
  await fs.symlink("wydania/w1", path.join(dane, "produkcja"));
  await fs.writeFile(path.join(dane, "stan.json"), JSON.stringify({ opublikowano: "abc1234" }));
  return dane;
}

test("pełna migracja przenosi stronę, wydanie i ustawienia", async () => {
  const dane = await staryUklad();
  await fs.mkdir(path.join(dane, "projekty"));
  assert.equal(await przeniesStaryUklad(dane, { id: "glina", nazwa: "Glina", domena: "glina.test" }), true);
  const projekt = path.join(dane, "projekty/glina");
  assert.equal(await fs.readFile(path.join(projekt, "produkcja/index.html"), "utf8"), "OPUBLIKOWANA");
  const stan = JSON.parse(await fs.readFile(path.join(projekt, "stan.json"), "utf8"));
  assert.equal(stan.domena, "glina.test");
  assert.equal(stan.opublikowano, "abc1234");
  assert.equal(await przeniesStaryUklad(dane, { id: "glina", nazwa: "Glina" }), false, "druga migracja nic nie robi");
  await fs.rm(dane, { recursive: true, force: true });
});

test("przerwana migracja (strona przeniesiona, reszta nie) zostaje dokończona", async () => {
  const dane = await staryUklad();
  const etap = path.join(dane, "projekty/.migracja-glina");
  await fs.mkdir(etap, { recursive: true });
  await fs.rename(path.join(dane, "strona"), path.join(etap, "strona")); // symulacja przerwania po pierwszym kroku
  assert.equal(await przeniesStaryUklad(dane, { id: "glina", nazwa: "Glina", domena: "glina.test" }), true);
  const projekt = path.join(dane, "projekty/glina");
  assert.equal(await fs.readFile(path.join(projekt, "produkcja/index.html"), "utf8"), "OPUBLIKOWANA");
  assert.equal(JSON.parse(await fs.readFile(path.join(projekt, "stan.json"), "utf8")).domena, "glina.test");
  await fs.rm(dane, { recursive: true, force: true });
});
