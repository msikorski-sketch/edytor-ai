#!/bin/bash
# Wdrożenie na VPS z bezpiecznikami: wdrażamy wyłącznie zacommitowany stan (git archive HEAD), bez zielonych testów
# nic nie idzie na serwer, przed zmianą powstaje kopia danych, a po zmianie sprawdzamy, czy opublikowane strony się
# nie zmieniły. Udane wdrożenie dostaje tag wdrozenie-RRRRMMDD-GGMM, a serwer plik WERSJA z commitem.
# Użycie: narzedzia/wdroz.sh (z katalogu projektu). Dane serwera: narzedzia/wdroz.env (nieśledzony, wzór: wdroz.env.example).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f narzedzia/wdroz.env ] || { echo "Brak narzedzia/wdroz.env — skopiuj narzedzia/wdroz.env.example i uzupełnij." >&2; exit 1; }
. narzedzia/wdroz.env
SSH=(ssh -i "$KLUCZ_SSH" -o BatchMode=yes "$SERWER")
ZDROWIE="$ADRES_PANELU/zdrowie"

if [ -n "$(git status --porcelain)" ]; then
  git status --short >&2
  echo "PRZERWANO: są niezacommitowane zmiany — wdrażamy tylko to, co jest w commicie." >&2
  exit 1
fi
COMMIT=$(git rev-parse --short HEAD)
echo "Wdrażam commit $COMMIT: $(git log -1 --format=%s)"

echo "1/6 Testy…"
if ! npm test > /tmp/edytor-testy.log 2>&1; then
  grep -E "^✖|^ℹ (pass|fail)" /tmp/edytor-testy.log || tail -20 /tmp/edytor-testy.log
  echo "PRZERWANO: testy nie przeszły, nic nie wdrożono." >&2
  exit 1
fi
grep -E "^ℹ (pass|fail)" /tmp/edytor-testy.log

echo "2/6 Kopia danych na serwerze…"
"${SSH[@]}" /opt/edytor-ai/narzedzia/kopia.sh

echo "3/6 Odcisk opublikowanych stron przed wdrożeniem…"
odcisk() {
  local wynik=""
  for adres in $("${SSH[@]}" 'for p in /opt/edytor-ai/dane/projekty/*/; do basename "$p"; done'); do
    wynik+="$adres:$(curl -s "$ADRES_STRON/$adres/" | md5sum | cut -c1-12) "
  done
  # Własne domeny projektów (routery z pliku Traefika) — kod odpowiedzi i treść.
  for domena in $("${SSH[@]}" "grep -ho '\"domena\": \"[^\"]*\"' /opt/edytor-ai/dane/projekty/*/stan.json | cut -d'\"' -f4"); do
    wynik+="$domena:$(curl -s -w '%{http_code}' "https://$domena/" | md5sum | cut -c1-12) "
  done
  echo "$wynik"
}
PRZED=$(odcisk)

# Restart przerywa pracujących asystentów (czat pokazuje komunikat o aktualizacji, polecenie trzeba powtórzyć) — tylko informujemy.
AKTYWNI=$(curl -sf "$ZDROWIE" | sed -n 's/.*"aktywniAgenci":\([0-9]*\).*/\1/p')
[ "${AKTYWNI:-0}" != 0 ] && echo "Uwaga: przerywam pracę asystentów ($AKTYWNI) — użytkownicy powtórzą polecenie."

echo "4/6 Wysyłka kodu i przebudowa…"
PACZKA=$(mktemp -d)
trap 'rm -rf "$PACZKA"' EXIT
git archive HEAD | tar -x -C "$PACZKA"
echo "$COMMIT $(git log -1 --format=%cI)" > "$PACZKA/WERSJA"
rsync -a --delete --exclude node_modules --exclude dane --exclude kopie --exclude .env --exclude test \
  -e "ssh -i $KLUCZ_SSH -o BatchMode=yes" "$PACZKA/" "$SERWER:/opt/edytor-ai/"
"${SSH[@]}" 'cd /opt/edytor-ai && docker compose up -d --build 2>&1 | tail -1'

echo "5/6 Czekam na zdrowy kontener…"
for i in $(seq 1 60); do curl -sf -o /dev/null "$ZDROWIE" && break; sleep 2; done
curl -sf "$ZDROWIE" && echo

echo "6/6 Porównanie opublikowanych stron…"
PO=$(odcisk)
if [ "$PRZED" = "$PO" ]; then
  echo "Strony publiczne bez zmian: $PO"
  TAG="wdrozenie-$(date +%Y%m%d-%H%M)"
  git tag "$TAG" "$COMMIT" && echo "Oznaczono: $TAG"
  # Zdalne repozytorium (GitHub) dostaje kod i tag — tam widać, co jest na produkcji. Brak sieci nie cofa wdrożenia.
  git push -q origin HEAD:main "$TAG" 2>&1 && echo "Wypchnięto do origin: main i $TAG" || echo "Uwaga: nie udało się wypchnąć do origin (zrób git push --follow-tags ręcznie)."
else echo "UWAGA: strony publiczne różnią się!"; echo "przed: $PRZED"; echo "po:    $PO"; exit 2; fi
