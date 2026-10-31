// Logowanie do panelu: wysyła hasło i po sukcesie przeładowuje stronę (ciasteczko ustawia serwer).
document.getElementById("formularz").addEventListener("submit", async (e) => {
  e.preventDefault();
  const komunikat = document.getElementById("komunikat");
  komunikat.textContent = "";
  const odp = await fetch("/zaloguj", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ haslo: document.getElementById("haslo").value }),
  });
  if (odp.ok) return location.reload();
  komunikat.textContent = (await odp.json().catch(() => ({}))).blad || "Nie udało się zalogować.";
});
