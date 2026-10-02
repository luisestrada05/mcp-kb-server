/**
 * YAML turns unquoted scalars into numbers, booleans or dates — `[cierre, 422]`
 * reads as `['cierre', 422]`. Fields that become search terms or code refs must
 * be lists of strings, so validation rejects anything else before ingestion
 * trips over it (`t.toLowerCase is not a function`).
 */

/** Errors for `value` if it is present and not a list of non-empty strings. */
export function stringListErrors(value: unknown, label: string, field: string): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) return [`${label}: "${field}" debe ser una lista`]
  const errors: string[] = []
  value.forEach((item, i) => {
    if (typeof item !== 'string' || item.trim() === '') {
      errors.push(
        `${label}: ${field}[${i}] = ${JSON.stringify(item)} no es texto — ponlo entre comillas`
      )
    }
  })
  return errors
}
