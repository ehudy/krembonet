/**
 * RFC 3805 (Printer MIB v2) and RFC 2790 (Host Resources) constants.
 *
 * Everything here is standard and vendor-neutral. That is the whole point of
 * the SNMP adapter: one implementation that reads toner and trays across HP,
 * Xerox, Brother, Lexmark, Ricoh, Kyocera and Sharp without a per-vendor branch.
 *
 * The vendor arc in `sysObjectID` is used *only* for a display label and for
 * ranking adapters during a probe. It must never change how anything is parsed
 * — the moment it does, this stops being a generic adapter.
 */

/** System group — identity. */
export const SYS = {
  descr: '1.3.6.1.2.1.1.1.0',
  objectId: '1.3.6.1.2.1.1.2.0',
  name: '1.3.6.1.2.1.1.5.0',
} as const;

/** Host Resources printer status. */
export const HR_PRINTER = {
  /** hrPrinterStatus */
  status: '1.3.6.1.2.1.25.3.5.1.1',
  /** hrPrinterDetectedErrorState, a bit field */
  errorState: '1.3.6.1.2.1.25.3.5.1.2',
} as const;

/** Printer MIB general group. */
export const PRT_GENERAL = {
  printerName: '1.3.6.1.2.1.43.5.1.1.16',
  serialNumber: '1.3.6.1.2.1.43.5.1.1.17',
} as const;

/**
 * prtMarkerSuppliesTable columns.
 *
 * `level` (.9) is the one everybody misreads: it is a raw value in `supplyUnit`
 * (.7) units measured against `maxCapacity` (.8), not a percentage.
 */
export const PRT_MARKER_SUPPLIES = {
  table: '1.3.6.1.2.1.43.11.1.1',
  colorantIndex: '1.3.6.1.2.1.43.11.1.1.3',
  class: '1.3.6.1.2.1.43.11.1.1.4',
  type: '1.3.6.1.2.1.43.11.1.1.5',
  description: '1.3.6.1.2.1.43.11.1.1.6',
  supplyUnit: '1.3.6.1.2.1.43.11.1.1.7',
  maxCapacity: '1.3.6.1.2.1.43.11.1.1.8',
  level: '1.3.6.1.2.1.43.11.1.1.9',
} as const;

/** prtMarkerColorantTable — colour is a *name* here, never a hex value. */
export const PRT_MARKER_COLORANT = {
  table: '1.3.6.1.2.1.43.12.1.1',
  value: '1.3.6.1.2.1.43.12.1.1.4',
} as const;

/** prtInputTable columns — paper sources. */
export const PRT_INPUT = {
  table: '1.3.6.1.2.1.43.8.2.1',
  type: '1.3.6.1.2.1.43.8.2.1.2',
  dimUnit: '1.3.6.1.2.1.43.8.2.1.3',
  mediaDimFeedDirDeclared: '1.3.6.1.2.1.43.8.2.1.4',
  mediaXFeedDirDeclared: '1.3.6.1.2.1.43.8.2.1.5',
  capacityUnit: '1.3.6.1.2.1.43.8.2.1.8',
  maxCapacity: '1.3.6.1.2.1.43.8.2.1.9',
  currentLevel: '1.3.6.1.2.1.43.8.2.1.10',
  mediaName: '1.3.6.1.2.1.43.8.2.1.12',
  name: '1.3.6.1.2.1.43.8.2.1.13',
  description: '1.3.6.1.2.1.43.8.2.1.18',
} as const;

/**
 * Negative values reserved by the MIB for levels and capacities.
 *
 * These are the reason the level model is a union. `-3` in particular is a
 * device saying "there is some left, I will not tell you how much", which no
 * single integer can represent honestly.
 */
export const LEVEL_SENTINEL = {
  /** A value exists but not in the stated unit. */
  OTHER: -1,
  /** The device does not know. */
  UNKNOWN: -2,
  /** Some remains; no number available. */
  SOME_REMAINING: -3,
} as const;

/** prtMarkerSuppliesClass. */
export const SUPPLY_CLASS = {
  OTHER: 1,
  CONSUMED: 3,
  RECEPTACLE: 4,
} as const;

/**
 * prtMarkerSuppliesType, mapped to our `SupplyType`.
 *
 * This is the vendor-neutral answer to "is this a waste tank?", and it is why
 * the adapter never has to inspect a description string to find out.
 */
export const SUPPLY_TYPE_BY_CODE: Readonly<Record<number, string>> = {
  1: 'other',
  2: 'other',
  3: 'toner',
  4: 'waste-toner',
  5: 'ink',
  6: 'ink',
  7: 'ink',
  8: 'waste-ink',
  9: 'drum',
  10: 'developer',
  11: 'fuser',
  12: 'other',
  13: 'other',
  14: 'waste-toner',
  15: 'fuser',
  16: 'other',
  17: 'fuser',
  18: 'cleaner',
  19: 'cleaner',
  20: 'other',
  21: 'toner',
  22: 'fuser',
  23: 'other',
  24: 'waste-ink',
  25: 'other',
  26: 'waste-toner',
  27: 'other',
  28: 'other',
  29: 'staples',
  30: 'other',
  31: 'other',
  32: 'staples',
  33: 'other',
  34: 'other',
};

/** PrtMarkerSuppliesSupplyUnitTC, mapped to our `SupplyUnit`. */
export const SUPPLY_UNIT_BY_CODE: Readonly<Record<number, string>> = {
  3: 'other', // tenThousandthsOfInches
  4: 'other', // micrometers
  7: 'impressions',
  8: 'sheets',
  11: 'hours',
  12: 'other', // thousandthsOfOunces
  13: 'other', // tenthsOfGrams
  14: 'other', // hundredthsOfFluidOunces
  15: 'millilitres', // tenthsOfMilliliters, rescaled on read
  16: 'other', // feet
  17: 'other', // meters
  18: 'other', // items
  19: 'percent',
};

/** prtInputType. */
export const INPUT_TYPE = {
  OTHER: 1,
  UNKNOWN: 2,
  SHEET_FEED_AUTO_REMOVABLE: 3,
  SHEET_FEED_AUTO_NON_REMOVABLE: 4,
  SHEET_FEED_MANUAL: 5,
  CONTINUOUS_ROLL: 6,
  CONTINUOUS_LONG_FAN_FOLD: 7,
} as const;

/** prtInputDimUnit — the only two values that appear in practice. */
export const DIM_UNIT = {
  TEN_THOUSANDTHS_OF_INCHES: 3,
  MICROMETERS: 4,
} as const;

/** hrPrinterStatus. */
export const HR_PRINTER_STATUS = {
  OTHER: 1,
  UNKNOWN: 2,
  IDLE: 3,
  PRINTING: 4,
  WARMUP: 5,
} as const;

/**
 * hrPrinterDetectedErrorState bits, in SNMP BITS order (bit 0 is the most
 * significant bit of the first octet).
 */
export const DETECTED_ERROR_BITS: readonly string[] = [
  'low paper',
  'no paper',
  'low toner',
  'no toner',
  'door open',
  'jammed',
  'offline',
  'service requested',
  'input tray missing',
  'output tray missing',
  'marker supply missing',
  'output near full',
  'output full',
  'input tray empty',
  'overdue preventive maintenance',
];

/**
 * Enterprise arcs under 1.3.6.1.4.1, for a vendor label only.
 *
 * Best-effort and deliberately consequence-free: an unrecognised vendor changes
 * nothing except the string shown next to the model. Verify any entry against
 * real hardware before relying on it for more than that.
 */
export const VENDOR_BY_ENTERPRISE: Readonly<Record<string, string>> = {
  '11': 'HP',
  '236': 'Samsung',
  '253': 'Xerox',
  '297': 'Panasonic',
  '367': 'Ricoh',
  '641': 'Lexmark',
  '674': 'Dell',
  '1248': 'Epson',
  '1347': 'Kyocera',
  '1602': 'Canon',
  '2001': 'OKI',
  '2385': 'Sharp',
  '2435': 'Brother',
  '18334': 'Konica Minolta',
};

const ENTERPRISE_PREFIX = '1.3.6.1.4.1.';

/** Vendor name from a `sysObjectID`, or null when the arc is unfamiliar. */
export function vendorFromSysObjectId(sysObjectId: string | undefined): string | null {
  if (sysObjectId === undefined || !sysObjectId.startsWith(ENTERPRISE_PREFIX)) return null;

  const arc = sysObjectId.slice(ENTERPRISE_PREFIX.length).split('.')[0] ?? '';
  return VENDOR_BY_ENTERPRISE[arc] ?? null;
}
