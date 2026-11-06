# Umowa powierzenia przetwarzania danych osobowych (wzór)

> Wzór do dostosowania i przejrzenia przez prawnika. Fragmenty w `[nawiasach]` uzupełnij. Może to być osobny dokument albo załącznik do umowy o obsługę strony.

zawarta [data] w [miejscowość] między:

**[nazwa klienta]**, [adres], NIP [NIP], zwanym dalej **Administratorem**,

a

**[nazwa agencji]**, [adres], NIP [NIP], zwanym dalej **Przetwarzającym**.

## § 1. Przedmiot i cel

1. Administrator powierza Przetwarzającemu przetwarzanie danych osobowych w zakresie i celu opisanym w tej umowie, na podstawie art. 28 rozporządzenia (UE) 2016/679 (RODO).
2. Celem przetwarzania jest obsługa strony internetowej [adres strony], w szczególności:
   - przyjmowanie wiadomości wysłanych przez formularze na stronie;
   - ich przechowywanie;
   - przekazywanie Administratorowi powiadomień o nowych wiadomościach.
3. Umowa obowiązuje przez czas trwania umowy głównej [nazwa i data umowy głównej].

## § 2. Zakres danych i kategorie osób

1. Kategorie osób to osoby wysyłające wiadomości przez formularze na stronie.
2. Rodzaje danych to dane podane w formularzu: [np. imię, adres e-mail, numer telefonu, treść wiadomości]. Do tego dochodzi data wysłania i adres podstrony.
3. Przetwarzający nie zapisuje adresów IP osób wysyłających formularz. Używa ich wyłącznie na bieżąco, do ochrony przed nadużyciami (limit liczby wysyłek), i przechowuje w pamięci serwera najwyżej 10 minut.

## § 3. Obowiązki Przetwarzającego

Przetwarzający:

1. przetwarza dane wyłącznie na udokumentowane polecenie Administratora; za takie polecenie strony uznają tę umowę i ustawienia projektu (adres powiadomień, webhook, okres przechowywania);
2. zapewnia, że osoby z dostępem do danych zobowiązały się do zachowania tajemnicy;
3. stosuje środki bezpieczeństwa z art. 32 RODO, opisane w § 6;
4. pomaga Administratorowi wywiązywać się z obowiązków wobec osób, których dane dotyczą (dostęp, usunięcie, przeniesienie danych), w terminie [3] dni roboczych od prośby;
5. zgłasza Administratorowi naruszenie ochrony danych bez zbędnej zwłoki, nie później niż w ciągu [24] godzin od jego wykrycia, i przekazuje informacje potrzebne do zgłoszenia naruszenia organowi nadzorczemu;
6. po zakończeniu umowy usuwa dane albo zwraca je Administratorowi w pliku CSV, wedle jego wyboru, w ciągu [14] dni. Kopie zapasowe wygasają samoczynnie w ciągu 14 dni od usunięcia danych;
7. udostępnia Administratorowi informacje potrzebne do wykazania zgodności z art. 28 RODO i umożliwia audyt po uprzednim zawiadomieniu z [14]-dniowym wyprzedzeniem.

## § 4. Okres przechowywania

1. Wiadomości z formularzy są przechowywane przez [24] miesiące od wysłania, a potem automatycznie usuwane.
2. Na polecenie Administratora Przetwarzający usuwa pojedyncze wiadomości wcześniej.

## § 5. Dalsze powierzenie

1. Administrator wyraża ogólną zgodę na dalsze powierzenie przetwarzania podmiotom wymienionym poniżej. O planowanej zmianie lub dodaniu podmiotu Przetwarzający informuje z [14]-dniowym wyprzedzeniem, a Administrator może zgłosić sprzeciw.

| Podmiot | Zakres | Miejsce przetwarzania |
|---|---|---|
| [dostawca serwera VPS] | hosting edytora, strony i danych z formularzy | [państwo / EOG] |
| [dostawca poczty SMTP] | wysyłka powiadomień e-mail z treścią wiadomości | [państwo] |
| [np. n8n na serwerze Przetwarzającego / inny system] | przekazanie wiadomości dalej (webhook) | [państwo] |
| [dostawca skrzynki Administratora] | odbiór powiadomień (podmiot Administratora, nie Przetwarzającego) | — |

2. Narzędzie AI używane do edycji strony ([dostawca modelu]) nie ma dostępu do wiadomości z formularzy. Przetwarza wyłącznie treść plików strony.
3. Jeśli dalszy podmiot przetwarza dane poza Europejskim Obszarem Gospodarczym, Przetwarzający zapewnia podstawę transferu z rozdziału V RODO, np. standardowe klauzule umowne albo decyzję stwierdzającą odpowiedni stopień ochrony.

## § 6. Środki bezpieczeństwa

1. Dostęp do panelu wymaga indywidualnych kont z rolami. Konto klienta widzi wyłącznie swój projekt. Hasła są przechowywane jako skróty (scrypt), a po 10 nieudanych próbach logowania adres jest blokowany na 15 minut.
2. Komunikacja odbywa się wyłącznie przez HTTPS (certyfikaty Let's Encrypt).
3. Serwer jest dostępny przez SSH wyłącznie za pomocą kluczy, logowanie hasłem jest wyłączone.
4. Kopie zapasowe powstają codziennie i są przechowywane przez 14 dni.
5. Monitoring dostępności z powiadomieniem o awarii.
6. [inne, np. szyfrowanie dysku, kopie poza serwerem]

## § 7. Odpowiedzialność i postanowienia końcowe

1. Przetwarzający odpowiada za szkody spowodowane przetwarzaniem niezgodnym z umową lub RODO na zasadach art. 82 RODO.
2. W sprawach nieuregulowanych stosuje się RODO i przepisy prawa polskiego.
3. Zmiany umowy wymagają formy [pisemnej / dokumentowej].

| Administrator | Przetwarzający |
|---|---|
| [podpis] | [podpis] |
