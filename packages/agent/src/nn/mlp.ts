/**
 * A tiny, from-scratch feed-forward neural network. No external ML library, no API,
 * no runtime dependencies — it is fully local and auditable.
 *
 * Architecture: nIn inputs -> nHid hidden (tanh) -> 1 output (sigmoid). Binary
 * classifier trained with binary cross-entropy via full-batch gradient descent.
 *
 * In SigilKit this network is an ADVISOR, never an authority: it outputs a probability
 * that a state is worth acting on. It does NOT choose amounts, targets, or caps, and it
 * cannot bypass the deterministic scope guardrails in the runner. See model/policy.ts.
 */

export interface MlpParams {
  readonly nIn: number;
  readonly nHid: number;
  w1: number[][]; // [nIn][nHid]
  b1: number[]; // [nHid]
  w2: number[]; // [nHid]
  b2: number; // scalar
}

/** Deterministic PRNG so init and dataset generation are reproducible across machines. */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sigmoid(x: number): number {
  // Numerically-stable logistic to avoid overflow at large |x|.
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}

export function initParams(nIn: number, nHid: number, seed: number): MlpParams {
  const rnd = mulberry32(seed);
  const w1: number[][] = [];
  for (let i = 0; i < nIn; i++) {
    const row: number[] = [];
    for (let j = 0; j < nHid; j++) row.push((rnd() - 0.5) * 0.8);
    w1.push(row);
  }
  const b1: number[] = [];
  for (let j = 0; j < nHid; j++) b1.push(0);
  const w2: number[] = [];
  for (let j = 0; j < nHid; j++) w2.push((rnd() - 0.5) * 0.8);
  return { nIn, nHid, w1, b1, w2, b2: 0 };
}

interface Activation {
  a1: number[]; // hidden activations (tanh)
  out: number; // sigmoid output in (0,1)
}

export function forward(x: number[], p: MlpParams): Activation {
  const { nHid, w1, b1, w2, b2 } = p;
  const a1 = new Array<number>(nHid);
  for (let j = 0; j < nHid; j++) {
    let z = b1[j] ?? 0;
    for (let i = 0; i < x.length; i++) z += (x[i] ?? 0) * (w1[i]?.[j] ?? 0);
    a1[j] = Math.tanh(z);
  }
  let o = b2;
  for (let j = 0; j < nHid; j++) o += (a1[j] ?? 0) * (w2[j] ?? 0);
  return { a1, out: sigmoid(o) };
}

export function predict(x: number[], p: MlpParams): number {
  return forward(x, p).out;
}

export interface Sample {
  x: number[];
  y: 0 | 1;
}

/** Full-batch gradient step on binary cross-entropy. Mutates and returns `p`. */
export function train(
  samples: Sample[],
  p: MlpParams,
  epochs: number,
  lr: number,
): { loss: number; accuracy: number } {
  const { nIn, nHid, w1, b1, w2 } = p;
  const N = samples.length || 1;

  for (let e = 0; e < epochs; e++) {
    // Zero the accumulators each epoch.
    const gW1: number[][] = w1.map((row) => row.map(() => 0));
    const gB1: number[] = new Array(nHid).fill(0);
    const gW2: number[] = new Array(nHid).fill(0);
    let gB2 = 0;
    let totalLoss = 0;
    let correct = 0;

    for (const s of samples) {
      const { a1, out } = forward(s.x, p);
      // BCE loss + prediction accuracy (threshold 0.5).
      const eps = 1e-9;
      totalLoss += -(s.y * Math.log(out + eps) + (1 - s.y) * Math.log(1 - out + eps));
      if ((out >= 0.5 ? 1 : 0) === s.y) correct++;

      // d(out)/d(z) for sigmoid is out*(1-out); combined with dBCE wrt out gives (out - y).
      const dOut = out - s.y;
      gB2 += dOut;
      for (let j = 0; j < nHid; j++) {
        const a1j = a1[j] ?? 0;
        gW2[j] = (gW2[j] ?? 0) + dOut * a1j;
        const da1 = dOut * (w2[j] ?? 0);
        const dz = da1 * (1 - a1j * a1j); // tanh'
        gB1[j] = (gB1[j] ?? 0) + dz;
        for (let i = 0; i < nIn; i++) {
          gW1[i]![j] = (gW1[i]![j] ?? 0) + dz * (s.x[i] ?? 0);
        }
      }
    }

    // Apply averaged gradients.
    for (let i = 0; i < nIn; i++)
      for (let j = 0; j < nHid; j++) w1[i]![j]! -= (lr * (gW1[i]![j] ?? 0)) / N;
    for (let j = 0; j < nHid; j++) {
      b1[j]! -= (lr * (gB1[j] ?? 0)) / N;
      w2[j]! -= (lr * (gW2[j] ?? 0)) / N;
    }
    p.b2 -= (lr * gB2) / N;
  }

  // Final metrics.
  let loss = 0;
  let acc = 0;
  for (const s of samples) {
    const out = forward(s.x, p).out;
    const eps = 1e-9;
    loss += -(s.y * Math.log(out + eps) + (1 - s.y) * Math.log(1 - out + eps));
    if ((out >= 0.5 ? 1 : 0) === s.y) acc++;
  }
  return { loss: loss / N, accuracy: acc / N };
}

export function save(p: MlpParams): string {
  return JSON.stringify(p);
}

export function load(text: string): MlpParams {
  const parsed = JSON.parse(text) as MlpParams;
  if (
    typeof parsed.nIn !== "number" ||
    typeof parsed.nHid !== "number" ||
    !Array.isArray(parsed.w1) ||
    !Array.isArray(parsed.w2)
  ) {
    throw new Error("invalid model file: not a serialized MlpParams");
  }
  return parsed;
}
