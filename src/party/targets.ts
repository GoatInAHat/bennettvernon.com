import { useEffect } from 'react'

export type TargetKind = 'dot' | 'nav' | 'block'

export interface EffectorTarget {
  id: string
  kind: TargetKind
  el: HTMLElement
}

export interface HoverState {
  kind: 'dot' | 'nav'
  id: string
}

// ponytail: module-level singleton registry, context is overkill for one canvas
const targets = new Map<string, EffectorTarget>()
let hovered: HoverState | null = null
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

export function getHovered(): HoverState | null {
  return hovered
}

export function setHovered(state: HoverState | null): void {
  hovered = state
  notify()
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
