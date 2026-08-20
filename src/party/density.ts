/**
 * What the name's particle distribution should do next, as pure arithmetic.
 *
 * Every rule here is a BAND, not a point. That distinction is the whole
 * design: an exact target is satisfied only on a set of states with no
 * thickness, so the field leaves it on the next frame and enforcement chases
 * it forever at whatever rate the field churns. With a band there is a whole
 * region of arrangements that satisfy every rule at once, and a name sitting
 * anywhere inside it needs no teleports at all. `density.check.ts` asserts
 * that region is non-empty and has real width.
 *
 * The host owns the particle plumbing — census cursors, GPU writes, the
 * positions to land on. It owns none of the decisions. Keeping the decisions
 * here is what lets them be checked at all; a rule that only exists inside a
 * frame loop can only be tested by running the site.
 */

export type DensityPlan = {
  /** Each cell's share of `total`. Sums to `total` EXACTLY. */
  target: Int32Array
  /** Half-width of each cell's band. At least 1 — a count is discrete, so a
   * band narrower than one particle is not a band. */
  tol: Int32Array
  /** The population the name should hold: what it holds now, floored at
   * `min` and thinned by whatever the per-letter cap clamps off. Equal to
   * `inName` whenever the name is above the floor and no letter is over its
   * cap, which is what makes the bounds a margin rather than a pair of
   * cliffs — inside them the name never changes size, it only redistributes. */
  total: number
  /** Particles to bring in from outside the name, per cell. */
  imports: Int32Array
  /** Particles to send back out of the name, per cell. */
  evictions: Int32Array
  /** Cell-to-cell transfers, fullest into emptiest. */
  transfers: { from: number; to: number; count: number }[]
  /** True when every rule is already satisfied and nothing needs to move. */
  settled: boolean
}

export type DensityRules = {
  /** Fewest particles the name may hold, as a total across the whole name. */
  min: number
  /** Most any ONE LETTER may hold. `Infinity` lifts the cap.
   *
   * Per letter rather than per cell or per name: a cell is an arbitrary
   * subdivision the reader never sees, and a name-wide total says nothing
   * about how thick any given letter gets. A letter is the thing that looks
   * too dense. */
  letterCap: number
  /** How far a cell may sit from its share before it is corrected, as a
   * fraction of that share. */
  variance: number
  /** Cell index → the letter it belongs to; negative for a cell no letter
   * claimed. Cells of one letter share that letter's cap. */
  letter: ArrayLike<number>
}

/**
 * Plan the corrections a measured distribution implies.
 *
 * Ordering is deliberate: the total is fixed first (eviction or import), then
 * the distribution is levelled inside it. Doing it the other way round is
 * what produced the old churn — a per-cell deficit pulled a particle in from
 * outside, and the eviction pass, which measured its surplus against the
 * measured total rather than against the cap, then sent that same particle
 * straight back out. Two teleports per particle, every frame, to launder one
 * cell-to-cell transfer through the field, while the cap itself went
 * unenforced.
 */
export function planDensity(counts: ArrayLike<number>, rules: DensityRules): DensityPlan {
  const n = counts.length
  const imports = new Int32Array(n)
  const evictions = new Int32Array(n)
  const transfers: { from: number; to: number; count: number }[] = []
  if (n === 0) {
    return { target: new Int32Array(0), tol: new Int32Array(0), total: 0, imports, evictions, transfers, settled: true }
  }

  let inName = 0
  for (let i = 0; i < n; i++) inName += counts[i]

  // The cap is per LETTER, so the cells of one letter share one allowance.
  // A cap per cell would bound an arbitrary subdivision of the glyphs that
  // nobody looking at the page can see; a cap on the name-wide total says
  // nothing about any individual letter, since half the name could pile into
  // one glyph and the total would be none the wiser. A letter is the thing
  // that reads as too thick, so a letter is what gets counted.
  //
  // Cells no letter claimed share a bucket of their own, so they are still
  // bounded rather than silently unlimited.
  const groups = new Map<number, number[]>()
  const letterOf = rules.letter && rules.letter.length === n ? rules.letter : null
  for (let i = 0; i < n; i++) {
    const key = letterOf && letterOf[i] >= 0 ? letterOf[i] : -1
    const g = groups.get(key)
    if (g) g.push(i)
    else groups.set(key, [i])
  }
  const cells: number[][] = [...groups.values()]
  const g = cells.length
  const width = cells.map((c) => c.length)
  const held = cells.map((c) => {
    let h = 0
    for (const i of c) h += counts[i]
    return h
  })
  const cap = rules.letterCap > 0 ? rules.letterCap : Infinity

  // Equal density: the cells are equal-area, so an equal count in every cell
  // IS an equal density, and a letter's share falls out proportional to its
  // own ink area -- a B more than a T, because a B is more letter. `rho` is
  // that density, in particles per cell.
  //
  // It is measured over the letters the cap is NOT holding down, found by
  // fixed point, and that is the whole subtlety here. Taking it over the
  // whole name instead makes capping compound: the clamped letters shed,
  // which lowers the name's total, which lowers the density every OTHER
  // letter is then targeted at, which sheds more. Measured live, a cap of
  // 1200 dragged a 20,000-particle name down past 5,000 -- thinning every
  // letter, including the ones nowhere near the cap, which is the opposite of
  // a per-letter ceiling. Holding the uncapped letters at their own density
  // makes the capped ones shed exactly once and then stay put.
  const capped = new Array<boolean>(g).fill(false)
  const shortfall = Math.max(0, rules.min - inName)
  let rho = 0
  for (let pass = 0; pass <= g; pass++) {
    let openCells = 0
    let openHeld = 0
    for (let i = 0; i < g; i++) {
      if (capped[i]) continue
      openCells += width[i]
      openHeld += held[i]
    }
    if (openCells === 0) break
    // The floor is name-wide, so a shortfall is made up by whichever letters
    // can still take particles.
    rho = (openHeld + shortfall) / openCells
    let changed = false
    for (let i = 0; i < g; i++) {
      if (!capped[i] && rho * width[i] > cap) {
        capped[i] = true
        changed = true
      }
    }
    if (!changed) break
  }

  // What the cap clamps off LEAVES the name; it is not handed to another
  // letter. Moving it would make small letters denser than large ones --
  // equal density broken in the opposite direction -- and would turn a
  // thinning control into a redistribution one, where lowering the cap made
  // the name more even without making it any thinner.
  const want = cells.map((_, i) => (capped[i] ? cap : rho * width[i]))
  const alloc = want.map(Math.floor)
  let sum = 0
  for (const a of alloc) sum += a
  let goal = 0
  for (const a of want) goal += a
  goal = Math.round(goal)
  // Largest remainder, so an uncapped name allocates exactly what it holds
  // instead of drifting by half a particle per letter every frame.
  const byFraction = want
    .map((_, i) => i)
    .sort((a, b) => want[b] - alloc[b] - (want[a] - alloc[a]) || a - b)
  for (const i of byFraction) {
    if (sum >= goal) break
    if (alloc[i] + 1 > cap) continue
    alloc[i]++
    sum++
  }
  // Whatever was actually allocated, not what was hoped for: the targets have
  // to sum to the total EXACTLY or there is no arrangement of the particles
  // that satisfies them, and the system teleports forever chasing a state
  // that does not exist.
  const total = sum

  const target = new Int32Array(n)
  const tol = new Int32Array(n)
  const variance = Math.max(0, rules.variance)
  for (let gi = 0; gi < cells.length; gi++) {
    const group = cells[gi]
    const w = group.length
    const base = Math.floor(alloc[gi] / w)
    const rem = alloc[gi] - base * w
    // The remainder goes to the cells already fullest WITHIN this letter, not
    // to the first indices. The letter's allowance moves every frame as the
    // field carries particles across the name's edge, so a fixed assignment
    // makes the +1 walk between cells -- a cell's own target flips by one with
    // no particle having moved, which at a tight variance is enough to push it
    // out of its band on its own. Handing it to whoever already holds the most
    // makes the target move toward the state instead of arbitrarily, so the
    // plan is the least work that satisfies the rule.
    const byCount = group.slice().sort((a, b) => counts[b] - counts[a] || a - b)
    for (let i = 0; i < w; i++) target[byCount[i]] = base + (i < rem ? 1 : 0)
  }
  for (let i = 0; i < n; i++) tol[i] = Math.max(1, Math.round(target[i] * variance))

  const work = new Int32Array(n)
  for (let i = 0; i < n; i++) work[i] = counts[i]

  // 1. The total, and only if it left the bounds. `total` equals `inName`
  //    whenever the name is between them, so both loops are idle there.
  let running = inName
  while (running > total) {
    // Most over its own target first, so the name levels on the way down.
    let from = -1
    let best = 0
    for (let i = 0; i < n; i++) {
      const surplus = work[i] - target[i]
      if (surplus > best) {
        best = surplus
        from = i
      }
    }
    if (from < 0) break
    const take = Math.min(best, running - total)
    work[from] -= take
    evictions[from] += take
    running -= take
  }
  while (running < total) {
    // Emptiest cell first, so imports land where the name is thinnest.
    let to = -1
    let worst = 0
    for (let i = 0; i < n; i++) {
      const deficit = target[i] - work[i]
      if (deficit > worst) {
        worst = deficit
        to = i
      }
    }
    if (to < 0) break
    const give = Math.min(worst, total - running)
    work[to] += give
    imports[to] += give
    running += give
  }

  // 2. Redistribution, fullest cell into emptiest, and only while either end
  //    is outside its band. Sorting once and walking in from both sides makes
  //    the rule symmetric: a cell ABOVE its band is levelled too, not only
  //    one below it. Triggering on deficits alone left a hot cell surrounded
  //    by slightly-light neighbours — which is what the field actually
  //    produces — hot forever.
  //
  //    A donor need only be above its own target, not above its band: it
  //    stops AT target, still in spec, so the move cannot provoke a
  //    counter-move. The band belongs on the trigger, not on the correction.
  const order = Array.from({ length: n }, (_, i) => i)
  order.sort((a, b) => work[b] - target[b] - (work[a] - target[a]))
  let hi = 0
  let lo = n - 1
  while (hi < lo) {
    const d = order[hi]
    const r = order[lo]
    const give = work[d] - target[d]
    const take = target[r] - work[r]
    if (give <= 0) {
      hi++
      continue
    }
    if (take <= 0) {
      lo--
      continue
    }
    // Both ends in spec means everything between them is too: the list is
    // ordered by deviation.
    if (give <= tol[d] && take <= tol[r]) break
    const count = Math.min(give, take)
    work[d] -= count
    work[r] += count
    transfers.push({ from: d, to: r, count })
    if (give === count) hi++
    if (take === count) lo--
  }

  let settled = transfers.length === 0
  if (settled) {
    for (let i = 0; i < n; i++) {
      if (imports[i] !== 0 || evictions[i] !== 0) {
        settled = false
        break
      }
    }
  }
  return { target, tol, total, imports, evictions, transfers, settled }
}
