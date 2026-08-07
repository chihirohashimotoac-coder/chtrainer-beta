/**
 * 反証可能な原因仮説の生成。
 *
 * 方針:
 *  - 仮説は断定ではなく「次回どうなれば支持され、どうなれば否定されるか」を
 *    必ず持つ候補として作る。
 *  - 観測事実（ObservedFact）とは別のフィールドに置き、同じ文章へ混ぜない。
 *  - 着弾データだけからは身体動作・心理・医学の要因を断定できない。
 *    これらに触れる仮説は必ず requiresExternalCheck を付け、
 *    「確認候補」であって結論ではないことを構造として保証する。
 *  - 同じデータから区別できない仮説は順位を付けず併記する。
 */
import { MAX_HYPOTHESES_PER_CANDIDATE } from "./config";
import type { CoachHypothesis } from "./types";

/**
 * 仮説を組み立てる際に参照できる、セッション横断の観測。
 * 「他の条件でも同じ悪化が出ているか」を仮説の支持・矛盾として使う。
 */
export interface HypothesisContext {
  /** 検出された全候補の subject 一覧（自分自身を含む） */
  firedSubjects: ReadonlySet<string>;
  /** 前半・後半の差が検出されたか */
  hasHalfChange: boolean;
  /** 投擲間隔（テンポ）の変化が検出されたか */
  hasTempoChange: boolean;
  /** 過剰修正が検出されたか */
  hasOverCorrection: boolean;
  /** セット内ターゲット切替のサンプルがあるか */
  hasTargetSwitchSamples: boolean;
  /** 詳細座標の投擲数 */
  coordinateCount: number;
  /** 簡易入力の投擲数 */
  approximateCount: number;
  /**
   * 自己評価（ユーザーが実際に操作した項目のみ）の開始前→終了後の変化。
   * 未回答（既定値のまま）の項目は measured=false とし、測定値として扱わない。
   */
  selfAssessment: {
    fatigueMeasured: boolean;
    fatigueChanged: boolean;
    concentrationMeasured: boolean;
    concentrationChanged: boolean;
  };
}

/** 身体・心理要因に触れる仮説へ必ず付ける確認手段の指定。 */
const EXTERNAL_CHECK =
  "着弾データだけでは判定できません。動画・センサー計測・本人の自己評価のいずれかで別途確認してください。";

/** 矛盾する観測が無い場合に必ず入れる明示（空配列にしない）。 */
const NO_CONTRADICTION = "矛盾する観測なし";

/**
 * 自己評価と着弾の不一致を、矛盾する観測として言語化する。
 * 「着弾は悪化したが、自己評価の疲労・集中は変化していない」場合、
 * 疲労を原因として断定できないことを明示するために使う。
 */
function selfAssessmentMismatch(ctx: HypothesisContext): string | undefined {
  const { fatigueMeasured, fatigueChanged, concentrationMeasured, concentrationChanged } =
    ctx.selfAssessment;
  const measured: string[] = [];
  if (fatigueMeasured && !fatigueChanged) measured.push("疲労度");
  if (concentrationMeasured && !concentrationChanged) measured.push("集中度");
  if (measured.length === 0) return undefined;
  return `着弾は変化していますが、自己評価の${measured.join("・")}は開始前から変化していません。この不一致があるため、${measured.join("・")}を原因として断定できません。`;
}

/** 自己評価が未回答で、疲労・集中を評価できないことを未測定として示す。 */
function selfAssessmentMissing(ctx: HypothesisContext): string | undefined {
  const missing: string[] = [];
  if (!ctx.selfAssessment.fatigueMeasured) missing.push("疲労度");
  if (!ctx.selfAssessment.concentrationMeasured) missing.push("集中度");
  if (missing.length === 0) return undefined;
  return `自己評価の${missing.join("・")}(未回答のため測定値として扱えません)`;
}

function hypothesis(input: CoachHypothesis): CoachHypothesis {
  return {
    ...input,
    contradicting:
      input.contradicting.length > 0 ? input.contradicting : [NO_CONTRADICTION],
  };
}

// ---------------------------------------------------------------------------
// パターン別の仮説
// ---------------------------------------------------------------------------

/** 投順（1〜3投目）に紐づく悪化。 */
function dartOrderHypotheses(
  order: string,
  ctx: HypothesisContext
): CoachHypothesis[] {
  const halfContradiction = ctx.hasHalfChange
    ? `前半・後半でも同じ向きの変化が出ています。投順だけに依存するとは限りません。`
    : undefined;
  return [
    hypothesis({
      id: "dart_order_intrinsic",
      label: "投順そのものに依存",
      statement: `${order}投目という順番自体に紐づいて結果が変わっている可能性。`,
      supporting: [
        `${order}投目でのみ他の投順と差が出ている`,
        ctx.hasHalfChange
          ? "（前半後半でも変化あり。投順以外の要因も併存しうる）"
          : "前半・後半の区間では同じ向きの差が出ていない",
      ],
      contradicting: [halfContradiction].filter((x): x is string => x != null),
      missingData: ["投順ごとの投擲間隔", "投順ごとの狙点の取り直しの有無"],
      ifTrue: `次回も${order}投目だけで同じ差が再現する`,
      ifFalse: `次回は${order}投目の差が消える、または他の投順にも同じ差が出る`,
      distinguishedBy:
        "投順を固定したまま、直前投擲の結果を見ない条件と見る条件を比べる",
    }),
    hypothesis({
      id: "dart_order_previous_result",
      label: "直前の投擲結果を受けた修正",
      statement: `直前の着弾を見てから狙いを変えていることで、${order}投目の結果が変わっている可能性。`,
      supporting: [
        ctx.hasOverCorrection
          ? "前投が横へ外れた直後に反対側へ外す割合が高い"
          : "同一セット内の連続する投擲で結果が変わっている",
      ],
      contradicting: ctx.hasOverCorrection
        ? []
        : ["過剰修正の割合は判定基準を超えていません"],
      missingData: ["各投擲で狙点を変えたかどうかの記録"],
      ifTrue: "直前の結果を見ない条件では投順差が小さくなる",
      ifFalse: "直前の結果を見ない条件でも投順差が変わらない",
      distinguishedBy:
        "同じ投順のまま、直前の着弾を確認する/しないだけを変えて比較する",
    }),
  ];
}

/** 前半・後半の悪化。 */
function halfChangeHypotheses(ctx: HypothesisContext): CoachHypothesis[] {
  const mismatch = selfAssessmentMismatch(ctx);
  return [
    hypothesis({
      id: "half_throw_count",
      label: "投擲数の経過に伴う変化",
      statement: "投げた本数が増えること自体に伴って結果が変わっている可能性。",
      supporting: ["投擲順で分割した後半区間でのみ差が出ている"],
      contradicting: [mismatch].filter((x): x is string => x != null),
      missingData: [
        selfAssessmentMissing(ctx) ?? "区間ごとの休憩の有無",
        "区間ごとの投擲間隔",
      ].filter(Boolean),
      ifTrue: "区間の間に休憩を入れると後半の差が小さくなる",
      ifFalse: "休憩を入れても後半の差が変わらない",
      distinguishedBy: "区間の間の休憩の有無だけを変えて比較する",
      requiresExternalCheck: mismatch ? EXTERNAL_CHECK : undefined,
    }),
    hypothesis({
      id: "half_tempo",
      label: "投擲間隔の変化と連動",
      statement: "後半で投擲間隔が変わっていることと結果が連動している可能性。",
      supporting: ctx.hasTempoChange
        ? ["後半で同一セット内の投擲間隔(中央値)が変化している"]
        : ["投擲間隔の変化は判定基準未満です(この候補の支持は弱い)"],
      contradicting: ctx.hasTempoChange
        ? []
        : ["投擲間隔は前半・後半で判定基準を超える差が出ていません"],
      missingData: ["区間ごとの投擲間隔を意図的に揃えた場合の結果"],
      ifTrue: "間隔を一定に保った条件では後半の差が小さくなる",
      ifFalse: "間隔を一定に保っても後半の差が変わらない",
      distinguishedBy: "投擲間隔の一定性だけを変えて比較する",
    }),
  ];
}

/** 平均位置の系統的な偏り。 */
function axisBiasHypotheses(axisLabel: string): CoachHypothesis[] {
  return [
    hypothesis({
      id: "axis_aim_offset",
      label: "狙点と着弾中心のずれ",
      statement: `狙っている点と実際の着弾中心が${axisLabel}方向へ一定量ずれている可能性。`,
      supporting: [
        `${axisLabel}の平均誤差が片側にあり、その95%区間が0を含まない`,
        "散らばり(標準偏差)に対して平均の寄りが大きい",
      ],
      contradicting: [],
      missingData: ["狙点を意図的にずらした場合の着弾中心"],
      ifTrue: "狙点を寄りと反対側へずらすと平均誤差が0へ近づく",
      ifFalse: "狙点をずらしても平均誤差が同じ側に残る、または散らばりが悪化する",
      distinguishedBy: "狙点だけを変え、散らばりを悪化させていないか同時に見る",
    }),
    hypothesis({
      id: "axis_release_variation",
      label: "投擲動作側の要因",
      statement: `${axisLabel}方向のずれが投擲動作に起因している可能性（確認候補）。`,
      supporting: [`${axisLabel}方向へ一貫して外れている`],
      contradicting: [
        "着弾データだけでは動作要因と狙点のずれを区別できません",
      ],
      missingData: ["投擲動作の映像", "リリース位置の計測値"],
      ifTrue: "狙点を変えても平均誤差が同じ側に残る",
      ifFalse: "狙点の変更だけで平均誤差が0へ近づく",
      distinguishedBy: "先に狙点だけを変える実験を行い、それで解消するかを見る",
      requiresExternalCheck: EXTERNAL_CHECK,
    }),
  ];
}

/** 平均は中央付近だが散らばりが大きい（再現性不足）。 */
function axisDispersionHypotheses(axisLabel: string): CoachHypothesis[] {
  return [
    hypothesis({
      id: "dispersion_setup_variation",
      label: "投擲ごとの開始手順のばらつき",
      statement:
        "1投ごとの構えに入るまでの手順が揃っておらず、着弾が散らばっている可能性。",
      supporting: [
        `${axisLabel}の平均は中央付近だが標準偏差が大きい`,
        "平均の寄りではなく散らばりが支配的",
      ],
      contradicting: [],
      missingData: ["1投ごとの準備手順の記録", "セット内分散とセット間の中心移動の内訳"],
      ifTrue: "開始手順を固定した条件で標準偏差が小さくなる",
      ifFalse: "開始手順を固定しても標準偏差が変わらない",
      distinguishedBy:
        "開始手順の固定だけを変え、平均位置を動かさないことを確認する",
    }),
    hypothesis({
      id: "dispersion_aim_reset",
      label: "セットごとの狙点の取り直し",
      statement:
        "セットごとに狙点を取り直しており、セット間で中心が動いている可能性。",
      supporting: ["セット内の3投より、セット間で着弾中心が動いている場合に整合"],
      contradicting: [
        "現在の記録ではセット内分散とセット間の中心移動を完全には分離できていません",
      ],
      missingData: ["セットごとの着弾中心", "狙点を固定した場合のセット間の中心移動"],
      ifTrue: "狙点を毎セット同じ手順で取ると、セット間の中心移動が小さくなる",
      ifFalse: "狙点の取り方を揃えてもセット間の中心移動が残る",
      distinguishedBy: "狙点の取り直し手順だけを変えて比較する",
    }),
  ];
}

/** セット内ターゲット切替直後の低下。 */
function targetSwitchHypotheses(): CoachHypothesis[] {
  return [
    hypothesis({
      id: "switch_transition_cost",
      label: "切替そのものの影響",
      statement: "狙いを切り替える動作自体が直後の投擲に影響している可能性。",
      supporting: ["同一ターゲット継続時に比べ、切替直後の投擲で結果が低い"],
      contradicting: [
        "切替先と継続時のターゲット難度が同じとは限らず、切替の影響と難度差が交絡しています",
      ],
      missingData: ["同一難度のターゲット同士で切り替えた場合の結果"],
      ifTrue: "同一難度のターゲット間で切り替えても直後の低下が残る",
      ifFalse: "同一難度で揃えると直後の低下が消える",
      distinguishedBy:
        "切替先と継続先の難度を揃え、切替の有無だけを変えて比較する",
    }),
    hypothesis({
      id: "switch_target_difficulty",
      label: "ターゲット難度の差",
      statement:
        "切替直後に狙うターゲットが元々難しいことで、結果が低く見えている可能性。",
      supporting: ["切替直後と継続時で狙うターゲットの構成が異なる"],
      contradicting: [],
      missingData: ["ターゲットごとの単独命中率(十分な分母で)"],
      ifTrue: "難度を揃えると切替直後の低下が消える",
      ifFalse: "難度を揃えても切替直後の低下が残る",
      distinguishedBy: "上と同じ実験で同時に区別できる（同一難度での切替比較）",
    }),
  ];
}

/** ターゲット別の弱点。 */
function weakTargetHypotheses(label: string): CoachHypothesis[] {
  return [
    hypothesis({
      id: "weak_target_intrinsic",
      label: "そのターゲット固有の難しさ",
      statement: `${label}を狙うこと自体が他より難しくなっている可能性。`,
      supporting: [`${label}の命中率が他のターゲットをまとめた値より低い`],
      contradicting: [
        "出題数や出題順が均等でない場合、難度以外の要因が混ざります",
      ],
      missingData: [`${label}と比較用ターゲットを同数・同条件で出題した結果`],
      ifTrue: "出題数を揃えても命中率の差が残る",
      ifFalse: "出題数を揃えると差が縮まる",
      distinguishedBy: "出題数と出題順を揃え、ターゲットだけを変えて比較する",
    }),
  ];
}

/** 投擲間隔（テンポ）の変化そのもの。 */
function tempoHypotheses(): CoachHypothesis[] {
  return [
    hypothesis({
      id: "tempo_shift",
      label: "投擲間隔の変化",
      statement:
        "セット内の投擲間隔が区間によって変わっており、結果と連動している可能性。",
      supporting: ["後半区間で投擲間隔の中央値が変化している"],
      contradicting: [
        "記録された時刻の差であり、その間に何をしていたかは分かりません",
      ],
      missingData: ["間隔を意図的に一定へ揃えた場合の精度"],
      ifTrue: "間隔を一定に保つと精度指標が変化する",
      ifFalse: "間隔を一定に保っても精度指標が変わらない",
      distinguishedBy: "間隔の一定性だけを変えて比較する",
    }),
  ];
}

/** 過去平均・長期トレンドとの差。 */
function baselineHypotheses(): CoachHypothesis[] {
  return [
    hypothesis({
      id: "baseline_condition_change",
      label: "記録条件・機材の変更",
      statement:
        "前回までと条件（機材・ボード・入力方式・セット数）が変わっている可能性。",
      supporting: ["本人の過去基準から外れた値になっている"],
      contradicting: [],
      missingData: ["前回から変更した項目の記録"],
      ifTrue: "条件を前回と揃えると本人基準の範囲へ戻る",
      ifFalse: "条件を揃えても本人基準から外れたままになる",
      distinguishedBy: "条件を1つも変えずに同じモードでもう1回実施する",
    }),
    hypothesis({
      id: "baseline_single_variation",
      label: "単発の変動",
      statement: "今回だけの揺れであり、継続的な変化ではない可能性。",
      supporting: ["本人基準の変動幅と今回値の位置関係（上の本人基準の行を参照）"],
      contradicting: [],
      missingData: ["同条件でのもう1セッション分の記録"],
      ifTrue: "次回は本人基準の変動幅の内側へ戻る",
      ifFalse: "次回も同じ方向へ外れ続ける",
      distinguishedBy: "同条件でもう1回実施し、変動幅の内外を見る",
    }),
  ];
}

/** 汎用（専用の仮説を持たない候補向け）。 */
function genericHypotheses(metric: string): CoachHypothesis[] {
  return [
    hypothesis({
      id: "generic_reproducibility",
      label: "再現するかどうか未確認",
      statement: `${metric}の差が、次回も再現する差なのか今回だけの揺れなのかが未確認です。`,
      supporting: ["今回のデータで判定基準を超える差が出ている"],
      contradicting: [],
      missingData: ["同条件でのもう1セッション分の記録"],
      ifTrue: "同条件で再度実施しても同じ差が出る",
      ifFalse: "同条件で再度実施すると差が消える",
      distinguishedBy: "条件を変えずにもう1回実施して再現性を見る",
    }),
  ];
}

/**
 * 候補の id / subject から、その候補に対応する仮説を生成する。
 * 該当パターンがない場合は汎用の再現性確認だけを返す（作り話をしない）。
 */
export function buildHypotheses(
  findingId: string,
  primaryMetric: string,
  ctx: HypothesisContext
): CoachHypothesis[] {
  const dartOrder = /^dart_order_(?:[xy]_spread|hit_rate)_([123])_/.exec(findingId);
  let list: CoachHypothesis[];
  if (dartOrder) {
    list = dartOrderHypotheses(dartOrder[1] as string, ctx);
  } else if (findingId.startsWith("half_")) {
    list = halfChangeHypotheses(ctx);
  } else if (findingId.startsWith("axis_bias_")) {
    list = axisBiasHypotheses(findingId.includes("_x_") ? "横" : "縦");
  } else if (findingId.startsWith("axis_dispersion_")) {
    list = axisDispersionHypotheses(findingId.includes("_x_") ? "横" : "縦");
  } else if (
    findingId.startsWith("target_switch_") ||
    findingId.startsWith("cricket_switch")
  ) {
    list = targetSwitchHypotheses();
  } else if (findingId.startsWith("weak_target_")) {
    const label = /^weak_target_(.+)_[^_]+$/.exec(findingId)?.[1] ?? "対象ターゲット";
    list = weakTargetHypotheses(label);
  } else if (findingId.startsWith("tempo_")) {
    list = tempoHypotheses();
  } else if (
    findingId.startsWith("baseline_") ||
    findingId.startsWith("trend_") ||
    findingId.startsWith("grouping_vs_baseline")
  ) {
    list = baselineHypotheses();
  } else if (findingId.startsWith("over_correction")) {
    list = dartOrderHypotheses("次", ctx).slice(1);
  } else {
    list = genericHypotheses(primaryMetric);
  }
  return list.slice(0, MAX_HYPOTHESES_PER_CANDIDATE);
}

/**
 * 同じデータからは区別できない仮説の組かどうか。
 * true の場合、表示層は順位を断定せず併記する。
 */
export function areIndistinguishable(
  hypotheses: readonly CoachHypothesis[]
): boolean {
  if (hypotheses.length < 2) return false;
  // 区別方法が同一の実験に帰着する場合、今回のデータだけでは切り分けられない
  const first = hypotheses[0]!;
  return hypotheses
    .slice(1)
    .some((h) => h.distinguishedBy === first.distinguishedBy ||
      h.distinguishedBy.includes("同じ実験"));
}
