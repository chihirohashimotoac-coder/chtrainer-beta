/**
 * 1変数実験の設計。
 *
 * 方針:
 *  - 一般的な練習アドバイスではなく、複数の原因仮説を区別するための対照実験。
 *  - 条件間で変更する要因は必ず1つだけ。
 *  - 各条件がそれぞれ最小サンプル基準を満たす投擲数を割り当てる
 *    （3投・5投だけの比較を確定的な実験として提案しない）。
 *  - 主要指標を改善させる代わりに他を悪化させていないか、
 *    ガードレール指標で必ず確認する。
 *  - 結果に応じた次の分岐まで示す。
 */
import { MIN_ANALYZABLE_SAMPLE } from "./config";
import type { ExperimentCondition } from "./types";

export interface ExperimentDesign {
  /** 条件間で変える唯一の要因 */
  changedFactor: string;
  control: ExperimentCondition;
  intervention: ExperimentCondition;
  /** ブロック順・交互実施の指定（順序効果を打ち消す） */
  blockOrder: string;
  /** この実験が区別しようとしている仮説 id */
  hypothesisIds: string[];
  /** ガードレール指標（主要指標と引き換えに悪化させてはいけないもの） */
  guardrailMetrics: string[];
  /** 仮説を否定する基準 */
  falsificationCriteria: string[];
  /** 結果に応じた次の分岐 */
  nextBranch: string;
}

/**
 * 各条件の投擲数。10セット=30投とし、投順別に分けても
 * 1投順あたり10投（MIN_ANALYZABLE_SAMPLE）を確保する。
 */
const THROWS_PER_CONDITION = 30;
const SETS_PER_CONDITION = THROWS_PER_CONDITION / 3;

/** 投順別に分けたときの1投順あたりの分母。設計の妥当性検査に使う。 */
export const PER_ORDER_SAMPLE_PER_CONDITION = SETS_PER_CONDITION;

/** 順序効果を打ち消す標準のブロック順。 */
const ABBA =
  `A→B→B→A の順に${SETS_PER_CONDITION / 2}セットずつ実施し、条件の前後関係が結果へ入らないようにする`;

function condition(
  label: string,
  description: string,
  throwCount = THROWS_PER_CONDITION
): ExperimentCondition {
  return { label, description, throwCount };
}

/**
 * パターン別の実験設計。
 * キーは actions.ts のテンプレート識別子に対応する。
 */
export const EXPERIMENT_DESIGNS: Record<string, ExperimentDesign> = {
  // --- 投順（3投目悪化など） ---
  dart_order_lateral_spread: {
    changedFactor: "直前の着弾を確認してから投げるかどうか",
    control: condition("A: いつも通り", "直前の着弾を確認してから次を投げる"),
    intervention: condition(
      "B: 直前の着弾を見ない",
      "3投を投げ終わるまで盤面の着弾を確認せず、同じ狙点・同じ間隔で投げる"
    ),
    blockOrder: ABBA,
    hypothesisIds: ["dart_order_intrinsic", "dart_order_previous_result"],
    guardrailMetrics: ["全体の平均グルーピング径", "全体の命中率"],
    falsificationCriteria: [
      "条件Bでも対象投順の横ばらつきが他の投順平均の130%を超えたままなら、直前結果への修正では説明できない",
      "条件A・Bのどちらでも投順差が10%以内なら、投順固有の差ではなかったと判断する",
    ],
    nextBranch:
      "Bで差が縮まれば直前結果への修正を主要因として扱う。縮まらなければ投擲間隔を次の1変数として比較する。",
  },
  dart_order_vertical_spread: {
    changedFactor: "直前の着弾を確認してから投げるかどうか",
    control: condition("A: いつも通り", "直前の着弾を確認してから次を投げる"),
    intervention: condition(
      "B: 直前の着弾を見ない",
      "3投を投げ終わるまで着弾を確認せず、同じ狙点・同じ間隔で投げる"
    ),
    blockOrder: ABBA,
    hypothesisIds: ["dart_order_intrinsic", "dart_order_previous_result"],
    guardrailMetrics: ["同じ軸の平均誤差", "全体の平均グルーピング径"],
    falsificationCriteria: [
      "条件Bでも対象投順の縦ばらつきが他の投順平均の130%を超えたままなら、直前結果への修正では説明できない",
    ],
    nextBranch:
      "Bで差が縮まれば直前結果への修正を主要因として扱う。縮まらなければ投擲間隔を次の1変数として比較する。",
  },
  dart_order_hit_rate: {
    changedFactor: "直前の着弾を確認してから投げるかどうか",
    control: condition("A: いつも通り", "直前の着弾を確認してから次を投げる"),
    intervention: condition(
      "B: 直前の着弾を見ない",
      "3投を投げ終わるまで着弾を確認せず、同じ狙点・同じ間隔で投げる"
    ),
    blockOrder: ABBA,
    hypothesisIds: ["dart_order_intrinsic", "dart_order_previous_result"],
    guardrailMetrics: ["全体の命中率", "全体の平均誤差距離"],
    falsificationCriteria: [
      "条件Bでも対象投順の命中率が他の投順より10ポイント以上低いままなら、直前結果への修正では説明できない",
    ],
    nextBranch:
      "Bで差が縮まれば直前結果への修正を主要因として扱う。縮まらなければ投擲間隔を次の1変数として比較する。",
  },

  // --- 前半・後半 ---
  half_hit_rate_down: {
    changedFactor: "ブロック間に休憩を入れるかどうか",
    control: condition("A: 休憩なし", "5セットを連続で投げ、間に休憩を入れない"),
    intervention: condition(
      "B: 休憩あり",
      "5セットごとに2分間の休憩を入れる。狙い方・テンポは変えない"
    ),
    blockOrder: ABBA,
    hypothesisIds: ["half_throw_count", "half_tempo"],
    guardrailMetrics: ["全体の命中率", "各条件の命中判定対象投擲数"],
    falsificationCriteria: [
      "休憩を入れても後半の命中率低下が10ポイント以上残るなら、投擲数の経過だけでは説明できない",
      "条件A・Bのどちらでも区間差が10ポイント以内なら、今回の後半低下は再現しなかったと判断する",
    ],
    nextBranch:
      "Bで差が縮まれば投擲数の経過を主要因として扱う。縮まらなければ投擲間隔の一定性を次の1変数として比較する。",
  },
  half_error_distance_up: {
    changedFactor: "ブロック間に休憩を入れるかどうか",
    control: condition("A: 休憩なし", "5セットを連続で投げ、間に休憩を入れない"),
    intervention: condition("B: 休憩あり", "5セットごとに2分間の休憩を入れる"),
    blockOrder: ABBA,
    hypothesisIds: ["half_throw_count", "half_tempo"],
    guardrailMetrics: ["全体の平均誤差距離", "各条件の誤差サンプル数"],
    falsificationCriteria: [
      "休憩を入れても後半の平均誤差距離が前半の130%を超えたままなら、投擲数の経過だけでは説明できない",
    ],
    nextBranch:
      "Bで差が縮まれば投擲数の経過を主要因として扱う。縮まらなければ投擲間隔の一定性を次の1変数として比較する。",
  },
  half_outboard_up: {
    changedFactor: "ブロック間に休憩を入れるかどうか",
    control: condition("A: 休憩なし", "5セットを連続で投げ、間に休憩を入れない"),
    intervention: condition("B: 休憩あり", "5セットごとに2分間の休憩を入れる"),
    blockOrder: ABBA,
    hypothesisIds: ["half_throw_count", "half_tempo"],
    guardrailMetrics: ["全体の命中率", "各条件の完了投擲数"],
    falsificationCriteria: [
      "休憩を入れても後半のアウトボード率が前半より10ポイント以上高いままなら、投擲数の経過だけでは説明できない",
    ],
    nextBranch:
      "Bで差が縮まれば投擲数の経過を主要因として扱う。縮まらなければ投擲間隔を次の1変数として比較する。",
  },

  // --- 系統偏り（平均位置） ---
  axis_bias: {
    changedFactor: "狙点の位置（寄りと反対側へ一定量ずらすかどうか）",
    control: condition("A: いつもの狙点", "普段どおりの狙点で投げる"),
    intervention: condition(
      "B: 狙点をずらす",
      "寄っている方向と反対側へ、観測された平均誤差と同じ量だけ狙点をずらす。テンポ・構えは変えない"
    ),
    blockOrder: ABBA,
    hypothesisIds: ["axis_aim_offset", "axis_release_variation"],
    guardrailMetrics: [
      "同じ軸の標準偏差（散らばりを悪化させない）",
      "平均グルーピング径",
    ],
    falsificationCriteria: [
      "狙点をずらしても平均誤差が同じ側に残るなら、狙点と着弾中心のずれでは説明できない",
      "条件Bで標準偏差が条件Aの115%を超えて悪化した場合、この補正は採用しない（偏りより再現性の問題として扱い直す）",
    ],
    nextBranch:
      "Bで平均誤差が0へ近づき散らばりが悪化しなければ、狙点の補正を採用する。残るなら投擲動作側の確認（動画等）へ進む。",
  },

  // --- 分散増大（再現性不足） ---
  axis_dispersion: {
    changedFactor: "構えに入るまでの開始手順を固定するかどうか",
    control: condition("A: いつも通り", "普段どおりに構えて投げる"),
    intervention: condition(
      "B: 開始手順を固定",
      "立ち位置・視線を向ける順番・投げ始めるまでの数え方を毎投同じにする。狙点は変えない"
    ),
    blockOrder: ABBA,
    hypothesisIds: ["dispersion_setup_variation", "dispersion_aim_reset"],
    guardrailMetrics: [
      "同じ軸の平均誤差（平均位置を動かさない）",
      "全体の命中率",
    ],
    falsificationCriteria: [
      "開始手順を固定しても標準偏差が条件Aの85%を下回らないなら、開始手順のばらつきでは説明できない",
      "条件Bで平均誤差が動いた場合、狙点も同時に変わってしまっているため実験をやり直す",
    ],
    nextBranch:
      "Bで散らばりが縮めば開始手順を採用する。変わらなければ、セットごとの狙点の取り直し手順を次の1変数として比較する。",
  },

  // --- ターゲット切替 ---
  target_switch_hit_rate_down: {
    changedFactor: "セット内でターゲットを切り替えるかどうか（難度は揃える）",
    control: condition(
      "A: 同一ターゲット継続",
      "1セット3投とも同じターゲットを狙う"
    ),
    intervention: condition(
      "B: 同一難度で切替",
      "今回の記録で命中率が近かったターゲット同士を、セット内で切り替えて狙う"
    ),
    blockOrder: ABBA,
    hypothesisIds: ["switch_transition_cost", "switch_target_difficulty"],
    guardrailMetrics: ["各条件の命中判定対象投擲数", "各ターゲットの単独命中率"],
    falsificationCriteria: [
      "難度を揃えても切替直後の命中率が継続時より10ポイント以上低いままなら、ターゲット難度の差では説明できない",
      "難度を揃えたら差が消えるなら、切替そのものの影響ではなかったと判断する",
    ],
    nextBranch:
      "難度を揃えても差が残れば切替そのものの影響として扱う。消えれば難度差だったと結論し、弱いターゲットの練習へ切り替える。",
  },
  cricket_switch_marks_down: {
    changedFactor: "セット内でナンバーを切り替えるかどうか（難度は揃える）",
    control: condition("A: 同一ナンバー継続", "1セット3投とも同じナンバーを狙う"),
    intervention: condition(
      "B: 同一難度で切替",
      "今回のマーク率が近かったナンバー同士を、セット内で切り替えて狙う"
    ),
    blockOrder: ABBA,
    hypothesisIds: ["switch_transition_cost", "switch_target_difficulty"],
    guardrailMetrics: ["各条件の投擲数", "各ナンバーの単独マーク率"],
    falsificationCriteria: [
      "難度を揃えても切替直後の1投平均マークが0.3以上低いままなら、ナンバー難度の差では説明できない",
    ],
    nextBranch:
      "差が残れば切替そのものの影響として扱う。消えればナンバー難度の差だったと結論する。",
  },

  // --- ターゲット別の弱点 ---
  weak_target: {
    changedFactor: "狙うターゲット（出題数と出題順は揃える）",
    control: condition(
      "A: 比較用ターゲット",
      "今回の命中率が高かったターゲットを狙う"
    ),
    intervention: condition(
      "B: 対象ターゲット",
      "今回の命中率が低かったターゲットを、Aと同じセット数・同じ順番で狙う"
    ),
    blockOrder: ABBA,
    hypothesisIds: ["weak_target_intrinsic"],
    guardrailMetrics: ["各ターゲットの命中判定対象投擲数", "全体の平均誤差距離"],
    falsificationCriteria: [
      "出題数を揃えても命中率の差が10ポイント以上残るなら、出題数の偏りでは説明できない",
      "揃えたら差が10ポイント以内になるなら、今回の差は出題条件によるものだったと判断する",
    ],
    nextBranch:
      "差が残れば対象ターゲットの狙点・外れ方向を次に調べる。消えれば出題数を揃えた記録を継続する。",
  },
  zero_one_ring_gap: {
    changedFactor: "狙うリング種別（出題数と出題順は揃える）",
    control: condition("A: 命中率が高かったリング", "同じセット数で狙う"),
    intervention: condition(
      "B: 命中率が低かったリング",
      "Aと同じセット数・同じ順番で狙う"
    ),
    blockOrder: ABBA,
    hypothesisIds: ["weak_target_intrinsic"],
    guardrailMetrics: ["各リングの命中判定対象投擲数", "各リングの外れ方向"],
    falsificationCriteria: [
      "出題数を揃えても命中率の差が10ポイント以上残るなら、出題数の偏りでは説明できない",
    ],
    nextBranch:
      "差が残れば低い方のリングの外れ方向（内側/外側・上下）を次に調べる。",
  },

  // --- 投擲間隔 ---
  tempo_change: {
    changedFactor: "セット内の投擲間隔を一定に保つかどうか",
    control: condition("A: いつも通り", "間隔を意識せずに投げる"),
    intervention: condition(
      "B: 間隔を一定",
      "1投ごとの間隔を同じ数え方で揃える。狙点・構えは変えない"
    ),
    blockOrder: ABBA,
    hypothesisIds: ["tempo_shift"],
    guardrailMetrics: ["平均誤差距離", "命中率"],
    falsificationCriteria: [
      "間隔を揃えても精度指標が条件Aと5%以内しか変わらないなら、投擲間隔と精度は連動していない",
      "間隔を意識したことで投擲そのものがぎこちなくなった場合は、この実験を中止し結果を採用しない",
    ],
    nextBranch:
      "Bで精度が改善すれば間隔の一定化を採用する。変わらなければ間隔は要因から外す。",
  },

  // --- グルーピング ---
  grouping_half_widen: {
    changedFactor: "ブロック間に休憩を入れるかどうか",
    control: condition("A: 休憩なし", "5セットを連続で投げる"),
    intervention: condition("B: 休憩あり", "5セットごとに2分間の休憩を入れる"),
    blockOrder: ABBA,
    hypothesisIds: ["half_throw_count", "half_tempo"],
    guardrailMetrics: ["各条件の有効セット数", "平均誤差距離"],
    falsificationCriteria: [
      "休憩を入れても後半のグルーピング径が前半の115%を超えたままなら、セット数の経過だけでは説明できない",
    ],
    nextBranch:
      "Bで差が縮まればセット数の経過を主要因として扱う。縮まらなければ開始手順の固定を次の1変数として比較する。",
  },
  grouping_inter_dart: {
    changedFactor: "2投目以降で狙点を取り直すかどうか",
    control: condition(
      "A: いつも通り",
      "2投目以降、直前の着弾を見て狙点を調整する"
    ),
    intervention: condition(
      "B: 狙点を固定",
      "3投とも最初に決めた狙点から動かさない。テンポは変えない"
    ),
    blockOrder: ABBA,
    hypothesisIds: ["dispersion_aim_reset", "dart_order_previous_result"],
    guardrailMetrics: ["平均グルーピング径", "各条件の有効セット数"],
    falsificationCriteria: [
      "狙点を固定しても投順間距離の差が115%を超えたままなら、狙点の取り直しでは説明できない",
    ],
    nextBranch:
      "Bで差が縮まれば狙点の取り直しを主要因として扱う。縮まらなければ投擲間隔を次の1変数として比較する。",
  },
  grouping_vs_baseline_widen: {
    changedFactor: "記録条件（機材・ボード・入力方式・セット数）を前回と揃えるかどうか",
    control: condition("A: 今回と同じ条件", "今回と同じ設定でそのまま実施する"),
    intervention: condition(
      "B: 前回までと同じ条件",
      "本人基準を作った過去セッションと同じ機材・ボード・入力方式・セット数へ戻す"
    ),
    blockOrder:
      "1回のセッション内で条件を混ぜず、A・Bを別セッションとして実施し、可能なら実施順を入れ替える",
    hypothesisIds: ["baseline_condition_change", "baseline_single_variation"],
    guardrailMetrics: ["有効セット数", "入力精度の内訳"],
    falsificationCriteria: [
      "条件を前回へ戻してもグルーピング径が本人基準の変動幅の外に残るなら、条件変更では説明できない",
      "条件を変えずに実施して変動幅の内側へ戻るなら、今回は単発の変動だったと判断する",
    ],
    nextBranch:
      "条件を戻して改善すれば条件変更が要因。改善しなければ継続傾向として、投順・前後半のどこで広がっているかを次に絞る。",
  },

  // --- 本人基準・長期トレンド ---
  baseline_hit_rate_down: {
    changedFactor: "記録条件（機材・ボード・入力方式・セット数）を前回と揃えるかどうか",
    control: condition("A: 今回と同じ条件", "今回と同じ設定でそのまま実施する"),
    intervention: condition(
      "B: 前回までと同じ条件",
      "本人基準を作った過去セッションと同じ条件へ戻す"
    ),
    blockOrder:
      "A・Bを別セッションとして実施し、可能なら実施順を入れ替える（同一セッション内で条件を混ぜない）",
    hypothesisIds: ["baseline_condition_change", "baseline_single_variation"],
    guardrailMetrics: ["命中判定対象投擲数", "入力精度の内訳"],
    falsificationCriteria: [
      "条件を前回へ戻しても命中率が本人基準の変動幅の外に残るなら、条件変更では説明できない",
      "条件を変えずに実施して変動幅の内側へ戻るなら、今回は単発の変動だったと判断する",
    ],
    nextBranch:
      "条件を戻して改善すれば条件変更が要因。改善しなければ継続傾向として、投順・前後半のどこで落ちているかを次に絞る。",
  },
  baseline_error_distance_up: {
    changedFactor: "記録条件（機材・ボード・入力方式・セット数）を前回と揃えるかどうか",
    control: condition("A: 今回と同じ条件", "今回と同じ設定でそのまま実施する"),
    intervention: condition(
      "B: 前回までと同じ条件",
      "本人基準を作った過去セッションと同じ条件へ戻す"
    ),
    blockOrder: "A・Bを別セッションとして実施し、可能なら実施順を入れ替える",
    hypothesisIds: ["baseline_condition_change", "baseline_single_variation"],
    guardrailMetrics: ["誤差サンプル数", "入力精度の内訳"],
    falsificationCriteria: [
      "条件を前回へ戻しても平均誤差距離が本人基準の変動幅の外に残るなら、条件変更では説明できない",
    ],
    nextBranch:
      "条件を戻して改善すれば条件変更が要因。改善しなければ継続傾向として扱う。",
  },
  trend_hit_rate_down: {
    changedFactor: "記録条件（機材・ボード・入力方式・セット数）を前回と揃えるかどうか",
    control: condition("A: 今回と同じ条件", "今回と同じ設定でそのまま実施する"),
    intervention: condition(
      "B: 連続低下が始まる前と同じ条件",
      "低下が始まる前のセッションと同じ条件へ戻す"
    ),
    blockOrder: "A・Bを別セッションとして実施し、可能なら実施順を入れ替える",
    hypothesisIds: ["baseline_condition_change", "baseline_single_variation"],
    guardrailMetrics: ["命中判定対象投擲数", "入力精度の内訳"],
    falsificationCriteria: [
      "条件を戻しても連続低下が止まらないなら、条件変更では説明できない",
    ],
    nextBranch:
      "条件を戻して止まれば条件変更が要因。止まらなければ投順・前後半のどこで落ちているかを次に絞る。",
  },
  trend_error_distance_up: {
    changedFactor: "記録条件（機材・ボード・入力方式・セット数）を前回と揃えるかどうか",
    control: condition("A: 今回と同じ条件", "今回と同じ設定でそのまま実施する"),
    intervention: condition(
      "B: 連続拡大が始まる前と同じ条件",
      "拡大が始まる前のセッションと同じ条件へ戻す"
    ),
    blockOrder: "A・Bを別セッションとして実施し、可能なら実施順を入れ替える",
    hypothesisIds: ["baseline_condition_change", "baseline_single_variation"],
    guardrailMetrics: ["誤差サンプル数", "入力精度の内訳"],
    falsificationCriteria: [
      "条件を戻しても連続拡大が止まらないなら、条件変更では説明できない",
    ],
    nextBranch: "条件を戻して止まれば条件変更が要因。止まらなければ継続傾向として扱う。",
  },

  // --- 前投の結果・過剰修正 ---
  previous_throw_hit_effect: {
    changedFactor: "直前の着弾を確認してから投げるかどうか",
    control: condition("A: いつも通り", "直前の着弾を確認してから次を投げる"),
    intervention: condition(
      "B: 直前の着弾を見ない",
      "3投を投げ終わるまで着弾を確認しない。狙点・テンポは変えない"
    ),
    blockOrder: ABBA,
    hypothesisIds: ["dart_order_previous_result"],
    guardrailMetrics: ["全体の命中率", "各条件の命中判定対象投擲数"],
    falsificationCriteria: [
      "条件Bでも前投命中後と前投ミス後の命中率差が10ポイント以上残るなら、直前結果の確認では説明できない",
    ],
    nextBranch:
      "Bで差が縮まれば直前結果への反応を主要因として扱う。縮まらなければ投順そのものを次に調べる。",
  },
  over_correction: {
    changedFactor: "直前の着弾に応じて狙点を動かすかどうか",
    control: condition("A: いつも通り", "直前の着弾を見て狙点を調整する"),
    intervention: condition(
      "B: 狙点を動かさない",
      "直前がどこへ外れても狙点を一切動かさない。テンポは変えない"
    ),
    blockOrder: ABBA,
    hypothesisIds: ["dart_order_previous_result"],
    guardrailMetrics: ["平均誤差距離", "各条件の判定分母"],
    falsificationCriteria: [
      "狙点を動かさなくても反対側へ外す割合が40%以上残るなら、狙点の修正では説明できない",
    ],
    nextBranch:
      "Bで割合が下がれば修正量の問題として扱う。下がらなければ散らばりそのものの問題として扱い直す。",
  },

  // --- 簡易入力の方向偏り ---
  direction_bias: {
    changedFactor: "記録の入力精度（簡易入力か詳細座標か）",
    control: condition(
      "A: 簡易入力のまま",
      "今回と同じセグメント単位の記録で狙う"
    ),
    intervention: condition(
      "B: 詳細座標で記録",
      "同じ狙い方のまま、着弾を詳細座標で記録する"
    ),
    blockOrder:
      "A・Bを別ブロックとして実施する。簡易入力と詳細座標は別母集団として集計し、平均位置やSDを混ぜない",
    hypothesisIds: ["generic_reproducibility"],
    guardrailMetrics: ["ミス投擲の総数（方向頻度の分母）", "命中判定対象投擲数"],
    falsificationCriteria: [
      "Bの詳細座標でも同じ方向への偏りが出なければ、今回の方向偏りは再現しなかったと判断する",
    ],
    nextBranch:
      "Bで偏りが再現すれば、詳細座標のデータで平均位置と散らばりを分けて評価する。再現しなければ偏りとして扱わない。",
  },

  // --- クリケットのノーマーク ---
  cricket_no_mark_high: {
    changedFactor: "狙うナンバー（出題数と出題順は揃える）",
    control: condition("A: マーク率が高かったナンバー", "同じセット数で狙う"),
    intervention: condition(
      "B: マーク率が低かったナンバー",
      "Aと同じセット数・同じ順番で狙う"
    ),
    blockOrder: ABBA,
    hypothesisIds: ["weak_target_intrinsic"],
    guardrailMetrics: ["各ナンバーの投擲数", "3投あたり平均マーク"],
    falsificationCriteria: [
      "出題数を揃えてもノーマーク率の差が10ポイント以上残るなら、出題数の偏りでは説明できない",
    ],
    nextBranch:
      "差が残ればそのナンバーの外れ先セグメントを次に調べる。消えれば出題条件の問題だったと判断する。",
  },
};

/**
 * 設計が最小サンプル基準を満たしているかを検査する。
 * 実験テンプレートを追加したときに、分母不足の比較を提案しないための自己検査。
 */
export function isValidDesign(design: ExperimentDesign): boolean {
  return (
    design.control.throwCount >= MIN_ANALYZABLE_SAMPLE &&
    design.intervention.throwCount >= MIN_ANALYZABLE_SAMPLE &&
    design.changedFactor.length > 0 &&
    design.falsificationCriteria.length > 0 &&
    design.hypothesisIds.length > 0 &&
    design.guardrailMetrics.length > 0 &&
    design.nextBranch.length > 0
  );
}

/** 専用設計がないテンプレート向けの、再現確認としての最小設計。 */
export function reproductionDesign(metric: string): ExperimentDesign {
  return {
    changedFactor: "なし（条件を変えずに再現するかだけを確認する）",
    control: condition("A: 今回と同じ条件", "今回と同じ設定・同じ狙い方で実施する"),
    intervention: condition(
      "B: 同条件の2回目",
      "Aと条件を1つも変えずにもう1ブロック実施する"
    ),
    blockOrder: "A→Bの順に連続して実施し、間に条件変更を挟まない",
    hypothesisIds: ["generic_reproducibility"],
    guardrailMetrics: ["各ブロックの分母", "入力精度の内訳"],
    falsificationCriteria: [
      `A・Bのどちらでも${metric}の差が判定基準未満なら、今回の差は再現しなかったと判断する`,
    ],
    nextBranch:
      "再現すれば要因を切り分ける1変数実験へ進む。再現しなければ課題として扱わない。",
  };
}
