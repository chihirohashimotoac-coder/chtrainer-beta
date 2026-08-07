/**
 * ローカルコーチの判定ルール（決定論的・純粋関数）。
 *
 * 記述方針:
 *  - 観測できる「状態」だけを記述する（例: 3投目で右方向のばらつきが増えている）。
 *  - 身体動作・感覚・心理・医学に関する原因は一切断定しない
 *    （例: グリップが強い / 肘が下がっている / 集中力がない は禁止）。
 *    これらは外部の生成AIが追加質問を通じて仮説として扱う領域。
 *  - すべての所見に分母（sampleSize）を持たせ、分母0は 0% ではなく N/A とする。
 *
 * 判定は2段構えにする:
 *  1) 実用上の閾値（例: 命中率10ポイント差）を超えたか
 *  2) その差の95%区間が0をまたがないか（＝標本の少なさで向きが反転しないか）
 * 1)を満たせば所見として出すが、2)を満たさない場合は確からしさを1段階下げる。
 * これにより「10投での15ポイント差」と「100投での15ポイント差」を同格に扱わない。
 */
import type {
  MissDirection,
  SessionStatistics,
  ThrowRecord,
  TrainingSession,
} from "../../types/models";
import { isGroupingOnlyTarget } from "../targets";
import { mean, median } from "../stats";
import {
  BIAS_MEAN_THRESHOLD,
  BIAS_MEAN_TO_SD_RATIO,
  CONFIDENCE_INTERVAL_Z,
  DIRECTION_BIAS_RATIO_THRESHOLD,
  DISPERSION_SD_THRESHOLD,
  EFFECT_SCALE_MARKS,
  EFFECT_SCALE_RATE,
  EFFECT_SCALE_RELATIVE,
  GROUPING_RELATIVE_DIFF_THRESHOLD,
  HIT_RATE_DIFF_THRESHOLD,
  LOG_SD_RATIO_THRESHOLD,
  MIN_ANALYZABLE_SAMPLE,
  MIN_GROUPING_SETS,
  MIN_MEANINGFUL_DISTANCE,
  MIN_TARGET_SAMPLE,
  MIN_TREND_SESSIONS,
  RELATIVE_DIFF_THRESHOLD,
  TEMPO_RELATIVE_DIFF_THRESHOLD,
} from "./config";
import {
  calculateConfidence,
  isAnalyzableSample,
  severityOf,
  type ConfidenceInput,
} from "./confidence";
import {
  excludesZero,
  logSdRatioInterval,
  meanDiffInterval,
  meanInterval,
  monotonicDirection,
  normalizedEffect,
  proportionDiffInterval,
  wilsonInterval,
} from "./statistics";
import type { LocalCoachFinding } from "./types";

/** ルール内部でのみ使う極性。レポートでは配列の振り分けに使う。 */
export type FindingPolarity = "positive" | "issue" | "unavailable";

export interface RuleFinding extends LocalCoachFinding {
  polarity: FindingPolarity;
  /**
   * 確からしさを算出した入力（内部用。レポートには含めない）。
   * 同じ主題を別の指標が裏付けていた場合に、裏付け条件数を上げて
   * 再計算するために保持する。
   */
  confidenceInput: ConfidenceInput;
}

/**
 * 比較可能な過去セッションから作った基準線。
 * セッション単位の値なので、スキル診断のようにラウンドで測定内容が変わる
 * セッションでは、ラウンド別スコープの所見に使ってはならない。
 */
export interface LocalCoachBaseline {
  sessionCount: number;
  /** 完全命中率の単純平均 */
  hitRate?: number;
  /** 命中率の分母合計（比較対象セッションの命中判定対象投擲数の合計） */
  hitRateSamples: number;
  /** 命中数の合計（区間推定に使う） */
  hitCountTotal: number;
  /** 詳細座標のみの平均誤差距離の単純平均 */
  coordinateErrorMean?: number;
  coordinateErrorSamples: number;
  /** グルーピング径（セット内最大距離の平均）の単純平均 */
  groupingDiameter?: number;
  groupingSets: number;
  /**
   * 古い順に並べた、比較可能セッションの推移（今回は含まない）。
   * 長期トレンドの単調性判定に使う。
   */
  history: {
    hitRate?: number;
    coordinateErrorMean?: number;
  }[];
}

export interface RuleContext {
  session: TrainingSession;
  /** セッション全体の統計（グルーピング等、既存計算を再利用する） */
  stats: SessionStatistics;
  /** このスコープの投擲（globalThrowNumber昇順） */
  throws: readonly ThrowRecord[];
  /** スコープ識別子。"session" はセッション全体。 */
  scopeKey: string;
  /** スコープ表示名（複数スコープのとき根拠へ付記する） */
  scopeLabel: string;
  /** スコープが複数あるか（スキル診断のラウンド分割時 true） */
  multiScope: boolean;
  /** 完了率（予定投擲数が0または不明なら undefined） */
  completionRatio?: number;
  /** 比較可能な過去セッションの基準線（条件を満たすものがなければ undefined） */
  baseline?: LocalCoachBaseline;
  /**
   * セッション単位で計算済みのグルーピング統計を、このスコープの所見に
   * 使ってよいか。スキル診断ではR1(grouping_only)スコープでのみ true。
   * 測定内容の異なるラウンドへ同じ実測値を当てないためのガード。
   */
  allowGroupingStats: boolean;
  /**
   * セッション単位の基準線（過去平均との差）や、セッション単位で計算済みの
   * モード別統計（クリケット・01）を、このスコープの所見に使ってよいか。
   * ラウンドで測定内容が変わるセッションでは false。
   */
  allowBaselineComparison: boolean;
}

// ---------------------------------------------------------------------------
// 数値ヘルパー
// ---------------------------------------------------------------------------

/**
 * 標本標準偏差（n-1）。ばらつきの推定値として一般的な定義を使う。
 * 2件未満では算出できないため undefined（N/A）を返す。
 */
export function sampleStdDev(values: readonly number[]): number | undefined {
  if (values.length < 2) return undefined;
  const m = mean(values);
  if (m == null) return undefined;
  let sum = 0;
  for (const v of values) sum += (v - m) * (v - m);
  return Math.sqrt(sum / (values.length - 1));
}

/**
 * 相対差 (current - baseline) / |baseline|。
 * 分母0（基準が0）では相対差を定義できないため undefined を返す
 * （0%として扱わない）。
 */
export function relativeDiff(
  current: number | undefined,
  baseline: number | undefined
): number | undefined {
  if (current == null || baseline == null) return undefined;
  if (baseline === 0) return undefined;
  return (current - baseline) / Math.abs(baseline);
}

/**
 * 距離・ばらつきの値が、相対差で語ってよい大きさかを判定する。
 * ほぼ同一の着弾では標準偏差が0付近になり、浮動小数点の丸め誤差だけで
 * 巨大な相対差が出てしまうため、比較の前に必ずこの下限を確認する。
 */
export function isMeaningfulDistance(value: number | undefined): boolean {
  return value != null && Math.abs(value) >= MIN_MEANINGFUL_DISTANCE;
}

/** 率の算出。分母0は 0% ではなく undefined（N/A）。 */
export function rateOf(numerator: number, denominator: number): number | undefined {
  if (denominator <= 0) return undefined;
  return numerator / denominator;
}

function isScorable(t: ThrowRecord): boolean {
  return !isGroupingOnlyTarget(t.target);
}

function isCoordinate(t: ThrowRecord): boolean {
  return t.landing.positionPrecision === "coordinate";
}

function isApproximate(t: ThrowRecord): boolean {
  return t.landing.positionPrecision === "segment_approximation";
}

function isOutboard(t: ThrowRecord): boolean {
  return t.landing.ring === "outboard";
}

function errorXs(throws: readonly ThrowRecord[]): number[] {
  return throws.map((t) => t.derived.errorX).filter((v): v is number => v != null);
}

function errorYs(throws: readonly ThrowRecord[]): number[] {
  return throws.map((t) => t.derived.errorY).filter((v): v is number => v != null);
}

function errorDistances(throws: readonly ThrowRecord[]): number[] {
  return throws
    .map((t) => t.derived.errorDistance)
    .filter((v): v is number => v != null);
}

interface HitSummary {
  hits: number;
  samples: number;
  rate?: number;
}

function hitRateOf(throws: readonly ThrowRecord[]): HitSummary {
  const scorable = throws.filter(isScorable);
  const hits = scorable.filter((t) => t.derived.exactHit === true).length;
  return { hits, samples: scorable.length, rate: rateOf(hits, scorable.length) };
}

function scopeNote(ctx: RuleContext, extra?: string): string | undefined {
  const parts = [ctx.multiScope ? ctx.scopeLabel : undefined, extra].filter(
    (x): x is string => x != null && x.length > 0
  );
  return parts.length > 0 ? parts.join(" / ") : undefined;
}

/** 全ルール共通の確からしさ入力（完了率をここで一元的に載せる）。 */
function confidenceInputOf(
  ctx: RuleContext,
  sampleSize: number,
  corroboratingConditions: number,
  differenceExcludesZero?: boolean
): ConfidenceInput {
  return {
    sampleSize,
    corroboratingConditions,
    completionRatio: ctx.completionRatio,
    differenceExcludesZero,
  };
}

/** 所見を組み立てる。確からしさと severity は入力から一意に決まる。 */
function makeFinding(
  input: Omit<RuleFinding, "severity" | "confidence">
): RuleFinding {
  const confidence = calculateConfidence(input.confidenceInput);
  return { ...input, confidence, severity: severityOf(input.effect, confidence) };
}

/**
 * 同じ主題を別の指標が裏付けていた場合に、裏付け条件数を上げて確からしさを
 * 再計算する。「複数指標で再現しているなら確からしさを上げる」という規則を、
 * ルール個々ではなく所見の集合を見てから適用するための入り口。
 * 条件数が増えないときは元の所見をそのまま返す（決定論性の担保）。
 */
export function withCorroboration(
  finding: RuleFinding,
  corroboratingConditions: number
): RuleFinding {
  if (corroboratingConditions <= finding.confidenceInput.corroboratingConditions) {
    return finding;
  }
  const confidenceInput = { ...finding.confidenceInput, corroboratingConditions };
  const confidence = calculateConfidence(confidenceInput);
  return {
    ...finding,
    confidenceInput,
    confidence,
    severity: severityOf(finding.effect, confidence),
  };
}

/** 身体動作・心理・医学の断定をしないことを、所見ごとに明示する共通の注意書き。 */
const NO_CAUSE_LIMITATION =
  "着弾データから観測できる状態のみを記述しています。身体動作・感覚・心理面の原因は判定していません。";

/** 区間推定の読み方を添える共通の注意書き。 */
const INTERVAL_LIMITATION =
  "95%区間は推定のぶれ幅の目安です。複数の指標を同時に見ているため、区間から有意性は判断していません。";

// ---------------------------------------------------------------------------
// ルール1: 投順別の変化
// ---------------------------------------------------------------------------

const DART_ORDERS = [1, 2, 3] as const;
type DartOrder = (typeof DART_ORDERS)[number];

const AXIS_DEFS = [
  { key: "x", label: "横方向", positive: "右", negative: "左" },
  { key: "y", label: "縦方向", positive: "上", negative: "下" },
] as const;

type AxisDef = (typeof AXIS_DEFS)[number];

function axisValues(throws: readonly ThrowRecord[], axis: AxisDef): number[] {
  return axis.key === "x" ? errorXs(throws) : errorYs(throws);
}

/**
 * 1〜3投目の間で、方向別のばらつきと命中率に差が出ていないかを見る。
 *
 * - ばらつきは詳細座標の投擲だけで算出する。簡易入力の座標はエリア代表点の
 *   概算値であり、標準偏差の絶対値を実測値と同格に扱えない。
 * - 命中率は命中判定対象（グルーピング専用ラウンドを除く）だけを分母にする。
 * - 各投順の分母が MIN_ANALYZABLE_SAMPLE 未満のときは判定しない。
 */
export function detectDartOrderChange(ctx: RuleContext): RuleFinding[] {
  const out: RuleFinding[] = [];
  const byOrder = new Map<DartOrder, ThrowRecord[]>();
  for (const order of DART_ORDERS) {
    byOrder.set(order, ctx.throws.filter((t) => t.dartInSet === order));
  }

  // --- 方向別のばらつき（詳細座標のみ） ---
  for (const axis of AXIS_DEFS) {
    const spread = new Map<DartOrder, { sd?: number; samples: number }>();
    for (const order of DART_ORDERS) {
      const coordinate = (byOrder.get(order) ?? []).filter(isCoordinate);
      const values = axisValues(coordinate, axis);
      spread.set(order, { sd: sampleStdDev(values), samples: values.length });
    }
    const analyzable = DART_ORDERS.every((order) => {
      const s = spread.get(order);
      return s != null && s.sd != null && isAnalyzableSample(s.samples);
    });
    if (!analyzable) continue;
    for (const order of DART_ORDERS) {
      const target = spread.get(order)!;
      const others = DART_ORDERS.filter((o) => o !== order);
      const othersMean = mean(others.map((o) => spread.get(o)!.sd as number));
      const othersSamples = others.reduce(
        (sum, o) => sum + (spread.get(o)?.samples ?? 0),
        0
      );
      const diff = relativeDiff(target.sd, othersMean);
      if (diff == null || diff < RELATIVE_DIFF_THRESHOLD) continue;
      // ばらつき自体が入力の分解能以下なら、相対差が大きくても傾向にしない
      if (!isMeaningfulDistance(target.sd)) continue;
      const ratioInterval = logSdRatioInterval(
        target.sd,
        target.samples,
        othersMean,
        othersSamples,
        CONFIDENCE_INTERVAL_Z
      );
      const supported =
        excludesZero(ratioInterval) &&
        Math.abs(Math.log(1 + diff)) >= LOG_SD_RATIO_THRESHOLD;
      out.push(
        makeFinding({
          id: `dart_order_${axis.key}_spread_${order}_${ctx.scopeKey}`,
          kind: "statistical_trend",
          polarity: "issue",
          priority: 10,
          effect: normalizedEffect(diff, EFFECT_SCALE_RELATIVE),
          primaryMetric: `${order}投目の${axis.label}ばらつき(標準偏差)`,
          subject: `dart_order_${order}_${ctx.scopeKey}`,
          title: `${order}投目で${axis.label}のばらつきが大きくなっています`,
          summary: `${order}投目の${axis.label}ばらつき(誤差${axis.key.toUpperCase()}の標準偏差)が、他の投順の平均より大きい状態です。`,
          confidenceInput: confidenceInputOf(ctx, target.samples, 1, supported),
          evidence: [
            ...DART_ORDERS.map((o) => ({
              metric: `${o}投目の${axis.label}ばらつき(標準偏差)`,
              current: spread.get(o)!.sd,
              sampleSize: spread.get(o)!.samples,
              unit: "normalized" as const,
              note: scopeNote(ctx, "詳細座標のみ"),
            })),
            {
              metric: `${order}投目と他の投順平均との相対差`,
              current: target.sd,
              baseline: othersMean,
              difference: diff,
              sampleSize: target.samples,
              unit: "ratio" as const,
              note: supported
                ? "95%区間は同等(比1.0)を含まない"
                : "95%区間は同等(比1.0)を含む",
            },
          ],
          limitations: [
            "詳細座標が記録された投擲のみを対象にしています。",
            INTERVAL_LIMITATION,
            NO_CAUSE_LIMITATION,
          ],
          actionTemplateId:
            axis.key === "x"
              ? "dart_order_lateral_spread"
              : "dart_order_vertical_spread",
        })
      );
    }
  }

  // --- 命中率 ---
  const hitRates = new Map<DartOrder, HitSummary>();
  for (const order of DART_ORDERS) {
    hitRates.set(order, hitRateOf(byOrder.get(order) ?? []));
  }
  const hitAnalyzable = DART_ORDERS.every((order) => {
    const h = hitRates.get(order);
    return h != null && h.rate != null && isAnalyzableSample(h.samples);
  });
  if (hitAnalyzable) {
    for (const order of DART_ORDERS) {
      const target = hitRates.get(order)!;
      const others = DART_ORDERS.filter((o) => o !== order);
      const otherHits = others.reduce((sum, o) => sum + hitRates.get(o)!.hits, 0);
      const otherSamples = others.reduce(
        (sum, o) => sum + hitRates.get(o)!.samples,
        0
      );
      const othersRate = rateOf(otherHits, otherSamples);
      if (othersRate == null || target.rate == null) continue;
      const diff = target.rate - othersRate;
      if (diff > -HIT_RATE_DIFF_THRESHOLD) continue;
      const diffInterval = proportionDiffInterval(
        target.hits,
        target.samples,
        otherHits,
        otherSamples,
        CONFIDENCE_INTERVAL_Z
      );
      const supported = excludesZero(diffInterval);
      out.push(
        makeFinding({
          id: `dart_order_hit_rate_${order}_${ctx.scopeKey}`,
          kind: "statistical_trend",
          polarity: "issue",
          priority: 12,
          effect: normalizedEffect(diff, EFFECT_SCALE_RATE),
          primaryMetric: `${order}投目の命中率`,
          subject: `dart_order_${order}_${ctx.scopeKey}`,
          title: `${order}投目の命中率が他の投順より低い状態です`,
          summary: `${order}投目の命中率が、他の投順をまとめた命中率を下回っています。`,
          confidenceInput: confidenceInputOf(ctx, target.samples, 1, supported),
          evidence: [
            ...DART_ORDERS.map((o) => ({
              metric: `${o}投目の命中率`,
              current: hitRates.get(o)!.rate,
              sampleSize: hitRates.get(o)!.samples,
              unit: "rate" as const,
              interval: wilsonInterval(
                hitRates.get(o)!.hits,
                hitRates.get(o)!.samples,
                CONFIDENCE_INTERVAL_Z
              ),
              note: scopeNote(ctx),
            })),
            {
              metric: `${order}投目と他の投順まとめとの差`,
              current: target.rate,
              baseline: othersRate,
              difference: diff,
              sampleSize: target.samples,
              unit: "rate" as const,
              interval: diffInterval,
            },
          ],
          limitations: [
            "命中判定対象の投擲のみを分母にしています。",
            INTERVAL_LIMITATION,
            NO_CAUSE_LIMITATION,
          ],
          actionTemplateId: "dart_order_hit_rate",
        })
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// ルール2: 前半・後半の変化
// ---------------------------------------------------------------------------

/**
 * セッションを投擲順で半分に割り、命中率・平均誤差距離・アウトボード率の
 * 変化を見る。奇数のときは既存統計と同じく前半を1投多くする。
 */
export function detectHalfChange(ctx: RuleContext): RuleFinding[] {
  const out: RuleFinding[] = [];
  const sorted = ctx.throws;
  const half = Math.ceil(sorted.length / 2);
  const first = sorted.slice(0, half);
  const second = sorted.slice(half);

  const firstHit = hitRateOf(first);
  const secondHit = hitRateOf(second);
  if (
    firstHit.rate != null &&
    secondHit.rate != null &&
    isAnalyzableSample(firstHit.samples) &&
    isAnalyzableSample(secondHit.samples)
  ) {
    const diff = secondHit.rate - firstHit.rate;
    if (Math.abs(diff) >= HIT_RATE_DIFF_THRESHOLD) {
      const worse = diff < 0;
      const diffInterval = proportionDiffInterval(
        secondHit.hits,
        secondHit.samples,
        firstHit.hits,
        firstHit.samples,
        CONFIDENCE_INTERVAL_Z
      );
      const supported = excludesZero(diffInterval);
      out.push(
        makeFinding({
          id: `half_hit_rate_${worse ? "down" : "up"}_${ctx.scopeKey}`,
          kind: "statistical_trend",
          polarity: worse ? "issue" : "positive",
          priority: worse ? 20 : 21,
          effect: normalizedEffect(diff, EFFECT_SCALE_RATE),
          primaryMetric: "後半の命中率",
          subject: `half_${ctx.scopeKey}`,
          title: worse
            ? "後半で命中率が下がっています"
            : "後半で命中率が上がっています",
          summary: worse
            ? "投擲順の後半区間で、前半区間より命中率が下がった状態です。"
            : "投擲順の後半区間で、前半区間より命中率が上がった状態です。",
          confidenceInput: confidenceInputOf(
            ctx,
            Math.min(firstHit.samples, secondHit.samples),
            1,
            supported
          ),
          evidence: [
            {
              metric: "前半の命中率",
              current: firstHit.rate,
              sampleSize: firstHit.samples,
              unit: "rate",
              interval: wilsonInterval(
                firstHit.hits,
                firstHit.samples,
                CONFIDENCE_INTERVAL_Z
              ),
              note: scopeNote(ctx),
            },
            {
              metric: "後半の命中率",
              current: secondHit.rate,
              baseline: firstHit.rate,
              difference: diff,
              sampleSize: secondHit.samples,
              unit: "rate",
              interval: diffInterval,
              note: scopeNote(ctx),
            },
          ],
          limitations: [
            "前半・後半は投擲順で分割した区間であり、時間経過そのものを測定した値ではありません。",
            INTERVAL_LIMITATION,
            NO_CAUSE_LIMITATION,
          ],
          actionTemplateId: worse ? "half_hit_rate_down" : undefined,
        })
      );
    }
  }

  // 平均誤差距離は入力精度ごとに分けて比較する（概算と実測を混ぜない）
  const firstCoordinate = errorDistances(first.filter(isCoordinate));
  const secondCoordinate = errorDistances(second.filter(isCoordinate));
  if (
    isAnalyzableSample(firstCoordinate.length) &&
    isAnalyzableSample(secondCoordinate.length)
  ) {
    const firstMean = mean(firstCoordinate);
    const secondMean = mean(secondCoordinate);
    const diff = relativeDiff(secondMean, firstMean);
    if (
      diff != null &&
      Math.abs(diff) >= RELATIVE_DIFF_THRESHOLD &&
      (isMeaningfulDistance(firstMean) || isMeaningfulDistance(secondMean))
    ) {
      const worse = diff > 0;
      const diffInterval = meanDiffInterval(
        secondCoordinate,
        firstCoordinate,
        CONFIDENCE_INTERVAL_Z
      );
      const supported = excludesZero(diffInterval);
      out.push(
        makeFinding({
          id: `half_error_distance_${worse ? "up" : "down"}_${ctx.scopeKey}`,
          kind: "statistical_trend",
          polarity: worse ? "issue" : "positive",
          priority: worse ? 22 : 23,
          effect: normalizedEffect(diff, EFFECT_SCALE_RELATIVE),
          primaryMetric: "後半の平均誤差距離",
          subject: `half_${ctx.scopeKey}`,
          title: worse
            ? "後半で平均誤差距離が大きくなっています"
            : "後半で平均誤差距離が小さくなっています",
          summary: worse
            ? "後半区間の平均誤差距離が前半区間より大きい状態です。"
            : "後半区間の平均誤差距離が前半区間より小さい状態です。",
          confidenceInput: confidenceInputOf(
            ctx,
            Math.min(firstCoordinate.length, secondCoordinate.length),
            1,
            supported
          ),
          evidence: [
            {
              metric: "前半の平均誤差距離",
              current: firstMean,
              sampleSize: firstCoordinate.length,
              unit: "normalized",
              interval: meanInterval(firstCoordinate, CONFIDENCE_INTERVAL_Z),
              note: scopeNote(ctx, "詳細座標のみ"),
            },
            {
              metric: "後半の平均誤差距離",
              current: secondMean,
              baseline: firstMean,
              difference: diff,
              sampleSize: secondCoordinate.length,
              unit: "ratio",
              note: supported
                ? "差の95%区間は0を含まない"
                : "差の95%区間は0を含む",
            },
          ],
          limitations: [
            "詳細座標が記録された投擲のみを対象にしています。",
            INTERVAL_LIMITATION,
            NO_CAUSE_LIMITATION,
          ],
          actionTemplateId: worse ? "half_error_distance_up" : undefined,
        })
      );
    }
  }

  // アウトボード率の変化（着弾位置が取れない投擲も含めて評価できる指標）
  if (isAnalyzableSample(first.length) && isAnalyzableSample(second.length)) {
    const firstOut = first.filter(isOutboard).length;
    const secondOut = second.filter(isOutboard).length;
    const firstRate = rateOf(firstOut, first.length);
    const secondRate = rateOf(secondOut, second.length);
    if (firstRate != null && secondRate != null) {
      const diff = secondRate - firstRate;
      if (diff >= HIT_RATE_DIFF_THRESHOLD) {
        const diffInterval = proportionDiffInterval(
          secondOut,
          second.length,
          firstOut,
          first.length,
          CONFIDENCE_INTERVAL_Z
        );
        const supported = excludesZero(diffInterval);
        out.push(
          makeFinding({
            id: `half_outboard_up_${ctx.scopeKey}`,
            kind: "statistical_trend",
            polarity: "issue",
            priority: 24,
            effect: normalizedEffect(diff, EFFECT_SCALE_RATE),
            primaryMetric: "後半のアウトボード率",
            subject: `half_outboard_${ctx.scopeKey}`,
            title: "後半で盤外へ外れた割合が増えています",
            summary:
              "後半区間で、盤外へ外れた投擲の割合が前半区間より高い状態です。",
            confidenceInput: confidenceInputOf(
              ctx,
              Math.min(first.length, second.length),
              1,
              supported
            ),
            evidence: [
              {
                metric: "前半のアウトボード率",
                current: firstRate,
                sampleSize: first.length,
                unit: "rate",
                interval: wilsonInterval(
                  firstOut,
                  first.length,
                  CONFIDENCE_INTERVAL_Z
                ),
                note: scopeNote(ctx),
              },
              {
                metric: "後半のアウトボード率",
                current: secondRate,
                baseline: firstRate,
                difference: diff,
                sampleSize: second.length,
                unit: "rate",
                interval: diffInterval,
                note: scopeNote(ctx),
              },
            ],
            limitations: [
              "分母は完了投擲数です(命中判定対象数ではありません)。",
              INTERVAL_LIMITATION,
              NO_CAUSE_LIMITATION,
            ],
            actionTemplateId: "half_outboard_up",
          })
        );
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// ルール3: 左右・上下の偏り / 再現性不足
// ---------------------------------------------------------------------------

/**
 * 平均位置が片側へ寄っている「偏り」と、平均は中央付近だが散らばりが大きい
 * 「再現性不足」を区別して検出する。平均誤差距離だけで左右・上下をまとめない。
 *
 * 詳細座標が十分にある場合のみ座標を根拠にする。簡易入力の場合は
 * ミリ単位の座標差ではなく、外れ方向の頻度として扱う（別ルール）。
 */
export function detectAxisBias(ctx: RuleContext): RuleFinding[] {
  const out: RuleFinding[] = [];
  const coordinate = ctx.throws.filter(isCoordinate);
  for (const axis of AXIS_DEFS) {
    const values = axisValues(coordinate, axis);
    if (!isAnalyzableSample(values.length)) continue;
    const m = mean(values);
    const sd = sampleStdDev(values);
    if (m == null || sd == null) continue;
    const side = m >= 0 ? axis.positive : axis.negative;
    const isBias =
      Math.abs(m) >= BIAS_MEAN_THRESHOLD && Math.abs(m) >= BIAS_MEAN_TO_SD_RATIO * sd;
    const isDispersion = !isBias && sd >= DISPERSION_SD_THRESHOLD;
    if (!isBias && !isDispersion) continue;
    const interval = meanInterval(values, CONFIDENCE_INTERVAL_Z);
    // 偏りは「平均が0から離れているか」が主題なので、平均の区間が0をまたがない
    // ことを裏付けに使う。再現性不足は散らばりの大きさが主題のため調整しない。
    const supported = isBias ? excludesZero(interval) : undefined;
    out.push(
      makeFinding({
        id: `axis_${isBias ? "bias" : "dispersion"}_${axis.key}_${ctx.scopeKey}`,
        kind: "statistical_trend",
        polarity: "issue",
        priority: isBias ? 40 : 42,
        effect: isBias
          ? normalizedEffect(m, BIAS_MEAN_THRESHOLD * 4)
          : normalizedEffect(sd, DISPERSION_SD_THRESHOLD * 4),
        primaryMetric: isBias
          ? `${axis.label}の平均誤差(${axis.positive}が正)`
          : `${axis.label}の標準偏差`,
        subject: `axis_${axis.key}_${ctx.scopeKey}`,
        title: isBias
          ? `${axis.label}の着弾が${side}側へ寄っています`
          : `${axis.label}の着弾のばらつきが大きい状態です`,
        summary: isBias
          ? `${axis.label}の平均誤差が${side}側にあり、散らばりよりも片側への寄りが目立つ状態です。`
          : `${axis.label}の平均誤差は中央付近ですが、標準偏差が大きく、同じ位置へ再現できていない状態です。`,
        confidenceInput: confidenceInputOf(ctx, values.length, 1, supported),
        evidence: [
          {
            metric: `${axis.label}の平均誤差(${axis.positive}が正)`,
            current: m,
            sampleSize: values.length,
            unit: "normalized",
            interval,
            note: scopeNote(ctx, "詳細座標のみ"),
          },
          {
            metric: `${axis.label}の標準偏差`,
            current: sd,
            sampleSize: values.length,
            unit: "normalized",
            note: scopeNote(ctx, "詳細座標のみ"),
          },
        ],
        limitations: [
          "偏り(平均の寄り)と再現性不足(散らばり)は別の状態として区別しています。",
          INTERVAL_LIMITATION,
          NO_CAUSE_LIMITATION,
        ],
        actionTemplateId: isBias ? "axis_bias" : "axis_dispersion",
      })
    );
  }
  return out;
}

const DIRECTION_LABELS: Record<MissDirection, string> = {
  center: "中心付近",
  up: "上",
  up_right: "右上",
  right: "右",
  down_right: "右下",
  down: "下",
  down_left: "左下",
  left: "左",
  up_left: "左上",
};

/**
 * 簡易入力（セグメント単位）のセッション向け。
 * 座標差ではなく外れ方向の頻度分布だけを根拠にする。
 */
export function detectDirectionBias(ctx: RuleContext): RuleFinding[] {
  const approximate = ctx.throws.filter(isApproximate);
  // 詳細座標が分析可能な量あるなら、座標ベースのルールが担当する
  if (isAnalyzableSample(ctx.throws.filter(isCoordinate).length)) return [];
  const counts = new Map<MissDirection, number>();
  let total = 0;
  for (const t of approximate) {
    const dir = t.derived.missDirection;
    if (dir == null || dir === "center") continue;
    if (t.derived.exactHit === true) continue;
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
    total += 1;
  }
  if (!isAnalyzableSample(total)) return [];
  const entries = [...counts.entries()].sort((a, b) =>
    b[1] === a[1] ? a[0].localeCompare(b[0]) : b[1] - a[1]
  );
  const top = entries[0];
  if (!top) return [];
  const ratio = rateOf(top[1], total);
  if (ratio == null || ratio < DIRECTION_BIAS_RATIO_THRESHOLD) return [];
  const interval = wilsonInterval(top[1], total, CONFIDENCE_INTERVAL_Z);
  // 8方向へ均等に散る場合の期待割合(1/8)を区間の下限が上回っていることを裏付けとする
  const supported = interval != null && interval.low > 1 / 8;
  return [
    makeFinding({
      id: `direction_bias_${top[0]}_${ctx.scopeKey}`,
      kind: "statistical_trend",
      polarity: "issue",
      priority: 44,
      effect: normalizedEffect(ratio - 1 / 8, 0.5),
      primaryMetric: `外れ方向「${DIRECTION_LABELS[top[0]]}」の割合`,
      subject: `direction_${ctx.scopeKey}`,
      title: `外れ方向が「${DIRECTION_LABELS[top[0]]}」に集中しています`,
      summary: `簡易入力の記録では、ミスした投擲の外れ方向が「${DIRECTION_LABELS[top[0]]}」へ偏っています。`,
      confidenceInput: confidenceInputOf(ctx, total, 1, supported),
      evidence: [
        {
          metric: `外れ方向「${DIRECTION_LABELS[top[0]]}」の割合`,
          current: ratio,
          sampleSize: total,
          unit: "rate",
          interval,
          note: scopeNote(ctx, "簡易入力・8方向が均等なら12.5%"),
        },
        {
          metric: `外れ方向「${DIRECTION_LABELS[top[0]]}」の件数`,
          current: top[1],
          sampleSize: total,
          unit: "count",
          note: scopeNote(ctx),
        },
      ],
      limitations: [
        "簡易入力の座標はエリア代表点による概算値のため、ミリ単位の偏差は根拠にしていません。",
        INTERVAL_LIMITATION,
        NO_CAUSE_LIMITATION,
      ],
      actionTemplateId: "direction_bias",
    }),
  ];
}

// ---------------------------------------------------------------------------
// ルール4: グルーピング
// ---------------------------------------------------------------------------

/**
 * 有効な同一ターゲット3投セット（3投すべて詳細座標）がある場合のみ扱う。
 * 既存の SessionStatistics.grouping をそのまま根拠に使い、統計を再計算しない。
 */
export function detectGroupingChange(ctx: RuleContext): RuleFinding[] {
  // グルーピング統計はセッション単位の計算のため、対象スコープでのみ使う
  if (!ctx.allowGroupingStats) return [];
  const grouping = ctx.stats.grouping;
  if (!grouping || grouping.status !== "available") return [];
  if (grouping.validSetCount < MIN_GROUPING_SETS) return [];
  const out: RuleFinding[] = [];

  const firstDiameter = grouping.firstHalfAverageDiameter;
  const secondDiameter = grouping.secondHalfAverageDiameter;
  const halfDiff = relativeDiff(secondDiameter, firstDiameter);
  if (
    halfDiff != null &&
    Math.abs(halfDiff) >= GROUPING_RELATIVE_DIFF_THRESHOLD &&
    (isMeaningfulDistance(firstDiameter) || isMeaningfulDistance(secondDiameter))
  ) {
    const worse = halfDiff > 0;
    out.push(
      makeFinding({
        id: `grouping_half_${worse ? "widen" : "tighten"}`,
        kind: "statistical_trend",
        polarity: worse ? "issue" : "positive",
        priority: worse ? 30 : 31,
        effect: normalizedEffect(halfDiff, EFFECT_SCALE_RELATIVE),
        primaryMetric: "後半の平均グルーピング径",
        subject: "grouping_half",
        title: worse
          ? "後半でグルーピング径が広がっています"
          : "後半でグルーピング径が縮小しています",
        summary: worse
          ? "有効セットを実施順で半分に割ったとき、後半のグルーピング径が前半より大きい状態です。"
          : "有効セットを実施順で半分に割ったとき、後半のグルーピング径が前半より小さい状態です。",
        confidenceInput: confidenceInputOf(ctx, grouping.validSetCount, 1),
        evidence: [
          {
            metric: "前半の平均グルーピング径",
            current: firstDiameter,
            sampleSize: Math.ceil(grouping.validSetCount / 2),
            unit: "normalized",
          },
          {
            metric: "後半の平均グルーピング径",
            current: secondDiameter,
            baseline: firstDiameter,
            difference: halfDiff,
            sampleSize: Math.floor(grouping.validSetCount / 2),
            unit: "ratio",
          },
        ],
        limitations: [
          "3投すべてに詳細座標がある有効セットのみを対象にしています。",
          "分母は投擲数ではなく有効セット数です。",
          NO_CAUSE_LIMITATION,
        ],
        actionTemplateId: worse ? "grouping_half_widen" : undefined,
      })
    );
  }

  // 投順間距離: 1→2投目 と 2→3投目 のどちらが離れているか
  const inter = grouping.interDartDistances;
  const d1d2 = inter?.d1d2;
  const d2d3 = inter?.d2d3;
  const interDiff = relativeDiff(d2d3, d1d2);
  if (
    interDiff != null &&
    Math.abs(interDiff) >= GROUPING_RELATIVE_DIFF_THRESHOLD &&
    (isMeaningfulDistance(d1d2) || isMeaningfulDistance(d2d3))
  ) {
    const laterIsWider = interDiff > 0;
    out.push(
      makeFinding({
        id: `grouping_inter_dart_${laterIsWider ? "late" : "early"}`,
        kind: "statistical_trend",
        polarity: "issue",
        priority: 33,
        effect: normalizedEffect(interDiff, EFFECT_SCALE_RELATIVE),
        primaryMetric: laterIsWider ? "2→3投目の平均距離" : "1→2投目の平均距離",
        subject: "grouping_inter_dart",
        title: laterIsWider
          ? "セット内で2投目から3投目の間隔が広がっています"
          : "セット内で1投目から2投目の間隔が広がっています",
        summary: laterIsWider
          ? "同一セット内の着弾間距離が、1→2投目より2→3投目で大きい状態です。"
          : "同一セット内の着弾間距離が、2→3投目より1→2投目で大きい状態です。",
        confidenceInput: confidenceInputOf(ctx, grouping.validSetCount, 1),
        evidence: [
          {
            metric: "1→2投目の平均距離",
            current: d1d2,
            sampleSize: grouping.validSetCount,
            unit: "normalized",
          },
          {
            metric: "2→3投目の平均距離",
            current: d2d3,
            baseline: d1d2,
            difference: interDiff,
            sampleSize: grouping.validSetCount,
            unit: "ratio",
          },
          {
            metric: "1→3投目の平均距離",
            current: inter?.d1d3,
            sampleSize: grouping.validSetCount,
            unit: "normalized",
          },
        ],
        limitations: [
          "3投すべてに詳細座標がある有効セットのみを対象にしています。",
          "分母は投擲数ではなく有効セット数です。",
          NO_CAUSE_LIMITATION,
        ],
        actionTemplateId: "grouping_inter_dart",
      })
    );
  }

  const baseline = ctx.allowBaselineComparison ? ctx.baseline : undefined;
  if (baseline?.groupingDiameter != null && grouping.averageDiameter != null) {
    const diff = relativeDiff(grouping.averageDiameter, baseline.groupingDiameter);
    if (
      diff != null &&
      Math.abs(diff) >= GROUPING_RELATIVE_DIFF_THRESHOLD &&
      (isMeaningfulDistance(grouping.averageDiameter) ||
        isMeaningfulDistance(baseline.groupingDiameter))
    ) {
      const worse = diff > 0;
      out.push(
        makeFinding({
          id: `grouping_vs_baseline_${worse ? "widen" : "tighten"}`,
          kind: "statistical_trend",
          polarity: worse ? "issue" : "positive",
          priority: worse ? 32 : 5,
          effect: normalizedEffect(diff, EFFECT_SCALE_RELATIVE),
          primaryMetric: "今回の平均グルーピング径",
          subject: "grouping_baseline",
          title: worse
            ? "平均グルーピング径が過去の同条件セッションより広がっています"
            : "平均グルーピング径が過去の同条件セッションより縮小しています",
          summary: worse
            ? "今回の平均グルーピング径は、比較可能な直近セッションの平均より大きい状態です。"
            : "今回の平均グルーピング径は、比較可能な直近セッションの平均より小さい状態です。",
          confidenceInput: confidenceInputOf(ctx, grouping.validSetCount, 2),
          evidence: [
            {
              metric: "今回の平均グルーピング径",
              current: grouping.averageDiameter,
              sampleSize: grouping.validSetCount,
              unit: "normalized",
            },
            {
              metric: "比較可能な過去セッションの平均",
              current: baseline.groupingDiameter,
              sampleSize: baseline.groupingSets,
              unit: "normalized",
              note: `対象${baseline.sessionCount}セッション`,
            },
            {
              metric: "相対差",
              current: grouping.averageDiameter,
              baseline: baseline.groupingDiameter,
              difference: diff,
              sampleSize: grouping.validSetCount,
              unit: "ratio",
            },
          ],
          limitations: [
            "同一モード・同一ボード種別・同一スコアリング形式・同一入力精度のセッションのみを比較対象にしています。",
            NO_CAUSE_LIMITATION,
          ],
          actionTemplateId: worse ? "grouping_vs_baseline_widen" : undefined,
        })
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// ルール5: ターゲット切替直後
// ---------------------------------------------------------------------------

/**
 * セット内でターゲットが切り替わった直後の投擲と、同一ターゲットが継続した
 * 投擲を比較する。セットの1投目（same_set_as_previous=false）は前投との関係が
 * 定義できないため、必ず除外する。
 * 切替サンプルが0件のときは推測せず「未測定・分析不能」とする。
 */
export function detectTargetSwitch(ctx: RuleContext): RuleFinding[] {
  const withinSet = ctx.throws.filter(
    (t) => t.derived.sameSetAsPrevious === true && isScorable(t)
  );
  const switched = withinSet.filter(
    (t) => t.derived.targetChangedFromPrevious === true
  );
  const continued = withinSet.filter(
    (t) => t.derived.targetChangedFromPrevious === false
  );
  if (switched.length === 0) {
    return [
      makeFinding({
        id: `target_switch_unmeasured_${ctx.scopeKey}`,
        kind: "not_analyzable",
        polarity: "unavailable",
        priority: 900,
        effect: 0,
        title: "ターゲット切替直後は未測定です",
        summary:
          "セット内でターゲットが切り替わった投擲が0件のため、切替直後の変化は分析できません。",
        confidenceInput: { sampleSize: 0, corroboratingConditions: 0 },
        evidence: [
          {
            metric: "セット内切替直後の投擲数",
            current: 0,
            sampleSize: withinSet.length,
            unit: "count",
            note: scopeNote(ctx),
          },
        ],
        limitations: ["サンプルが0件のため、切替能力の推測は行いません。"],
      }),
    ];
  }
  if (
    !isAnalyzableSample(switched.length) ||
    !isAnalyzableSample(continued.length)
  ) {
    return [
      makeFinding({
        id: `target_switch_insufficient_${ctx.scopeKey}`,
        kind: "not_analyzable",
        polarity: "unavailable",
        priority: 901,
        effect: 0,
        title: "ターゲット切替直後の比較はサンプル不足です",
        summary: `切替直後${switched.length}投 / 同一ターゲット継続${continued.length}投で、最低分析数${MIN_ANALYZABLE_SAMPLE}投に達していません。`,
        confidenceInput: { sampleSize: 0, corroboratingConditions: 0 },
        evidence: [
          {
            metric: "セット内切替直後の投擲数",
            current: switched.length,
            sampleSize: withinSet.length,
            unit: "count",
          },
          {
            metric: "同一ターゲット継続の投擲数",
            current: continued.length,
            sampleSize: withinSet.length,
            unit: "count",
          },
        ],
        limitations: ["セットの1投目は前投との関係が定義できないため除外しています。"],
      }),
    ];
  }
  const switchedHit = hitRateOf(switched);
  const continuedHit = hitRateOf(continued);
  if (switchedHit.rate == null || continuedHit.rate == null) return [];
  const diff = switchedHit.rate - continuedHit.rate;
  if (diff > -HIT_RATE_DIFF_THRESHOLD) return [];
  const diffInterval = proportionDiffInterval(
    switchedHit.hits,
    switchedHit.samples,
    continuedHit.hits,
    continuedHit.samples,
    CONFIDENCE_INTERVAL_Z
  );
  const supported = excludesZero(diffInterval);
  return [
    makeFinding({
      id: `target_switch_hit_rate_down_${ctx.scopeKey}`,
      kind: "statistical_trend",
      polarity: "issue",
      priority: 60,
      effect: normalizedEffect(diff, EFFECT_SCALE_RATE),
      primaryMetric: "セット内切替直後の命中率",
      subject: `target_switch_${ctx.scopeKey}`,
      title: "セット内でターゲットが切り替わった直後の命中率が下がっています",
      summary:
        "同一ターゲットが続いた投擲に比べ、セット内で狙いが切り替わった直後の投擲で命中率が低い状態です。",
      confidenceInput: confidenceInputOf(ctx, switched.length, 1, supported),
      evidence: [
        {
          metric: "同一ターゲット継続の命中率",
          current: continuedHit.rate,
          sampleSize: continuedHit.samples,
          unit: "rate",
          interval: wilsonInterval(
            continuedHit.hits,
            continuedHit.samples,
            CONFIDENCE_INTERVAL_Z
          ),
          note: scopeNote(ctx),
        },
        {
          metric: "セット内切替直後の命中率",
          current: switchedHit.rate,
          baseline: continuedHit.rate,
          difference: diff,
          sampleSize: switchedHit.samples,
          unit: "rate",
          interval: diffInterval,
          note: scopeNote(ctx),
        },
      ],
      limitations: [
        "セットの1投目は前投との関係が定義できないため除外しています。",
        INTERVAL_LIMITATION,
        NO_CAUSE_LIMITATION,
      ],
      actionTemplateId: "target_switch_hit_rate_down",
    }),
  ];
}

// ---------------------------------------------------------------------------
// ルール6: 命中後・ミス後の次投
// ---------------------------------------------------------------------------

/**
 * 同一セット内の「前投が命中した直後」「前投がミスした直後」を比較する。
 * セットをまたぐ投擲（セットの1投目）は前投関係へ含めない。
 * あわせて、前投が横方向へ外れた直後に反対方向へ大きく外す「過剰修正」を見る。
 */
export function detectPreviousThrowEffect(ctx: RuleContext): RuleFinding[] {
  const out: RuleFinding[] = [];
  const withinSet = ctx.throws.filter(
    (t) =>
      t.derived.sameSetAsPrevious === true &&
      isScorable(t) &&
      t.derived.previousThrowWasHitInSameSet != null
  );
  const afterHit = withinSet.filter(
    (t) => t.derived.previousThrowWasHitInSameSet === true
  );
  const afterMiss = withinSet.filter(
    (t) => t.derived.previousThrowWasHitInSameSet === false
  );
  if (isAnalyzableSample(afterHit.length) && isAnalyzableSample(afterMiss.length)) {
    const hitNext = hitRateOf(afterHit);
    const missNext = hitRateOf(afterMiss);
    if (hitNext.rate != null && missNext.rate != null) {
      const diff = hitNext.rate - missNext.rate;
      if (Math.abs(diff) >= HIT_RATE_DIFF_THRESHOLD) {
        const worseAfterHit = diff < 0;
        const diffInterval = proportionDiffInterval(
          hitNext.hits,
          hitNext.samples,
          missNext.hits,
          missNext.samples,
          CONFIDENCE_INTERVAL_Z
        );
        const supported = excludesZero(diffInterval);
        out.push(
          makeFinding({
            id: `previous_throw_hit_effect_${worseAfterHit ? "after_hit" : "after_miss"}_${ctx.scopeKey}`,
            kind: "statistical_trend",
            polarity: "issue",
            priority: 50,
            effect: normalizedEffect(diff, EFFECT_SCALE_RATE),
            primaryMetric: worseAfterHit ? "前投命中後の命中率" : "前投ミス後の命中率",
            subject: `previous_throw_${ctx.scopeKey}`,
            title: worseAfterHit
              ? "前投が命中した直後の投擲で命中率が下がっています"
              : "前投がミスした直後の投擲で命中率が下がっています",
            summary: worseAfterHit
              ? "同一セット内で、前の投擲が命中した直後の投擲の命中率が、ミス直後より低い状態です。"
              : "同一セット内で、前の投擲がミスした直後の投擲の命中率が、命中直後より低い状態です。",
            confidenceInput: confidenceInputOf(
              ctx,
              Math.min(afterHit.length, afterMiss.length),
              1,
              supported
            ),
            evidence: [
              {
                metric: "前投命中後の命中率",
                current: hitNext.rate,
                sampleSize: hitNext.samples,
                unit: "rate",
                interval: wilsonInterval(
                  hitNext.hits,
                  hitNext.samples,
                  CONFIDENCE_INTERVAL_Z
                ),
                note: scopeNote(ctx),
              },
              {
                metric: "前投ミス後の命中率",
                current: missNext.rate,
                baseline: hitNext.rate,
                difference: -diff,
                sampleSize: missNext.samples,
                unit: "rate",
                interval: diffInterval,
                note: scopeNote(ctx),
              },
            ],
            limitations: [
              "同一セット内の投擲のみを対象とし、セットをまたぐ前投関係は含めていません。",
              INTERVAL_LIMITATION,
              NO_CAUSE_LIMITATION,
            ],
            actionTemplateId: "previous_throw_hit_effect",
          })
        );
      }
    }
  }

  // 過剰修正: 前投が横方向へ大きく外れた直後、反対側へ大きく外している割合
  const bySet = new Map<string, ThrowRecord[]>();
  for (const t of ctx.throws) {
    const list = bySet.get(t.setId) ?? [];
    list.push(t);
    bySet.set(t.setId, list);
  }
  let overCorrections = 0;
  let candidates = 0;
  for (const set of bySet.values()) {
    const ordered = set.slice().sort((a, b) => a.dartInSet - b.dartInSet);
    for (let i = 1; i < ordered.length; i += 1) {
      const previous = ordered[i - 1]!;
      const current = ordered[i]!;
      if (current.derived.sameSetAsPrevious !== true) continue;
      if (!isCoordinate(previous) || !isCoordinate(current)) continue;
      const prevX = previous.derived.errorX;
      const currX = current.derived.errorX;
      if (prevX == null || currX == null) continue;
      if (Math.abs(prevX) < BIAS_MEAN_THRESHOLD) continue;
      candidates += 1;
      if (
        Math.sign(currX) !== Math.sign(prevX) &&
        Math.abs(currX) >= BIAS_MEAN_THRESHOLD
      ) {
        overCorrections += 1;
      }
    }
  }
  const overRate = rateOf(overCorrections, candidates);
  if (
    isAnalyzableSample(candidates) &&
    overRate != null &&
    overRate >= DIRECTION_BIAS_RATIO_THRESHOLD
  ) {
    const interval = wilsonInterval(
      overCorrections,
      candidates,
      CONFIDENCE_INTERVAL_Z
    );
    const supported =
      interval != null && interval.low > DIRECTION_BIAS_RATIO_THRESHOLD;
    out.push(
      makeFinding({
        id: `over_correction_${ctx.scopeKey}`,
        kind: "statistical_trend",
        polarity: "issue",
        priority: 52,
        effect: normalizedEffect(overRate - DIRECTION_BIAS_RATIO_THRESHOLD, 0.4),
        primaryMetric: "前投が横方向へ外れた投擲数(判定の分母)",
        subject: `over_correction_${ctx.scopeKey}`,
        title: "前投が横へ外れた直後、反対側へ大きく外す投擲が多い状態です",
        summary:
          "同一セット内で前の投擲が横方向へ外れたあと、次の投擲が反対側へ同程度以上外れている割合が高い状態です。",
        confidenceInput: confidenceInputOf(ctx, candidates, 1, supported),
        evidence: [
          {
            metric: "前投が横方向へ外れた投擲数(判定の分母)",
            current: candidates,
            sampleSize: candidates,
            unit: "count",
            note: scopeNote(ctx, "詳細座標のみ"),
          },
          {
            metric: "うち反対側へ外した投擲の割合",
            current: overRate,
            sampleSize: candidates,
            unit: "rate",
            interval,
            note: scopeNote(ctx),
          },
        ],
        limitations: [
          "同一セット内の連続する投擲のみを対象にしています。",
          INTERVAL_LIMITATION,
          NO_CAUSE_LIMITATION,
        ],
        actionTemplateId: "over_correction",
      })
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// ルール7: 本人の過去平均との差
// ---------------------------------------------------------------------------

/**
 * 比較可能な過去セッションの平均と今回を比較する。
 * 比較対象は selectComparableSessions で条件を満たしたものだけ。
 * スコープ分割時（スキル診断のラウンド別）はセッション単位の基準線を
 * そのまま当てられないため実行しない。
 */
export function detectBaselineDiff(ctx: RuleContext): RuleFinding[] {
  if (!ctx.allowBaselineComparison) return [];
  const baseline = ctx.baseline;
  if (!baseline) return [];
  const out: RuleFinding[] = [];

  const currentHit = ctx.stats.scorableExactHitRate ?? ctx.stats.exactHitRate;
  const currentHitSamples = ctx.stats.scorableThrows ?? ctx.stats.completedThrows;
  if (
    currentHit != null &&
    baseline.hitRate != null &&
    isAnalyzableSample(currentHitSamples) &&
    isAnalyzableSample(baseline.hitRateSamples)
  ) {
    const diff = currentHit - baseline.hitRate;
    if (Math.abs(diff) >= HIT_RATE_DIFF_THRESHOLD) {
      const better = diff > 0;
      const diffInterval = proportionDiffInterval(
        ctx.stats.exactHits,
        currentHitSamples,
        baseline.hitCountTotal,
        baseline.hitRateSamples,
        CONFIDENCE_INTERVAL_Z
      );
      const supported = excludesZero(diffInterval);
      out.push(
        makeFinding({
          id: `baseline_hit_rate_${better ? "up" : "down"}`,
          kind: "statistical_trend",
          polarity: better ? "positive" : "issue",
          priority: better ? 4 : 70,
          effect: normalizedEffect(diff, EFFECT_SCALE_RATE),
          primaryMetric: "今回の完全命中率",
          subject: "baseline_hit_rate",
          title: better
            ? "命中率が過去の同条件セッション平均を上回っています"
            : "命中率が過去の同条件セッション平均を下回っています",
          summary: better
            ? "今回の完全命中率は、比較可能な直近セッションの平均より高い状態です。"
            : "今回の完全命中率は、比較可能な直近セッションの平均より低い状態です。",
          confidenceInput: confidenceInputOf(ctx, currentHitSamples, 2, supported),
          evidence: [
            {
              metric: "今回の完全命中率",
              current: currentHit,
              sampleSize: currentHitSamples,
              unit: "rate",
              interval: wilsonInterval(
                ctx.stats.exactHits,
                currentHitSamples,
                CONFIDENCE_INTERVAL_Z
              ),
            },
            {
              metric: "比較可能な過去セッションの平均",
              current: baseline.hitRate,
              sampleSize: baseline.hitRateSamples,
              unit: "rate",
              note: `対象${baseline.sessionCount}セッション`,
            },
            {
              metric: "差",
              current: currentHit,
              baseline: baseline.hitRate,
              difference: diff,
              sampleSize: currentHitSamples,
              unit: "rate",
              interval: diffInterval,
            },
          ],
          limitations: [
            "同一モード・同一ボード種別・同一スコアリング形式・同一入力精度のセッションのみを比較対象にしています。",
            INTERVAL_LIMITATION,
            NO_CAUSE_LIMITATION,
          ],
          actionTemplateId: better ? undefined : "baseline_hit_rate_down",
        })
      );
    }
  }

  const currentError = ctx.stats.coordinateError.averageErrorDistance;
  const currentErrorSamples = ctx.stats.coordinateError.sampleCount;
  if (
    currentError != null &&
    baseline.coordinateErrorMean != null &&
    isAnalyzableSample(currentErrorSamples) &&
    isAnalyzableSample(baseline.coordinateErrorSamples)
  ) {
    const diff = relativeDiff(currentError, baseline.coordinateErrorMean);
    if (
      diff != null &&
      Math.abs(diff) >= RELATIVE_DIFF_THRESHOLD &&
      (isMeaningfulDistance(currentError) ||
        isMeaningfulDistance(baseline.coordinateErrorMean))
    ) {
      const better = diff < 0;
      out.push(
        makeFinding({
          id: `baseline_error_distance_${better ? "down" : "up"}`,
          kind: "statistical_trend",
          polarity: better ? "positive" : "issue",
          priority: better ? 6 : 72,
          effect: normalizedEffect(diff, EFFECT_SCALE_RELATIVE),
          primaryMetric: "今回の平均誤差距離",
          subject: "baseline_error_distance",
          title: better
            ? "平均誤差距離が過去の同条件セッション平均より小さくなっています"
            : "平均誤差距離が過去の同条件セッション平均より大きくなっています",
          summary: better
            ? "今回の詳細座標による平均誤差距離は、比較可能な直近セッションの平均より小さい状態です。"
            : "今回の詳細座標による平均誤差距離は、比較可能な直近セッションの平均より大きい状態です。",
          confidenceInput: confidenceInputOf(ctx, currentErrorSamples, 2),
          evidence: [
            {
              metric: "今回の平均誤差距離",
              current: currentError,
              sampleSize: currentErrorSamples,
              unit: "normalized",
              note: "詳細座標のみ",
            },
            {
              metric: "比較可能な過去セッションの平均",
              current: baseline.coordinateErrorMean,
              sampleSize: baseline.coordinateErrorSamples,
              unit: "normalized",
              note: `対象${baseline.sessionCount}セッション / 詳細座標のみ`,
            },
            {
              metric: "相対差",
              current: currentError,
              baseline: baseline.coordinateErrorMean,
              difference: diff,
              sampleSize: currentErrorSamples,
              unit: "ratio",
            },
          ],
          limitations: [
            "詳細座標のみの平均誤差距離を比較しています。簡易入力の概算値とは同じ誤差指標として比較していません。",
            NO_CAUSE_LIMITATION,
          ],
          actionTemplateId: better ? undefined : "baseline_error_distance_up",
        })
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// ルール8: 長期トレンド（複数セッションで方向が一貫しているか）
// ---------------------------------------------------------------------------

/**
 * 比較可能な過去セッションと今回を古い順に並べ、指標が一貫して同じ方向へ
 * 動いているかを見る。単発の差ではなく方向の継続を扱うため、
 * MIN_TREND_SESSIONS 未満では方向を語らない。
 */
export function detectLongTermTrend(ctx: RuleContext): RuleFinding[] {
  if (!ctx.allowBaselineComparison) return [];
  const baseline = ctx.baseline;
  if (!baseline) return [];
  const out: RuleFinding[] = [];

  const currentHit = ctx.stats.scorableExactHitRate ?? ctx.stats.exactHitRate;
  const hitSeries = [...baseline.history.map((h) => h.hitRate), currentHit].filter(
    (v): v is number => v != null
  );
  if (hitSeries.length >= MIN_TREND_SESSIONS) {
    const direction = monotonicDirection(hitSeries);
    if (direction) {
      const better = direction === "increasing";
      const span =
        (hitSeries[hitSeries.length - 1] as number) - (hitSeries[0] as number);
      const samples = ctx.stats.scorableThrows ?? ctx.stats.completedThrows;
      out.push(
        makeFinding({
          id: `trend_hit_rate_${better ? "up" : "down"}`,
          kind: "statistical_trend",
          polarity: better ? "positive" : "issue",
          priority: better ? 8 : 74,
          effect: normalizedEffect(span, EFFECT_SCALE_RATE),
          primaryMetric: "命中率のセッション間推移",
          subject: "trend_hit_rate",
          title: better
            ? `命中率が${hitSeries.length}セッション連続で上がっています`
            : `命中率が${hitSeries.length}セッション連続で下がっています`,
          summary: better
            ? "比較可能なセッションを古い順に並べたとき、命中率が一貫して上がっています。"
            : "比較可能なセッションを古い順に並べたとき、命中率が一貫して下がっています。",
          confidenceInput: confidenceInputOf(ctx, samples, 2),
          evidence: [
            {
              metric: `古い順${hitSeries.length}セッションの最初の命中率`,
              current: hitSeries[0],
              sampleSize: hitSeries.length,
              unit: "rate",
              note: "分母はセッション数",
            },
            {
              metric: "今回の命中率",
              current: currentHit,
              baseline: hitSeries[0],
              difference: span,
              sampleSize: samples,
              unit: "rate",
            },
          ],
          limitations: [
            "連続する変化の向きだけを見ており、変化量の大きさは評価していません。",
            "セッションごとに投擲数が異なるため、各点の推定の幅は同じではありません。",
            NO_CAUSE_LIMITATION,
          ],
          actionTemplateId: better ? undefined : "trend_hit_rate_down",
        })
      );
    }
  }

  const errorSeries = [
    ...baseline.history.map((h) => h.coordinateErrorMean),
    ctx.stats.coordinateError.averageErrorDistance,
  ].filter((v): v is number => v != null);
  if (errorSeries.length >= MIN_TREND_SESSIONS) {
    const direction = monotonicDirection(errorSeries);
    const span = relativeDiff(errorSeries[errorSeries.length - 1], errorSeries[0]);
    if (direction && span != null) {
      const better = direction === "decreasing";
      out.push(
        makeFinding({
          id: `trend_error_distance_${better ? "down" : "up"}`,
          kind: "statistical_trend",
          polarity: better ? "positive" : "issue",
          priority: better ? 9 : 76,
          effect: normalizedEffect(span, EFFECT_SCALE_RELATIVE),
          primaryMetric: "平均誤差距離のセッション間推移",
          subject: "trend_error_distance",
          title: better
            ? `平均誤差距離が${errorSeries.length}セッション連続で小さくなっています`
            : `平均誤差距離が${errorSeries.length}セッション連続で大きくなっています`,
          summary: better
            ? "比較可能なセッションを古い順に並べたとき、平均誤差距離が一貫して小さくなっています。"
            : "比較可能なセッションを古い順に並べたとき、平均誤差距離が一貫して大きくなっています。",
          confidenceInput: confidenceInputOf(ctx, ctx.stats.coordinateError.sampleCount, 2),
          evidence: [
            {
              metric: `古い順${errorSeries.length}セッションの最初の平均誤差距離`,
              current: errorSeries[0],
              sampleSize: errorSeries.length,
              unit: "normalized",
              note: "分母はセッション数 / 詳細座標のみ",
            },
            {
              metric: "今回の平均誤差距離",
              current: errorSeries[errorSeries.length - 1],
              baseline: errorSeries[0],
              difference: span,
              sampleSize: ctx.stats.coordinateError.sampleCount,
              unit: "ratio",
            },
          ],
          limitations: [
            "連続する変化の向きだけを見ており、変化量の大きさは評価していません。",
            "詳細座標のみを対象にしています。",
            NO_CAUSE_LIMITATION,
          ],
          actionTemplateId: better ? undefined : "trend_error_distance_up",
        })
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// ルール9: ターゲット別の弱点
// ---------------------------------------------------------------------------

interface TargetSummary extends HitSummary {
  label: string;
}

/** 十分な分母があるターゲットだけを、ラベル昇順で集計する。 */
function eligibleTargets(ctx: RuleContext): TargetSummary[] {
  const byLabel = new Map<string, ThrowRecord[]>();
  for (const t of ctx.throws.filter(isScorable)) {
    const list = byLabel.get(t.target.label) ?? [];
    list.push(t);
    byLabel.set(t.target.label, list);
  }
  return [...byLabel.entries()]
    .filter(([, list]) => list.length >= MIN_TARGET_SAMPLE)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([label, list]) => ({ label, ...hitRateOf(list) }));
}

function sumExcept(
  summaries: readonly TargetSummary[],
  label: string
): { hits: number; samples: number; rate?: number } {
  const others = summaries.filter((s) => s.label !== label);
  const hits = others.reduce((sum, s) => sum + s.hits, 0);
  const samples = others.reduce((sum, s) => sum + s.samples, 0);
  return { hits, samples, rate: rateOf(hits, samples) };
}

/**
 * 十分な分母があるターゲットの中で命中率が最も低いものを、
 * それ以外をまとめた命中率と比較する。
 * 1〜2投しかないターゲットを得意・不得意と評価しない。
 */
export function detectWeakTarget(ctx: RuleContext): RuleFinding[] {
  const summaries = eligibleTargets(ctx);
  if (summaries.length < 2) return [];
  const weakest = summaries.reduce((worst, item) =>
    (item.rate ?? 1) < (worst.rate ?? 1) ? item : worst
  );
  const others = sumExcept(summaries, weakest.label);
  if (weakest.rate == null || others.rate == null) return [];
  const diff = weakest.rate - others.rate;
  if (diff > -HIT_RATE_DIFF_THRESHOLD) return [];
  const diffInterval = proportionDiffInterval(
    weakest.hits,
    weakest.samples,
    others.hits,
    others.samples,
    CONFIDENCE_INTERVAL_Z
  );
  const supported = excludesZero(diffInterval);
  return [
    makeFinding({
      id: `weak_target_${weakest.label}_${ctx.scopeKey}`,
      kind: "statistical_trend",
      polarity: "issue",
      priority: 46,
      effect: normalizedEffect(diff, EFFECT_SCALE_RATE),
      primaryMetric: `${weakest.label}の命中率`,
      subject: `weak_target_${ctx.scopeKey}`,
      title: `${weakest.label}の命中率が他のターゲットより低い状態です`,
      summary: `十分な出題数があるターゲットの中で、${weakest.label}の命中率が他をまとめた命中率を下回っています。`,
      confidenceInput: confidenceInputOf(ctx, weakest.samples, 1, supported),
      evidence: [
        {
          metric: `${weakest.label}の命中率`,
          current: weakest.rate,
          sampleSize: weakest.samples,
          unit: "rate",
          interval: wilsonInterval(
            weakest.hits,
            weakest.samples,
            CONFIDENCE_INTERVAL_Z
          ),
          note: scopeNote(ctx),
        },
        {
          metric: "他のターゲットをまとめた命中率",
          current: others.rate,
          baseline: weakest.rate,
          difference: -diff,
          sampleSize: others.samples,
          unit: "rate",
          interval: wilsonInterval(
            others.hits,
            others.samples,
            CONFIDENCE_INTERVAL_Z
          ),
          note: `対象${summaries.length - 1}ターゲット`,
        },
      ],
      limitations: [
        `出題数が${MIN_TARGET_SAMPLE}投未満のターゲットは比較へ含めていません。`,
        INTERVAL_LIMITATION,
        NO_CAUSE_LIMITATION,
      ],
      actionTemplateId: "weak_target",
    }),
  ];
}

// ---------------------------------------------------------------------------
// ルール10: クリケット固有
// ---------------------------------------------------------------------------

/**
 * クリケット練習セッションでのみ実行する。既存の CricketStats を根拠に、
 * 同一ターゲット継続／セット内切替直後の1投平均マークと、ノーマーク率を見る。
 */
export function detectCricketPatterns(ctx: RuleContext): RuleFinding[] {
  const cricket = ctx.stats.cricket;
  if (!cricket || !ctx.allowBaselineComparison) return [];
  const out: RuleFinding[] = [];
  const same = cricket.continuity?.sameTarget;
  const afterSwitch = cricket.continuity?.afterSwitch;
  if (
    same != null &&
    afterSwitch != null &&
    isAnalyzableSample(same.throwCount) &&
    isAnalyzableSample(afterSwitch.throwCount) &&
    same.marksPerDart != null &&
    afterSwitch.marksPerDart != null
  ) {
    const diff = afterSwitch.marksPerDart - same.marksPerDart;
    if (diff <= -0.3) {
      out.push(
        makeFinding({
          id: "cricket_switch_marks_down",
          kind: "statistical_trend",
          polarity: "issue",
          priority: 62,
          effect: normalizedEffect(diff, EFFECT_SCALE_MARKS),
          primaryMetric: "セット内切替直後の1投平均マーク",
          subject: "cricket_switch",
          title: "セット内でナンバーが切り替わった直後の平均マークが下がっています",
          summary:
            "同一ナンバーを続けた投擲に比べ、セット内でナンバーが切り替わった直後の1投あたり平均マークが低い状態です。",
          confidenceInput: confidenceInputOf(ctx, afterSwitch.throwCount, 1),
          evidence: [
            {
              metric: "同一ターゲット継続の1投平均マーク",
              current: same.marksPerDart,
              sampleSize: same.throwCount,
              unit: "normalized",
            },
            {
              metric: "セット内切替直後の1投平均マーク",
              current: afterSwitch.marksPerDart,
              baseline: same.marksPerDart,
              difference: diff,
              sampleSize: afterSwitch.throwCount,
              unit: "normalized",
            },
          ],
          limitations: [
            "マーク換算はT=3・D=2・S=1・インナーブル=2・アウターブル=1です。",
            "セットの1投目は前投との関係が定義できないため除外しています。",
            NO_CAUSE_LIMITATION,
          ],
          actionTemplateId: "cricket_switch_marks_down",
        })
      );
    }
  }

  const noMarkRate = cricket.noMarkRate;
  const completed = ctx.stats.completedThrows;
  if (noMarkRate != null && isAnalyzableSample(completed) && noMarkRate >= 0.4) {
    out.push(
      makeFinding({
        id: "cricket_no_mark_high",
        kind: "fact",
        polarity: "issue",
        priority: 64,
        effect: normalizedEffect(noMarkRate - 0.4, 0.4),
        primaryMetric: "ノーマーク率",
        subject: "cricket_no_mark",
        title: "マークが付かなかった投擲の割合が高い状態です",
        summary:
          "1マークも取れなかった投擲の割合が、完了投擲全体の40%以上を占めています。",
        confidenceInput: confidenceInputOf(ctx, completed, 1),
        evidence: [
          {
            metric: "ノーマーク率",
            current: noMarkRate,
            sampleSize: completed,
            unit: "rate",
            interval: wilsonInterval(
              Math.round(noMarkRate * completed),
              completed,
              CONFIDENCE_INTERVAL_Z
            ),
          },
          {
            metric: "3投あたり平均マーク",
            current: cricket.marksPerThreeDarts,
            sampleSize: completed,
            unit: "normalized",
          },
        ],
        limitations: [
          "分母は完了投擲数です。",
          "練習データであり、実戦のMPRとは異なります。",
          NO_CAUSE_LIMITATION,
        ],
        actionTemplateId: "cricket_no_mark_high",
      })
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// ルール11: 01固有
// ---------------------------------------------------------------------------

/**
 * 01練習セッションでのみ実行する。既存の ZeroOneStats を根拠に、
 * リング種別（Bull・トリプル・ダブル）間の命中率差を比較する。
 */
export function detectZeroOnePatterns(ctx: RuleContext): RuleFinding[] {
  const zeroOne = ctx.stats.zeroOne;
  if (!zeroOne || !ctx.allowBaselineComparison) return [];
  const rings = [
    { label: "Bull", rate: zeroOne.bullHitRate, samples: zeroOne.bullThrowCount },
    {
      label: "トリプル",
      rate: zeroOne.tripleHitRate,
      samples: zeroOne.tripleThrowCount,
    },
    {
      label: "ダブル",
      rate: zeroOne.doubleHitRate,
      samples: zeroOne.doubleThrowCount,
    },
  ].filter(
    (r): r is { label: string; rate: number; samples: number } =>
      r.rate != null && isAnalyzableSample(r.samples)
  );
  if (rings.length < 2) return [];
  const sorted = rings
    .slice()
    .sort((a, b) =>
      a.rate === b.rate ? a.label.localeCompare(b.label) : a.rate - b.rate
    );
  const weakest = sorted[0]!;
  const strongest = sorted[sorted.length - 1]!;
  const diff = weakest.rate - strongest.rate;
  if (diff > -HIT_RATE_DIFF_THRESHOLD) return [];
  const weakHits = Math.round(weakest.rate * weakest.samples);
  const strongHits = Math.round(strongest.rate * strongest.samples);
  const diffInterval = proportionDiffInterval(
    weakHits,
    weakest.samples,
    strongHits,
    strongest.samples,
    CONFIDENCE_INTERVAL_Z
  );
  const supported = excludesZero(diffInterval);
  return [
    makeFinding({
      id: `zero_one_ring_gap_${weakest.label}`,
      kind: "statistical_trend",
      polarity: "issue",
      priority: 66,
      effect: normalizedEffect(diff, EFFECT_SCALE_RATE),
      primaryMetric: `${weakest.label}の命中率`,
      subject: "zero_one_ring",
      title: `${weakest.label}の命中率が${strongest.label}より低い状態です`,
      summary: `01練習の中で、${weakest.label}狙いの命中率が${strongest.label}狙いを下回っています。`,
      confidenceInput: confidenceInputOf(ctx, weakest.samples, 1, supported),
      evidence: [
        {
          metric: `${strongest.label}の命中率`,
          current: strongest.rate,
          sampleSize: strongest.samples,
          unit: "rate",
          interval: wilsonInterval(
            strongHits,
            strongest.samples,
            CONFIDENCE_INTERVAL_Z
          ),
        },
        {
          metric: `${weakest.label}の命中率`,
          current: weakest.rate,
          baseline: strongest.rate,
          difference: diff,
          sampleSize: weakest.samples,
          unit: "rate",
          interval: diffInterval,
        },
      ],
      limitations: [
        "練習データであり、実戦のフィニッシュ成功率とは異なります。",
        INTERVAL_LIMITATION,
        NO_CAUSE_LIMITATION,
      ],
      actionTemplateId: "zero_one_ring_gap",
    }),
  ];
}

// ---------------------------------------------------------------------------
// ルール12: 投擲間隔（テンポ）
// ---------------------------------------------------------------------------

/**
 * 同一セット内の連続する投擲の間隔を、前半区間と後半区間で比較する。
 * セットの1投目はセット準備の時間を含むため対象外にする。
 * 中断・休憩で個々の間隔が大きく振れるため、平均ではなく中央値で比べる。
 *
 * これは記録された時刻から観測できる状態であり、
 * 身体動作や心理状態の判定ではない。
 */
export function detectTempoChange(ctx: RuleContext): RuleFinding[] {
  const bySet = new Map<string, ThrowRecord[]>();
  for (const t of ctx.throws) {
    const list = bySet.get(t.setId) ?? [];
    list.push(t);
    bySet.set(t.setId, list);
  }
  const intervals: { globalThrowNumber: number; ms: number }[] = [];
  for (const set of bySet.values()) {
    const ordered = set.slice().sort((a, b) => a.dartInSet - b.dartInSet);
    for (let i = 1; i < ordered.length; i += 1) {
      const previous = ordered[i - 1]!;
      const current = ordered[i]!;
      if (current.derived.sameSetAsPrevious !== true) continue;
      const ms = current.elapsedMs - previous.elapsedMs;
      if (!Number.isFinite(ms) || ms <= 0) continue;
      intervals.push({ globalThrowNumber: current.globalThrowNumber, ms });
    }
  }
  intervals.sort((a, b) => a.globalThrowNumber - b.globalThrowNumber);
  const half = Math.ceil(intervals.length / 2);
  const first = intervals.slice(0, half).map((x) => x.ms);
  const second = intervals.slice(half).map((x) => x.ms);
  if (!isAnalyzableSample(first.length) || !isAnalyzableSample(second.length)) {
    return [];
  }
  const firstMedian = median(first);
  const secondMedian = median(second);
  const diff = relativeDiff(secondMedian, firstMedian);
  if (diff == null || Math.abs(diff) < TEMPO_RELATIVE_DIFF_THRESHOLD) return [];
  const shorter = diff < 0;
  return [
    makeFinding({
      id: `tempo_${shorter ? "shorter" : "longer"}_${ctx.scopeKey}`,
      kind: "fact",
      polarity: "issue",
      priority: 80,
      effect: normalizedEffect(diff, EFFECT_SCALE_RELATIVE),
      primaryMetric: "後半の投擲間隔(中央値)",
      subject: `tempo_${ctx.scopeKey}`,
      title: shorter
        ? "セット内の投擲間隔が後半で短くなっています"
        : "セット内の投擲間隔が後半で長くなっています",
      summary: shorter
        ? "同一セット内の連続する投擲の間隔(中央値)が、後半区間で前半区間より短い状態です。"
        : "同一セット内の連続する投擲の間隔(中央値)が、後半区間で前半区間より長い状態です。",
      confidenceInput: confidenceInputOf(ctx, Math.min(first.length, second.length), 1),
      evidence: [
        {
          metric: "前半の投擲間隔(中央値・秒)",
          current: firstMedian != null ? firstMedian / 1000 : undefined,
          sampleSize: first.length,
          unit: "normalized",
          note: scopeNote(ctx, "セットの1投目を除く"),
        },
        {
          metric: "後半の投擲間隔(中央値・秒)",
          current: secondMedian != null ? secondMedian / 1000 : undefined,
          baseline: firstMedian != null ? firstMedian / 1000 : undefined,
          difference: diff,
          sampleSize: second.length,
          unit: "ratio",
          note: scopeNote(ctx),
        },
      ],
      limitations: [
        "記録された時刻の差であり、投げるまでの間の過ごし方は分かりません。",
        "中断・休憩を挟んだ間隔も含まれるため、中央値で比較しています。",
        NO_CAUSE_LIMITATION,
      ],
      actionTemplateId: "tempo_change",
    }),
  ];
}

// ---------------------------------------------------------------------------
// ルール13: 良かった点の専用検出
// ---------------------------------------------------------------------------

/**
 * 比較可能な過去セッションがなくても「良かった点」を出せるようにする。
 * 課題の裏返しではなく、その回の中で相対的に安定していた条件を示す。
 */
export function detectStrengths(ctx: RuleContext): RuleFinding[] {
  const out: RuleFinding[] = [];

  // 最も横方向のばらつきが小さかった投順
  const spread = new Map<DartOrder, { sd?: number; samples: number }>();
  for (const order of DART_ORDERS) {
    const values = errorXs(
      ctx.throws.filter((t) => t.dartInSet === order).filter(isCoordinate)
    );
    spread.set(order, { sd: sampleStdDev(values), samples: values.length });
  }
  const analyzable = DART_ORDERS.every((order) => {
    const s = spread.get(order);
    return s != null && s.sd != null && isAnalyzableSample(s.samples);
  });
  if (analyzable) {
    const best = DART_ORDERS.reduce((a, b) =>
      (spread.get(a)!.sd as number) <= (spread.get(b)!.sd as number) ? a : b
    );
    const others = DART_ORDERS.filter((o) => o !== best);
    const othersMean = mean(others.map((o) => spread.get(o)!.sd as number));
    const diff = relativeDiff(spread.get(best)!.sd, othersMean);
    if (
      diff != null &&
      diff <= -GROUPING_RELATIVE_DIFF_THRESHOLD &&
      isMeaningfulDistance(othersMean)
    ) {
      out.push(
        makeFinding({
          id: `strength_stable_order_${best}_${ctx.scopeKey}`,
          kind: "fact",
          polarity: "positive",
          priority: 12,
          effect: normalizedEffect(diff, EFFECT_SCALE_RELATIVE),
          primaryMetric: `${best}投目の横方向ばらつき(標準偏差)`,
          subject: `strength_order_${ctx.scopeKey}`,
          title: `${best}投目が最も横方向に安定しています`,
          summary: `${best}投目の横方向ばらつきが、他の投順の平均より小さい状態です。`,
          confidenceInput: confidenceInputOf(ctx, spread.get(best)!.samples, 1),
          evidence: [
            {
              metric: `${best}投目の横方向ばらつき(標準偏差)`,
              current: spread.get(best)!.sd,
              sampleSize: spread.get(best)!.samples,
              unit: "normalized",
              note: scopeNote(ctx, "詳細座標のみ"),
            },
            {
              metric: "他の投順平均との相対差",
              current: spread.get(best)!.sd,
              baseline: othersMean,
              difference: diff,
              sampleSize: spread.get(best)!.samples,
              unit: "ratio",
            },
          ],
          limitations: [
            "詳細座標が記録された投擲のみを対象にしています。",
            NO_CAUSE_LIMITATION,
          ],
        })
      );
    }
  }

  // 十分な分母があるターゲットの中で最も命中率が高いもの
  const summaries = eligibleTargets(ctx);
  if (summaries.length >= 2) {
    const best = summaries.reduce((top, item) =>
      (item.rate ?? 0) > (top.rate ?? 0) ? item : top
    );
    const others = sumExcept(summaries, best.label);
    if (
      best.rate != null &&
      others.rate != null &&
      best.rate - others.rate >= HIT_RATE_DIFF_THRESHOLD
    ) {
      const diff = best.rate - others.rate;
      const diffInterval = proportionDiffInterval(
        best.hits,
        best.samples,
        others.hits,
        others.samples,
        CONFIDENCE_INTERVAL_Z
      );
      out.push(
        makeFinding({
          id: `strength_best_target_${best.label}_${ctx.scopeKey}`,
          kind: "fact",
          polarity: "positive",
          priority: 14,
          effect: normalizedEffect(diff, EFFECT_SCALE_RATE),
          primaryMetric: `${best.label}の命中率`,
          subject: `strength_target_${ctx.scopeKey}`,
          title: `${best.label}の命中率が他のターゲットより高い状態です`,
          summary: `十分な出題数があるターゲットの中で、${best.label}の命中率が他をまとめた命中率を上回っています。`,
          confidenceInput: confidenceInputOf(
            ctx,
            best.samples,
            1,
            excludesZero(diffInterval)
          ),
          evidence: [
            {
              metric: `${best.label}の命中率`,
              current: best.rate,
              sampleSize: best.samples,
              unit: "rate",
              interval: wilsonInterval(
                best.hits,
                best.samples,
                CONFIDENCE_INTERVAL_Z
              ),
              note: scopeNote(ctx),
            },
            {
              metric: "他のターゲットをまとめた命中率",
              current: others.rate,
              baseline: best.rate,
              difference: -diff,
              sampleSize: others.samples,
              unit: "rate",
            },
          ],
          limitations: [
            `出題数が${MIN_TARGET_SAMPLE}投未満のターゲットは比較へ含めていません。`,
            NO_CAUSE_LIMITATION,
          ],
        })
      );
    }
  }
  return out;
}

/** 実行する全ルール（実行順は結果に影響しない。severity で並べ替える）。 */
export const LOCAL_COACH_RULES: ((ctx: RuleContext) => RuleFinding[])[] = [
  detectDartOrderChange,
  detectHalfChange,
  detectAxisBias,
  detectDirectionBias,
  detectGroupingChange,
  detectTargetSwitch,
  detectPreviousThrowEffect,
  detectBaselineDiff,
  detectLongTermTrend,
  detectWeakTarget,
  detectCricketPatterns,
  detectZeroOnePatterns,
  detectTempoChange,
  detectStrengths,
];
