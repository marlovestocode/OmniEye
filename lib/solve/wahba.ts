/**
 * Wahba's problem.
 *
 * Given the same set of directions measured in two frames, find the rotation that
 * best carries one onto the other. This is not a novel problem -- it is exactly
 * what a spacecraft attitude sensor solves, and naming it correctly buys a
 * closed-form answer instead of an improvised optimiser.
 *
 * Kabsch via singular value decomposition: build the 3x3 correlation matrix
 * B = sum(w_i * v_i * u_i^T), take B = U S V^T, and the optimal rotation is
 * R = U * diag(1, 1, det(U V^T)) * V^T. The determinant term is what stops the
 * solution collapsing into a reflection when the measurements are noisy or nearly
 * coplanar -- a reflection would fit the points beautifully and describe a sky
 * seen through a mirror.
 */
import { Matrix, SingularValueDecomposition } from 'ml-matrix';
import { Matrix3, Vector3 } from 'three';

export interface VectorPair {
  /** Direction in the source frame, unit length. */
  from: Vector3;
  /** The same direction in the target frame, unit length. */
  to: Vector3;
  /** Relative weight. Brighter, sharper sources deserve more say. */
  weight?: number;
}

/**
 * The rotation that best maps `from` onto `to`, in the least-squares sense.
 *
 * Needs at least two non-parallel pairs. Returns null when the correspondences
 * are degenerate -- all parallel, or too few -- because an arbitrary rotation
 * that happens to satisfy a rank-deficient system is worse than no answer.
 */
export function solveRotation(pairs: VectorPair[]): Matrix3 | null {
  if (pairs.length < 2) return null;

  const b = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];

  for (const { from, to, weight = 1 } of pairs) {
    const u = [from.x, from.y, from.z];
    const v = [to.x, to.y, to.z];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) b[i][j] += weight * v[i] * u[j];
    }
  }

  let svd: SingularValueDecomposition;
  try {
    svd = new SingularValueDecomposition(new Matrix(b), { autoTranspose: true });
  } catch {
    return null;
  }

  const U = svd.leftSingularVectors.to2DArray();
  const V = svd.rightSingularVectors.to2DArray();
  const s = svd.diagonal;

  // Rank check: two singular values must be clearly non-zero, or the directions
  // did not span enough of the sphere to pin a rotation down.
  if (s[1] < 1e-9 * Math.max(s[0], 1e-30)) return null;

  // R = U * diag(1, 1, d) * V^T with d = det(U V^T).
  const uvT = multiply3(U, transpose3(V));
  const d = determinant3(uvT);
  const sign = d < 0 ? -1 : 1;

  const middle = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, sign],
  ];
  const r = multiply3(multiply3(U, middle), transpose3(V));

  return new Matrix3().set(r[0][0], r[0][1], r[0][2], r[1][0], r[1][1], r[1][2], r[2][0], r[2][1], r[2][2]);
}

/**
 * Attitude from exactly two correspondences, built directly rather than solved.
 *
 * Two non-parallel directions already determine a rotation completely, and during
 * a blind search this runs tens of thousands of times -- far too often to pay for
 * a singular value decomposition. Constructing an orthonormal triad from each
 * pair and composing them gives the same answer for two points at a fraction of
 * the cost. This is the classic TRIAD method.
 *
 * The first direction is honoured exactly and the second only sets the roll about
 * it, so the brighter, better-measured source should be passed first.
 */
const _a1 = new Vector3();
const _a2 = new Vector3();
const _a3 = new Vector3();
const _b1 = new Vector3();
const _b2 = new Vector3();
const _b3 = new Vector3();
const _triadA = [_a1, _a2, _a3];
const _triadB = [_b1, _b2, _b3];

export function triadRotation(
  u1: Vector3,
  u2: Vector3,
  v1: Vector3,
  v2: Vector3,
  out = new Matrix3(),
): Matrix3 | null {
  // Scratch vectors, reused. A blind solve calls this hundreds of thousands of
  // times, and allocating nine objects per call made garbage collection the
  // single largest cost in the search.
  _a1.copy(u1).normalize();
  _a2.crossVectors(_a1, u2);
  if (_a2.lengthSq() < 1e-12) return null;
  _a2.normalize();
  _a3.crossVectors(_a1, _a2);

  _b1.copy(v1).normalize();
  _b2.crossVectors(_b1, v2);
  if (_b2.lengthSq() < 1e-12) return null;
  _b2.normalize();
  _b3.crossVectors(_b1, _b2);

  // R = B * A^T, with the triads as columns.
  const e = out.elements; // column-major
  for (let c = 0; c < 3; c++) {
    for (let r = 0; r < 3; r++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) {
        sum += _triadB[k].getComponent(r) * _triadA[k].getComponent(c);
      }
      e[c * 3 + r] = sum;
    }
  }
  return out;
}

// -- small 3x3 helpers ---------------------------------------------------------

type Mat3 = number[][];

function transpose3(m: Mat3): Mat3 {
  return [
    [m[0][0], m[1][0], m[2][0]],
    [m[0][1], m[1][1], m[2][1]],
    [m[0][2], m[1][2], m[2][2]],
  ];
}

function multiply3(a: Mat3, b: Mat3): Mat3 {
  const out: Mat3 = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += a[i][k] * b[k][j];
      out[i][j] = sum;
    }
  }
  return out;
}

function determinant3(m: Mat3): number {
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  );
}
