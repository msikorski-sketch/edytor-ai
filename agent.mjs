// Uruchamia Claude'a (Agent SDK) na katalogu strony i przekazuje zdarzenia do przeglądarki.
import fs from "node:fs";
import path from "node:path";
import { createSdkMcpServer, getSessionInfo, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { ZRZUTY_DOSTEPNE, zrobZrzut } from "./zrzuty.mjs";

const MODEL = process.env.EDYTOR_MODEL || "claude-opus-5-5";
// Używany automatycznie, gdy główny model jest przeciążony albo niedostępny.
const MODEL_ZAPASOWY = process.env.EDYTOR_MODEL_ZAPASOWY || undefined;

// Cennik Claude (USD za 1 mln tokenów, claude.com/pricing, sprawdzony 30.10.2026) — do szacowania,
// ile polecenie kosztowałoby na każdym modelu, także gdy faktycznie działa darmowy model z OpenRoutera.
const CENNIK = {
  "claude-haiku-5-5": { wejscie: 0.10, zapisCache: 0.125, odczytCache: 0.01, wyjscie: 0.50 },
  "claude-sonnet-5-5": { wejscie: 2, zapisCache: 2.5, odczytCache: 0.10, wyjscie: 10 },
  "claude-opus-5-5": { wejscie: 4, zapisCache: 5, odczytCache: 0.20, wyjscie: 20 },
};

// Sumuje tokeny ze wszystkich modeli użytych w poleceniu i szacuje koszt na każdym modelu Claude.
export function policzZuzycie(wynik) {
  const tokeny = { wejscie: 0, wyjscie: 0, odczytCache: 0, zapisCache: 0 };
  for (const u of Object.values(wynik.modelUsage || {})) {
    tokeny.wejscie += u.inputTokens || 0;
    tokeny.wyjscie += u.outputTokens || 0;
    tokeny.odczytCache += u.cacheReadInputTokens || 0;
    tokeny.zapisCache += u.cacheCreationInputTokens || 0;
  }
  const szacunek = Object.fromEntries(Object.entries(CENNIK).map(([model, c]) => [model,
    Number(((tokeny.wejscie * c.wejscie + tokeny.zapisCache * c.zapisCache + tokeny.odczytCache * c.odczytCache + tokeny.wyjscie * c.wyjscie) / 1e6).toFixed(4))]));
  return { model: MODEL, modele: Object.keys(wynik.modelUsage || {}), tury: wynik.num_turns || 0, tokeny, szacunekUsd: szacunek };
}

// Kody błędów API zamieniamy na komunikaty, z którymi użytkownik wie, co zrobić.
const KOMUNIKATY = {
  rate_limit: "Przekroczony limit zapytań modelu. Darmowe modele mają limit na minutę i na dzień: spróbuj ponownie za minutę, a jeśli to nie pomoże — jutro albo zmień model w ustawieniach serwera.",
  overloaded: "Model jest przeciążony. Spróbuj ponownie za minutę.",
  authentication_failed: "Serwer nie może zalogować się do API modelu (brak lub zły klucz). Sprawdź klucz w pliku .env na serwerze.",
  billing_error: "Problem z płatnościami na koncie API modelu.",
  model_not_found: "Wybrany model nie istnieje albo przestał być dostępny. Zmień EDYTOR_MODEL w pliku .env.",
  server_error: "Błąd po stronie dostawcy modelu. Spróbuj ponownie.",
  max_output_tokens: "Odpowiedź modelu była za długa i została ucięta. Podziel polecenie na mniejsze.",
};

export function komunikatBledu(tekst) {
  const t = String(tekst || "");
  if (/not logged in|invalid api key|401/i.test(t)) return KOMUNIKATY.authentication_failed;
  if (/rate.?limit|429|quota/i.test(t)) return KOMUNIKATY.rate_limit;
  if (/overloaded|529|503/i.test(t)) return KOMUNIKATY.overloaded;
  if (/model.*(not found|does not exist|invalid)|no endpoints found|not a valid model|issue with the selected model/i.test(t)) return KOMUNIKATY.model_not_found;
  return t.replace(/^Claude Code returned an error result:\s*/, "");
}

// Agent dostaje tylko narzędzia plikowe — bez Bash, WebFetch itp. — oraz własne narzędzie zrzutu ekranu.
const NARZEDZIA = ["Read", "Edit", "Write", "Glob", "Grep"];
const ZRZUT = "mcp__podglad__zrzut_strony";
const DOZWOLONE = ZRZUTY_DOSTEPNE ? [...NARZEDZIA, ZRZUT] : NARZEDZIA;
const LIMIT_ZRZUTOW = 4;

// Narzędzie zrzutu ekranu jako serwer MCP w tym samym procesie. Ścieżkę sprawdza zrobZrzut (tylko .html w katalogu strony).
function serwerZrzutow(katalog, wyslij) {
  let wykonane = 0;
  return createSdkMcpServer({
    name: "podglad",
    version: "1.0.0",
    tools: [
      tool(
        "zrzut_strony",
        "Robi zrzut ekranu podstrony w obecnym stanie plików, żeby sprawdzić, jak zmiana wygląda. " +
          "urzadzenie: 'komputer' (1280 px) albo 'telefon' (390 px). selektor (opcjonalny) zawęża zrzut do jednego elementu.",
        {
          plik: z.string().default("index.html").describe("Podstrona, np. index.html"),
          urzadzenie: z.enum(["komputer", "telefon"]).default("komputer"),
          selektor: z.string().optional().describe("Selektor CSS elementu do pokazania"),
        },
        async (argumenty) => {
          if (++wykonane > LIMIT_ZRZUTOW) {
            return { content: [{ type: "text", text: `Limit ${LIMIT_ZRZUTOW} zrzutów na polecenie wyczerpany. Zakończ pracę.` }], isError: true };
          }
          try {
            const dane = await zrobZrzut(katalog, argumenty);
            wyslij({ typ: "zrzut", dane, opis: `${argumenty.plik} · ${argumenty.urzadzenie}` });
            return { content: [{ type: "image", data: dane, mimeType: "image/jpeg" }] };
          } catch (e) {
            return { content: [{ type: "text", text: `Nie udało się zrobić zrzutu: ${e.message}` }], isError: true };
          }
        },
      ),
    ],
  });
}

const INSTRUKCJE_ZRZUTY = "- Po zmianie wyglądu sprawdź efekt narzędziem zrzut_strony (zwykle komputer, a przy zmianach układu także telefon). Jeśli coś jest nieczytelne, nachodzi na siebie albo wygląda inaczej, niż prosił użytkownik — popraw i sprawdź ponownie. Masz najwyżej 4 zrzuty na polecenie.";
const INSTRUKCJE = `
Pracujesz jako edytor statycznej strony WWW (HTML + CSS + JS, bez builda).
Katalog roboczy to cała strona. Użytkownik zaznacza element w podglądzie i pisze, co zmienić.
- Zmieniaj tylko to, o co prosi; zachowaj styl i strukturę reszty strony.
- Element jest opisany selektorem CSS i fragmentem HTML — znajdź go w plikach (Grep) przed edycją.
- Style dopisuj do istniejących plików CSS, nie twórz stylów inline, chyba że użytkownik o to prosi.
- Linki i ścieżki do plików zawsze względne (np. "obrazy/logo.png", "kontakt.html"), nigdy od "/" — strona może działać w podkatalogu.
- Zdjęcia i grafiki wgrane przez użytkownika leżą w plikach strony (zwykle w katalogu "obrazy/"); użyj Glob, żeby je znaleźć. Nie wymyślaj adresów obrazków z internetu.
- Dbaj o wersję mobilną: zmiany mają dobrze wyglądać także na ekranie szerokości 390 px.
- Formularze (kontakt, zapisy, zamówienia): <form action="__formularz" method="post">, pola z atrybutem name (po polsku, np. imie, email, wiadomosc) i ukryte pole-pułapka na boty: <input type="text" name="_gotcha" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true">. Opcjonalnie <input type="hidden" name="_temat" value="…"> (temat powiadomienia) i <input type="hidden" name="_powrot" value="dziekujemy.html"> (strona po wysłaniu; ścieżka od głównego katalogu strony, bez ukośnika na początku). Bez pól typu file i bez zewnętrznych usług formularzy.
- Na koniec napisz po polsku jedno lub dwa zdania, co zmieniłeś.
`.trim();

// Ścieżka jest dozwolona, gdy po rozwinięciu dowiązań (realpath) leży w katalogu strony i nie dotyka `.git`.
// Dla plików, których jeszcze nie ma (Write), sprawdzamy najbliższy istniejący katalog nadrzędny.
function sciezkaDozwolona(korzen, sciezka) {
  if (typeof sciezka !== "string" || !sciezka) return false;
  const pelna = path.resolve(korzen, sciezka);
  if (pelna !== korzen && !pelna.startsWith(korzen + path.sep)) return false;
  if (path.relative(korzen, pelna).split(path.sep).includes(".git")) return false;
  let istniejaca = pelna;
  while (!fs.existsSync(istniejaca)) istniejaca = path.dirname(istniejaca);
  const prawdziwa = fs.realpathSync(istniejaca);
  return prawdziwa === korzen || prawdziwa.startsWith(korzen + path.sep);
}

// Wzorce Glob/Grep nie mogą wychodzić w górę drzewa ani celować w `.git`.
const wzorzecDozwolony = (wzorzec) =>
  typeof wzorzec !== "string" || (!path.isAbsolute(wzorzec) && !wzorzec.split(/[\\/]/).some((c) => c === ".." || c === ".git"));

// Zwraca powód odmowy albo null, gdy wywołanie narzędzia mieści się w katalogu strony.
export function powodOdmowy(katalog, nazwa, wejscie = {}, dozwolone = DOZWOLONE) {
  if (!dozwolone.includes(nazwa)) return `Narzędzie ${nazwa} jest wyłączone.`;
  const korzen = fs.realpathSync(katalog);
  const sciezki = [wejscie.file_path, wejscie.path].filter((s) => s !== undefined);
  if (!sciezki.every((s) => sciezkaDozwolona(korzen, s))) return "Dostęp tylko do plików strony (bez .git).";
  if (!wzorzecDozwolony(wejscie.pattern && nazwa === "Glob" ? wejscie.pattern : undefined) || !wzorzecDozwolony(wejscie.glob)) {
    return "Wzorzec wyszukiwania musi dotyczyć plików strony.";
  }
  return null;
}

// Hook PreToolUse działa przed KAŻDYM wywołaniem narzędzia, także tym, które SDK zatwierdza samo
// (np. odczyt w katalogu roboczym). `canUseTool` jest wołane tylko wtedy, gdy SDK pyta o zgodę.
function hookStraznika(katalog, dozwolone) {
  return async (wejscie) => {
    const powod = powodOdmowy(katalog, wejscie.tool_name, wejscie.tool_input, dozwolone);
    if (!powod) return {};
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: powod } };
  };
}

function straznik(katalog, dozwolone) {
  return async (nazwa, wejscie) => {
    const powod = powodOdmowy(katalog, nazwa, wejscie, dozwolone);
    return powod ? { behavior: "deny", message: powod } : { behavior: "allow", updatedInput: wejscie };
  };
}

function opisNarzedzia(blok, katalog) {
  const plik = blok.input?.file_path ?? blok.input?.path;
  const wzgledna = plik ? path.relative(katalog, path.resolve(katalog, plik)) || "." : "";
  if (blok.name === ZRZUT) return `Oglądam efekt: ${blok.input?.plik || "index.html"} (${blok.input?.urzadzenie || "komputer"})`;
  const czynnosc = { Read: "Czytam", Edit: "Edytuję", Write: "Zapisuję", Glob: "Szukam plików", Grep: "Szukam w plikach" }[blok.name] ?? blok.name;
  return [czynnosc, wzgledna || blok.input?.pattern || ""].join(" ").trim();
}

export function zbudujPolecenie({ tresc, element, strona }) {
  const czesci = [`Podstrona: ${strona || "index.html"}`];
  if (element) {
    czesci.push(
      `Zaznaczony element:`,
      `- selektor: ${element.selektor}`,
      `- tekst: ${(element.tekst || "").slice(0, 300)}`,
      `- HTML (skrócony):\n${(element.html || "").slice(0, 2000)}`,
    );
  }
  czesci.push(`Polecenie użytkownika: ${tresc}`);
  return czesci.join("\n");
}

// Polecenie z obrazkami (np. wklejony wzór) musi pójść jako wiadomość z blokami treści, a nie zwykły tekst.
function wiadomoscZObrazami(polecenie, obrazy) {
  const tresc = obrazy.map(({ typ, dane }) => ({ type: "image", source: { type: "base64", media_type: typ, data: dane } }));
  tresc.push({ type: "text", text: `${polecenie}\n\nDołączone obrazy to wzór lub kontekst od użytkownika.` });
  return (async function* () {
    yield { type: "user", message: { role: "user", content: tresc }, parent_tool_use_id: null };
  })();
}

// Wywołuje agenta i woła `wyslij(zdarzenie)` dla każdego kroku. Zwraca id sesji, by kolejne polecenia pamiętały kontekst.
// `tylkoOdczyt` — agent może tylko czytać i szukać (planowanie zadań globalnych); `instrukcje` — dodatkowe zasady;
// `maxTurns` — limit kroków agenta.
const NARZEDZIA_ODCZYTU = ["Read", "Glob", "Grep"];
export async function uruchomAgenta({ katalog, polecenie, obrazy = [], sesja, wyslij, sygnal, tylkoOdczyt = false, instrukcje = "", maxTurns = 40 }) {
  const dozwolone = tylkoOdczyt ? NARZEDZIA_ODCZYTU : DOZWOLONE;
  const kontroler = new AbortController();
  // Przeglądarka mogła się rozłączyć, zanim tu dotarliśmy — wtedy nie startujemy agenta wcale.
  if (sygnal?.aborted) throw new Error("Połączenie z przeglądarką zostało przerwane.");
  sygnal?.addEventListener("abort", () => kontroler.abort(), { once: true });

  // Zapis rozmowy mógł zniknąć (np. po przebudowie kontenera bez trwałego CLAUDE_CONFIG_DIR) — wtedy zaczynamy nową.
  if (sesja && !(await getSessionInfo(sesja, { dir: katalog }).catch(() => undefined))) {
    wyslij({ typ: "narzedzie", tekst: "Poprzednia rozmowa jest niedostępna, zaczynam nową." });
    sesja = null;
  }

  let idSesji = sesja;
  const przebieg = query({
    prompt: obrazy.length ? wiadomoscZObrazami(polecenie, obrazy) : polecenie,
    options: {
      cwd: katalog,
      model: MODEL,
      // Poziom wysiłku rozumieją tylko modele Claude; inne (np. przez OpenRouter) dostają ustawienia domyślne.
      ...(MODEL.startsWith("claude") ? { effort: "medium" } : {}),
      tools: tylkoOdczyt ? NARZEDZIA_ODCZYTU : NARZEDZIA,
      permissionMode: "default",
      canUseTool: straznik(katalog, dozwolone),
      hooks: { PreToolUse: [{ hooks: [hookStraznika(katalog, dozwolone)] }] },
      settingSources: [],
      systemPrompt: {
        type: "preset", preset: "claude_code",
        append: [INSTRUKCJE, ZRZUTY_DOSTEPNE && !tylkoOdczyt ? INSTRUKCJE_ZRZUTY : "", instrukcje].filter(Boolean).join("\n"),
      },
      // Bez allowedTools: każde wywołanie zrzutu przechodzi przez hook i canUseTool, jak pozostałe narzędzia.
      ...(ZRZUTY_DOSTEPNE && !tylkoOdczyt ? { mcpServers: { podglad: serwerZrzutow(katalog, wyslij) } } : {}),
      maxTurns,
      // Domyślnie Claude Code ponawia błędy API ~10 razy z rosnącą przerwą (przy wyczerpanym limicie to ~3 min ciszy).
      // Dwa ponowienia wystarczą na chwilowe przeciążenie; `env` zastępuje całe środowisko procesu, stąd kopia process.env.
      env: { ...process.env, CLAUDE_CODE_MAX_RETRIES: process.env.CLAUDE_CODE_MAX_RETRIES || "2" },
      fallbackModel: MODEL_ZAPASOWY,
      resume: sesja || undefined,
      abortController: kontroler,
    },
  });

  try {
    for await (const wiadomosc of przebieg) {
      if (wiadomosc.session_id) idSesji = wiadomosc.session_id;
      przekaz(wiadomosc, katalog, wyslij);
    }
  } catch (e) {
    if (kontroler.signal.aborted) throw e;
    throw new Error(komunikatBledu(e.message));
  }
  return idSesji;
}

// Zamienia wiadomości SDK na zdarzenia dla przeglądarki.
function przekaz(wiadomosc, katalog, wyslij) {
  if (wiadomosc.type === "assistant" && !wiadomosc.parent_tool_use_id) {
    for (const blok of wiadomosc.message.content) {
      // Wiadomość z polem `error` to syntetyczny komunikat SDK („API Error: …”) — pokazujemy zamiast niego nasz opis błędu.
      if (blok.type === "text" && blok.text.trim() && !wiadomosc.error) wyslij({ typ: "tekst", tekst: blok.text });
      if (blok.type === "tool_use") wyslij({ typ: "narzedzie", tekst: opisNarzedzia(blok, katalog) });
    }
    if (wiadomosc.error) {
      // Kod błędu SDK bywa ogólny („unknown”), więc najpierw próbujemy rozpoznać treść komunikatu dostawcy.
      const tresc = wiadomosc.message.content.filter((b) => b.type === "text").map((b) => b.text).join(" ");
      const komunikat = komunikatBledu(tresc);
      const rozpoznany = Object.values(KOMUNIKATY).includes(komunikat);
      wyslij({ typ: "blad", tekst: rozpoznany ? komunikat : KOMUNIKATY[wiadomosc.error] || `Błąd API modelu: ${komunikat.replace(/^API Error:\s*/, "")}` });
    }
  }
  if (wiadomosc.type === "result") {
    wyslij({
      typ: "wynik",
      ok: wiadomosc.subtype === "success",
      // SDK liczy koszt według cennika Claude'a; dla innych modeli (OpenRouter) ta liczba nie odpowiada rachunkowi.
      koszt: MODEL.startsWith("claude") ? wiadomosc.total_cost_usd : null,
      czas: wiadomosc.duration_ms,
      zuzycie: policzZuzycie(wiadomosc),
    });
  }
}
