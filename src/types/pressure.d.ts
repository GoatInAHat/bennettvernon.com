declare module 'pressure' {
  interface PressureOptions {
    polyfill?: boolean
    polyfillSpeedUp?: number
    polyfillSpeedDown?: number
    only?: 'touch' | 'mouse' | 'pointer' | null
    preventSelect?: boolean
  }
  interface PressureCallbacks {
    start?(event: Event): void
    end?(): void
    startDeepPress?(event: Event): void
    endDeepPress?(): void
    change?(force: number, event: Event): void
    unsupported?(): void
  }
  const Pressure: {
    set(target: string | Element, callbacks: PressureCallbacks, options?: PressureOptions): void
  }
  export default Pressure
}
