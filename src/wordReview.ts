import type { WordReview } from './readerStorage';

const reviewIntervalsDays = [0, 1, 3, 7, 14, 30];

export function createInitialWordReview(now = new Date()): WordReview {
  return {
    level: 0,
    nextReviewAt: startOfDayIso(now)
  };
}

export function advanceWordReview(review: WordReview | undefined, remembered: boolean, now = new Date()): WordReview {
  const currentLevel = review?.level ?? 0;
  const nextLevel = remembered ? Math.min(currentLevel + 1, reviewIntervalsDays.length - 1) : 0;
  return {
    level: nextLevel,
    lastReviewedAt: now.toISOString(),
    nextReviewAt: addDaysIso(now, remembered ? reviewIntervalsDays[nextLevel] : 1)
  };
}

function startOfDayIso(value: Date) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date.toISOString();
}

function addDaysIso(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  next.setHours(0, 0, 0, 0);
  return next.toISOString();
}
