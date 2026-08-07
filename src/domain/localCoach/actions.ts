/**
 * 検出した課題と1対1で対応する推奨メニューを生成する。
 *
 * 方針:
 *  - 「Bullを60投」のような、原因仮説を検証できない一般的な練習提案にしない。
 *  - 身体動作を直接修正させない。まず「その傾向が再現するか」を確認できる
 *    比較実験を提案する。
 *  - 一度の実験で複数のフォーム要素を変更させない。
 *  - 成功判定は、その課題の判定に使った指標と同じ指標で書く。
 */
import { MAX_SUCCESS_CRITERIA } from "./config";
import {
  EXPERIMENT_DESIGNS,
  isValidDesign,
  reproductionDesign,
} from "./experiments";
import type { LocalCoachAction, LocalCoachFinding } from "./types";

/** 全メニュー共通の「意識してはいけないこと」。フォーム同時変更の禁止。 */
const COMMON_AVOID =
  "肘・肩・手首・グリップなど複数のフォーム要素を同時に変更しないでください。今回は投げ方を変えるのではなく、同じ投げ方で傾向が再現するかを確認します。";

/** 全メニュー共通の中止・変更基準。 */
const COMMON_STOP_CRITERIA = [
  "痛みや違和感が出た場合は、投擲数が残っていても中止してください。",
  "予定投擲数の半分を終えた時点で記録が取れていない項目がある場合は、記録方法を見直してから再開してください。",
];

type ActionTemplate = (finding: LocalCoachFinding) => LocalCoachAction;

/** 課題の根拠に使った代表指標名（成功判定の文言に使う）。 */
function primaryMetric(finding: LocalCoachFinding): string {
  return finding.primaryMetric ?? finding.evidence[0]?.metric ?? "対象指標";
}

const TEMPLATES: Record<string, ActionTemplate> = {
  dart_order_lateral_spread: (finding) => ({
    id: "action_dart_order_lateral_spread",
    targetFindingId: finding.id,
    title: "投順による横方向ばらつきの再現性を確認する",
    purpose:
      "特定の投順でだけ横方向のばらつきが大きくなる傾向が、投順に依存して再現するかを確認する。",
    method:
      "同一ターゲットへ15セット(45投)投げ、3投とも同じ開始タイミング・同じテンポで記録する。詳細座標入力で全投擲を記録する。",
    throwCount: 45,
    focus:
      "3投とも同じ開始タイミングを保つこと。特定の投順だけ急いだり間を置いたりしない。",
    avoid: COMMON_AVOID,
    recordItems: [
      "投順ごとの誤差X(右が正)",
      "投順ごとの命中判定対象投擲数",
      "各セットのグルーピング径",
    ],
    successCriteria: [
      `${primaryMetric(finding)}が、他の投順の平均の130%以内に収まる。`,
      "全体の平均グルーピング径を今回より悪化させない。",
    ],
    stopOrChangeCriteria: [
      ...COMMON_STOP_CRITERIA,
      "投順別の分母がいずれも10投未満の場合は、セット数を増やしてから判定してください。",
    ],
  }),
  dart_order_hit_rate: (finding) => ({
    id: "action_dart_order_hit_rate",
    targetFindingId: finding.id,
    title: "投順による命中率差の再現性を確認する",
    purpose: "特定の投順でだけ命中率が下がる傾向が再現するかを確認する。",
    method:
      "同一ターゲットへ15セット(45投)投げ、3投とも同じ狙い方・同じテンポで記録する。投順ごとの命中判定対象投擲数を必ず残す。",
    throwCount: 45,
    focus: "3投とも同じ狙点を見続けること。投順によって狙う場所を変えない。",
    avoid: COMMON_AVOID,
    recordItems: [
      "投順ごとの命中数と命中判定対象投擲数",
      "投順ごとの外れ方向",
    ],
    successCriteria: [
      `${primaryMetric(finding)}と他の投順平均との差が10ポイント以内に収まる。`,
      "各投順の分母が10投以上ある。",
    ],
    stopOrChangeCriteria: COMMON_STOP_CRITERIA,
  }),
  half_hit_rate_down: (finding) => ({
    id: "action_half_hit_rate_down",
    targetFindingId: finding.id,
    title: "後半の命中率低下が投擲数に依存するかを確認する",
    purpose:
      "後半で命中率が下がる傾向が、投擲数の増加そのものに伴って再現するかを確認する。",
    method:
      "同一ターゲットへ20セット(60投)を、10セットごとに区切って記録する。区切りの間に2分間の休憩を入れ、前半区間と後半区間の命中率を比較する。",
    throwCount: 60,
    focus:
      "各区間の開始時に同じ準備動作から入ること。区間ごとに自己評価(疲労度・集中度)を記録する。",
    avoid: COMMON_AVOID,
    recordItems: [
      "区間ごとの命中数と命中判定対象投擲数",
      "区間ごとの自己評価(疲労度・集中度)",
    ],
    successCriteria: [
      `${primaryMetric(finding)}を基準として、後半区間と前半区間の命中率差が10ポイント以内に収まる。`,
      "各区間の分母が10投以上ある。",
    ],
    stopOrChangeCriteria: COMMON_STOP_CRITERIA,
  }),
  half_error_distance_up: (finding) => ({
    id: "action_half_error_distance_up",
    targetFindingId: finding.id,
    title: "後半の誤差拡大が投擲数に依存するかを確認する",
    purpose:
      "後半で平均誤差距離が大きくなる傾向が、投擲数の増加に伴って再現するかを確認する。",
    method:
      "同一ターゲットへ20セット(60投)を詳細座標で記録し、10セットごとに区切って前半区間と後半区間の平均誤差距離を比較する。区切りの間に2分間の休憩を入れる。",
    throwCount: 60,
    focus: "各区間で同じテンポを保つこと。区間の後半で投げ急がない。",
    avoid: COMMON_AVOID,
    recordItems: [
      "区間ごとの平均誤差距離(詳細座標のみ)",
      "区間ごとの誤差サンプル数",
      "区間ごとの自己評価(疲労度・集中度)",
    ],
    successCriteria: [
      `${primaryMetric(finding)}に対し、後半区間の平均誤差距離が前半区間の130%以内に収まる。`,
      "各区間の誤差サンプル数が10投以上ある。",
    ],
    stopOrChangeCriteria: COMMON_STOP_CRITERIA,
  }),
  axis_bias: (finding) => ({
    id: "action_axis_bias",
    targetFindingId: finding.id,
    title: "片側への寄りが狙点の取り方で変わるかを確認する",
    purpose:
      "平均着弾が片側へ寄る傾向が、狙点の取り方だけで変化するかを確認する。",
    method:
      "同一ターゲットへ10セット(30投)を通常どおり投げて記録する。続けて、狙点だけを寄りと反対側へわずかにずらして10セット(30投)を記録し、2条件の平均誤差を比較する。変更するのは狙点だけとする。",
    throwCount: 60,
    focus: "条件ごとに狙点を固定すること。1セットの途中で狙点を変えない。",
    avoid: COMMON_AVOID,
    recordItems: [
      "条件ごとの平均誤差(該当軸)",
      "条件ごとの標準偏差(該当軸)",
      "条件ごとの誤差サンプル数",
    ],
    successCriteria: [
      `${primaryMetric(finding)}の絶対値が、狙点を変えた条件で今回より小さくなる。`,
      "同じ軸の標準偏差を今回より悪化させない。",
    ],
    stopOrChangeCriteria: [
      ...COMMON_STOP_CRITERIA,
      "狙点を変えた条件で標準偏差が悪化した場合は、寄りではなく再現性の問題として扱い直してください。",
    ],
  }),
  axis_dispersion: (finding) => ({
    id: "action_axis_dispersion",
    targetFindingId: finding.id,
    title: "ばらつきがテンポの一定性で変わるかを確認する",
    purpose:
      "平均は中央付近でもばらつきが大きい状態が、投擲テンポを一定にすることで変化するかを確認する。",
    method:
      "同一ターゲットへ10セット(30投)を通常どおり投げて記録する。続けて、1投ごとの間隔を数えて一定に保った状態で10セット(30投)を記録し、2条件の標準偏差を比較する。変更するのはテンポの一定性だけとする。",
    throwCount: 60,
    focus: "条件ごとに投擲間隔を一定に保つこと。",
    avoid: COMMON_AVOID,
    recordItems: [
      "条件ごとの標準偏差(該当軸)",
      "条件ごとの平均誤差(該当軸)",
      "条件ごとの誤差サンプル数",
    ],
    successCriteria: [
      `${primaryMetric(finding)}を基準に、テンポを一定にした条件の標準偏差が今回より小さくなる。`,
      "同じ軸の平均誤差を今回より悪化させない。",
    ],
    stopOrChangeCriteria: COMMON_STOP_CRITERIA,
  }),
  direction_bias: (finding) => ({
    id: "action_direction_bias",
    targetFindingId: finding.id,
    title: "外れ方向の偏りが再現するかを確認する",
    purpose:
      "簡易入力の記録で見えた外れ方向の偏りが、次回も同じ方向で再現するかを確認する。",
    method:
      "同一ターゲットへ15セット(45投)投げ、外した投擲ごとにどのセグメントへ落ちたかを記録する。可能であれば詳細座標入力へ切り替えて記録する。",
    throwCount: 45,
    focus: "外した投擲の着弾セグメントを毎回記録すること。",
    avoid: COMMON_AVOID,
    recordItems: [
      "ミス投擲の外れ方向の件数",
      "ミス投擲の総数(分母)",
      "命中判定対象投擲数",
    ],
    successCriteria: [
      `${primaryMetric(finding)}が、ミス投擲全体の40%未満に収まる。`,
      "ミス投擲の総数が10投以上ある(分母が確保できている)。",
    ],
    stopOrChangeCriteria: [
      ...COMMON_STOP_CRITERIA,
      "詳細座標へ切り替えた場合は、簡易入力の概算値と同じ指標として比較しないでください。",
    ],
  }),
  grouping_half_widen: (finding) => ({
    id: "action_grouping_half_widen",
    targetFindingId: finding.id,
    title: "後半のグルーピング拡大がセット数に依存するかを確認する",
    purpose:
      "後半でグルーピング径が広がる傾向が、セット数の増加に伴って再現するかを確認する。",
    method:
      "同一ターゲットへ20セット(60投)を詳細座標で記録し、10セットごとに区切って区間別の平均グルーピング径を比較する。区切りの間に2分間の休憩を入れる。",
    throwCount: 60,
    focus: "各セットで同じ狙点・同じテンポを保つこと。",
    avoid: COMMON_AVOID,
    recordItems: [
      "区間ごとの平均グルーピング径",
      "区間ごとの有効セット数",
      "区間ごとの自己評価(疲労度・集中度)",
    ],
    successCriteria: [
      `${primaryMetric(finding)}に対し、後半区間の平均グルーピング径が前半区間の115%以内に収まる。`,
      "各区間の有効セット数が5セット以上ある。",
    ],
    stopOrChangeCriteria: COMMON_STOP_CRITERIA,
  }),
  grouping_vs_baseline_widen: (finding) => ({
    id: "action_grouping_vs_baseline_widen",
    targetFindingId: finding.id,
    title: "グルーピング径の悪化が今回限りかを確認する",
    purpose:
      "平均グルーピング径が過去の同条件セッションより広がった状態が、今回限りの変動か継続する傾向かを確認する。",
    method:
      "今回と同じモード・同じボード種別・同じ入力精度で、同じセット数のセッションをもう1回実施する。設定と機材は変えずに記録する。",
    throwCount: 60,
    focus: "前回と同じ条件で記録すること(モード・ボード・入力方式・機材を変えない)。",
    avoid: COMMON_AVOID,
    recordItems: [
      "平均グルーピング径",
      "有効セット数",
      "前半・後半の平均グルーピング径",
    ],
    successCriteria: [
      `${primaryMetric(finding)}が、比較可能な過去セッションの平均の115%以内に戻る。`,
      "有効セット数が5セット以上ある。",
    ],
    stopOrChangeCriteria: [
      ...COMMON_STOP_CRITERIA,
      "条件を変えて実施した場合は比較対象にならないため、判定せずに記録だけ残してください。",
    ],
  }),
  target_switch_hit_rate_down: (finding) => ({
    id: "action_target_switch_hit_rate_down",
    targetFindingId: finding.id,
    title: "ターゲット切替直後の命中率低下が再現するかを確認する",
    purpose:
      "セット内で狙いが切り替わった直後に命中率が下がる傾向が再現するかを確認する。",
    method:
      "同一ターゲット3投のセットを10セット(30投)、セット内でターゲットが切り替わるセットを10セット(30投)、交互ではなくブロックに分けて記録する。両条件の命中率を比較する。",
    throwCount: 60,
    focus:
      "切替のあるセットでも、切替前と同じ準備時間を取ること。切替直後だけ急がない。",
    avoid: COMMON_AVOID,
    recordItems: [
      "条件ごとの命中数と命中判定対象投擲数",
      "切替直後の投擲数(セットの1投目を除く)",
    ],
    successCriteria: [
      `${primaryMetric(finding)}を基準に、切替直後と同一ターゲット継続の命中率差が10ポイント以内に収まる。`,
      "切替直後の分母が10投以上ある。",
    ],
    stopOrChangeCriteria: [
      ...COMMON_STOP_CRITERIA,
      "セットの1投目は前投との関係が定義できないため、集計へ含めないでください。",
    ],
  }),
  previous_throw_hit_effect: (finding) => ({
    id: "action_previous_throw_hit_effect",
    targetFindingId: finding.id,
    title: "前投の結果が次投へ影響するかを確認する",
    purpose:
      "同一セット内で、前の投擲の結果によって次の投擲の命中率が変わる傾向が再現するかを確認する。",
    method:
      "同一ターゲットへ20セット(60投)投げ、1投ごとに結果(命中/ミス)と着弾を記録する。集計では、セットの1投目を除外して前投命中後・前投ミス後に分けて比較する。",
    throwCount: 60,
    focus:
      "前の投擲の結果を確認したあと、次の投擲に入るまでの間隔を毎回同じにすること。",
    avoid: COMMON_AVOID,
    recordItems: [
      "前投命中後の命中数と分母",
      "前投ミス後の命中数と分母",
      "セットの1投目を除外した投擲数",
    ],
    successCriteria: [
      `${primaryMetric(finding)}を基準に、前投命中後と前投ミス後の命中率差が10ポイント以内に収まる。`,
      "両条件の分母がいずれも10投以上ある。",
    ],
    stopOrChangeCriteria: [
      ...COMMON_STOP_CRITERIA,
      "セットをまたぐ投擲を前投関係へ含めないでください。",
    ],
  }),
  over_correction: (finding) => ({
    id: "action_over_correction",
    targetFindingId: finding.id,
    title: "前投のズレに対する修正量が過剰かを確認する",
    purpose:
      "前の投擲が横へ外れたあと、次の投擲が反対側へ大きく外れる傾向が再現するかを確認する。",
    method:
      "同一ターゲットへ10セット(30投)を通常どおり投げて記録する。続けて、前投の結果にかかわらず狙点を一切変えないことだけを条件にして10セット(30投)を記録し、2条件で反対側へ外した割合を比較する。",
    throwCount: 60,
    focus: "後半条件では、前投がどこへ外れても狙点を動かさないこと。",
    avoid: COMMON_AVOID,
    recordItems: [
      "前投が横方向へ外れた投擲数(分母)",
      "うち反対側へ外した投擲数",
      "条件ごとの誤差X",
    ],
    successCriteria: [
      `${primaryMetric(finding)}を分母として、反対側へ外した割合が40%未満に収まる。`,
      "分母が10投以上ある。",
    ],
    stopOrChangeCriteria: COMMON_STOP_CRITERIA,
  }),
  dart_order_vertical_spread: (finding) => ({
    id: "action_dart_order_vertical_spread",
    targetFindingId: finding.id,
    title: "投順による縦方向ばらつきの再現性を確認する",
    purpose:
      "特定の投順でだけ縦方向のばらつきが大きくなる傾向が、投順に依存して再現するかを確認する。",
    method:
      "同一ターゲットへ15セット(45投)投げ、3投とも同じ立ち位置・同じ狙点で記録する。詳細座標入力で全投擲を記録する。",
    throwCount: 45,
    focus: "投順によらず同じ狙点を見続けること。立ち位置を毎セット同じにする。",
    avoid: COMMON_AVOID,
    recordItems: [
      "投順ごとの誤差Y(上が正)",
      "投順ごとの誤差サンプル数",
      "各セットのグルーピング径",
    ],
    successCriteria: [
      `${primaryMetric(finding)}が、他の投順の平均の130%以内に収まる。`,
      "全体の平均グルーピング径を今回より悪化させない。",
    ],
    stopOrChangeCriteria: [
      ...COMMON_STOP_CRITERIA,
      "投順別の分母がいずれも10投未満の場合は、セット数を増やしてから判定してください。",
    ],
  }),
  half_outboard_up: (finding) => ({
    id: "action_half_outboard_up",
    targetFindingId: finding.id,
    title: "後半の盤外ミス増加が投擲数に依存するかを確認する",
    purpose:
      "後半で盤外へ外れる割合が増える傾向が、投擲数の増加に伴って再現するかを確認する。",
    method:
      "同一ターゲットへ20セット(60投)を、10セットごとに区切って記録する。区切りの間に2分間の休憩を入れ、区間別のアウトボード率を比較する。",
    throwCount: 60,
    focus: "各区間の開始時に同じ準備動作から入ること。",
    avoid: COMMON_AVOID,
    recordItems: [
      "区間ごとのアウトボード数と完了投擲数",
      "アウトボードした投擲の外れ方向",
      "区間ごとの自己評価(疲労度・集中度)",
    ],
    successCriteria: [
      `${primaryMetric(finding)}と前半区間との差が10ポイント以内に収まる。`,
      "各区間の完了投擲数が10投以上ある。",
    ],
    stopOrChangeCriteria: COMMON_STOP_CRITERIA,
  }),
  grouping_inter_dart: (finding) => ({
    id: "action_grouping_inter_dart",
    targetFindingId: finding.id,
    title: "セット内で着弾間隔が広がる位置を特定する",
    purpose:
      "同一セットの3投のうち、どの投擲間で着弾が離れるかが再現するかを確認する。",
    method:
      "同一ターゲットへ15セット(45投)を詳細座標で記録し、1→2投目・2→3投目・1→3投目の距離をセットごとに残す。",
    throwCount: 45,
    focus: "3投とも同じ狙点へ投げること。前の投擲の位置に合わせて狙点を変えない。",
    avoid: COMMON_AVOID,
    recordItems: [
      "セットごとの1→2投目の距離",
      "セットごとの2→3投目の距離",
      "有効セット数",
    ],
    successCriteria: [
      `${primaryMetric(finding)}が、もう一方の投順間距離の115%以内に収まる。`,
      "有効セット数が5セット以上ある。",
    ],
    stopOrChangeCriteria: COMMON_STOP_CRITERIA,
  }),
  weak_target: (finding) => ({
    id: "action_weak_target",
    targetFindingId: finding.id,
    title: "特定ターゲットの命中率差が再現するかを確認する",
    purpose:
      "命中率が低かったターゲットの結果が、出題数の偏りによる見かけの差か、繰り返しても再現する差かを確認する。",
    method:
      "対象のターゲットと、比較用に命中率が高かったターゲットを、それぞれ10セット(30投)ずつブロックに分けて記録する。出題数を揃えることが条件。",
    throwCount: 60,
    focus:
      "ターゲットごとに同じ手順で構えに入ること。ブロックの切り替わりで手順を変えない。",
    avoid: COMMON_AVOID,
    recordItems: [
      "ターゲットごとの命中数と命中判定対象投擲数",
      "ターゲットごとの外れ方向",
      "ターゲットごとの平均誤差距離",
    ],
    successCriteria: [
      `${primaryMetric(finding)}と比較用ターゲットの命中率差が10ポイント以内に収まる。`,
      "両ターゲットの分母がいずれも10投以上ある。",
    ],
    stopOrChangeCriteria: [
      ...COMMON_STOP_CRITERIA,
      "出題数を揃えられなかった場合は、命中率の差を判定せず記録だけ残してください。",
    ],
  }),
  cricket_switch_marks_down: (finding) => ({
    id: "action_cricket_switch_marks_down",
    targetFindingId: finding.id,
    title: "ナンバー切替直後のマーク低下が再現するかを確認する",
    purpose:
      "セット内でナンバーが切り替わった直後に平均マークが下がる傾向が再現するかを確認する。",
    method:
      "同一ナンバー3投のセットを10セット(30投)、セット内でナンバーが切り替わるセットを10セット(30投)、ブロックに分けて記録する。両条件の1投平均マークを比較する。",
    throwCount: 60,
    focus:
      "切替のあるセットでも、切替前と同じ準備時間を取ること。切替直後だけ急がない。",
    avoid: COMMON_AVOID,
    recordItems: [
      "条件ごとの総マーク数と投擲数",
      "条件ごとのノーマーク数",
      "切替直後の投擲数(セットの1投目を除く)",
    ],
    successCriteria: [
      `${primaryMetric(finding)}と同一ターゲット継続との差が0.3マーク以内に収まる。`,
      "切替直後の分母が10投以上ある。",
    ],
    stopOrChangeCriteria: [
      ...COMMON_STOP_CRITERIA,
      "セットの1投目は前投との関係が定義できないため、集計へ含めないでください。",
    ],
  }),
  cricket_no_mark_high: (finding) => ({
    id: "action_cricket_no_mark_high",
    targetFindingId: finding.id,
    title: "ノーマークが集中しているナンバーを特定する",
    purpose:
      "マークが付かなかった投擲が、特定のナンバーに集中しているのか全体に散っているのかを確認する。",
    method:
      "練習で使うナンバーを4つに絞り、各5セット(計60投)をナンバーごとのブロックで記録する。ナンバーごとのノーマーク数を残す。",
    throwCount: 60,
    focus: "ナンバーごとに同じ手順で構えに入ること。",
    avoid: COMMON_AVOID,
    recordItems: [
      "ナンバーごとのノーマーク数と投擲数",
      "ナンバーごとの総マーク数",
      "外した際に着弾したセグメント",
    ],
    successCriteria: [
      `${primaryMetric(finding)}が全体で40%未満に収まる。`,
      "各ナンバーの分母が10投以上ある。",
    ],
    stopOrChangeCriteria: COMMON_STOP_CRITERIA,
  }),
  zero_one_ring_gap: (finding) => ({
    id: "action_zero_one_ring_gap",
    targetFindingId: finding.id,
    title: "リング種別による命中率差が再現するかを確認する",
    purpose:
      "Bull・トリプル・ダブルの間に見えた命中率差が、出題数の偏りではなく繰り返しても再現する差かを確認する。",
    method:
      "命中率が低かったリングと高かったリングを、それぞれ10セット(30投)ずつブロックに分けて記録する。出題数を揃えることが条件。",
    throwCount: 60,
    focus: "リングごとに同じ手順で構えに入ること。狙点をリングの中心に固定する。",
    avoid: COMMON_AVOID,
    recordItems: [
      "リングごとの命中数と命中判定対象投擲数",
      "リングごとの外れ方向(内側/外側/上下)",
      "リングごとの平均誤差距離",
    ],
    successCriteria: [
      `${primaryMetric(finding)}と比較用リングの命中率差が10ポイント以内に収まる。`,
      "両リングの分母がいずれも10投以上ある。",
    ],
    stopOrChangeCriteria: [
      ...COMMON_STOP_CRITERIA,
      "練習データからは実戦のフィニッシュ成功率を判定できないため、比較は練習内に留めてください。",
    ],
  }),
  tempo_change: (finding) => ({
    id: "action_tempo_change",
    targetFindingId: finding.id,
    title: "投擲間隔を一定にした場合との差を確認する",
    purpose:
      "セット内の投擲間隔が後半で変化する状態が、精度の変化と一緒に動くかを確認する。",
    method:
      "同一ターゲットへ10セット(30投)を通常どおり記録する。続けて、1投ごとの間隔を数えて一定に保った状態で10セット(30投)を記録し、2条件の間隔中央値と誤差を比較する。変更するのは間隔の一定性だけとする。",
    throwCount: 60,
    focus: "後半条件では、セット内の投擲間隔を毎回同じ数え方で保つこと。",
    avoid: COMMON_AVOID,
    recordItems: [
      "条件ごとの投擲間隔(セットの1投目を除く)",
      "条件ごとの平均誤差距離",
      "条件ごとの命中数と命中判定対象投擲数",
    ],
    successCriteria: [
      `${primaryMetric(finding)}と前半区間との差が25%以内に収まる。`,
      "平均誤差距離を今回より悪化させない。",
    ],
    stopOrChangeCriteria: [
      ...COMMON_STOP_CRITERIA,
      "間隔を意識したことで投擲そのものがぎこちなくなる場合は、この実験を中止してください。",
    ],
  }),
  trend_hit_rate_down: (finding) => ({
    id: "action_trend_hit_rate_down",
    targetFindingId: finding.id,
    title: "命中率の連続した低下が条件変更と対応するかを確認する",
    purpose:
      "複数セッションにわたる命中率の低下が、記録条件や機材の変更と重なっていないかを切り分ける。",
    method:
      "直前まで使っていた条件(機材・ボード・入力方式・セット数)を1つも変えずに、同じモードでもう1回実施する。変更した項目がある場合は、変更前の条件へ戻して記録する。",
    throwCount: 60,
    focus: "条件を1つも変えずに実施すること。変えた項目があればメモへ残す。",
    avoid: COMMON_AVOID,
    recordItems: [
      "完全命中率と命中判定対象投擲数",
      "使用した機材とボード種別",
      "前回から変更した項目(なければ「なし」と記録)",
    ],
    successCriteria: [
      `${primaryMetric(finding)}が下げ止まり、前回の命中率と同等以上になる。`,
      "命中判定対象投擲数が10投以上ある。",
    ],
    stopOrChangeCriteria: [
      ...COMMON_STOP_CRITERIA,
      "条件を変えて実施した場合は比較対象にならないため、判定せずに記録だけ残してください。",
    ],
  }),
  trend_error_distance_up: (finding) => ({
    id: "action_trend_error_distance_up",
    targetFindingId: finding.id,
    title: "誤差距離の連続した拡大が条件変更と対応するかを確認する",
    purpose:
      "複数セッションにわたる平均誤差距離の拡大が、記録条件や機材の変更と重なっていないかを切り分ける。",
    method:
      "直前まで使っていた条件(機材・ボード・入力方式・セット数)を1つも変えずに、詳細座標のまま同じモードでもう1回実施する。",
    throwCount: 60,
    focus: "条件を1つも変えずに実施すること。変えた項目があればメモへ残す。",
    avoid: COMMON_AVOID,
    recordItems: [
      "平均誤差距離(詳細座標のみ)と誤差サンプル数",
      "誤差X・誤差Yの平均と標準偏差",
      "前回から変更した項目(なければ「なし」と記録)",
    ],
    successCriteria: [
      `${primaryMetric(finding)}が拡大を止め、前回の平均誤差距離の115%以内に収まる。`,
      "誤差サンプル数が10投以上ある。",
    ],
    stopOrChangeCriteria: [
      ...COMMON_STOP_CRITERIA,
      "条件を変えて実施した場合は比較対象にならないため、判定せずに記録だけ残してください。",
    ],
  }),
  baseline_hit_rate_down: (finding) => ({
    id: "action_baseline_hit_rate_down",
    targetFindingId: finding.id,
    title: "命中率の低下が今回限りかを確認する",
    purpose:
      "命中率が過去の同条件セッション平均を下回った状態が、今回限りの変動か継続する傾向かを確認する。",
    method:
      "今回と同じモード・同じボード種別・同じ入力精度・同じセット数でもう1回実施する。機材と設定は変えずに記録する。",
    throwCount: 60,
    focus: "前回と同じ条件で記録すること(モード・ボード・入力方式・機材を変えない)。",
    avoid: COMMON_AVOID,
    recordItems: [
      "完全命中率と命中判定対象投擲数",
      "投順別の命中率",
      "前半・後半の命中率",
    ],
    successCriteria: [
      `${primaryMetric(finding)}が、比較可能な過去セッションの平均との差10ポイント以内に戻る。`,
      "命中判定対象投擲数が10投以上ある。",
    ],
    stopOrChangeCriteria: [
      ...COMMON_STOP_CRITERIA,
      "条件を変えて実施した場合は比較対象にならないため、判定せずに記録だけ残してください。",
    ],
  }),
  baseline_error_distance_up: (finding) => ({
    id: "action_baseline_error_distance_up",
    targetFindingId: finding.id,
    title: "平均誤差距離の悪化が今回限りかを確認する",
    purpose:
      "平均誤差距離が過去の同条件セッション平均より大きくなった状態が、今回限りの変動か継続する傾向かを確認する。",
    method:
      "今回と同じモード・同じボード種別・同じ入力精度で、詳細座標のままもう1回実施する。機材と設定は変えずに記録する。",
    throwCount: 60,
    focus: "前回と同じ条件で記録すること(モード・ボード・入力方式・機材を変えない)。",
    avoid: COMMON_AVOID,
    recordItems: [
      "平均誤差距離(詳細座標のみ)と誤差サンプル数",
      "誤差X・誤差Yの平均と標準偏差",
    ],
    successCriteria: [
      `${primaryMetric(finding)}が、比較可能な過去セッションの平均の130%以内に戻る。`,
      "誤差サンプル数が10投以上ある。",
    ],
    stopOrChangeCriteria: [
      ...COMMON_STOP_CRITERIA,
      "簡易入力へ切り替えた場合は、概算値と実測値を同じ誤差指標として比較しないでください。",
    ],
  }),
};

/**
 * 実装済みの推奨メニューテンプレート識別子（辞書順）。
 * ルール側の actionTemplateId がここに存在することをテストで検証し、
 * 課題を検出したのにメニューが生成されない配線漏れを防ぐ。
 */
export const ACTION_TEMPLATE_IDS: readonly string[] = Object.keys(TEMPLATES).sort();

/**
 * 最優先の課題所見から推奨メニューを1件だけ生成する。
 * 対応するテンプレートがない所見では undefined を返し、
 * 課題と対応しない一般的な練習メニューは生成しない。
 */
export function buildAction(
  finding: LocalCoachFinding | undefined
): LocalCoachAction | undefined {
  if (!finding?.actionTemplateId) return undefined;
  const template = TEMPLATES[finding.actionTemplateId];
  if (!template) return undefined;
  const action = template(finding);
  // 1変数実験としての構造（対照条件・介入条件・否定基準・次の分岐）を重ねる。
  // 専用設計がないテンプレートは、断定を避けて再現確認の設計へ落とす。
  const metric = primaryMetric(finding);
  const candidate = EXPERIMENT_DESIGNS[finding.actionTemplateId];
  const design =
    candidate != null && isValidDesign(candidate)
      ? candidate
      : reproductionDesign(metric);
  return {
    ...action,
    successCriteria: action.successCriteria.slice(0, MAX_SUCCESS_CRITERIA),
    hypothesisIds: design.hypothesisIds,
    changedFactor: design.changedFactor,
    control: design.control,
    intervention: design.intervention,
    blockOrder: design.blockOrder,
    primaryMetric: metric,
    guardrailMetrics: design.guardrailMetrics,
    falsificationCriteria: design.falsificationCriteria,
    nextBranch: design.nextBranch,
    // 条件ごとの分母を満たす合計投擲数へ揃える
    throwCount: design.control.throwCount + design.intervention.throwCount,
  };
}
