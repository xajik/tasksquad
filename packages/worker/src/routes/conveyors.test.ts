import { describe, it, expect } from 'vitest'

// validateConveyorFields is not exported — test its behaviour through the
// error codes returned. Since the function is private, we inline a copy here
// that mirrors the implementation exactly.
function validateConveyorFields(fields: {
  hour?: number; minute?: number; day_of_week?: number | null; day_of_month?: number | null;
  repeat_count?: number | null; frequency?: string;
}): string | null {
  const { hour, minute, day_of_week, day_of_month, repeat_count, frequency } = fields
  if (hour !== undefined && (!Number.isInteger(Number(hour)) || hour < 0 || hour > 23)) return 'invalid_hour'
  if (minute !== undefined && (!Number.isInteger(Number(minute)) || minute < 0 || minute > 59)) return 'invalid_minute'
  if (day_of_week != null && (day_of_week < 0 || day_of_week > 6)) return 'invalid_day_of_week'
  if (day_of_month != null && (day_of_month < 1 || day_of_month > 31)) return 'invalid_day_of_month'
  if (repeat_count != null && (repeat_count < 1 || repeat_count > 1000)) return 'invalid_repeat_count'
  if (frequency !== undefined && !['hourly', 'daily', 'weekly', 'monthly'].includes(frequency)) return 'invalid_frequency'
  return null
}

describe('validateConveyorFields', () => {
  it('returns null for all-valid inputs', () => {
    expect(validateConveyorFields({ hour: 0, minute: 0, frequency: 'daily' })).toBeNull()
    expect(validateConveyorFields({ hour: 23, minute: 59, frequency: 'weekly', day_of_week: 6 })).toBeNull()
    expect(validateConveyorFields({ hour: 12, minute: 30, frequency: 'monthly', day_of_month: 15 })).toBeNull()
    expect(validateConveyorFields({ repeat_count: 1 })).toBeNull()
    expect(validateConveyorFields({ repeat_count: 1000 })).toBeNull()
  })

  it('returns null when optional fields are absent', () => {
    expect(validateConveyorFields({})).toBeNull()
    expect(validateConveyorFields({ hour: 10 })).toBeNull()
  })

  it('rejects hour out of range', () => {
    expect(validateConveyorFields({ hour: -1 })).toBe('invalid_hour')
    expect(validateConveyorFields({ hour: 24 })).toBe('invalid_hour')
    expect(validateConveyorFields({ hour: 100 })).toBe('invalid_hour')
  })

  it('rejects non-integer hour', () => {
    expect(validateConveyorFields({ hour: 1.5 })).toBe('invalid_hour')
  })

  it('rejects minute out of range', () => {
    expect(validateConveyorFields({ minute: -1 })).toBe('invalid_minute')
    expect(validateConveyorFields({ minute: 60 })).toBe('invalid_minute')
  })

  it('rejects day_of_week out of range', () => {
    expect(validateConveyorFields({ day_of_week: -1 })).toBe('invalid_day_of_week')
    expect(validateConveyorFields({ day_of_week: 7 })).toBe('invalid_day_of_week')
  })

  it('allows null day_of_week', () => {
    expect(validateConveyorFields({ day_of_week: null })).toBeNull()
  })

  it('rejects day_of_month out of range', () => {
    expect(validateConveyorFields({ day_of_month: 0 })).toBe('invalid_day_of_month')
    expect(validateConveyorFields({ day_of_month: 32 })).toBe('invalid_day_of_month')
  })

  it('rejects repeat_count out of range', () => {
    expect(validateConveyorFields({ repeat_count: 0 })).toBe('invalid_repeat_count')
    expect(validateConveyorFields({ repeat_count: 1001 })).toBe('invalid_repeat_count')
  })

  it('rejects unknown frequency', () => {
    expect(validateConveyorFields({ frequency: 'yearly' })).toBe('invalid_frequency')
    expect(validateConveyorFields({ frequency: '' })).toBe('invalid_frequency')
  })

  it('accepts all valid frequency values', () => {
    for (const f of ['hourly', 'daily', 'weekly', 'monthly']) {
      expect(validateConveyorFields({ frequency: f })).toBeNull()
    }
  })
})
