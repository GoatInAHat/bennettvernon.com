import { useEffect } from 'react'

export type TargetKind = 'block' | 'panel'

export interface EffectorTarget {
  id: string
  kind: TargetKind
  el: HTMLElement
}

// ponytail: module-level singleton registry, context is overkill for one canvas
const targets = new Map<string, EffectorTarget>()
const listeners = new Set<() => void>()

function notify() {
  for (const fn of listeners) fn()
}

export function onTargetsChanged(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function getTargets(): EffectorTarget[] {
  return [...targets.values()]
}

/** Registers a DOM element as a particle effector target. */
export function useEffectorTarget(
  id: string,
  kind: TargetKind,
  ref: React.RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    targets.set(id, { id, kind, el })
    notify()
    return () => {
      targets.delete(id)
      notify()
    }
  }, [id, kind, ref])
}
