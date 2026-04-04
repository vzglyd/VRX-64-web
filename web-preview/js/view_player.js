export const DEFAULT_SLIDE_DURATION_SECONDS = 7;

export function resolveDurationSeconds(
  entry,
  defaults = {},
  engineDefaultDurationSeconds = DEFAULT_SLIDE_DURATION_SECONDS,
) {
  return Number(entry?.duration_seconds ?? defaults?.duration_seconds ?? engineDefaultDurationSeconds);
}

export function buildPlayableSchedule(
  playlist,
  {
    engineDefaultDurationSeconds = DEFAULT_SLIDE_DURATION_SECONDS,
  } = {},
) {
  const defaults = playlist?.defaults ?? {};
  const slides = Array.isArray(playlist?.slides) ? playlist.slides : [];

  return slides.flatMap((entry, playlistIndex) => {
    if (entry?.enabled === false) {
      return [];
    }

    return [{
      playlistIndex,
      path: entry.path,
      params: entry.params,
      durationSeconds: resolveDurationSeconds(entry, defaults, engineDefaultDurationSeconds),
      transitionIn: entry.transition_in ?? defaults.transition_in ?? null,
      transitionOut: entry.transition_out ?? defaults.transition_out ?? null,
    }];
  });
}

export function normalizeStartIndex(value, totalSlides) {
  if (!Number.isInteger(totalSlides) || totalSlides <= 0) {
    return 0;
  }

  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return 0;
  }

  return Math.min(parsed, totalSlides - 1);
}

export function nextScheduleIndex(index, totalSlides) {
  if (!Number.isInteger(totalSlides) || totalSlides <= 0) {
    return 0;
  }

  return (index + 1) % totalSlides;
}
