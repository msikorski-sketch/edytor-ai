#!/bin/sh
# Nocna kopia danych edytora (projekty, historia git, stan) + .env. Zostaje 14 ostatnich kopii.
# Instalacja na hoście (cron, codziennie o 3:15):
#   echo '15 3 * * * root /opt/edytor-ai/narzedzia/kopia.sh' > /etc/cron.d/edytor-ai-kopia
set -eu
KATALOG=/opt/edytor-ai
CEL=/opt/kopie/edytor-ai
mkdir -p "$CEL"
chmod 700 "$CEL"
PLIK="$CEL/edytor-ai-$(date +%Y%m%d-%H%M).tgz"
# Bez katalogu claude/ (pamięć rozmów agenta da się odtworzyć) i bez wydań starszych niż bieżące — są w historii git.
tar czf "$PLIK.tmp" -C "$KATALOG" --exclude='dane/claude' .env dane
mv "$PLIK.tmp" "$PLIK"
ls -1t "$CEL"/edytor-ai-*.tgz | tail -n +15 | xargs -r rm --
echo "Kopia: $PLIK ($(du -h "$PLIK" | cut -f1))"
