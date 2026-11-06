# RODO w Edytorze AI: kto za co odpowiada i jak to obsłużyć

> To są wzory i opis działania narzędzia, a nie porada prawna. Przed pierwszym wdrożeniem dla klienta daj je do przejrzenia prawnikowi albo inspektorowi ochrony danych. Fragmenty w `[nawiasach]` uzupełnij.

## Role

| Kto | Rola w RODO | Dlaczego |
|---|---|---|
| Klient (właściciel strony) | **administrator danych** | decyduje, po co zbiera dane z formularza i co z nimi robi |
| Agencja (Ty, operator edytora) | **podmiot przetwarzający** (art. 28) | przechowuje zgłoszenia na swoim serwerze i wysyła powiadomienia na polecenie klienta |
| Dostawca serwera, poczty, webhooków, modelu AI | **dalsi podmiot przetwarzający** | Ty powierzasz im część przetwarzania |

Z tego wynika jeden obowiązkowy dokument między Tobą a klientem: [umowa powierzenia](umowa-powierzenia.md). Klient z kolei musi poinformować osoby wypełniające formularz: [klauzula przy formularzu](klauzula-formularza.md) i [polityka prywatności](polityka-prywatnosci.md).

## Jakie dane przetwarza edytor

- **Zgłoszenia z formularzy** to pola, które wypełnił odwiedzający, data, podstrona i temat.
  - Zapisują się w `dane/projekty/<projekt>/formularze/RRRR-MM.jsonl` na serwerze.
  - **Adresu IP nie zapisujemy.** Służy tylko do limitu wysyłek i jest trzymany w pamięci przez 10 minut.
- **Powiadomienia o zgłoszeniach.** Treść zgłoszenia idzie e-mailem przez serwer SMTP z `.env` albo na webhook ustawiony w projekcie (np. n8n).
- **Kopie zapasowe.** Codzienna kopia danych zawiera także zgłoszenia i jest trzymana 14 dni (`dane` → `kopie/`). Usunięte zgłoszenie znika więc z kopii najpóźniej po 14 dniach. Tak to opisz w umowie i polityce.
- **Model AI** dostaje polecenia i treść plików strony, nad którą pracuje (teksty, kod, zrzuty ekranu podglądu). **Zgłoszeń z formularzy nie widzi**, bo leżą poza katalogiem strony, do którego agent ma dostęp. Jeśli na stronie są dane osobowe (np. imiona i zdjęcia zespołu), trafiają do dostawcy modelu razem z treścią strony.
- **Konta panelu** zawierają login, nazwę i skrót hasła (scrypt) w `dane/stan.json`. Sesję trzyma ciasteczko niezbędne do działania panelu.
- **Integracje na stronie** (Google Analytics, Meta Pixel, Clarity, czaty) przetwarzają dane odwiedzających po stronie ich dostawców. Skrypty śledzące włączają się dopiero po zgodzie w banerze. Zgoda jest zapisana w przeglądarce odwiedzającego (`localStorage`, klucz `edytor-zgody`) na 12 miesięcy.

## Okres przechowywania

Zgłoszenia starsze niż `EDYTOR_FORMULARZE_MIESIACE` (domyślnie 24 miesiące) są usuwane automatycznie, całymi plikami miesięcznymi. Wartość ustaw w `.env` zgodnie z tym, co klient wpisze w polityce prywatności, np. 12 miesięcy dla zapytań ofertowych.

## Żądania osób, których dane dotyczą

| Żądanie | Co zrobić w edytorze |
|---|---|
| Dostęp i kopia danych (art. 15), przeniesienie (art. 20) | „Formularze” → „Pobierz wszystkie (CSV)”, wybierz wiersze tej osoby i wyślij jej |
| Usunięcie (art. 17) | „Formularze” → × przy zgłoszeniu, kliknij dwa razy. Zgłoszenie znika z pliku na serwerze, a z kopii zapasowych po 14 dniach. Usuń też e-mail z powiadomieniem ze skrzynki i dane z systemu za webhookiem |
| Sprostowanie (art. 16) | zgłoszenia są zapisem tego, co ktoś wysłał. Dopisz poprawkę w CRM albo usuń i poproś o ponowne wysłanie |
| Sprzeciw lub cofnięcie zgody na cookies | odwiedzający sam zmienia wybór przyciskiem „Cookies” w rogu strony |

Usuwać zgłoszenia może redaktor i administrator. Klient widzi zgłoszenia i pobiera CSV, ale ich nie usuwa. Dzięki temu nie skasuje czegoś przypadkiem, a każde usunięcie przechodzi przez osobę, która zna procedurę.

## Lista kontrolna przed uruchomieniem strony klienta

1. Umowa powierzenia podpisana, a lista dalszych podmiotów przetwarzających zgadza się z tym, czego naprawdę używasz (SMTP, webhook, model AI).
2. Pod każdym formularzem jest klauzula informacyjna albo link do niej. Jeśli formularz służy też marketingowi, dodaj osobny, niezaznaczony checkbox zgody.
3. Strona ma politykę prywatności z sekcją o cookies, zgodną z włączonymi integracjami.
4. Jeśli włączona jest choć jedna integracja śledząca, w integracjach ustawiony jest baner zgód z adresem polityki.
5. Okres przechowywania w `.env` (`EDYTOR_FORMULARZE_MIESIACE`) zgadza się z polityką.
6. Powiadomienia e-mail idą na skrzynkę klienta, do której dostęp mają tylko uprawnione osoby.
7. Klient ma konto „klient” wyłącznie do swojego projektu.
