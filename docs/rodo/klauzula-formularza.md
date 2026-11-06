# Klauzula informacyjna przy formularzu (wzór)

> Wzór do dostosowania. Fragmenty w `[nawiasach]` uzupełnij. Asystentowi w edytorze wystarczy polecenie: „pod formularzem kontaktowym dodaj krótką klauzulę informacyjną z linkiem do polityki prywatności”, a potem wklej tekst poniżej.

## Wersja krótka (pod przyciskiem „Wyślij”)

Administratorem Twoich danych jest [nazwa firmy], [adres]. Dane z formularza wykorzystamy tylko po to, żeby odpowiedzieć na Twoją wiadomość, i przechowamy je przez [24] miesiące. Masz prawo dostępu do danych, ich sprostowania, usunięcia i ograniczenia przetwarzania oraz prawo sprzeciwu. Szczegóły znajdziesz w [polityce prywatności](polityka-prywatnosci.html).

## Wersja pełna (art. 13 RODO, np. w polityce prywatności)

1. **Administrator:** [nazwa firmy], [adres], NIP [NIP], e-mail [adres do spraw danych].
2. **Cel i podstawa:**
   - odpowiedź na wiadomość i kontakt w jej sprawie, na podstawie prawnie uzasadnionego interesu administratora (art. 6 ust. 1 lit. f RODO);
   - jeśli wiadomość dotyczy zawarcia umowy, podstawą są działania przed jej zawarciem (art. 6 ust. 1 lit. b).
3. **Odbiorcy:**
   - firma obsługująca stronę i formularze ([nazwa agencji]) oraz jej dostawcy (serwer, poczta), działający na nasze polecenie;
   - [system CRM / inne], jeśli dotyczy.
4. **Okres przechowywania:** [24] miesiące od wysłania wiadomości, a jeśli zawrzemy umowę, przez okres wymagany przepisami.
5. **Twoje prawa:**
   - dostęp do danych, ich sprostowanie, usunięcie, ograniczenie przetwarzania i przeniesienie;
   - sprzeciw wobec przetwarzania;
   - skarga do Prezesa Urzędu Ochrony Danych Osobowych (ul. Stawki 2, 00-193 Warszawa).
6. **Dobrowolność:** podanie danych jest dobrowolne, ale bez nich nie odpowiemy na wiadomość.
7. **Zautomatyzowane decyzje:** nie podejmujemy decyzji wyłącznie automatycznie i nie profilujemy na podstawie danych z formularza.

## Zgoda marketingowa (tylko jeśli potrzebna)

Osobny checkbox, **domyślnie niezaznaczony** i niewymagany do wysłania formularza:

```html
<label><input type="checkbox" name="zgoda_marketing" value="tak">
Chcę otrzymywać informacje o nowościach i ofertach [nazwa firmy] e-mailem. Zgodę mogę wycofać w każdej chwili.</label>
```

Treść pola trafi do zgłoszenia i do eksportu CSV. To jest Twój dowód, że zgoda została wyrażona i kiedy.
