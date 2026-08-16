// Duolingo-style streak flame next to the nav "check-in" button. Attribute-
// selected (not a single ID) so both the desktop and mobile nav bars' copies
// update from one call, regardless of which is currently visible.
// checkin_streak only advances from a checkin-page visit (POST /checkin), so
// this reflects the last-banked streak, not a live "would still count today"
// projection.
export function updateCheckinStreakBadge(streak: number): void {
  document
    .querySelectorAll<HTMLElement>("[data-checkin-streak]")
    .forEach((el) => {
      if (streak > 0) {
        el.textContent = `🔥${streak}`;
        el.classList.remove("hidden");
      } else {
        el.classList.add("hidden");
      }
    });
}
