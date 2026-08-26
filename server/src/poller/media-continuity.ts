/**
 * Whether a fresh media reading may replace the one already held.
 *
 * The failure this exists to stop: a printer waking from sleep answers
 * Get-Printer-Attributes successfully but omits `media-col-ready`, so every
 * slot normalises to "not loaded, no type, no width". That is a *successful*
 * read, so nothing downstream treats it as an error — it simply overwrites the
 * roll type and width the last good poll established, in the cache and in
 * SQLite, and the paper panel goes blank on a printer with paper in it.
 *
 * The rule is deliberately narrow. Absence of evidence is only treated as
 * "keep what you have" when there is something to keep and the new reading
 * genuinely saw nothing; a device that really has an empty tray still reports
 * an empty tray, and a first poll is still accepted.
 */
import type { MediaSource } from '../devices/types.js';

export interface MediaContinuity {
  /** What the cache currently holds for this device. */
  existing: readonly MediaSource[];
  /** What the adapter just produced. */
  incoming: readonly MediaSource[];
  /**
   * Whether the device actually reported loaded-media evidence in this read.
   *
   * For IPP that is the presence of `media-col-ready`; for SNMP it is whether
   * the `prtInput` table returned any rows at all. False means "could not
   * see", which is not the same claim as "nothing is loaded".
   */
  reported: boolean;
}

export function shouldReplaceMedia(continuity: MediaContinuity): boolean {
  const { existing, incoming, reported } = continuity;

  // The device answered the question, so its answer wins — including when the
  // answer is that a roll has been taken out.
  if (reported) return true;

  // Nothing worth protecting: a first poll, or a device whose slots were
  // already all empty. Take the new reading so slot enumeration still updates.
  if (!existing.some((source) => source.isLoaded)) return true;

  // The adapter inferred loadedness some other way (SNMP reads it off the tray
  // level, not off a dedicated attribute), so this is real evidence after all.
  if (incoming.some((source) => source.isLoaded)) return true;

  return false;
}
