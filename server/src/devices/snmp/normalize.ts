/**
 * Turns an SNMP walk into the device-neutral shapes in `../types`.
 *
 * Pure: it takes a plain map of OID to value, so it is tested against captured
 * JSON walks rather than hardware. That split is what makes it possible to
 * develop this adapter without owning every printer it claims to support.
 *
 * The hard part is not the OIDs, it is refusing to invent numbers. RFC 3805
 * levels are raw values against a capacity, in units that are frequently not
 * percent, with negative sentinels for "unknown" and "some remaining". Reading
 * `prtMarkerSuppliesLevel` and rendering it as a percentage — which is what
 * most homegrown printer dashboards do — is wrong on a large fraction of real
 * devices.
 */
import type {
  DeviceState,
  MediaSource,
  MediaSourceType,
  Supply,
  SupplyKind,
  SupplyLevel,
  SupplyType,
  SupplyUnit,
} from '../types.js';
import {
  DETECTED_ERROR_BITS,
  DIM_UNIT,
  HR_PRINTER,
  HR_PRINTER_STATUS,
  INPUT_TYPE,
  LEVEL_SENTINEL,
  PRT_GENERAL,
  PRT_INPUT,
  PRT_MARKER_COLORANT,
  PRT_MARKER_SUPPLIES,
  SUPPLY_CLASS,
  SUPPLY_TYPE_BY_CODE,
  SUPPLY_UNIT_BY_CODE,
  SYS,
  vendorFromSysObjectId,
} from './oids.js';
import { cleanSupplyName } from '../supply-name.js';

/** A value read from an SNMP agent. Buffers survive for bit-field columns. */
export type SnmpValue = string | number | Buffer | null;

/** OID (fully qualified, including the row index) to value. */
export type SnmpWalk = Record<string, SnmpValue>;

// --- reading helpers ------------------------------------------------------

function asNumber(value: SnmpValue | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asString(value: SnmpValue | undefined): string | undefined {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value.trim();
  if (typeof value === 'number') return String(value);
  if (Buffer.isBuffer(value)) {
    const text = value.toString('utf8').replace(/\0+$/, '').trim();
    return text === '' ? undefined : text;
  }
  return undefined;
}

/**
 * Row indices present under a table column, in numeric order.
 *
 * Indices are compared numerically rather than lexically so supply 10 sorts
 * after supply 9 instead of after supply 1.
 */
export function rowIndices(walk: SnmpWalk, columnOid: string): string[] {
  const prefix = `${columnOid}.`;

  return Object.keys(walk)
    .filter((oid) => oid.startsWith(prefix))
    .map((oid) => oid.slice(prefix.length))
    .sort((a, b) => {
      const as = a.split('.').map(Number);
      const bs = b.split('.').map(Number);
      for (let i = 0; i < Math.max(as.length, bs.length); i += 1) {
        const diff = (as[i] ?? 0) - (bs[i] ?? 0);
        if (diff !== 0) return diff;
      }
      return 0;
    });
}

const cell = (walk: SnmpWalk, columnOid: string, index: string): SnmpValue | undefined =>
  walk[`${columnOid}.${index}`];

// --- levels ---------------------------------------------------------------

/**
 * Builds a level from a raw reading, its capacity, and its unit.
 *
 * Exported because it is the single most consequential function in the adapter
 * and deserves to be tested on its own.
 */
export function readSupplyLevel(
  level: number | undefined,
  maxCapacity: number | undefined,
  unitCode: number | undefined,
): SupplyLevel {
  if (level === undefined) return { kind: 'unknown' };

  // "There is some left, but no number." A device that says this and gets
  // rendered as a percentage is being misquoted.
  if (level === LEVEL_SENTINEL.SOME_REMAINING) {
    return { kind: 'binary', state: 'ok' };
  }
  if (level === LEVEL_SENTINEL.UNKNOWN || level === LEVEL_SENTINEL.OTHER || level < 0) {
    return { kind: 'unknown' };
  }

  const unit = (SUPPLY_UNIT_BY_CODE[unitCode ?? -1] ?? 'other') as SupplyUnit;

  // A device reporting in percent means it, whatever it put in maxCapacity.
  if (unit === 'percent') {
    return { kind: 'percent', percent: Math.max(0, Math.min(100, Math.round(level))) };
  }

  // Without a usable capacity the raw number cannot be turned into a ratio, and
  // a bare "1500 impressions" is not something to compare a threshold against.
  if (maxCapacity === undefined || maxCapacity <= 0) return { kind: 'unknown' };

  // tenthsOfMilliliters is the one unit worth rescaling, since the label would
  // otherwise read "3000 millilitres" for a 300ml tank.
  if (unitCode === 15) {
    return { kind: 'absolute', value: level / 10, max: maxCapacity / 10, unit: 'millilitres' };
  }

  return { kind: 'absolute', value: level, max: maxCapacity, unit };
}

/**
 * Re-expresses a receptacle's reading as how full it is.
 *
 * This is the single most consequential asymmetry in the Printer MIB, and
 * getting it wrong is what made healthy waste tanks alert. RFC 3805 defines
 * `prtMarkerSuppliesLevel` as "the current level if this supply is a container;
 * **the remaining space** if this supply is a receptacle" — so for a waste tank
 * the number counts *down* as the tank fills, exactly like an ink cartridge,
 * and it is the one supply where that is not what it looks like.
 *
 * Read literally, a freshly emptied tank reports nearly its whole capacity as
 * free space, which the rest of this codebase — where a receptacle's percentage
 * means percent *full* — then displayed as "98% full" and alerted on. The
 * device was right; the reading was inverted. docs/canon-tz32000-field-notes.md
 * §4 records the same thing against real hardware: `8000 / 10000` of space left
 * is a tank 20% full, and the IPP path already reports fullness directly, so
 * this is also what makes the two adapters agree about one physical tank.
 *
 * Applied to every receptacle the adapter identifies, by class or by supply
 * type, rather than to any particular model: the semantics come from the MIB,
 * so anything reading that table inherits them.
 *
 * The binary case is deliberately left alone. `-3` is "some remaining", which
 * for a receptacle means some space remains — the tank is not full — and `ok`
 * already says that.
 */
export function toReceptacleFullness(level: SupplyLevel): SupplyLevel {
  switch (level.kind) {
    case 'percent':
      return {
        kind: 'percent',
        percent: Math.max(0, Math.min(100, 100 - level.percent)),
      };
    case 'absolute': {
      // Guarded rather than trusted: a device reporting more free space than
      // the tank holds would otherwise produce a negative fullness.
      if (level.max <= 0) return { kind: 'unknown' };
      return {
        kind: 'absolute',
        value: Math.max(0, Math.min(level.max, level.max - level.value)),
        max: level.max,
        unit: level.unit,
      };
    }
    case 'binary':
    case 'unknown':
      return level;
  }
}

// --- supplies -------------------------------------------------------------

/** Colorant row index to its name, e.g. `1` → `black`. */
function colorantNames(walk: SnmpWalk): Map<string, string> {
  const names = new Map<string, string>();

  for (const index of rowIndices(walk, PRT_MARKER_COLORANT.value)) {
    const name = asString(cell(walk, PRT_MARKER_COLORANT.value, index));
    if (name !== undefined) {
      // The colorant index is the last sub-identifier; the marker index
      // precedes it.
      names.set(index.split('.').at(-1) ?? index, name.toLowerCase());
    }
  }

  return names;
}

/**
 * Colorant name to a display colour.
 *
 * SNMP gives a name, never a hex value, so a table is unavoidable. Keying it on
 * standard colour names rather than a vendor's own codes is what makes it work
 * across brands.
 */
const COLORANT_HEX: Readonly<Record<string, string>> = {
  black: '#111827',
  cyan: '#00b7eb',
  magenta: '#e5007d',
  yellow: '#ffd200',
  red: '#dc2626',
  green: '#16a34a',
  blue: '#2563eb',
  orange: '#ea580c',
  violet: '#7c3aed',
  gray: '#6b7280',
  grey: '#6b7280',
  'light black': '#4b5563',
  'matte black': '#4b5563',
  'photo black': '#1f2937',
  'light cyan': '#7dd3fc',
  'light magenta': '#f9a8d4',
  white: '#e5e7eb',
  clear: '#cbd5e1',
};

function colorFor(colorant: string | undefined, description: string): string | null {
  const candidates = [colorant, description.toLowerCase()];

  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const exact = COLORANT_HEX[candidate];
    if (exact !== undefined) return exact;
  }

  // Descriptions are vendor prose ("CANON Matte Black Ink Tank"), so a
  // longest-match scan finds "matte black" before it finds "black".
  const haystack = `${colorant ?? ''} ${description}`.toLowerCase();
  const match = Object.keys(COLORANT_HEX)
    .sort((a, b) => b.length - a.length)
    .find((name) => haystack.includes(name));

  return match === undefined ? null : (COLORANT_HEX[match] ?? null);
}

function classifySupply(
  classCode: number | undefined,
  typeCode: number | undefined,
): { kind: SupplyKind; type: SupplyType } {
  const type = (SUPPLY_TYPE_BY_CODE[typeCode ?? -1] ?? 'other') as SupplyType;

  // prtMarkerSuppliesClass is authoritative and vendor-neutral; the type enum
  // is the fallback for devices that leave the class at other(1).
  if (classCode === SUPPLY_CLASS.RECEPTACLE) return { kind: 'receptacle', type };
  if (classCode === SUPPLY_CLASS.CONSUMED) return { kind: 'consumable', type };

  const impliesReceptacle = type === 'waste-ink' || type === 'waste-toner';
  return { kind: impliesReceptacle ? 'receptacle' : 'consumable', type };
}

export function normalizeSupplies(walk: SnmpWalk): Supply[] {
  const colorants = colorantNames(walk);

  return rowIndices(walk, PRT_MARKER_SUPPLIES.description).map((index, position) => {
    const description = asString(cell(walk, PRT_MARKER_SUPPLIES.description, index)) ?? `Supply ${index}`;
    const { kind, type } = classifySupply(
      asNumber(cell(walk, PRT_MARKER_SUPPLIES.class, index)),
      asNumber(cell(walk, PRT_MARKER_SUPPLIES.type, index)),
    );

    const colorantIndex = asNumber(cell(walk, PRT_MARKER_SUPPLIES.colorantIndex, index));
    // Colorant index 0 means "no colorant", which is how waste tanks and drums
    // are reported — looking one up anyway would colour them black.
    const colorant =
      colorantIndex === undefined || colorantIndex === 0
        ? undefined
        : colorants.get(String(colorantIndex));

    const reported = readSupplyLevel(
      asNumber(cell(walk, PRT_MARKER_SUPPLIES.level, index)),
      asNumber(cell(walk, PRT_MARKER_SUPPLIES.maxCapacity, index)),
      asNumber(cell(walk, PRT_MARKER_SUPPLIES.supplyUnit, index)),
    );

    // The description is a parts-catalogue string ("Black Cartridge HP
    // W9060MC"); the label shows the colour and the SKU is kept for reordering.
    // colorHex still reads the raw description, which is where the colour word
    // and the colorant hints live.
    const { label, partNumber } = cleanSupplyName(description);

    return {
      index: position,
      // The row index is the stable key across polls; the description is prose
      // and can change with the device's configured language.
      name: index,
      label,
      partNumber,
      kind,
      type,
      // A receptacle's raw reading is free space, not contents. Everything
      // downstream — the "% full" label, the `above` alert rule — reads a
      // receptacle's percentage as fullness, so the conversion belongs here,
      // where the MIB's semantics are known, rather than in each consumer.
      level: kind === 'receptacle' ? toReceptacleFullness(reported) : reported,
      colorHex: colorFor(colorant, description),
    };
  });
}

// --- media ----------------------------------------------------------------

function mediaTypeFor(typeCode: number | undefined): MediaSourceType {
  switch (typeCode) {
    case INPUT_TYPE.CONTINUOUS_ROLL:
    case INPUT_TYPE.CONTINUOUS_LONG_FAN_FOLD:
      return 'roll';
    case INPUT_TYPE.SHEET_FEED_MANUAL:
      return 'manual';
    case INPUT_TYPE.SHEET_FEED_AUTO_REMOVABLE:
    case INPUT_TYPE.SHEET_FEED_AUTO_NON_REMOVABLE:
      return 'sheet-tray';
    default:
      return 'unknown';
  }
}

/** Declared media width to millimetres, honouring prtInputDimUnit. */
export function dimensionToMm(value: number | undefined, unitCode: number | undefined): number | null {
  if (value === undefined || value <= 0) return null;

  if (unitCode === DIM_UNIT.TEN_THOUSANDTHS_OF_INCHES) {
    return Math.round((value / 10_000) * 25.4 * 10) / 10;
  }
  if (unitCode === DIM_UNIT.MICROMETERS) {
    return Math.round((value / 1000) * 10) / 10;
  }
  return null;
}

export function normalizeMedia(walk: SnmpWalk): MediaSource[] {
  // Prefer the name column for row discovery, but fall back to the type column:
  // plenty of devices leave prtInputName empty while still populating the rest.
  const indices =
    rowIndices(walk, PRT_INPUT.name).length > 0
      ? rowIndices(walk, PRT_INPUT.name)
      : rowIndices(walk, PRT_INPUT.type);

  return indices.map((index) => {
    const typeCode = asNumber(cell(walk, PRT_INPUT.type, index));
    const level = readSupplyLevel(
      asNumber(cell(walk, PRT_INPUT.currentLevel, index)),
      asNumber(cell(walk, PRT_INPUT.maxCapacity, index)),
      asNumber(cell(walk, PRT_INPUT.capacityUnit, index)),
    );

    const name =
      asString(cell(walk, PRT_INPUT.name, index)) ??
      asString(cell(walk, PRT_INPUT.description, index)) ??
      `Input ${index}`;

    const widthMm = dimensionToMm(
      asNumber(cell(walk, PRT_INPUT.mediaXFeedDirDeclared, index)),
      asNumber(cell(walk, PRT_INPUT.dimUnit, index)),
    );

    // An explicitly empty tray is loaded = false; anything else we cannot
    // disprove counts as loaded, since most devices only report a level.
    const isLoaded =
      level.kind === 'percent'
        ? level.percent > 0
        : level.kind === 'absolute'
          ? level.value > 0
          : true;

    return {
      key: `input-${index}`,
      label: name,
      type: mediaTypeFor(typeCode),
      isLoaded,
      // prtInputMediaName is free text and frequently blank, but when a device
      // does fill it in it is the closest thing to a media code SNMP offers.
      mediaTypeCode: asString(cell(walk, PRT_INPUT.mediaName, index)) ?? null,
      widthMm,
      widthInches: widthMm === null ? null : Math.round((widthMm / 25.4) * 10) / 10,
      // No vendor-neutral OID reports remaining roll length. Only a
      // vendor-specific adapter could fill this in.
      lengthRemainingMm: null,
      level,
    };
  });
}

// --- state ----------------------------------------------------------------

/** Decodes the hrPrinterDetectedErrorState bit field into readable reasons. */
export function decodeErrorState(value: SnmpValue | undefined): string[] {
  if (!Buffer.isBuffer(value)) return [];

  const reasons: string[] = [];
  for (let bit = 0; bit < DETECTED_ERROR_BITS.length; bit += 1) {
    const byte = value[Math.floor(bit / 8)];
    if (byte === undefined) break;
    // SNMP BITS: bit 0 is the most significant bit of the first octet.
    if ((byte & (0x80 >> bit % 8)) !== 0) {
      reasons.push(DETECTED_ERROR_BITS[bit] as string);
    }
  }

  return reasons;
}

export function normalizeState(walk: SnmpWalk): {
  state: DeviceState;
  stateReasons: string[];
} {
  const [index] = rowIndices(walk, HR_PRINTER.status);
  const code = index === undefined ? undefined : asNumber(cell(walk, HR_PRINTER.status, index));

  const reasons = index === undefined ? [] : decodeErrorState(cell(walk, HR_PRINTER.errorState, index));

  let state: DeviceState;
  switch (code) {
    case HR_PRINTER_STATUS.IDLE:
      state = 'idle';
      break;
    case HR_PRINTER_STATUS.PRINTING:
    case HR_PRINTER_STATUS.WARMUP:
      state = 'processing';
      break;
    default:
      state = 'unknown';
  }

  // A device can report "idle" while its own error bits say the door is open.
  // Trusting the status word alone would show a jammed printer as Ready.
  const stopped = reasons.some((reason) =>
    ['jammed', 'door open', 'no paper', 'no toner', 'offline', 'service requested'].includes(
      reason,
    ),
  );

  return { state: stopped ? 'stopped' : state, stateReasons: reasons };
}

// --- identity -------------------------------------------------------------

export function normalizeIdentity(walk: SnmpWalk): {
  vendor: string | null;
  makeAndModel: string | null;
  serial: string | null;
  firmware: string | null;
} {
  const sysDescr = asString(walk[SYS.descr]);
  const [generalIndex] = rowIndices(walk, PRT_GENERAL.printerName);

  const printerName =
    generalIndex === undefined
      ? undefined
      : asString(cell(walk, PRT_GENERAL.printerName, generalIndex));
  const serial =
    generalIndex === undefined
      ? undefined
      : asString(cell(walk, PRT_GENERAL.serialNumber, generalIndex));

  return {
    vendor: vendorFromSysObjectId(asString(walk[SYS.objectId])),
    // sysDescr is usually the fuller string ("HP ETHERNET MULTI-ENVIRONMENT…"),
    // but prtGeneralPrinterName is the cleaner one when present.
    makeAndModel: printerName ?? sysDescr ?? null,
    serial: serial ?? null,
    // No standard OID carries firmware; sysDescr often embeds it, but parsing
    // that per vendor is exactly the branching this adapter exists to avoid.
    firmware: null,
  };
}
