/**
 * ローカルコーチが使う推定の不確実性（区間推定）。
 *
 * なぜ必要か:
 *   「閾値を超えたか」だけで判定すると、10投で観測した15ポイント差と
 *   100投で観測した15ポイント差を同じ強さの根拠として扱ってしまう。
 *   ここで推定の幅を算出し、差が幅を超えているかを確からしさへ反映する。
 *
 * 用語について:
 *   出力では「95%区間」「推定の幅」とだけ呼び、「有意」という語は使わない。
 *   多数の指標を同時に見ているため検定の多重性があり、単独の区間から
 *   有意性を主張することはできない。区間はあくまで、その推定がどれだけ
 *   ぶれ得るかを示す目安として扱う。
 *
 * 実装方針:
 *   外部ライブラリを追加しない。正規近似とWilson法・Newcombe法だけで、
 *   同じ入力から必ず同じ結果を返す（乱数・ブートストラップを使わない）。
 */

/** 95%区間に対応する標準正規分布の分位点。 */
export const DEFAULT_Z = 1.96;

export interface Interval {
  low: number;
  high: number;
}

/** 区間が0をまたがない（＝差の向きが区間内で一貫している）か。 */
export function excludesZero(interval: Interval | undefined): boolean {
  if (!interval) return false;
  return interval.low > 0 || interval.high < 0;
}

/**
 * 比率のWilsonスコア区間。
 * 単純な正規近似(p±z√(p(1-p)/n))と違い、p が0や1に近くても
 * 区間が[0,1]をはみ出さず、小標本でも破綻しない。
 * 分母0では区間を定義できないため undefined（N/A）を返す。
 */
export function wilsonInterval(
  successes: number,
  total: number,
  z: number = DEFAULT_Z
): Interval | undefined {
  if (total <= 0) return undefined;
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const margin =
    (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) /
    denominator;
  return {
    low: Math.max(0, center - margin),
    high: Math.min(1, center + margin),
  };
}

/**
 * 2つの比率の差 (p1 - p2) の区間（Newcombeのハイブリッドスコア法）。
 * 各比率のWilson区間から差の区間を組み立てるため、
 * 小標本や0%・100%に近い比率でも妥当な幅になる。
 */
export function proportionDiffInterval(
  successes1: number,
  total1: number,
  successes2: number,
  total2: number,
  z: number = DEFAULT_Z
): Interval | undefined {
  const first = wilsonInterval(successes1, total1, z);
  const second = wilsonInterval(successes2, total2, z);
  if (!first || !second) return undefined;
  const p1 = successes1 / total1;
  const p2 = successes2 / total2;
  const diff = p1 - p2;
  const lowerSpread = Math.sqrt(
    (p1 - first.low) ** 2 + (second.high - p2) ** 2
  );
  const upperSpread = Math.sqrt(
    (first.high - p1) ** 2 + (p2 - second.low) ** 2
  );
  return { low: diff - lowerSpread, high: diff + upperSpread };
}

/** 平均と標準誤差。2件未満では算出できないため undefined。 */
export function meanWithStandardError(
  values: readonly number[]
): { mean: number; standardError: number; count: number } | undefined {
  if (values.length < 2) return undefined;
  const count = values.length;
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / count;
  let squared = 0;
  for (const v of values) squared += (v - mean) * (v - mean);
  const variance = squared / (count - 1);
  return { mean, standardError: Math.sqrt(variance / count), count };
}

/** 平均の区間（正規近似）。 */
export function meanInterval(
  values: readonly number[],
  z: number = DEFAULT_Z
): Interval | undefined {
  const summary = meanWithStandardError(values);
  if (!summary) return undefined;
  return {
    low: summary.mean - z * summary.standardError,
    high: summary.mean + z * summary.standardError,
  };
}

/**
 * 2群の平均差 (mean1 - mean2) の区間（Welch流に標準誤差を合成）。
 * 分散が等しいと仮定しないため、投擲数やばらつきが違う群同士でも使える。
 */
export function meanDiffInterval(
  values1: readonly number[],
  values2: readonly number[],
  z: number = DEFAULT_Z
): Interval | undefined {
  const first = meanWithStandardError(values1);
  const second = meanWithStandardError(values2);
  if (!first || !second) return undefined;
  const diff = first.mean - second.mean;
  const standardError = Math.sqrt(
    first.standardError ** 2 + second.standardError ** 2
  );
  return { low: diff - z * standardError, high: diff + z * standardError };
}

/**
 * 2つの標準偏差の比 (sd1 / sd2) を対数スケールで見た区間。
 *
 * 標準偏差の比の正確な区間はF分布を要するが、log(SD)の標準誤差は
 * 近似的に 1/√(2(n-1)) となることを使い、正規近似で求める。
 * 返り値は log(sd1/sd2) の区間なので、0をまたがなければ
 * 「ばらつきの大きさが同じとは言いにくい」と読める。
 */
export function logSdRatioInterval(
  sd1: number | undefined,
  count1: number,
  sd2: number | undefined,
  count2: number,
  z: number = DEFAULT_Z
): Interval | undefined {
  if (sd1 == null || sd2 == null) return undefined;
  if (sd1 <= 0 || sd2 <= 0) return undefined;
  if (count1 < 2 || count2 < 2) return undefined;
  const logRatio = Math.log(sd1 / sd2);
  const standardError = Math.sqrt(
    1 / (2 * (count1 - 1)) + 1 / (2 * (count2 - 1))
  );
  return { low: logRatio - z * standardError, high: logRatio + z * standardError };
}

/**
 * 効果の大きさを0〜1へ正規化する。優先度の並べ替えに使う。
 * scale は「これだけ差があれば大きい」と見なす基準値。
 */
export function normalizedEffect(
  magnitude: number | undefined,
  scale: number
): number {
  if (magnitude == null || Number.isNaN(magnitude) || scale <= 0) return 0;
  return Math.min(1, Math.abs(magnitude) / scale);
}

/**
 * 系列が単調に増加・減少しているか。
 * 連続するすべての区間で同じ向きに動いている場合だけ向きを返す。
 * 偶然の一致を避けるため、呼び出し側で最小の点数を必ず確認すること
 * （4点が偶然に単調へ並ぶ確率は約1/12）。
 */
export function monotonicDirection(
  values: readonly number[]
): "increasing" | "decreasing" | undefined {
  if (values.length < 3) return undefined;
  let increasing = true;
  let decreasing = true;
  for (let i = 1; i < values.length; i += 1) {
    const previous = values[i - 1] as number;
    const current = values[i] as number;
    if (current <= previous) increasing = false;
    if (current >= previous) decreasing = false;
  }
  if (increasing) return "increasing";
  if (decreasing) return "decreasing";
  return undefined;
}
