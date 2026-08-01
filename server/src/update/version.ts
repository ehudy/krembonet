/**
 * Version parsing and comparison — pure, no network and no filesystem.
 *
 * Separated from the update check because this is where the wrong answer is
 * silent. "Is 1.10.0 newer than 1.9.0?" is a string comparison away from being
 * wrong, and a hub that decides it is already up to date stops offering updates
 * forever without anything appearing in a log.
 *
 * A deliberately small subset of semver: major.minor.patch, an optional
 * prerelease, and build metadata that is parsed and then ignored, per the spec.
 * Anything that does not fit is refused rather than guessed at — a release tag
 * this cannot read must mean "no opinion", never "an update is available".
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated identifiers. Empty means a stable release. */
  prerelease: string[];
}

/** Strict: three numeric parts, no leading zeroes, optional -prerelease and +build. */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Parses a version string, tolerating the leading `v` that git tags carry.
 *
 * Returns null rather than throwing: an unparseable tag is an ordinary outcome
 * — a repository may tag `nightly` or `2024-06-01` — and it must degrade to
 * "cannot tell" rather than taking down the poll that read it.
 */
export function parseVersion(raw: string): ParsedVersion | null {
  const trimmed = String(raw ?? '')
    .trim()
    .replace(/^v/i, '');

  const match = SEMVER.exec(trimmed);
  if (match === null) return null;

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined || match[4] === '' ? [] : match[4].split('.'),
  };
}

/**
 * Orders two prerelease identifiers per semver §11.4.
 *
 * Numeric identifiers compare numerically and rank below alphanumeric ones, so
 * `1.0.0-alpha.9` precedes `1.0.0-alpha.beta`. Getting this backwards is how a
 * prerelease appears to be newer than the release it precedes.
 */
function comparePrereleaseIds(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);

  if (aNumeric && bNumeric) return Number(a) - Number(b);
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Negative when `a` is older, positive when newer, zero when equal. */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;

  // A version with a prerelease ranks below the same version without one:
  // 1.0.0-rc.1 comes before 1.0.0.
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;

  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    const left = a.prerelease[i];
    const right = b.prerelease[i];

    // A shorter prerelease ranks lower when all preceding parts match:
    // 1.0.0-alpha precedes 1.0.0-alpha.1.
    if (left === undefined) return -1;
    if (right === undefined) return 1;

    const order = comparePrereleaseIds(left, right);
    if (order !== 0) return order;
  }

  return 0;
}

/**
 * Whether `latest` is genuinely newer than `current`.
 *
 * False whenever either side cannot be parsed, and false when the two are
 * equal or the running build is *ahead* of the newest release — which is the
 * normal state of anyone running from a checkout between releases. Offering
 * them a downgrade would be worse than saying nothing.
 */
export function isUpdateAvailable(current: string, latest: string): boolean {
  const from = parseVersion(current);
  const to = parseVersion(latest);
  if (from === null || to === null) return false;

  return compareVersions(to, from) > 0;
}
