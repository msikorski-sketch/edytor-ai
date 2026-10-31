#!/bin/sh
# Kopia danych edytora poza serwer: restic → Hetzner Storage Box (SFTP, port 23).
# Restic szyfruje dane po stronie VPS (Storage Box widzi tylko zaszyfrowane bloki) i deduplikuje je,
# więc codzienna kopia wysyła tylko zmiany. Uruchamiane przez timer systemd (narzedzia/systemd/).
# Konfiguracja: /root/.config/edytor-kopia/env (RESTIC_REPOSITORY, RESTIC_PASSWORD_FILE) — opis w README.
set -eu
. /root/.config/edytor-kopia/env
export RESTIC_REPOSITORY RESTIC_PASSWORD_FILE
STAN=/var/lib/edytor-kopia
mkdir -p "$STAN"

# Bez dane/claude: pamięć rozmów agenta da się odtworzyć, a zmienia się przy każdym poleceniu.
restic backup --quiet --tag edytor-ai --exclude /opt/edytor-ai/dane/claude /opt/edytor-ai/dane /opt/edytor-ai/.env
# Rotacja: 14 dziennych, 8 tygodniowych, 12 miesięcznych; --prune usuwa niepotrzebne już bloki.
restic forget --quiet --tag edytor-ai --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune
# Spójność repozytorium; raz w tygodniu dodatkowo odczyt 10% danych (wykrywa uszkodzone bloki na Storage Boksie).
if [ "$(date +%u)" = 7 ]; then restic check --quiet --read-data-subset=10%; else restic check --quiet; fi

date -Is > "$STAN/ostatnia-udana"
echo "Kopia zdalna OK: $(restic snapshots --tag edytor-ai --latest 1 --compact | tail -n +3 | head -1)"
