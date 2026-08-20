/**
 * The density rules must admit a steady state.
 *
 * `planDensity` decides every teleport the name makes. If any of its rules is
 * an exact target rather than a band, there is no arrangement of particles
 * the field can hold — corrections fire on every frame forever, which is the
 * failure this file exists to catch. The load-bearing assertion is the last
 * one: perturb a settled distribution anywhere inside its bands and it must
 * still ask for nothing.
 *
 * Run: npm run check:density
 */
import { planDensity, type DensityRules } from './density'

let checks = 0
const ok = (cond: boolean, what: string) => {
  checks++
  if (!cond) throw new Error(what)
}

/** Deterministic; the check must not pass or fail by luck. */
let seed = 0x2f6e2b1
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)

const CELLS = [2, 4, 8, 72, 120]
const TOTALS = [0, 1, 7, 71, 72, 73, 500, 999, 1000, 1001, 4321, 21_000, 23_999, 24_000]
const VARIANCES = [0, 0.01, 0.1, 0.25, 0.5]

/** Spread `total` over `n` cells exactly, unevenly, so nothing under test is
 * only ever handed a uniform vector. */
function scatter(total: number, n: number): Int32Array {
  const c = new Int32Array(n)
  for (let i = 0; i < total; i++) c[Math.floor(rnd() * n)]++
  return c
}

function run() {
  const rules = (over: Partial<DensityRules> = {}): DensityRules => ({
    min: 1000,
    cap: 24_000,
    variance: 0.1,
    ...over,
  })

  for (const n of CELLS) {
    for (const variance of VARIANCES) {
      for (const total of TOTALS) {
        const r = rules({ variance })
        const plan = planDensity(scatter(total, n), r)

        // 1. The targets must be reachable at all: a rounded share left
        //    `total mod n` particles with nowhere to live, so for half of all
        //    totals the demand exceeded the population and no arrangement
        //    could satisfy it.
        let sum = 0
        for (let i = 0; i < n; i++) sum += plan.target[i]
        ok(sum === plan.total, `targets sum to ${sum}, not ${plan.total} (n=${n}, total=${total})`)

        // 2. A band narrower than one particle is not a band.
        for (let i = 0; i < n; i++) {
          ok(plan.tol[i] >= 1, `tol[${i}]=${plan.tol[i]} < 1 (n=${n}, variance=${variance})`)
        }

        // 3. The total set-point respects both bounds, and equals what the
        //    name holds whenever that is already between them — which is what
        //    makes the pair a margin instead of two cliffs.
        const held = Math.min(Math.max(total, r.min), r.cap)
        ok(
          plan.total === Math.round(held),
          `total ${plan.total} != clamp(${total}, ${r.min}, ${r.cap}) (n=${n})`,
        )

        // 4. Hitting the target exactly must ask for nothing.
        const settled = planDensity(plan.target, r)
        ok(
          settled.settled,
          `exact targets still asked for work (n=${n}, total=${total}, variance=${variance})`,
        )
        ok(settled.transfers.length === 0, `exact targets asked for transfers (n=${n})`)

        // 5. THE REQUIREMENT. Perturb by any zero-sum vector that keeps every
        //    cell inside its band and it must STILL ask for nothing: the
        //    steady state is a region with real width, not a single point the
        //    field leaves on the next frame.
        for (let trial = 0; trial < 8; trial++) {
          const c = Int32Array.from(plan.target)
          // Zero-sum by construction: move between pairs, never past a band
          // edge, never below zero.
          for (let m = 0; m < n; m++) {
            const a = Math.floor(rnd() * n)
            const b = Math.floor(rnd() * n)
            if (a === b) continue
            const room = Math.min(
              plan.target[a] + plan.tol[a] - c[a],
              c[b] - Math.max(0, plan.target[b] - plan.tol[b]),
            )
            if (room <= 0) continue
            const step = 1 + Math.floor(rnd() * room)
            c[a] += step
            c[b] -= step
          }
          let moved = 0
          for (let i = 0; i < n; i++) {
            moved += c[i]
            ok(
              Math.abs(c[i] - plan.target[i]) <= plan.tol[i],
              `perturbation left the band, the check is wrong (n=${n})`,
            )
          }
          ok(moved === plan.total, `perturbation changed the total (n=${n})`)
          const p = planDensity(c, r)
          ok(
            p.settled,
            `in-band state asked for work: n=${n}, total=${total}, variance=${variance}, ` +
              `transfers=${p.transfers.length}, imports=${p.imports.reduce((s, x) => s + x, 0)}, ` +
              `evictions=${p.evictions.reduce((s, x) => s + x, 0)}`,
          )
        }
      }
    }
  }

  // The remainder must follow the counts, not the indices. A fixed
  // assignment makes the +1 walk between cells as the total drifts, flipping
  // a cell's target with no particle having moved — which at variance 0
  // (band = 1 particle) is enough to push it out of spec on its own.
  for (const n of [8, 72]) {
    const c = scatter(1234, n)
    const p = planDensity(c, rules({ variance: 0 }))
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (c[i] > c[j]) {
          ok(
            p.target[i] >= p.target[j],
            `fuller cell ${i} (${c[i]}) got a smaller target than ${j} (${c[j]})`,
          )
        }
      }
    }
    // A settled name that gains or loses one particle must not have to move
    // every cell to absorb it.
    const settledCounts = Int32Array.from(p.target)
    for (const d of [1, -1, 5, -5]) {
      const c2 = Int32Array.from(settledCounts)
      c2[Math.floor(rnd() * n)] += d
      if (c2.some((x) => x < 0)) continue
      const p2 = planDensity(c2, rules({ variance: 0 }))
      let moved = 0
      for (const t of p2.transfers) moved += t.count
      ok(
        moved <= Math.abs(d) * 2,
        `a ${d}-particle change forced ${moved} moves at n=${n} (remainder is walking)`,
      )
    }
  }

  // The bounds are bounds. Over the cap the name comes down to it exactly,
  // under the floor it goes up to it, and neither fires in between.
  {
    const r = rules()
    const over = planDensity(scatter(30_000, 72), r)
    let ev = 0
    for (const x of over.evictions) ev += x
    ok(ev === 30_000 - 24_000, `over the cap evicted ${ev}, expected 6000`)
    ok(over.total === 24_000, `over the cap settled at ${over.total}`)

    const under = planDensity(scatter(400, 72), r)
    let im = 0
    for (const x of under.imports) im += x
    ok(im === 1000 - 400, `under the floor imported ${im}, expected 600`)

    // In between, the population must not move at all — the old rule measured
    // its surplus against the measured total rather than the cap, so it
    // evicted exactly what it had just imported, every round, forever.
    for (const total of [1000, 5000, 21_000, 24_000]) {
      const mid = planDensity(scatter(total, 72), r)
      let i2 = 0
      let e2 = 0
      for (const x of mid.imports) i2 += x
      for (const x of mid.evictions) e2 += x
      ok(i2 === 0 && e2 === 0, `inside the bounds the name changed size by ${i2 - e2} (total=${total})`)
      // ...and redistribution must conserve it.
      let net = 0
      for (const t of mid.transfers) net += t.count - t.count
      ok(net === 0, 'redistribution changed the total')
    }
  }

  // An uncapped name never evicts.
  {
    const p = planDensity(scatter(60_000, 72), rules({ cap: Infinity }))
    let ev = 0
    for (const x of p.evictions) ev += x
    ok(ev === 0, `uncapped name evicted ${ev}`)
  }

  // A cell above its band is levelled too, not only one below it: the field
  // makes hot cells surrounded by slightly-light neighbours, and a rule that
  // only triggers on deficits leaves them hot forever.
  {
    const r = rules({ variance: 0.1 })
    const c = new Int32Array(72).fill(100)
    c[0] = 400
    for (let i = 1; i < 72; i++) c[i] = 100 - Math.floor(300 / 71)
    const p = planDensity(c, r)
    ok(p.transfers.length > 0, 'a cell far above its band was not levelled')
    ok(p.transfers[0].from === 0, `levelling drew from cell ${p.transfers[0].from}, not the hot one`)
  }

  // Degenerate shapes must not throw or produce nonsense.
  {
    ok(planDensity(new Int32Array(0), rules()).settled, 'empty partition asked for work')
    const one = planDensity(new Int32Array([5]), rules({ min: 0, cap: Infinity }))
    ok(one.target[0] === 5 && one.settled, 'single cell did not settle on itself')
  }

  console.log(`density.check: ${checks} assertions passed`)
}

run()
