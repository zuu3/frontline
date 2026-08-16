// Shared between server (grant amount) and client (calendar preview) so the
// two can't drift. A streak is consecutive daily check-ins (missing a day
// resets it to 1); the reward repeats every 7 attended days.
export const DAILY_CHECKIN_SCHEDULE: readonly number[] = [
  20, 20, 30, 30, 40, 40, 100,
];

/** 1-indexed day-in-cycle for a given streak count (streak >= 1). */
export function dailyCheckinCycleDay(streak: number): number {
  return ((streak - 1) % DAILY_CHECKIN_SCHEDULE.length) + 1;
}

/** Reward amount for a given streak count (streak >= 1). */
export function dailyCheckinAmountForStreak(streak: number): number {
  return DAILY_CHECKIN_SCHEDULE[dailyCheckinCycleDay(streak) - 1];
}
