import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Per-entity debounced saving.
 *
 * Two things make this different from a plain debounce, and both were learned
 * the hard way in PM v2:
 *
 * 1. The timer is keyed. A technician editing a room while a visit's technician
 *    name is also in flight must not have one save cancel the other, so each
 *    entity gets its own timer under its own key ('room:<id>', 'visit:<id>').
 *
 * 2. The save function reads the value at FIRE time, not at schedule time. If
 *    the callback closed over the entity as it looked when the keystroke
 *    happened, 600 ms of further typing would be written back stale — the last
 *    save would undo the last few characters. Callers pass a function that
 *    reaches into a ref, so whatever fires writes the newest value.
 *
 * `status` is 'idle' | 'saving' | 'saved' | 'error', for a save indicator.
 */
export function useAutosave(delay = 600) {
  const timers = useRef({})
  const [status, setStatus] = useState('idle')
  const [error, setError] = useState(null)

  // Pending timers must not fire after the page has gone, or they write into a
  // component that no longer exists and report status onto a dead setter.
  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const t of Object.values(pending)) clearTimeout(t.id)
    }
  }, [])

  const run = useCallback(async save => {
    try {
      await save()
      // Only claim "saved" if nothing else is still waiting to go out.
      if (Object.keys(timers.current).length === 0) setStatus('saved')
    } catch (e) {
      console.error(e)
      setError(e)
      setStatus('error')
    }
  }, [])

  const schedule = useCallback(
    (key, save) => {
      clearTimeout(timers.current[key]?.id)
      setStatus('saving')
      const id = setTimeout(() => {
        delete timers.current[key]
        run(save)
      }, delay)
      // The save function is kept beside its timer so flush() can still run it
      // after cancelling — cancelling a pending save without performing it is
      // how edits get silently dropped on navigation.
      timers.current[key] = { id, save }
    },
    [delay, run],
  )

  /** Performs every pending save immediately — for "before I leave" moments. */
  const flush = useCallback(async () => {
    const pending = Object.values(timers.current)
    timers.current = {}
    for (const { id } of pending) clearTimeout(id)
    await Promise.all(pending.map(({ save }) => run(save)))
  }, [run])

  return { schedule, flush, status, error }
}

/** Keeps a ref in step with a value, so a debounced save can read it at fire time. */
export function useLatest(value) {
  const ref = useRef(value)
  useEffect(() => {
    ref.current = value
  }, [value])
  return ref
}
