/**
 * Translation between the `SupplyLevel` union and the flat columns that store
 * it.
 *
 * Kept in one place because supplies, supply history, and media sources all use
 * the same five columns, and a mismatch between how one of them writes and how
 * it reads would surface as a silently wrong level rather than an error.
 */
import type { SupplyLevel, SupplyUnit } from '../devices/types.js';

export interface LevelColumns {
  levelKind: string;
  levelValue: number | null;
  levelMax: number | null;
  levelUnit: string | null;
  levelState: string | null;
}

const UNITS = new Set<SupplyUnit>([
  'percent',
  'impressions',
  'sheets',
  'millilitres',
  'hours',
  'other',
]);

export function levelToColumns(level: SupplyLevel): LevelColumns {
  switch (level.kind) {
    case 'percent':
      return {
        levelKind: 'percent',
        levelValue: level.percent,
        levelMax: null,
        levelUnit: null,
        levelState: null,
      };
    case 'absolute':
      return {
        levelKind: 'absolute',
        levelValue: level.value,
        levelMax: level.max,
        levelUnit: level.unit,
        levelState: null,
      };
    case 'binary':
      return {
        levelKind: 'binary',
        levelValue: null,
        levelMax: null,
        levelUnit: null,
        levelState: level.state,
      };
    case 'unknown':
      return {
        levelKind: 'unknown',
        levelValue: null,
        levelMax: null,
        levelUnit: null,
        levelState: null,
      };
  }
}

/**
 * Rebuilds a level from stored columns.
 *
 * Anything malformed degrades to `unknown` rather than throwing: a row written
 * by an older version, or hand-edited, should cost one reading rather than
 * taking down the poller that was about to overwrite it anyway.
 */
export function levelFromColumns(row: Partial<LevelColumns>): SupplyLevel {
  switch (row.levelKind) {
    case 'percent':
      return row.levelValue === null || row.levelValue === undefined
        ? { kind: 'unknown' }
        : { kind: 'percent', percent: row.levelValue };

    case 'absolute': {
      const { levelValue: value, levelMax: max } = row;
      if (value === null || value === undefined || max === null || max === undefined) {
        return { kind: 'unknown' };
      }
      const unit = (row.levelUnit ?? 'other') as SupplyUnit;
      return {
        kind: 'absolute',
        value,
        max,
        unit: UNITS.has(unit) ? unit : 'other',
      };
    }

    case 'binary':
      return {
        kind: 'binary',
        state: row.levelState === 'attention' ? 'attention' : 'ok',
      };

    default:
      return { kind: 'unknown' };
  }
}

/**
 * True when two levels differ enough to be worth a history row.
 *
 * History exists to show movement, so an unchanged reading — including one that
 * is unknown twice running — must not append.
 */
export function levelsDiffer(a: SupplyLevel | undefined, b: SupplyLevel): boolean {
  if (a === undefined) return true;
  if (a.kind !== b.kind) return true;

  switch (b.kind) {
    case 'percent':
      return a.kind === 'percent' && a.percent !== b.percent;
    case 'absolute':
      return a.kind === 'absolute' && (a.value !== b.value || a.max !== b.max);
    case 'binary':
      return a.kind === 'binary' && a.state !== b.state;
    case 'unknown':
      return false;
  }
}
