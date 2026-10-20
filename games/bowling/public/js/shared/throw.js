// What the release point does to a throw. Pure (TV, phone and tests share it).
//
// `release` is the arm angle when the thumb came off B, in degrees from the
// bottom of the swing: − = early (the arm still behind, coming down), + = late
// (already on the way up). Around the bottom is the sweet spot; outside it the
// throw suffers, more the further out it is:
//   early → the ball is dumped: slower, lands hard, pushed off the line
//           outward (and, as in the original, it turns a little more);
//   late  → the ball is lofted: it flies and bounces, hooks less, and is
//           pulled across the body.

export const RELEASE_ZONE = { early: -12, late: 20 };   // the sweet spot (deg)
export const PERFECT_ZONE = { early: -6, late: 12 };

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// { grade, label, short, tone } for feedback.
//   grade: 'perfect' | 'good' | 'early' | 'late' | 'way-early' | 'lofted' | 'none'
export function releaseGrade(release) {
  if (release === null || release === undefined || !Number.isFinite(release)) {
    return { grade: 'none', label: '', short: '', tone: 'none' };
  }
  if (release >= PERFECT_ZONE.early && release <= PERFECT_ZONE.late) return { grade: 'perfect', label: 'Perfect release!', short: 'Perfect release', tone: 'good' };
  if (release >= RELEASE_ZONE.early && release <= RELEASE_ZONE.late) return { grade: 'good', label: 'Good release', short: 'Good release', tone: 'good' };
  if (release < -38) return { grade: 'way-early', label: 'Way too early!', short: 'Way too early', tone: 'bad' };
  if (release < RELEASE_ZONE.early) return { grade: 'early', label: 'A bit early', short: 'Early release', tone: 'warn' };
  if (release > 42) return { grade: 'lofted', label: 'Lofted — too late!', short: 'Lofted', tone: 'bad' };
  return { grade: 'late', label: 'A bit late', short: 'Late release', tone: 'warn' };
}

// Effects of the release point on a throw.
//   speedK          multiply the ball speed
//   spinK           multiply the spin
//   lineDeg         change of direction in degrees (+ = right), mirrored for left-handers
//   loftY / loftVy  extra height (m) and upward speed (m/s) at release (late)
//   dumpVy          downward speed (m/s) at release (early)
export function releaseEffects(release, hand = 'right') {
  if (release === null || release === undefined || !Number.isFinite(release)) {
    return { speedK: 1, spinK: 1, lineDeg: 0, loftY: 0, loftVy: 0, dumpVy: 0, early: 0, late: 0 };
  }
  const early = Math.max(0, RELEASE_ZONE.early - release);   // degrees outside the zone
  const late = Math.max(0, release - RELEASE_ZONE.late);
  const side = hand === 'left' ? -1 : 1;
  return {
    speedK: 1 - Math.min(0.25, early * 0.0075) - Math.min(0.06, late * 0.0012),
    spinK: (1 + Math.min(0.25, early * 0.006)) * (1 - Math.min(0.7, late * 0.014)),
    lineDeg: side * clamp(early * 0.04 - late * 0.035, -2.2, 2.2),
    loftY: Math.min(0.45, late * 0.009),
    loftVy: Math.min(1.6, late * 0.032),
    dumpVy: early > 0 ? -Math.min(1.5, early * 0.045) : 0,
    early,
    late,
  };
}
