export interface GelfMessage {
  version: '1.1'
  host: string
  short_message: string
  full_message?: string
  timestamp: number
  level: number
  [key: string]: unknown
}

/**
 * Formats one log record (a Pino JSON line, a Buffer, or an object) as a
 * GELF 1.1 JSON string.
 */
export type GelfFormatter = (chunk: unknown) => string

// Pino fields that are mapped to standard GELF fields (or dropped) rather than
// being sent as custom fields.
const EXCLUDED_FIELDS = new Set([
  'msg',
  'message',
  'level',
  'time',
  'pid',
  'hostname',
  'stack',
  'v',
  'err',
])

const UNDERSCORE = 95 // '_'

export const mapPinoLevelToGelf = (pinoLevel: number | undefined): number => {
  // Pino levels: 10 trace, 20 debug, 30 info, 40 warn, 50 error, 60 fatal
  // GELF levels: 0 emergency, 1 alert, 2 critical, 3 error, 4 warning, 5 notice, 6 info, 7 debug
  if (!pinoLevel) return 6 // default to info
  if (pinoLevel >= 60) return 2 // fatal -> critical
  if (pinoLevel >= 50) return 3 // error
  if (pinoLevel >= 40) return 4 // warning
  if (pinoLevel >= 30) return 6 // info
  if (pinoLevel >= 20) return 7 // debug
  return 7 // trace -> debug
}

function isJsonWhitespace(code: number): boolean {
  return code === 32 || code === 10 || code === 13 || code === 9
}

function parseChunk(chunk: unknown): Record<string, unknown> {
  // Objects are passed through as-is
  if (typeof chunk === 'object' && chunk !== null && !Buffer.isBuffer(chunk)) {
    return chunk as Record<string, unknown>
  }

  let str = ''
  if (typeof chunk === 'string') {
    str = chunk
  } else if (Buffer.isBuffer(chunk)) {
    str = chunk.toString()
  }

  // Only try parsing if it looks like JSON: this avoids throwing on plain
  // text logs. Scan for the first non-whitespace character instead of
  // trim(), which would copy the whole line.
  let i = 0
  while (i < str.length && isJsonWhitespace(str.charCodeAt(i))) i++
  const first = str.charCodeAt(i)
  if (first === 123 /* { */ || first === 91 /* [ */) {
    try {
      const parsed = JSON.parse(str)
      if (typeof parsed === 'object' && parsed !== null) return parsed
    } catch {
      // Looked like JSON but wasn't: send it as a plain message below
    }
  }

  return { msg: str }
}

function extractMessage(obj: Record<string, unknown>): string {
  if (typeof obj.msg === 'string') return obj.msg
  if (typeof obj.message === 'string') return obj.message
  if (typeof obj.short_message === 'string') return obj.short_message
  return JSON.stringify(obj)
}

function extractStack(obj: Record<string, unknown>): string | undefined {
  if (typeof obj.stack === 'string') return obj.stack
  const err = obj.err as Record<string, unknown> | undefined | null
  if (typeof err?.stack === 'string') return err.stack
  return undefined
}

// GELF does not support nested objects, so objects are sent as JSON strings
function toGelfValue(value: unknown): unknown {
  return typeof value === 'object' ? JSON.stringify(value) : value
}

function toFieldName(key: string): string {
  return key.charCodeAt(0) === UNDERSCORE ? key : `_${key}`
}

// Encode `,"name":value` for one field, or '' when JSON would omit the value
// (functions, symbols, undefined).
function encodeField(name: string, value: unknown): string {
  const encodedValue = JSON.stringify(value)
  return encodedValue === undefined
    ? ''
    : `,${JSON.stringify(name)}:${encodedValue}`
}

/** How one record key is sent; null means the key is never sent as a custom field. */
type KeyPlan = {
  /** `,"_name":`, ready to be followed by the encoded value */
  prefix: string
  /** The other key that maps to the same field (`foo` <-> `_foo`) */
  twin: string
  /** True when the field is `_pid`, which the record's own pid overrides */
  isPid: boolean
} | null

// Record keys repeat across messages, so how each one is sent is worked out
// once and cached per formatter. Bounded so that high-cardinality keys cannot
// grow it without limit.
const MAX_CACHED_KEYS = 1000

/**
 * Creates a formatter for one transport. The parts of every message that do
 * not change (host, facility, static metadata) are encoded once here, and each
 * message is written straight to a JSON string without building an
 * intermediate GELF object.
 *
 * Field precedence: standard GELF fields, then `_facility` and static
 * metadata, then the record's own fields (first one wins when `foo` and `_foo`
 * are both present). The record's `pid` is always sent as `_pid`.
 */
export function createGelfFormatter(
  hostname: string,
  facility: string,
  staticMeta: Record<string, unknown> = {},
): GelfFormatter {
  // Static fields, resolved in the same order they are applied:
  // _facility first, then staticMeta (which may override _facility).
  const staticFields: Record<string, unknown> = {}
  if (facility) staticFields._facility = facility
  for (const key in staticMeta) {
    const value = staticMeta[key]
    if (value !== undefined && value !== null) {
      staticFields[toFieldName(key)] = toGelfValue(value)
    }
  }

  let staticPart = ''
  let staticPartWithoutPid = ''
  for (const name in staticFields) {
    const encoded = encodeField(name, staticFields[name])
    staticPart += encoded
    if (name !== '_pid') staticPartWithoutPid += encoded
  }

  const head = `{"version":"1.1","host":${JSON.stringify(hostname)},"short_message":`

  const keyPlans = new Map<string, KeyPlan>()
  const planKey = (key: string): KeyPlan => {
    let plan = keyPlans.get(key)
    if (plan !== undefined) return plan

    const fieldName = toFieldName(key)
    // Excluded Pino fields and fields set by _facility/static metadata are
    // never sent from the record
    plan =
      EXCLUDED_FIELDS.has(key) || fieldName in staticFields
        ? null
        : {
            prefix: `,${JSON.stringify(fieldName)}:`,
            twin: key.charCodeAt(0) === UNDERSCORE ? key.slice(1) : fieldName,
            isPid: fieldName === '_pid',
          }
    if (keyPlans.size < MAX_CACHED_KEYS) keyPlans.set(key, plan)
    return plan
  }

  // One of the record's own fields as `,"_name":value`, or '' to skip it.
  // `custom` is what has been encoded for this record so far.
  const encodeCustomField = (
    obj: Record<string, unknown>,
    key: string,
    hasPid: boolean,
    custom: string,
  ): string => {
    const value = obj[key]
    if (value === undefined || value === null) return ''

    const plan = planKey(key)
    if (plan === null || (hasPid && plan.isPid)) return ''

    // `foo` and `_foo` both map to `_foo`: keep the first one. Encoded
    // values cannot contain an unescaped `,"`, so this only matches keys.
    if (plan.twin in obj && custom.includes(plan.prefix)) return ''

    const encodedValue = JSON.stringify(
      typeof value === 'object' ? JSON.stringify(value) : value,
    )
    return encodedValue === undefined ? '' : plan.prefix + encodedValue
  }

  return (chunk: unknown): string => {
    const obj = parseChunk(chunk)

    // Keep Pino's time (ms since epoch) so queued messages keep their event
    // time; fall back to now for records without one.
    const timestamp =
      typeof obj.time === 'number' ? obj.time * 1e-3 : Date.now() * 1e-3

    // The record's pid always wins over a static or custom `_pid`
    const pid = obj.pid
    const hasPid = Boolean(pid)

    let out =
      head +
      JSON.stringify(extractMessage(obj)) +
      ',"timestamp":' +
      (Number.isFinite(timestamp) ? timestamp : 'null') +
      ',"level":' +
      mapPinoLevelToGelf(obj.level as number) +
      (hasPid ? staticPartWithoutPid : staticPart)

    const stack = extractStack(obj)
    if (stack !== undefined) {
      out += `,"full_message":${JSON.stringify(stack)}`
    }

    let custom = ''
    for (const key in obj) {
      custom += encodeCustomField(obj, key, hasPid, custom)
    }
    out += custom

    if (hasPid) {
      out += encodeField('_pid', pid)
    }

    return `${out}}`
  }
}

/**
 * Formats a single message. Prefer createGelfFormatter() when formatting many
 * messages with the same settings.
 */
export function formatGelfMessage(
  chunk: unknown,
  hostname: string,
  facility: string,
  staticMeta: Record<string, unknown> = {},
): string {
  return createGelfFormatter(hostname, facility, staticMeta)(chunk)
}
