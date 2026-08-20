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

/** Cells grouped into letters of deliberately uneven size, the way the real
 * partition is: the live name has 13 letters over 72 cells, three to seven
 * each, in proportion to how much ink the letter has. Equal groups would hide
 * the whole behaviour under test, which is that a per-letter cap bites the
 * letters holding the most. */
function letters(n: number, groups: number): Int32Array {
  const l = new Int32Array(n)
  if (groups <= 1 || n === 0) return l
  const sizes: number[] = []
  let left = n
  for (let g = 0; g < groups; g++) {
    const rest = groups - g - 1
    const size = g === groups - 1 ? left : Math.max(1, Math.min(left - rest, 1 + (g % 5)))
    sizes.push(size)
    left -= size
  }
  let i = 0
  for (let g = 0; g < sizes.length; g++) {
    for (let k = 0; k < sizes[g] && i < n; k++) l[i++] = g
  }
  return l
}

/** Per-letter totals of any per-cell vector. */
function byLetter(v: ArrayLike<number>, l: ArrayLike<number>): Map<number, number> {
  const m = new Map<number, number>()
  for (let i = 0; i < v.length; i++) m.set(l[i], (m.get(l[i]) ?? 0) + v[i])
  return m
}

function run() {
  const rules = (over: Partial<DensityRules> = {}): DensityRules => ({
    min: 1000,
    letterCap: Infinity,
    variance: 0.1,
    letter: new Int32Array(0),
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

        // 3. With no cap in play the set-point is exactly what the name holds,
        //    floored at the minimum — so inside the bounds the name never
        //    changes size and the floor is a margin, not a cliff.
        ok(
          plan.total === Math.max(total, r.min),
          `total ${plan.total} != max(${total}, ${r.min}) uncapped (n=${n})`,
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

  // THE CAP IS PER LETTER. Not per cell -- a cell is an arbitrary subdivision
  // nobody sees -- and not per name, which says nothing about how thick any
  // individual letter got: half the name could sit in one glyph and a
  // name-wide total would be none the wiser.
  {
    const n = 72
    const L = letters(n, 13)
    const sizeOf = byLetter(new Int32Array(n).fill(1), L)
    ok(new Set(sizeOf.values()).size > 1, 'the check itself needs letters of different sizes')

    // (a) No letter may ever be targeted above its cap, and (b) the targets
    // must still sum to the total EXACTLY -- the cap must not break the
    // identity that makes a zero-teleport state reachable at all.
    for (const cap of [200, 900, 5_000]) {
      for (const held of [0, 500, 5_000, 40_000, 200_000]) {
        const p = planDensity(scatter(held, n), rules({ letterCap: cap, letter: L, min: 1000 }))
        for (const [li, v] of byLetter(p.target, L)) {
          ok(v <= cap, `letter ${li} targeted ${v}, over its cap of ${cap} (held=${held})`)
        }
        let sum = 0
        for (let i = 0; i < n; i++) sum += p.target[i]
        ok(sum === p.total, `capped targets sum to ${sum}, not ${p.total}`)
      }
    }

    // (c) THE COMPOUNDING GUARD. A cap must thin only the letters that are
    // over it. Deriving the equal density from the whole name instead makes
    // capping feed back on itself: the clamped letters shed, the name total
    // drops, every other letter is then targeted at the lower density and
    // sheds too. Measured live before this was fixed, a cap of 1200 dragged a
    // 20,000-particle name below 5,000.
    {
      const q = 200 // uniform density: every letter starts at q per cell
      const c = new Int32Array(n).fill(q)
      const sizes = [...sizeOf.values()]
      const big = Math.max(...sizes)
      const cap = q * big - q // low enough that only the widest letters cap
      const p = planDensity(c, rules({ letterCap: cap, letter: L, min: 0 }))
      const got = byLetter(p.target, L)
      for (const [li, size] of sizeOf) {
        const startedAt = q * size
        if (startedAt <= cap) {
          ok(
            got.get(li) === startedAt,
            `letter ${li} held ${startedAt}, under the cap of ${cap}, but was thinned to ${got.get(li)}`,
          )
        } else {
          ok(got.get(li) === cap, `letter ${li} was over the cap but targeted ${got.get(li)}`)
        }
      }
    }

    // (d) And it must be a FIXED POINT: apply the plan, re-plan, and nothing
    // more may move. A compounding cap converges somewhere far below instead.
    {
      const cap = 900
      const r = rules({ letterCap: cap, letter: L, min: 0 })
      let c: Int32Array = scatter(40_000, n)
      let last = -1
      for (let step = 0; step < 12; step++) {
        const p = planDensity(c, r)
        c = Int32Array.from(p.target)
        last = p.total
      }
      const settledPlan = planDensity(c, r)
      ok(settledPlan.settled, `the capped plan never settled (total ${settledPlan.total})`)
      ok(
        settledPlan.total === last,
        `the capped total is still moving: ${last} then ${settledPlan.total}`,
      )
      // A letter whose equal-density share is under the cap is never pinned to
      // it -- the cap is a ceiling, not a target.
      const at = byLetter(settledPlan.target, L)
      let pinned = 0
      for (const v of at.values()) if (v === cap) pinned++
      ok(pinned > 0, 'nothing was capped at all')
      ok(pinned < at.size, 'every letter pinned at the cap, so the cap is acting as a target')

      // Far enough over and every letter does pin, and the ceiling is then the
      // sum of the LETTER caps -- not one name-wide cap, and not one per cell.
      let far: Int32Array = scatter(200_000, n)
      for (let step = 0; step < 12; step++) far = Int32Array.from(planDensity(far, r).target)
      const saturated = planDensity(far, r)
      ok(
        saturated.total === cap * sizeOf.size,
        `saturated at ${saturated.total}, expected ${sizeOf.size} letters x ${cap} ` +
          `(a name-wide cap would give ${cap}, a per-cell one ${cap * n})`,
      )
    }

    // The BIG letters cap first, and what the cap clamps off LEAVES the name
    // rather than moving to a letter with room -- moving it would make small
    // letters denser than large ones, equal density broken the other way, and
    // would turn a thinning control into a redistribution one.
    {
      const cap = 900
      const sizes = [...sizeOf.values()]
      const big = Math.max(...sizes)
      const small = Math.min(...sizes)
      // A density at which the biggest letter is over the cap and the
      // smallest is comfortably under it.
      const held = Math.round((cap / big) * n * 1.2)
      const p = planDensity(scatter(held, n), rules({ letterCap: cap, letter: L, min: 0 }))
      const got = byLetter(p.target, L)
      let bigCapped = false
      let smallCapped = false
      for (const [li, size] of sizeOf) {
        if (size === big && (got.get(li) ?? 0) >= cap) bigCapped = true
        if (size === small && (got.get(li) ?? 0) >= cap) smallCapped = true
      }
      ok(bigCapped, 'the biggest letter did not reach its cap first')
      ok(!smallCapped, 'the smallest letter capped at the same time as the biggest')
      ok(p.total < held, 'capping did not thin the name at all')
      let ev = 0
      for (const x of p.evictions) ev += x
      ok(ev === held - p.total, `evicted ${ev}, expected ${held - p.total} to leave the name`)
    }

    // A cap no letter reaches changes nothing at all.
    {
      const loose = planDensity(scatter(5_000, n), rules({ letterCap: 100_000, letter: L }))
      let ev = 0
      for (const x of loose.evictions) ev += x
      ok(ev === 0, `a cap no letter reaches still evicted ${ev}`)
      ok(loose.total === 5_000, `a cap no letter reaches changed the total to ${loose.total}`)
    }

    // The discriminator against a name-wide cap. With 13 letters and a cap of
    // 100, a cap read as a name-wide total would clamp the whole name to 100.
    // Read per letter it clamps each letter to 100, so the name settles near
    // 13 x 100 -- an order of magnitude apart, and no letter over its cap.
    {
      const cap = 100
      const p = planDensity(scatter(5_000, n), rules({ letterCap: cap, letter: L, min: 0 }))
      const got = byLetter(p.target, L)
      for (const [li, v] of got) ok(v <= cap, `letter ${li} targeted ${v}, over the cap of ${cap}`)
      ok(
        p.total > cap * 2,
        `total ${p.total} looks like a name-wide cap of ${cap}, not a per-letter one`,
      )
      ok(
        p.total <= cap * got.size,
        `total ${p.total} exceeds ${got.size} letters x ${cap}`,
      )
    }

    // A cap cannot be per CELL either: with 72 cells and 13 letters, a
    // per-cell reading would allow 72 x cap, a per-letter one 13 x cap.
    {
      const cap = 300
      const p = planDensity(scatter(100_000, n), rules({ letterCap: cap, letter: L, min: 0 }))
      const got = byLetter(p.target, L)
      ok(
        p.total === cap * got.size,
        `saturated total ${p.total} != ${got.size} letters x ${cap} (per-cell would be ${cap * n})`,
      )
      for (let i = 0; i < n; i++) {
        const size = sizeOf.get(L[i])!
        if (size > 1) {
          ok(
            p.target[i] < cap,
            `cell ${i} alone targeted ${p.target[i]}, the cap is on its letter not on it`,
          )
        }
      }
    }
  }

  // The floor is a whole-name total, and the cap wins when the two cannot both
  // hold: the plan simply targets less, and the import loop stops there rather
  // than topping up to a floor the cap would evict again on the same frame.
  {
    const n = 72
    const L = letters(n, 13)
    const groups = new Set<number>()
    for (let i = 0; i < n; i++) groups.add(L[i])
    const p = planDensity(scatter(50, n), rules({ min: 40_000, letterCap: 100, letter: L }))
    ok(p.total <= 100 * groups.size, `floor beat the cap: total ${p.total}`)
    let im = 0
    for (const x of p.imports) im += x
    ok(50 + im === p.total, `imports overshot the capped target (${50}+${im} != ${p.total})`)
  }

  // The floor still behaves, and nothing moves in between.
  {
    const r = rules()
    const under = planDensity(scatter(400, 72), r)
    let im = 0
    for (const x of under.imports) im += x
    ok(im === 1000 - 400, `under the floor imported ${im}, expected 600`)

    // Above the floor with no cap, the population must not move at all — the
    // old rule measured its surplus against the measured total rather than the
    // cap, so it evicted exactly what it had just imported, every round.
    for (const total of [1000, 5000, 21_000, 24_000]) {
      const mid = planDensity(scatter(total, 72), r)
      let i2 = 0
      let e2 = 0
      for (const x of mid.imports) i2 += x
      for (const x of mid.evictions) e2 += x
      ok(i2 === 0 && e2 === 0, `inside the bounds the name changed size by ${i2 - e2} (total=${total})`)
    }
  }

  // An uncapped name never evicts.
  {
    const p = planDensity(scatter(60_000, 72), rules({ letterCap: Infinity }))
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
    const one = planDensity(new Int32Array([5]), rules({ min: 0, letterCap: Infinity }))
    ok(one.target[0] === 5 && one.settled, 'single cell did not settle on itself')
  }

  console.log(`density.check: ${checks} assertions passed`)
}

run()
