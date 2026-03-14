import * as React from "react"
import { format } from "date-fns"
import { Calendar as CalendarIcon, X } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

interface DateTimePickerProps {
  date: Date | undefined
  setDate: (date: Date | undefined) => void
}

function isToday(date: Date): boolean {
  const now = new Date()
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  )
}

/** Returns the earliest valid hour for a given date (0–23). */
function minHourFor(date: Date | undefined): number {
  if (!date || !isToday(date)) return 0
  const now = new Date()
  // Need at least 5 min in the future; if current minute >= 55, bump to next hour
  return now.getMinutes() >= 55 ? now.getHours() + 1 : now.getHours()
}

/** Returns the earliest valid minute for a given date + hour. */
function minMinuteFor(date: Date | undefined, hour: number): number {
  if (!date || !isToday(date)) return 0
  const now = new Date()
  if (hour > now.getHours()) return 0
  if (hour === now.getHours()) return now.getMinutes() + 5
  return 60 // entire hour is invalid → caller should not offer these minutes
}

/** Clamps a Date to be at least 5 minutes in the future. */
function clampToFuture(date: Date): Date {
  const minMs = Date.now() + 5 * 60 * 1000
  if (date.getTime() <= minMs) {
    return new Date(minMs)
  }
  return date
}

/** Default time when picking a new date: next whole hour that is in the future. */
function defaultTimeFor(date: Date): { hour: number; minute: number } {
  if (!isToday(date)) return { hour: 9, minute: 0 }
  const now = new Date()
  return { hour: now.getHours() + 1, minute: 0 }
}

export function DateTimePicker({ date, setDate }: DateTimePickerProps) {
  const [selectedDate, setSelectedDate] = React.useState<Date | undefined>(date)
  const [selectedHour, setSelectedHour] = React.useState(
    date ? date.getHours() : 9
  )
  const [selectedMinute, setSelectedMinute] = React.useState(
    date ? date.getMinutes() : 0
  )
  const [open, setOpen] = React.useState(false)

  React.useEffect(() => {
    if (date) {
      setSelectedDate(date)
      setSelectedHour(date.getHours())
      setSelectedMinute(date.getMinutes())
    }
  }, [date])

  const handleDateSelect = (newDate: Date | undefined) => {
    if (!newDate) {
      setSelectedDate(undefined)
      setDate(undefined)
      return
    }

    const { hour, minute } = defaultTimeFor(newDate)
    const h = isToday(newDate) ? Math.max(selectedHour, hour) : selectedHour
    const m = isToday(newDate) && h === hour ? Math.max(selectedMinute, minute) : selectedMinute

    newDate.setHours(h, m, 0, 0)
    const clamped = clampToFuture(newDate)

    setSelectedDate(clamped)
    setSelectedHour(clamped.getHours())
    setSelectedMinute(clamped.getMinutes())
    setDate(clamped)
  }

  const handleHourChange = (hour: number) => {
    setSelectedHour(hour)
    if (!selectedDate) return

    const d = new Date(selectedDate)
    d.setHours(hour, selectedMinute, 0, 0)
    const clamped = clampToFuture(d)

    // If clamping changed the minute too, sync it
    if (clamped.getMinutes() !== selectedMinute) {
      setSelectedMinute(clamped.getMinutes())
    }
    setSelectedDate(clamped)
    setDate(clamped)
  }

  const handleMinuteChange = (minute: number) => {
    setSelectedMinute(minute)
    if (!selectedDate) return

    const d = new Date(selectedDate)
    d.setHours(selectedHour, minute, 0, 0)
    const clamped = clampToFuture(d)
    setSelectedDate(clamped)
    setDate(clamped)
  }

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation()
    setSelectedDate(undefined)
    setSelectedHour(9)
    setSelectedMinute(0)
    setDate(undefined)
    setOpen(false)
  }

  const minHour = minHourFor(selectedDate)
  const minMinute = minMinuteFor(selectedDate, selectedHour)

  const displayValue = date
    ? format(date, "MMM d, yyyy 'at' h:mm a")
    : "Select date and time"

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant={"outline"}
          className={cn(
            "w-full justify-start text-left font-normal h-9 px-3",
            !date && "text-muted-foreground"
          )}
        >
          <CalendarIcon className="mr-2 h-4 w-4 shrink-0" />
          <span className="truncate flex-1">{displayValue}</span>
          {date && (
            <X
              className="h-4 w-4 ml-auto shrink-0 text-muted-foreground hover:text-foreground"
              onClick={handleClear}
            />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start" sideOffset={4}>
        <Calendar
          mode="single"
          selected={selectedDate}
          onSelect={handleDateSelect}
          disabled={(d) => {
            const today = new Date()
            today.setHours(0, 0, 0, 0)
            return d < today
          }}
          initialFocus
        />
        <div className="p-3 flex items-center gap-2 border-t">
          <span className="text-sm text-muted-foreground shrink-0">Time:</span>
          <select
            value={selectedHour}
            onChange={(e) => handleHourChange(parseInt(e.target.value))}
            className="h-8 rounded-md border border-input bg-background px-2 py-1 text-sm min-w-[60px]"
          >
            {Array.from({ length: 24 }, (_, i) => (
              <option key={i} value={i} disabled={i < minHour}>
                {i.toString().padStart(2, "0")}
              </option>
            ))}
          </select>
          <span className="text-muted-foreground">:</span>
          <select
            value={selectedMinute}
            onChange={(e) => handleMinuteChange(parseInt(e.target.value))}
            className="h-8 rounded-md border border-input bg-background px-2 py-1 text-sm min-w-[60px]"
          >
            {Array.from({ length: 60 }, (_, i) => (
              <option key={i} value={i} disabled={i < minMinute}>
                {i.toString().padStart(2, "0")}
              </option>
            ))}
          </select>
        </div>
      </PopoverContent>
    </Popover>
  )
}
