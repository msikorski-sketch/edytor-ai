#!/bin/bash
# Odświeża publiczne repozytorium (portfolio) oczyszczoną migawką bieżącego commita. Historia prywatnego repozytorium
# tam nie trafia: każde odświeżenie to jeden nowy commit z samym stanem kodu.
# Przed wysłaniem migawka przechodzi trzy kontrole i przy jakimkolwiek trafieniu nic nie jest wypychane:
#   1) wzorce typowych sekretów (klucze API, klucze prywatne, adresy pingów monitoringu),
#   2) frazy zakazane z narzedzia/portfolio-zakazane.txt (nieśledzony: nazwy klientów, IP, domeny serwera…),
#   3) prawdziwe wartości sekretów z .env na serwerze (pobierane przez SSH do pliku tymczasowego, nigdy nie wypisywane).
# Użycie: narzedzia/portfolio.sh ["opis zmian"]   (--sprawdz: same kontrole, bez wysyłki)   Dane: narzedzia/wdroz.env (PORTFOLIO_REPO, PORTFOLIO_AUTOR).
set -euo pipefail
cd "$(dirname "$0")/.."
. narzedzia/wdroz.env
: "${PORTFOLIO_REPO:?ustaw PORTFOLIO_REPO w narzedzia/wdroz.env, np. uzytkownik/edytor-ai}"
: "${PORTFOLIO_AUTOR:?ustaw PORTFOLIO_AUTOR w narzedzia/wdroz.env, np. \"Imię Nazwisko <id+login@users.noreply.github.com>\"}"
ZAKAZANE=narzedzia/portfolio-zakazane.txt
[ -s "$ZAKAZANE" ] || { echo "Brak $ZAKAZANE — wpisz frazy, które nie mogą trafić do publicznego repozytorium (po jednej w linii)." >&2; exit 1; }
if [ -n "$(git status --porcelain)" ]; then echo "PRZERWANO: są niezacommitowane zmiany." >&2; exit 1; fi
TYLKO_SPRAWDZ=false; [ "${1:-}" = "--sprawdz" ] && { TYLKO_SPRAWDZ=true; shift; }
OPIS=${1:-"Aktualizacja: $(git log -1 --format=%s)"}
# Frazy bez komentarzy, pustych linii i znaków CR (plik zapisany w Windows nie może po cichu wyłączyć kontroli).
FRAZY=$(mktemp); tr -d '\r' < "$ZAKAZANE" | grep -v '^\s*\(#\|$\)' > "$FRAZY"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP" "$FRAZY"' EXIT
mkdir "$TMP/kod"
git archive HEAD | tar -x -C "$TMP/kod"
printf '%s\n' "$OPIS" > "$TMP/opis-commita" # opis commita też jest publiczny, więc też go skanujemy
# grep -a: pliki binarne (obrazki, archiwa w szablonach) też są przeszukiwane, a nie pomijane.

echo "1/3 Wzorce sekretów…"
if grep -rlaE 'sk-(or|ant)-[A-Za-z0-9_-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY|hc-ping\.com/[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}' "$TMP/kod" "$TMP/opis-commita"; then
  echo "PRZERWANO: pliki wyżej zawierają coś, co wygląda na sekret." >&2; exit 1
fi

echo "2/3 Frazy zakazane…"
if grep -rlaiF -f "$FRAZY" "$TMP/kod" "$TMP/opis-commita"; then
  echo "PRZERWANO: pliki wyżej zawierają frazy z $ZAKAZANE (sprawdź: grep -rniF -f $ZAKAZANE .)." >&2; exit 1
fi

echo "3/3 Prawdziwe wartości z .env na serwerze…"
# Same wartości (bez nazw). Normalizacja: CR, „export”, spacje, komentarz na końcu, cudzysłowy. Z adresów URL
# dodatkowo każdy segment i dane logowania (użytkownik:hasło@ w SMTP) — sekret bywa tylko częścią adresu.
ssh -i "$KLUCZ_SSH" -o BatchMode=yes "$SERWER" "cat /opt/edytor-ai/.env" | tr -d '\r' \
  | sed -n 's/^[[:space:]]*\(export[[:space:]]\+\)\?[A-Z_]*\(HASLO\|SEKRET\|TOKEN\|KEY\|WEBHOOK\|SMTP\|MONITOR_URL\)[[:space:]]*=[[:space:]]*//p' \
  | sed 's/[[:space:]]\+#.*$//; s/^"\(.*\)"$/\1/; s/^'"'"'\(.*\)'"'"'$/\1/' \
  | awk 'length($0) > 7 { print; n = split($0, c, /[\/@:?&=]/); for (i = 1; i <= n; i++) if (length(c[i]) > 7) print c[i] }' \
  | grep -vxE 'https?|smtps?|[a-z0-9.-]+\.(com|pl|net|org|io|cloud|sh)' | sort -u > "$TMP/sekrety"
chmod 600 "$TMP/sekrety"
[ -s "$TMP/sekrety" ] || { echo "PRZERWANO: nie udało się pobrać wartości z serwera (bez tej kontroli nie publikujemy)." >&2; exit 1; }
if grep -rlaF -f "$TMP/sekrety" "$TMP/kod" "$TMP/opis-commita"; then
  echo "PRZERWANO: pliki wyżej zawierają wartość sekretu z serwera." >&2; exit 1
fi
echo "   sprawdzono $(wc -l < "$TMP/sekrety") wartości — brak trafień"

$TYLKO_SPRAWDZ && { echo "Kontrole przeszły (tryb --sprawdz, nic nie wysłano)."; exit 0; }
echo "Wysyłka do $PORTFOLIO_REPO…"
git clone -q --depth 1 "https://github.com/$PORTFOLIO_REPO.git" "$TMP/repo"
rsync -a --delete --exclude .git "$TMP/kod/" "$TMP/repo/"
cd "$TMP/repo"
git add -A
if git diff --cached --quiet; then echo "Bez zmian — publiczne repozytorium jest aktualne."; exit 0; fi
git diff --cached --stat | tail -1
NAZWA=${PORTFOLIO_AUTOR% <*}; EMAIL=${PORTFOLIO_AUTOR##*<}; EMAIL=${EMAIL%>}
git -c user.name="$NAZWA" -c user.email="$EMAIL" commit -q -m "$OPIS"
git push -q origin HEAD
echo "Gotowe: https://github.com/$PORTFOLIO_REPO"
