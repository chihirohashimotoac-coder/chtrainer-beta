/**
 * ローカルコーチの判定ルール（決定論的・純粋関数）。
 *
 * 記述方針:
 *  - 観測できる「状態」だけを記述する（例: 3投目で右方向のばらつきが増えている）。
 *  - 身体動作・感覚・心理・医学に関する原因は一切断定しない
 *    （例: グリップが強い / 肘が下がっている / 集中力がない は禁止）。
 *    これらは外部の生成AIが追加質問を通じて仮説として扱う領域。
 *  - すべての所見に分母（sampleSize）を持たせ、分母0は 0% ではなく N/A とする。
 */
import type {
  MissDirection,
  SessionStatistics,
  ThrowRecord,
  TrainingSession,
} from "../../types/models";
import { isGroupingOnlyTarget } from "../targets";
import { mean } from "../stats";
import {
  BIAS_MEAN_THRESHOLD,
  BIAS_MEAN_TO_SD_RATIO,
  DIRECTION_BIAS_RATIO_THRESHOLD,
  DISPERSION_SD_THRESHOLD,
  GROUPING_RELATIVE_DIFF_THRESHOLD,
  HIT_RATE_DIFF_THRESHOLD,
  MIN_ANALYZABLE_SAMPLE,
  MIN_GROUPING_SETS,
  MIN_MEANINGFUL_DISTANCE,
  RELATIVE_DIFF_THRESHOLD,
} from "./config";
import { calculateConfidence, isAnalyzableSample } from "./confidence";
import type { LocalCoachEvidence, LocalCoachFinding } from "./types";

/** ルール内部でのみ使う極性。レポートでは配列の振り分けに使う。 */
export type FindingPolarity = "positive" | "issue" | "unavailable";

export interface RuleFinding extends LocalCoachFinding {
  polarity: FindingPolarity;
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
  /** 詳細座標のみの平均誤差距離の単純平均 */
  coordinateErrorMean?: number;
  coordinateErrorSamples: number;
  /** グルーピング径（セット内最大距離の平均）の単純平均 */
  groupingDiameter?: number;
  groupingSets: number;
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
   * セッション単位の基準線（過去平均との差）を、このスコープの所見に
   * 使ってよいか。ラウンドで測定内容が変わるセッションでは false。
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

function errorXs(throws: readonly ThrowRecord[]): number[] {
  return throws
    .map((t) => t.derived.errorX)
    .filter((v): v is number => v != null);
}

function errorYs(throws: readonly ThrowRecord[]): number[] {
  return throws
    .map((t) => t.derived.errorY)
    .filter((v): v is number => v != null);
}

function errorDistances(throws: readonly ThrowRecord[]): number[] {
  return throws
    .map((t) => t.derived.errorDistance)
    .filter((v): v is number => v != null);
}

function hitRateOf(throws: readonly ThrowRecord[]): {
  rate?: number;
  samples: number;
} {
  const scorable = throws.filter(isScorable);
  const hits = scorable.filter((t) => t.derived.exactHit === true).length;
  return { rate: rateOf(hits, scorable.length), samples: scorable.length };
}

function scopeNote(ctx: RuleContext, extra?: string): string | undefined {
  const parts = [ctx.multiScope ? ctx.scopeLabel : undefined, extra].filter(
    (x): x is string => x != null && x.length > 0
  );
  return parts.length > 0 ? parts.join(" / ") : undefined;
}

/** 全ルール共通の確からしさ算出（完了率の減点をここで一元適用する）。 */
function confidenceOf(
  ctx: RuleContext,
  sampleSize: number,
  corroboratingConditions: number
) {
  return calculateConfidence({
    sampleSize,
    corroboratingConditions,
    completionRatio: ctx.completionRatio,
  });
}

/** 身体動作・心理・医学の断定をしないことを、所見ごとに明示する共通の注意書き。 */
const NO_CAUSE_LIMITATION =
  "着弾データから観測できる状態のみを記述しています。身体動作・感覚・心理面の原因は判定していません。";

// ---------------------------------------------------------------------------
// ルール1: 投順別の変化
// ---------------------------------------------------------------------------

const DART_ORDERS = [1, 2, 3] as const;
type DartOrder = (typeof DART_ORDERS)[number];

/**
 * 1〜3投目の間で、横方向のばらつき（誤差Xの標準偏差）または命中率に
 * 差が出ていないかを見る。
 *
 * - 横方向のばらつきは詳細座標の投擲だけで算出する。簡易入力の座標は
 *   エリア代表点の概算値であり、標準偏差の絶対値を実測値と同格に扱えない。
 * - 命中率は命中判定対象（グルーピング専用ラウンドを除く）だけを分母にする。
 * - 各投順の分母が MIN_ANALYZABLE_SAMPLE 未満のときは判定しない。
 */
export function detectDartOrderChange(ctx: RuleContext): RuleFinding[] {
  const out: RuleFinding[] = [];
  const byOrder = new Map<DartOrder, ThrowRecord[]>();
  for (const order of DART_ORDERS) {
    byOrder.set(
      order,
      ctx.throws.filter((t) => t.dartInSet === order)
    );
  }

  // --- 横方向のばらつき（詳細座標のみ） ---
  const spread = new Map<DartOrder, { sd?: number; samples: number }>();
  for (const order of DART_ORDERS) {
    const coordinate = (byOrder.get(order) ?? []).filter(isCoordinate);
    const xs = errorXs(coordinate);
    spread.set(order, { sd: sampleStdDev(xs), samples: xs.length });
  }
  const allSpreadAnalyzable = DART_ORDERS.every((order) => {
    const s = spread.get(order);
    return s != null && s.sd != null && isAnalyzableSample(s.samples);
  });
  if (allSpreadAnalyzable) {
    for (const order of DART_ORDERS) {
      const target = spread.get(order)!;
      const others = DART_ORDERS.filter((o) => o !== order).map(
        (o) => spread.get(o)!.sd as number
      );
      const othersMean = mean(others);
      const diff = relativeDiff(target.sd, othersMean);
      if (diff == null || diff < RELATIVE_DIFF_THRESHOLD) continue;
      // ばらつき自体が入力の分解能以下なら、相対差が大きくても傾向にしない
      if (!isMeaningfulDistance(target.sd)) continue;
      const evidence: LocalCoachEvidence[] = DART_ORDERS.map((o) => ({
        metric: `${o}投目の横方向ばらつき(標準偏差)`,
        current: spread.get(o)!.sd,
        sampleSize: spread.get(o)!.samples,
        unit: "normalized" as const,
        note: scopeNote(ctx, "詳細座標のみ"),
      }));
      evidence.push({
        metric: `${order}投目と他の投順平均との相対差`,
        current: target.sd,
        baseline: othersMean,
        difference: diff,
        sampleSize: target.samples,
        unit: "ratio",
        note: scopeNote(ctx),
      });
      out.push({
        id: `dart_order_lateral_spread_${order}_${ctx.scopeKey}`,
        kind: "statistical_trend",
        polarity: "issue",
        priority: 10,
        primaryMetric: `${order}投目の横方向ばらつき(標準偏差)`,
        subject: `dart_order_${order}_${ctx.scopeKey}`,
        title: `${order}投目で横方向のばらつきが大きくなっています`,
        summary: `${order}投目の横方向ばらつき(誤差Xの標準偏差)が、他の投順の平均より大きい状態です。`,
        confidence: confidenceOf(ctx, target.samples, 1),
        evidence,
        limitations: [
          "詳細座標が記録された投擲のみを対象にしています。",
          NO_CAUSE_LIMITATION,
        ],
        actionTemplateId: "dart_order_lateral_spread",
      });
    }
  }

  // --- 命中率 ---
  const hitRates = new Map<DartOrder, { rate?: number; samples: number }>();
  for (const order of DART_ORDERS) {
    hitRates.set(order, hitRateOf(byOrder.get(order) ?? []));
  }
  const allHitAnalyzable = DART_ORDERS.every((order) => {
    const h = hitRates.get(order);
    return h != null && h.rate != null && isAnalyzableSample(h.samples);
  });
  if (allHitAnalyzable) {
    for (const order of DART_ORDERS) {
      const target = hitRates.get(order)!;
      const othersMean = mean(
        DART_ORDERS.filter((o) => o !== order).map(
          (o) => hitRates.get(o)!.rate as number
        )
      );
      if (othersMean == null || target.rate == null) continue;
      const diff = target.rate - othersMean;
      if (diff > -HIT_RATE_DIFF_THRESHOLD) continue;
      out.push({
        id: `dart_order_hit_rate_${order}_${ctx.scopeKey}`,
        kind: "statistical_trend",
        polarity: "issue",
        priority: 12,
        primaryMetric: `${order}投目の命中率`,
        subject: `dart_order_${order}_${ctx.scopeKey}`,
        title: `${order}投目の命中率が他の投順より低い状態です`,
        summary: `${order}投目の命中率が、他の投順の平均を下回っています。`,
        confidence: confidenceOf(ctx, target.samples, 1),
        evidence: [
          ...DART_ORDERS.map((o) => ({
            metric: `${o}投目の命中率`,
            current: hitRates.get(o)!.rate,
            sampleSize: hitRates.get(o)!.samples,
            unit: "rate" as const,
            note: scopeNote(ctx),
          })),
          {
            metric: `${order}投目と他の投順平均との差`,
            current: target.rate,
            baseline: othersMean,
            difference: diff,
            sampleSize: target.samples,
            unit: "rate",
          },
        ],
        limitations: [
          "命中判定対象の投擲のみを分母にしています。",
          NO_CAUSE_LIMITATION,
        ],
        actionTemplateId: "dart_order_hit_rate",
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// ルール2: 前半・後半の変化
// ---------------------------------------------------------------------------

/**
 * セッションを投擲順で半分に割り、命中率・平均誤差距離・グルーピング径の
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
      out.push({
        id: `half_hit_rate_${worse ? "down" : "up"}_${ctx.scopeKey}`,
        kind: "statistical_trend",
        polarity: worse ? "issue" : "positive",
        priority: worse ? 20 : 21,
        primaryMetric: "後半の命中率",
        subject: `half_${ctx.scopeKey}`,
        title: worse
          ? "後半で命中率が下がっています"
          : "後半で命中率が上がっています",
        summary: worse
          ? "投擲順の後半区間で、前半区間より命中率が下がった状態です。"
          : "投擲順の後半区間で、前半区間より命中率が上がった状態です。",
        confidence: confidenceOf(ctx, Math.min(firstHit.samples, secondHit.samples), 1),
        evidence: [
          {
            metric: "前半の命中率",
            current: firstHit.rate,
            sampleSize: firstHit.samples,
            unit: "rate",
            note: scopeNote(ctx),
          },
          {
            metric: "後半の命中率",
            current: secondHit.rate,
            baseline: firstHit.rate,
            difference: diff,
            sampleSize: secondHit.samples,
            unit: "rate",
            note: scopeNote(ctx),
          },
        ],
        limitations: [
          "前半・後半は投擲順で分割した区間であり、時間経過そのものを測定した値ではありません。",
          NO_CAUSE_LIMITATION,
        ],
        actionTemplateId: worse ? "half_hit_rate_down" : undefined,
      });
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
      out.push({
        id: `half_error_distance_${worse ? "up" : "down"}_${ctx.scopeKey}`,
        kind: "statistical_trend",
        polarity: worse ? "issue" : "positive",
        priority: worse ? 22 : 23,
        primaryMetric: "後半の平均誤差距離",
        subject: `half_${ctx.scopeKey}`,
        title: worse
          ? "後半で平均誤差距離が大きくなっています"
          : "後半で平均誤差距離が小さくなっています",
        summary: worse
          ? "後半区間の平均誤差距離が前半区間より大きい状態です。"
          : "後半区間の平均誤差距離が前半区間より小さい状態です。",
        confidence: confidenceOf(
          ctx,
          Math.min(firstCoordinate.length, secondCoordinate.length),
          1
        ),
        evidence: [
          {
            metric: "前半の平均誤差距離",
            current: firstMean,
            sampleSize: firstCoordinate.length,
            unit: "normalized",
            note: scopeNote(ctx, "詳細座標のみ"),
          },
          {
            metric: "後半の平均誤差距離",
            current: secondMean,
            baseline: firstMean,
            difference: diff,
            sampleSize: secondCoordinate.length,
            unit: "ratio",
            note: scopeNote(ctx, "詳細座標のみ"),
          },
        ],
        limitations: [
          "詳細座標が記録された投擲のみを対象にしています。",
          NO_CAUSE_LIMITATION,
        ],
        actionTemplateId: worse ? "half_error_distance_up" : undefined,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// ルール3: 左右・上下の偏り / 再現性不足
// ---------------------------------------------------------------------------

const AXIS_DEFS = [
  { key: "x", label: "横方向", positive: "右", negative: "左" },
  { key: "y", label: "縦方向", positive: "上", negative: "下" },
] as const;

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
    const values = axis.key === "x" ? errorXs(coordinate) : errorYs(coordinate);
    if (!isAnalyzableSample(values.length)) continue;
    const m = mean(values);
    const sd = sampleStdDev(values);
    if (m == null || sd == null) continue;
    const side = m >= 0 ? axis.positive : axis.negative;
    const isBias =
      Math.abs(m) >= BIAS_MEAN_THRESHOLD && Math.abs(m) >= BIAS_MEAN_TO_SD_RATIO * sd;
    const isDispersion =
      !isBias && sd >= DISPERSION_SD_THRESHOLD;
    if (!isBias && !isDispersion) continue;
    out.push({
      id: `axis_${isBias ? "bias" : "dispersion"}_${axis.key}_${ctx.scopeKey}`,
      kind: "statistical_trend",
      polarity: "issue",
      priority: isBias ? 40 : 42,
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
      confidence: confidenceOf(ctx, values.length, 1),
      evidence: [
        {
          metric: `${axis.label}の平均誤差(${axis.positive}が正)`,
          current: m,
          sampleSize: values.length,
          unit: "normalized",
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
        NO_CAUSE_LIMITATION,
      ],
      actionTemplateId: isBias ? "axis_bias" : "axis_dispersion",
    });
  }
  return out;
}

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
  return [
    {
      id: `direction_bias_${top[0]}_${ctx.scopeKey}`,
      kind: "statistical_trend",
      polarity: "issue",
      priority: 44,
      primaryMetric: `外れ方向「${DIRECTION_LABELS[top[0]]}」の件数`,
      subject: `direction_${ctx.scopeKey}`,
      title: `外れ方向が「${DIRECTION_LABELS[top[0]]}」に集中しています`,
      summary: `簡易入力の記録では、ミスした投擲の外れ方向が「${DIRECTION_LABELS[top[0]]}」へ偏っています。`,
      confidence: confidenceOf(ctx, total, 1),
      evidence: [
        {
          metric: `外れ方向「${DIRECTION_LABELS[top[0]]}」の件数`,
          current: top[1],
          sampleSize: total,
          unit: "count",
          note: scopeNote(ctx, "簡易入力・方向頻度"),
        },
        {
          metric: "ミス投擲全体に占める割合",
          current: ratio,
          sampleSize: total,
          unit: "rate",
          note: scopeNote(ctx),
        },
      ],
      limitations: [
        "簡易入力の座標はエリア代表点による概算値のため、ミリ単位の偏差は根拠にしていません。",
        NO_CAUSE_LIMITATION,
      ],
      actionTemplateId: "direction_bias",
    },
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
    out.push({
      id: `grouping_half_${worse ? "widen" : "tighten"}`,
      kind: "statistical_trend",
      polarity: worse ? "issue" : "positive",
      priority: worse ? 30 : 31,
      primaryMetric: "後半の平均グルーピング径",
      subject: "grouping_half",
      title: worse
        ? "後半でグルーピング径が広がっています"
        : "後半でグルーピング径が縮小しています",
      summary: worse
        ? "有効セットを実施順で半分に割ったとき、後半のグルーピング径が前半より大きい状態です。"
        : "有効セットを実施順で半分に割ったとき、後半のグルーピング径が前半より小さい状態です。",
      confidence: confidenceOf(ctx, grouping.validSetCount, 1),
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
        NO_CAUSE_LIMITATION,
      ],
      actionTemplateId: worse ? "grouping_half_widen" : undefined,
    });
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
      out.push({
        id: `grouping_vs_baseline_${worse ? "widen" : "tighten"}`,
        kind: "statistical_trend",
        polarity: worse ? "issue" : "positive",
        priority: worse ? 32 : 5,
        primaryMetric: "今回の平均グルーピング径",
        subject: "grouping_baseline",
        title: worse
          ? "平均グルーピング径が過去の同条件セッションより広がっています"
          : "平均グルーピング径が過去の同条件セッションより縮小しています",
        summary: worse
          ? "今回の平均グルーピング径は、比較可能な直近セッションの平均より大きい状態です。"
          : "今回の平均グルーピング径は、比較可能な直近セッションの平均より小さい状態です。",
        confidence: confidenceOf(ctx, grouping.validSetCount, 2),
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
      });
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
      {
        id: `target_switch_unmeasured_${ctx.scopeKey}`,
        kind: "not_analyzable",
        polarity: "unavailable",
        priority: 900,
        title: "ターゲット切替直後は未測定です",
        summary:
          "セット内でターゲットが切り替わった投擲が0件のため、切替直後の変化は分析できません。",
        confidence: "low",
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
      },
    ];
  }
  if (
    !isAnalyzableSample(switched.length) ||
    !isAnalyzableSample(continued.length)
  ) {
    return [
      {
        id: `target_switch_insufficient_${ctx.scopeKey}`,
        kind: "not_analyzable",
        polarity: "unavailable",
        priority: 901,
        title: "ターゲット切替直後の比較はサンプル不足です",
        summary: `切替直後${switched.length}投 / 同一ターゲット継続${continued.length}投で、最低分析数${MIN_ANALYZABLE_SAMPLE}投に達していません。`,
        confidence: "low",
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
      },
    ];
  }
  const switchedHit = hitRateOf(switched);
  const continuedHit = hitRateOf(continued);
  if (switchedHit.rate == null || continuedHit.rate == null) return [];
  const diff = switchedHit.rate - continuedHit.rate;
  if (diff > -HIT_RATE_DIFF_THRESHOLD) return [];
  return [
    {
      id: `target_switch_hit_rate_down_${ctx.scopeKey}`,
      kind: "statistical_trend",
      polarity: "issue",
      priority: 60,
      primaryMetric: "セット内切替直後の命中率",
      subject: `target_switch_${ctx.scopeKey}`,
      title: "セット内でターゲットが切り替わった直後の命中率が下がっています",
      summary:
        "同一ターゲットが続いた投擲に比べ、セット内で狙いが切り替わった直後の投擲で命中率が低い状態です。",
      confidence: confidenceOf(ctx, switched.length, 1),
      evidence: [
        {
          metric: "同一ターゲット継続の命中率",
          current: continuedHit.rate,
          sampleSize: continuedHit.samples,
          unit: "rate",
          note: scopeNote(ctx),
        },
        {
          metric: "セット内切替直後の命中率",
          current: switchedHit.rate,
          baseline: continuedHit.rate,
          difference: diff,
          sampleSize: switchedHit.samples,
          unit: "rate",
          note: scopeNote(ctx),
        },
      ],
      limitations: [
        "セットの1投目は前投との関係が定義できないため除外しています。",
        NO_CAUSE_LIMITATION,
      ],
      actionTemplateId: "target_switch_hit_rate_down",
    },
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
  if (
    isAnalyzableSample(afterHit.length) &&
    isAnalyzableSample(afterMiss.length)
  ) {
    const hitNext = hitRateOf(afterHit);
    const missNext = hitRateOf(afterMiss);
    if (hitNext.rate != null && missNext.rate != null) {
      const diff = hitNext.rate - missNext.rate;
      if (Math.abs(diff) >= HIT_RATE_DIFF_THRESHOLD) {
        const worseAfterHit = diff < 0;
        out.push({
          id: `previous_throw_hit_effect_${worseAfterHit ? "after_hit" : "after_miss"}_${ctx.scopeKey}`,
          kind: "statistical_trend",
          polarity: "issue",
          priority: 50,
          primaryMetric: worseAfterHit ? "前投命中後の命中率" : "前投ミス後の命中率",
          subject: `previous_throw_${ctx.scopeKey}`,
          title: worseAfterHit
            ? "前投が命中した直後の投擲で命中率が下がっています"
            : "前投がミスした直後の投擲で命中率が下がっています",
          summary: worseAfterHit
            ? "同一セット内で、前の投擲が命中した直後の投擲の命中率が、ミス直後より低い状態です。"
            : "同一セット内で、前の投擲がミスした直後の投擲の命中率が、命中直後より低い状態です。",
          confidence: confidenceOf(
            ctx,
            Math.min(afterHit.length, afterMiss.length),
            1
          ),
          evidence: [
            {
              metric: "前投命中後の命中率",
              current: hitNext.rate,
              sampleSize: hitNext.samples,
              unit: "rate",
              note: scopeNote(ctx),
            },
            {
              metric: "前投ミス後の命中率",
              current: missNext.rate,
              baseline: hitNext.rate,
              difference: -diff,
              sampleSize: missNext.samples,
              unit: "rate",
              note: scopeNote(ctx),
            },
          ],
          limitations: [
            "同一セット内の投擲のみを対象とし、セットをまたぐ前投関係は含めていません。",
            NO_CAUSE_LIMITATION,
          ],
          actionTemplateId: "previous_throw_hit_effect",
        });
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
      if (Math.sign(currX) !== Math.sign(prevX) && Math.abs(currX) >= BIAS_MEAN_THRESHOLD) {
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
    out.push({
      id: `over_correction_${ctx.scopeKey}`,
      kind: "statistical_trend",
      polarity: "issue",
      priority: 52,
      primaryMetric: "前投が横方向へ外れた投擲数(判定の分母)",
      subject: `over_correction_${ctx.scopeKey}`,
      title: "前投が横へ外れた直後、反対側へ大きく外す投擲が多い状態です",
      summary:
        "同一セット内で前の投擲が横方向へ外れたあと、次の投擲が反対側へ同程度以上外れている割合が高い状態です。",
      confidence: confidenceOf(ctx, candidates, 1),
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
          note: scopeNote(ctx),
        },
      ],
      limitations: [
        "同一セット内の連続する投擲のみを対象にしています。",
        NO_CAUSE_LIMITATION,
      ],
      actionTemplateId: "over_correction",
    });
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
      out.push({
        id: `baseline_hit_rate_${better ? "up" : "down"}`,
        kind: "statistical_trend",
        polarity: better ? "positive" : "issue",
        priority: better ? 4 : 70,
        primaryMetric: "今回の完全命中率",
        subject: "baseline_hit_rate",
        title: better
          ? "命中率が過去の同条件セッション平均を上回っています"
          : "命中率が過去の同条件セッション平均を下回っています",
        summary: better
          ? "今回の完全命中率は、比較可能な直近セッションの平均より高い状態です。"
          : "今回の完全命中率は、比較可能な直近セッションの平均より低い状態です。",
        confidence: confidenceOf(ctx, currentHitSamples, 2),
        evidence: [
          {
            metric: "今回の完全命中率",
            current: currentHit,
            sampleSize: currentHitSamples,
            unit: "rate",
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
          },
        ],
        limitations: [
          "同一モード・同一ボード種別・同一スコアリング形式・同一入力精度のセッションのみを比較対象にしています。",
          NO_CAUSE_LIMITATION,
        ],
        actionTemplateId: better ? undefined : "baseline_hit_rate_down",
      });
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
      out.push({
        id: `baseline_error_distance_${better ? "down" : "up"}`,
        kind: "statistical_trend",
        polarity: better ? "positive" : "issue",
        priority: better ? 6 : 72,
        primaryMetric: "今回の平均誤差距離",
        subject: "baseline_error_distance",
        title: better
          ? "平均誤差距離が過去の同条件セッション平均より小さくなっています"
          : "平均誤差距離が過去の同条件セッション平均より大きくなっています",
        summary: better
          ? "今回の詳細座標による平均誤差距離は、比較可能な直近セッションの平均より小さい状態です。"
          : "今回の詳細座標による平均誤差距離は、比較可能な直近セッションの平均より大きい状態です。",
        confidence: confidenceOf(ctx, currentErrorSamples, 2),
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
      });
    }
  }
  return out;
}

/** MVPで実行する全ルール（実行順は結果に影響しない。優先度で並べ替える）。 */
export const LOCAL_COACH_RULES: ((ctx: RuleContext) => RuleFinding[])[] = [
  detectDartOrderChange,
  detectHalfChange,
  detectAxisBias,
  detectDirectionBias,
  detectGroupingChange,
  detectTargetSwitch,
  detectPreviousThrowEffect,
  detectBaselineDiff,
];
