import type {
  EquipmentProfile,
  EquipmentSnapshot,
  MissDirection,
  PlayerProfile,
  PlayerRating,
  ScoringStyle,
  RequiredScaleKey,
  SelfAssessment,
  SessionStatistics,
  ThrowRecord,
  TrainingSession,
} from "../types/models";
import { normalizeScoringStyle } from "../types/models";
import { isGroupingOnlyTarget } from "../domain/targets";
import {
  effectiveR4PatternMetadata,
  type EffectivePatternMetadata,
} from "./patternMetadata";
import { compareStatistics } from "../domain/compare";
import { getBoardProfile } from "../config/boardProfiles";
import {
  RATING_SYSTEM_LABELS,
  formatRating,
  ratingRowOf,
} from "../config/ratingTable";
import { ALL_DIRECTIONS } from "../domain/stats";
import { fmtNum, fmtNumDiff, fmtRate, fmtRateDiff, fmtDateTime, fmtElapsed } from "../utils/format";
import { t } from "../i18n/ja";

const NA = "N/A";

const MODE_LABELS: Record<string, string> = {
  zero_one: "01練習",
  cricket: "クリケット練習",
  skill_check: "スキル診断",
  same_target: "同一ターゲット3投",
  per_dart_targets: "3投別ターゲット",
  random: "全体診断(ランダム)",
  sequence: "登録順出題",
  bull: "ブル練習",
  double: "ダブル練習",
  triple: "トリプル練習",
  number: "特定ナンバー練習",
};

export function modeLabel(mode: string): string {
  return MODE_LABELS[mode] ?? mode;
}

const CONDITION_LABELS: Record<string, string> = {
  better_than_usual: "普段より良い",
  usual: "普段通り",
  worse_than_usual: "普段より悪い",
};

const HAND_LABELS: Record<string, string> = {
  right: "右",
  left: "左",
  ambidextrous: "両利き",
};

const INPUT_LABELS: Record<string, string> = {
  simple: "簡易入力",
  coordinate: "詳細座標入力",
};

const ARRANGEMENT_LABELS: Record<string, string> = {
  balanced: "均等ランダム",
  pure: "完全ランダム",
  same_per_set: "同一ターゲット3投",
  fixed_three: "3投別ターゲット",
  cycle: "登録順",
  blocks: "ナンバー順に集中(ブロック出題)",
  skill_rounds: "ラウンド制(グルーピング/スコアリング/ナンバー/ダブル)",
};

const SCORING_STYLE_LABELS: Record<string, string> = {
  fat_bull: "ファットブル(ブル一律50点のソフト・削りの主役はBull)",
  separate_bull: "セパレートブル(内50/外25のソフト・削りの主役はT20)",
  steel: "ハード(スティール・削りの主役はT20)",
};

/** スコアリング形式の表示ラベル。旧値 fit_bull もファットブルとして受理する。 */
export function scoringStyleLabel(style: string): string {
  const normalized = normalizeScoringStyle(style) ?? style;
  return SCORING_STYLE_LABELS[normalized] ?? normalized;
}

const EYE_LABELS: Record<string, string> = {
  right: "右",
  left: "左",
  unknown: "不明",
};

const GOAL_LABELS: Record<string, string> = {
  rating: "実力・レーティング向上",
  recovery: "復調・イップス(以前の実力に戻る)",
  zero_one: "01ゲームの強化",
  cricket: "クリケットの強化",
  pro: "プロ志望(競技力向上)",
  form_check: "フォーム確認",
  bull: "ブル精度の向上",
};

const STANCE_LABELS: Record<string, string> = {
  closed: "クローズド",
  middle: "ミドル",
  open: "オープン",
};

const TIMING_LABELS: Record<string, string> = {
  before: "開始前",
  middle: "中間",
  after: "終了後",
};

const RELEASE_STOP_TIMING_LABELS: Record<string, string> = {
  none: "なし",
  during_setup: "セットアップ中",
  before_takeback: "テイクバック開始前",
  after_takeback: "テイクバック後／前へ出す直前",
  during_forward: "フォワード動作中",
  before_release: "リリース直前",
  unknown: "わからない",
  other: "その他",
};

const CHANGE_LABELS: Record<string, string> = {
  better: "開始時より良くなった",
  same: "変わらない",
  worse: "開始時より悪くなった",
};

export function directionLabel(dir: MissDirection | undefined): string {
  if (!dir) return NA;
  return t().direction[dir];
}

export function ringLabel(ring: string): string {
  const r = t().ring as Record<string, string>;
  return r[ring] ?? ring;
}

function landingLabel(throwRecord: ThrowRecord): string {
  const l = throwRecord.landing;
  if (l.ring === "outboard") {
    const dir = l.outboardDirection
      ? t().direction[l.outboardDirection as MissDirection] ?? "不明"
      : "";
    return dir ? `アウトボード(${dir})` : "アウトボード";
  }
  if (l.ring === "bounce_out") return "バウンスアウト";
  if (l.ring === "inner_bull") return "インナーブル";
  if (l.ring === "outer_bull") return "アウターブル";
  if (l.ring === "unknown") return "不明";
  const prefix =
    l.ring === "double" ? "D" : l.ring === "triple" ? "T" : "S";
  return `${prefix}${l.number ?? "?"}`;
}

/**
 * AIに与える役割定義(ペルソナ)。分析指示より前、依頼文の冒頭に置く。
 * 分析の視点(バイオメカニクス+データ分析)とトーン(客観的・建設的)を先に固定することで、
 * 以降の詳細ルールが「どの立場からの指示か」を解釈しやすくする。
 */
export const ANALYSIS_PERSONA =
  "あなたはダーツのスポーツバイオメカニクスおよびデータ分析に精通した専門コーチです。以下の練習データに基づき、客観的かつ建設的なフィードバックを提供してください。";

/** AI分析依頼文(分析指示ブロック) */
export const ANALYSIS_INSTRUCTIONS = `以下の順序とルールで、統計の言い換えではなく、ユーザーが次に何を確認し何を試すべきかまで踏み込んで具体的に診断してください。

## リスクヘッジの置き方(最初に読むこと)
- 回答の冒頭に「この分析はAIによる予測・仮説であり、断定するものではありません」という趣旨の注意書きを1〜2文だけ置いてください。
- 回答の末尾にも同趣旨の短い注意書きを1回だけ置いてください。
- リスクヘッジはこの冒頭と末尾の2か所だけで十分です。本文の各項目では免責の繰り返しや「あくまで可能性ですが」「一概には言えませんが」等のぼかし表現を使わず、最も可能性が高い見立てを明確に、歯切れよく述べてください。冒頭と末尾に注意書きがあるため、本文が踏み込んだ表現になっても問題ありません。

## 分析の姿勢
- この分析の最大の価値は、ユーザー自身が気付いていないクセ・傾向・改善点を発見して言語化することです。投順、方向偏り、前後半、修正パターン、自己評価との関係などデータを多角的に突き合わせ、本人が言語化していないパターンを積極的に指摘してください。
- 【深掘りの必須要件】統計値をそのまま言い換えただけの指摘(例:「命中率が低い」「3投目の誤差が大きい」「アウトボードが多い」など、依頼文の数値を見れば誰でも即座に分かること)を、発見・結論・重要な洞察として提示しないでください。価値ある指摘は、2つ以上の指標・条件を掛け合わせて初めて見える非自明な関係に限ります。目安として、"条件×結果"(例: 前投が命中した直後だけ3投目が右へ散る=命中後の力み)、"時間変化×自己評価"(例: 自己申告の集中度が下がったセットでのみ左右のばらつきが増える)、"切替×再現性"(例: 同一ターゲット継続は安定だが、セット内切替直後の1投だけ手前に落ちる)のように、複数の軸の交差・交互作用・時間推移から、本人が数値を眺めるだけでは気づけない層を提示してください。単一指標だけで分かる表面的事実は、深掘りの前提や根拠として使うのは構いませんが、それ自体を主要な結論・洞察として扱わないでください。
- 表面的な事実に留まりそうな場合は、「なぜそれが起きるのか(条件)」「どの局面で強まるのか(いつ・どの投順・どのターゲット・どの自己評価状態で)」を必ず一段掘り下げてから提示してください。
- 重要な指摘は【事実】【統計的傾向】【原因仮説】【分析不能】【追加確認が必要】のいずれかで区別してください。区別した上で、原因仮説は「最有力はどれか」まで順位付けして踏み込んでください。候補の大量列挙や両論併記で終わらせないでください。
- 重要な指摘には「確からしさ：高 / 中 / 低」を添えてください(複数セット・複数指標で再現=高、1指標で一定傾向=中、少数または間接推測=低)。必要データがない項目だけを分析不能としてください。標本が少ない項目(目安: 該当10投未満、または中断により予定の半分未満しか完了していない)は、傾向が明確でも確からしさを「高」にしないでください。
- 数値の裏付けがない指摘を、データがあるかのように述べないでください。統計的有意差は計算していないため「有意」という表現は使わず、1投しかない個別ターゲットを得意・不得意と評価しないでください。

## 安全ルール(必ず守る)
- 医学的診断、心理的診断、性格診断は禁止です。復調・イップス傾向でも症状名や人格を診断しないでください。
- 復調・イップス目的では命中結果と投擲プロセスを分け、止まらず投げられた割合を主要改善指標として時間変化を評価してください。不安またはリリースの怖さが悪化した場合は休憩か終了を提案し、リリース動作を過度に意識させる提案は禁止です。
- 初心者、または専門用語に詳しくないと記録されたユーザーには、専門用語の初出時に括弧で短い説明を付けてください。
- プロ志望でも練習データだけからプロレベル、試験合格、公式レーティングの到達を保証しないでください。試合データがなければ試合適応性は追加質問または分析不能としてください。
- 練習データ(Bull反復・同一ターゲット反復・スキル診断等)から公式のPPD・MPR・レーティング(DARTSLIVE/PHOENIX等)を算出・宣言しないでください。これらは実戦のゲーム集計でのみ決まります。レーティングの参考値が依頼文に含まれる場合も、非公式の距離感としてのみ扱ってください。

## データの読み方
- 着弾データだけからグリップ、スタンス、肘、肩、手首、リリース等の真因を確定することはできません。フォーム情報も自己申告の背景です。身体・動作要因を原因仮説として挙げるのは、対応するデータ上の傾向(例: 3投目だけ右へ散る)と、本人が確認できる方法(例: 3投目のグリップ圧を意識して15投比較)をセットで示せる場合だけにしてください。その条件を満たす場合は萎縮せず、最有力の仮説として明確に挙げてください。フォーム情報が記録されていない場合は、身体・動作要因を断定的な最有力候補にせず、まず追加質問で確認してください。
- same_set_as_previous=false の投擲はセットの1投目です。前投命中・ターゲット変更をN/Aとして、切替直後、命中後の再現性、ミス後の修正の集計から除外してください。previous_throw_was_hit_in_same_set と same_target_as_previous を優先してください。
- クリケットのセット内切替サンプルが0投なら、切替能力を推測せず「未測定・分析不能」と明記してください。
- 自己評価の数値に「(未回答)」が付いている項目は、ユーザーが操作しなかった既定値です。測定値として扱わず、その項目単独での傾向・原因の断定や、開始前と終了時の差分評価に使わないでください。必要なら追加質問で確認してください。
- 矢速(speed_kmh)は任意入力のため一部の投擲にしか記録されていない場合があります。記録がある投擲だけで、矢速と精度・ミス方向・投順の関係を傾向として分析してください。

## 用語を混同しない
- 問題点: 観測された結果（例「3投目の右方向ミスが多い」）
- 原因候補: 問題を生む可能性のある未確定要因（例「3投目にグリップ圧が上がる可能性」）
- 改善項目: 変えたい状態（例「3投目も同じテンポとグリップ圧を維持」）
- 改善方法: 仮説を検証する具体的実験（例「グリップ圧の自己評価と左右ミス率を15投ずつ比較」）

## 思考プロセス(回答を書く前にこの手順で考える)
分析を行う際は、以下のステップに従って記述してください：
1. **客観的事実の抽出**: 提示された数値データ(命中率、前後半比較、1〜3投目別、外れ方向の偏り、グルーピング、自己評価の時間変化など)から確認できる事実を箇条書きで整理する。
2. **要因の仮説提示**: 抽出した事実に基づき、フォーム・テンポ・集中力等に関する考えられる仮説(原因候補)を2〜3点提示する。
3. **改善アクション案**: 次回の練習で試すことができる具体的なアクションプランと成功判定基準を提示する。

このステップ1〜3は、下の「回答構成」の第1章・第2章・第3章にそれぞれ対応します。ステップ1で挙げていない事実を根拠にしてステップ2の仮説を述べないでください。ステップ2で挙げていない原因仮説を検証するための実験をステップ3に置かないでください。各ステップの飛ばし読み(事実の整理を省いて結論だけ述べる、仮説を示さず練習メニューだけ挙げる)は禁止です。

## 回答構成
回答の一番最初に冒頭の注意書き(1〜2文)、一番最後に末尾の注意書き(1文)を置き、その間を以下の3章構成にしてください。章のタイトルと並び順は変更せず、各章の中は指定された小見出しに分けてください。

### 1. データの特徴(思考ステップ1: 客観的事実の抽出)

#### 1-1. 最重要結論
最大3点。各点に、何が問題か、根拠データ、目標への影響、確からしさを含め、言い切れる部分は言い切ってください。数値の単純な言い換えではなく、複数条件の掛け合わせから見える踏み込んだ結論にしてください(「命中率が低い」で終わらせず、どの条件でなぜ崩れるかまで)。

#### 1-2. ユーザーの問題点
優先順の表にし、列は「優先度 / 問題点 / 根拠 / ユーザーへの影響 / 確からしさ / 不足している情報」としてください。単なる「命中率が低い」で終わらせず、1〜3投目差、命中後の再現性、ミス後の修正・過剰修正、同一ターゲット継続、セット内切替直後、方向偏り、前後半、疲労・集中・不安・リリースの怖さ、固定と切替の差をデータがある範囲で調べ、ない項目は分析不能としてください。

### 2. 考えられる要因（仮説）(思考ステップ2: 要因の仮説提示)

#### 2-1. 原因候補・仮説
問題点ごとに最大3件の表とし、列は「原因候補 / 根拠 / 確からしさ / 仮説と矛盾する点 / 不足データ / 正しい場合に出やすい感覚・現象 / 確認方法 / 正しかった場合の改善方法」としてください。着弾、投順、切替、自己評価と関係する候補だけを選び、最有力の候補がどれかを明示してください。

#### 2-2. ユーザーが気付いていない可能性がある傾向
この分析のハイライトです。最大3件、「あなたは〇〇の傾向があります」の形式で、推測される傾向、根拠データ、本人が確認すべき感覚・動作、確認質問を含めてください。本人が既に自覚している悩み(記録済みの悩み・重点課題)の言い換えではなく、データからしか見えない新しい発見を優先してください。ここでは単一指標で分かる表面的傾向(命中率・平均誤差の高低など)は禁止とし、条件依存・交互作用・時間変化・自己評価との関係など、複数の軸を掛け合わせてはじめて見える層に限定してください。各件について「この傾向は数値を眺めるだけでは気づけない」と言える根拠(どの指標とどの指標を突き合わせたか)を明示してください。根拠のない性格診断は禁止です。

### 3. 次回へのアクション(思考ステップ3: 改善アクション案)

#### 3-1. 優先して改善すべき項目
最大3項目。改善目標、優先理由、改善できたと判断する基準、先に確認すべき条件、今は優先しなくてよい項目を示してください。一度に複数のフォーム要素を変更させないでください。

#### 3-2. 改善方法（原因仮説を確認するための実験）
各メニューに「目的 / 検証する原因仮説 / 実施方法 / 投擲数 / 意識すること / 意識してはいけないこと / 記録項目 / 成功判定 / 中止・変更基準 / 次に行う判断」を含めてください。Bullを60投、苦手ナンバーを投げ込む等だけで終わらせず、原因候補が複数なら1要因ずつ条件を変えて比較してください。

#### 3-3. 原因を絞り込む追加質問
今回の問題点と原因候補に合わせ、情報価値の高い質問を3〜7問選んでください。毎回同じ質問にせず、可能ならA/B/C/D等の選択肢形式にしてください。投げ方を直接観察できない項目、ミス時の感覚、修正対象、ターゲット切替時の身体の動かし方、3投目のテンポ、命中後の力み、ダブル時の力み・テンポ、リリースが止まるタイミング、試合と練習の差から必要なものを選んでください。

#### 3-4. ユーザー回答後の再診断
ユーザーが追加質問へ回答した場合は、最初の分析を繰り返さず、回答内容を使って原因候補の順位を更新してください。再診断は「原因候補の順位変更 / 可能性が上がった原因 / 可能性が下がった原因 / 否定できた原因 / まだ不足している情報 / 最初に試すべき改善実験 / 改善実験後に記録すべき内容」を出力してください。`;

/**
 * 出力フォーマット・トーンの指定。依頼文の末尾(データを読ませた後)に置く。
 * 章立ては「AIへの分析指示」の回答構成と同一であり、両者が矛盾しないよう
 * 章タイトルはここでも同じ文言を使う。
 */
export const OUTPUT_FORMAT_INSTRUCTIONS = `## 回答のフォーマットとトーン

- 全体を「1. データの特徴」「2. 考えられる要因（仮説）」「3. 次回へのアクション」の3章構成とすること。各章の小見出しと内容は「## AIへの分析指示」の回答構成に従うこと。
- 文字数制限は設けず、データから読み取れるすべての特徴と課題を詳細に記述すること。字数を短くするために章や小見出しを省略しないこと。
- 批判的な表現を避け、プレイングの改善に向けた前向きで実践的なトーンとすること。ユーザーの技術・人格を否定する表現や、「下手」「悪い癖」等の断罪的な言い回しは使わないこと。
- ただし前向きなトーンのために課題を曖昧にしたり、確からしさを実際より高く述べたり、データにない改善を述べたりしないこと。データが不足する項目は「分析不能」と明記すること。
- 冒頭と末尾の注意書き(この分析はAIによる予測・仮説であり断定するものではない旨)は「## AIへの分析指示」の指定どおり残すこと。
- 医学的診断・心理的診断・性格診断は行わないこと。イップス等の症状名で状態を断定しないこと。`;

/**
 * このセッションの着弾データの精度区分。
 * セッション設定(inputMethod)ではなく実際に記録された着弾の精度から決める。
 * スキル診断のR1グルーピングは簡易入力セッションでも詳細座標を要求するため、
 * 1セッション内で両方式が混在しうる(mixed)。
 */
export type InputPrecisionMode = "coordinate" | "simple" | "mixed";

/** 記録済み着弾の精度から分析指示の切替区分を判定する */
export function inputPrecisionModeOf(
  stats: SessionStatistics,
  session: TrainingSession
): InputPrecisionMode {
  const coordinate = stats.coordinateInputCount;
  const approximate = stats.approximateInputCount;
  if (coordinate > 0 && approximate > 0) return "mixed";
  if (coordinate > 0) return "coordinate";
  if (approximate > 0) return "simple";
  // バウンスアウトのみ等で精度付き着弾が1件もない場合はセッション設定へフォールバック
  const method = session.contextSnapshot?.inputMethod ?? session.inputMethod;
  return method === "coordinate" ? "coordinate" : "simple";
}

/**
 * 入力精度に応じた分析指示。
 * 詳細座標では左右(X)・上下(Y)の偏差を軸ごとに、簡易入力では命中率と確率推移を中心に、
 * と分析の主対象を切り替える。簡易入力の座標はエリア代表点の概算値であり、
 * mm単位の偏差を根拠にすると誤った精度の結論が出るため明示的に禁止する。
 */
export function inputPrecisionSection(
  mode: InputPrecisionMode,
  stats: SessionStatistics,
  session: TrainingSession
): string {
  const radiusMm = getBoardProfile(session.boardProfileId).doubleOuterRadiusMm;
  const mmNote = `座標・誤差距離は外側ダブル半径=1.0の正規化値です。実寸へ換算する場合はこのセッションのボード半径 ${radiusMm}mm を掛けてください(誤差距離0.10 ≒ ${Math.round(radiusMm * 0.1)}mm)。mm換算値を述べるときは換算した旨を明記してください。`;
  const coordinateBody = [
    `本データは詳細なX/Y座標(実寸換算でミリ単位の分解能)を含みます。平均誤差距離および着弾座標の分布から、左右の偏差(テイクバック・リリースラインに関わる軸)と上下の偏差(リリースポイント・高低差に関わる軸)を個別に分析してください。`,
    `- 誤差X(右が正)と誤差Y(上が正)は必ず分けて集計・評価し、どちらの軸のばらつきが支配的かを明示してください。左右と上下を「平均誤差距離」だけにまとめないでください。`,
    `- 平均だけでなく符号の偏り(常に右へ出るのか、左右に散るのか)を区別してください。平均が0付近でもばらつきが大きい場合は「偏り」ではなく「再現性の低さ」として扱ってください。`,
    `- ${mmNote}`,
  ].join("\n");
  const simpleBody = [
    `本データはセグメント単位の簡易入力です。ミリ単位の誤差ではなく、ターゲットごとの命中率および投順・セット間での確率推移を中心に分析してください。`,
    `- 座標・誤差距離は選択エリアの代表点(幾何学的中心)から算出した概算値です。mm単位の精密な偏差、グルーピング径の絶対値、平均誤差距離の小さな差を根拠にしないでください。`,
    `- 左右・上下の傾向は座標値ではなく、外れ方向(ズレ方向)の頻度分布と、外した際にどのセグメントへ落ちたかで評価してください。`,
    `- 命中率の比較では必ず分母(命中判定対象投擲数)を併記し、少数サンプルの差を傾向と断定しないでください。`,
  ].join("\n");
  const mixedBody = [
    `本データは詳細座標入力と簡易入力が混在しています(内訳は上記)。精度の異なる2種類の記録を同じ測定値として合算した結論を出さないでください。`,
    `- 左右・上下の偏差、グルーピング径、mm単位の議論は詳細座標(入力精度=座標)の投擲だけを対象にしてください。誤差X(右が正)と誤差Y(上が正)は分けて評価してください。`,
    `- 簡易入力を含む集計(全体の命中率、ターゲット別、前後半など)は、命中率と確率推移を中心に評価し、平均誤差距離の小さな差を根拠にしないでください。`,
    `- 結論ごとに、どちらの精度のデータに基づく指摘かを明示してください。`,
    `- ${mmNote}`,
  ].join("\n");
  const body =
    mode === "coordinate"
      ? coordinateBody
      : mode === "simple"
        ? simpleBody
        : mixedBody;
  return [
    "### 入力精度に応じた分析指示",
    "",
    `- 着弾記録の内訳: 詳細座標入力 ${stats.coordinateInputCount}投 / 簡易入力(セグメント単位) ${stats.approximateInputCount}投`,
    "",
    body,
  ].join("\n");
}

type FocusCategory =
  | "repeat"
  | "bull"
  | "finish"
  | "cricket"
  | "diagnostic"
  | "skill";

/** トレーニングモードから分析焦点カテゴリを決める */
export function focusCategoryOf(
  session: TrainingSession
): FocusCategory | undefined {
  switch (session.trainingMode) {
    case "bull":
      return "bull";
    case "cricket":
      return "cricket";
    case "random":
      return "diagnostic";
    case "skill_check":
      return "skill";
    case "zero_one":
      return session.arrangement === "fixed_three" ? "finish" : "repeat";
    // 旧バージョンのモードは近い焦点へマッピング
    case "same_target":
    case "number":
    case "double":
    case "triple":
      return "repeat";
    case "per_dart_targets":
      return "finish";
    default:
      return undefined;
  }
}

/**
 * スキル診断の分析焦点。スコアリング形式で主役(R2)と副ターゲット(R3同一3投)が
 * 入れ替わるため、セッションの形式から動的に生成する。
 * 旧データ(scoringStyle未記録)はファットブル配列(R2=Bull・R3同一=T20)で出題されている。
 */
function skillFocusSection(style: ScoringStyle | undefined): string {
  const effective: ScoringStyle = normalizeScoringStyle(style) ?? "fat_bull";
  const mainIsBull = effective === "fat_bull";
  const main = mainIsBull ? "Bull" : "T20";
  const sub = mainIsBull ? "T20" : "Bull";
  const styleNote = style
    ? `スコアリング形式は「${scoringStyleLabel(style)}」です。`
    : "スコアリング形式は記録されていません(旧バージョンの診断。ファットブル相当の出題構成)。";
  const mainDetail = mainIsBull
    ? "命中率・平均誤差・インナー/アウター比率"
    : "命中率・平均誤差・外した際の落下先(S20/S5/S1)の分布";
  return `### このセッションの分析焦点(スキル診断)

このセッションは4ラウンド構成の技能測定です。${styleNote}01の削りの主役ターゲットは${main}です。round_id・round_kind・evaluation_kindを優先してラウンドを判別し、これらがない旧データだけターゲット構造を補助的に使ってください。

- R1 グルーピング(grouping_only): 詳細座標入力の有効な3投セットだけで、平均・最大・中央値ペア距離と有効セット数を扱ってください。R1は命中を評価しないため、命中数・命中率・投擲一覧の命中(exact_hit)・前投命中(previous_throw_was_hit / previous_throw_was_hit_in_same_set)はすべてN/Aです。前投がミスだった前提の「ミス後の修正」としてR1を扱わないでください。分析不能理由は、有効な詳細座標3投セットなし、バウンスアウト、アウトボード、位置不明、3投未満、segment_approximationを区別してください
- R2 スコアリング(scoring): 主役ターゲット${main}の${mainDetail}を、命中判定対象投擲数とともに示してください
- R3 ナンバー(number): 副ターゲット${sub}の同一3投セットと、T20→T16→T15 / T12→T18→T3の切替セットを、命中率・平均誤差・切替直後の変化で比較してください
- R4 チェックアウト(checkout): pattern_id・pattern_kind・analysis_categoryを使い、実際にサンプルが存在する分類だけを比較してください。D20固定、D16固定、固定全体、切替全体、20系、16系、位置分散、切替直後、ボード上側/下側/左側/右側、内側/外側/上下ミス、D16・D20以外、特定ダブル依存、1投目ミス後のセット内修正が候補です。サンプルがない分類は未測定として「分析不能」とし、測定済みであるかのように扱わないでください。個別1投のダブルを得意・不得意とせず、少数なら固定/切替/20系/16系/位置分散/位置/ミス方向でまとめてください
- pattern_metadata_source が inferred_from_observed_targets の場合は旧セッションの実際のターゲット順からfixed/switch等を観測ベースで補完した値です。新しい標準R4パターンを実施した証拠ではないため、記録されていない切替・位置分散を推測で補わないでください
- 根拠のない100点満点評価や採点基準の創作は禁止です。4ラウンドの強弱は実測値・分母・入力精度・信頼度を併記し、サンプル不足は参考値または分析不能としてください
- R3・R4の切替直後は同一セット内の2投目・3投目だけです。前セットとターゲットが異なるだけの1投目を含めないでください
- 過去のスキル診断セッションが比較対象にある場合は、カテゴリ別の伸びを比較してください。ただしスコアリング形式が異なる過去診断はR2/R3の主役・副が入れ替わっているため、カテゴリ単位ではなく同一ターゲット(Bull・T20)単位で比較し、形式が異なることを明記してください
- ラウンドの出題順と自己評価の時間変化は関連の仮説として扱い、因果関係を断定しないでください
- 最も優先度の高い課題と、その根拠に対応する具体的な練習提案を示してください`;
}

const FOCUS_SECTIONS: Record<Exclude<FocusCategory, "skill">, string> = {
  repeat: `### このセッションの分析焦点(同一ターゲット反復練習)

このセッションは少数のターゲットを繰り返し狙う反復練習です。以下を最優先で分析してください。

- グルーピング: 同一ターゲットへの3投のまとまり(セット内の着弾のばらつき)と、セッション全体の散布が縦長か横長か
- 前投からの修正: 外した方向に対する次投の補正が適切か、反対方向へ外れる過修正がないか
- 1投目・2投目・3投目の系統差: 1投目を基準に2投目・3投目で狙いへ寄せられているか
- セッション経過に伴う精度・ばらつきの変化(疲労・集中との関係)
- 01ゲームへの示唆: 狙いを外した際の落下先の分布(例: T20狙いでS20/S5/S1へ落ちる割合)と得点期待値への影響
- 複数ターゲットをブロック順に練習している場合は、ブロックの切り替わり直後の精度低下も確認してください
- ターゲット切替に関する項目(必ず分析する項目の9・10)はこのセッションではほぼ該当しません。無理に分析せず「該当なし」と明記してください`,
  bull: `### このセッションの分析焦点(ブル反復練習)

このセッションはBullのみを狙う反復練習です。以下を最優先で分析してください。

- Bull狙いのグルーピングと外れ方向の偏り(上下・左右どちらへ散るか、縦横どちらのばらつきが大きいか)
- インナーブルとアウターブルの比率
- セット内3投の系統差と、前投の外れに対する修正傾向・過修正の有無
- セッション経過に伴う精度変化(疲労・集中との関係)
- ソフトダーツの01(Bull中心のスコアリング)を想定した得点期待値への示唆。ゲームルールはデータから断定できないため、仮定を明示して述べてください
- ターゲット切替に関する項目(9・10)は該当しません。「該当なし」と明記してください`,
  finish: `### このセッションの分析焦点(フィニッシュ3投指定)

このセッションは1投目・2投目・3投目のターゲットを固定したフィニッシュ(チェックアウト)練習です。以下を最優先で分析してください。

- 投擲順ごとのターゲット切替: ターゲットが変わる投擲(特に3投目のダブル等)で精度がどう変化するか
- ダブル狙いの外れ方向: 内側(シングル側)か外側(アウトボード側)か、上下どちらへ外すか。チェックアウト成功率への影響を推定してください(推定方法を明示)
- 同一ターゲットが続く投擲間(例: 1投目と2投目が同じ)のグルーピングと修正傾向
- BullまたはT20の削り、1〜3投目の変化、命中後の再現性、ミス後の修正・過剰修正、ダブル、フィニッシュ時のセット内ターゲット切替を分けて評価してください
- 3投連続でこのフィニッシュが成立する確率の概算(各投の成功率から計算し、計算方法を明示)`,
  cricket: `### このセッションの分析焦点(クリケット練習)

このセッションはクリケットナンバー(20〜15・Bull)の練習です。以下を最優先で分析してください。

- ナンバーごとの精度比較は投擲数を併記し、少数サンプルを得意・不得意と断定しないでください
- 各ナンバーの平均マーク数: トリプル=3、ダブル=2、シングル=1、インナーブル=2、アウターブル=1マークとして3投あたりの期待マーク数を計算してください(計算方法を明示)
- 出題ブロックの切り替わり直後(新しいナンバーの最初のセット)に精度低下があるか
- 同一ナンバーを狙い続ける能力と、セット内でナンバーを切り替えた直後の変化を分けてください。苦手ナンバーを投げ込むだけで終わらず、原因候補を比較する練習実験を示してください
- ナンバーによる外れ方向の違い(ボード上の位置=狙う角度による癖)
- Bullとナンバーで精度傾向に差があるか`,
  diagnostic: `### このセッションの分析焦点(全体診断)

このセッションはボード全体からランダム出題した診断用データです。以下を最優先で分析してください。

- ボード全体に対する方向バイアス(上下・左右、縦横どちらのばらつきが大きいか)
- 個別ターゲットのサンプル数は非常に少ないため、ターゲット単位の得意・不得意は断定せず、エリア単位(ボード上部/下部/左右、シングル/ダブル/トリプル/ブル)の傾向として集約してください
- グルーピングや前投からの修正傾向は、ターゲットが頻繁に変わるため参考程度に留めてください
- 次回どのターゲットを集中練習すべきかの優先順位を提案してください`,
};

const GOAL_SECTIONS: Partial<Record<NonNullable<PlayerProfile["goal"]>, string>> = {
  rating: `### 目的別の注意（実力・レーティング向上）

- レーティングに直結する指標(Bull・T20まわりの命中率、グルーピング、3投の再現性)を優先し、改善した場合の総合力への影響が大きい課題から順位付けしてください。
- 平均値だけでなくばらつきに注目し、「悪い時の底上げ」につながる改善を重視してください。
- 練習データからレベル感を概算で述べるのは構いませんが、公式レーティングの決定方式はサービスごとに異なるため、概算である旨を一言添えてください。`,
  recovery: `### 目的別の注意（復調・イップス）

- 命中結果と、止まらず投げられた割合・ルーティン達成度等の投擲プロセスを分けて扱ってください。
- 投げる前の不安、リリースの怖さ、セッション中の変化、投げ急ぎ、結果を意識した力みを確認してください。データがなければ追加質問にしてください。
- 症状と成績の時間変化を確認し、リリース動作を過度に意識させる助言は避けてください。
- 主観症状が悪化した場合は休憩・終了を選択肢として示し、医学的・心理的診断はしないでください。`,
  zero_one: `### 目的別の注意（01）

- BullまたはT20の削り、1〜3投目差、命中後の再現性、ミス後の修正・過剰修正、ダブル、フィニッシュ時のターゲット切替を優先してください。`,
  cricket: `### 目的別の注意（クリケット）

- ナンバー別MPR相当、ノーマーク率、有効マーク率、同一ナンバー継続、セット内切替直後を分けてください。
- 苦手ナンバーを投げ込むだけの提案は禁止し、原因仮説を1つずつ比較する実験を提示してください。`,
  pro: `### 目的別の注意（プロ志望）

- 精度だけでなく再現性、安定性、試合適応性、ダブル、切替能力を重視してください。
- 練習データだけで競技レベルやプロテストの合否を断定しないでください。試合データがなければ、試合と練習で変わるグリップ・呼吸・テンポ・視線を追加質問にしてください。
- 現行のJAPANプロテスト基準を推測・創作しないでください。`,
};

const GRIP_FINGER_LABELS: Record<string, string> = {
  "2": "2フィンガー",
  "3": "3フィンガー",
  "4": "4フィンガー",
  other: "その他",
  unknown: "不明",
};
const GRIP_POSITION_LABELS: Record<string, string> = {
  front: "前方",
  center: "中央",
  rear: "後方",
  unknown: "不明",
};
const TAKEBACK_LABELS: Record<string, string> = {
  shallow: "浅い",
  standard: "標準",
  deep: "深い",
  unknown: "不明",
};
const TEMPO_LABELS: Record<string, string> = {
  slow: "遅い",
  standard: "標準",
  fast: "速い",
  unknown: "不明",
};

function equipmentSummary(equipment: EquipmentProfile | EquipmentSnapshot | undefined): string {
  if (!equipment) return NA;
  const parts: string[] = [equipment.name];
  const b = equipment.barrel;
  if (b?.maker || b?.model || b?.weightG != null || b?.lengthMm != null || b?.maxDiameterMm != null) {
    const specs = [
      [b.maker, b.model].filter(Boolean).join(" "),
      b.weightG != null ? `${b.weightG}g` : "",
      b.lengthMm != null ? `全長${b.lengthMm}mm` : "",
      b.maxDiameterMm != null ? `最大径${b.maxDiameterMm}mm` : "",
    ]
      .filter(Boolean)
      .join(" ");
    parts.push(`バレル: ${specs}`);
  }
  const sh = equipment.shaft;
  if (sh?.maker || sh?.model || sh?.lengthMm != null) {
    const specs = [
      [sh.maker, sh.model].filter(Boolean).join(" "),
      sh.lengthMm != null ? `全長${sh.lengthMm}mm` : "",
    ]
      .filter(Boolean)
      .join(" ");
    parts.push(`シャフト: ${specs}`);
  }
  const fl = equipment.flight;
  if (fl?.maker || fl?.model || fl?.shape) {
    parts.push(
      `フライト: ${[fl.maker, fl.model, fl.shape].filter(Boolean).join(" ")}`
    );
  }
  const pt = equipment.point;
  if (pt?.maker || pt?.model || pt?.lengthMm != null) {
    const specs = [
      [pt.maker, pt.model].filter(Boolean).join(" "),
      pt.lengthMm != null ? `全長${pt.lengthMm}mm` : "",
    ]
      .filter(Boolean)
      .join(" ");
    parts.push(`ポイント: ${specs}`);
  }
  if (equipment.notes) {
    parts.push(`メモ: ${equipment.notes}`);
  }
  return parts.join(" / ");
}

function assessmentSection(assessments: readonly SelfAssessment[]): string {
  if (assessments.length === 0) return "記録なし\n";
  const lines: string[] = [
    "| タイミング | 疲労度 | 集中度 | 痛み | 自信度 | 投げる前の不安 | リリースの怖さ | ルーティン達成度 | 止まらず投げられた割合 | 止まる主なタイミング | 調子の変化 | メモ |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|",
  ];
  let hasUnanswered = false;
  for (const a of assessments) {
    // 既定値のまま送信された項目は「未回答」と明示する。値だけを出すと、
    // ユーザーが実際にその値を選んだ自己申告値とAIが区別できない。
    const untouched = new Set(a.untouchedScales ?? []);
    if (untouched.size > 0) hasUnanswered = true;
    const scale = (key: RequiredScaleKey, value: number) =>
      untouched.has(key) ? `${value}(未回答)` : String(value);
    lines.push(
      `| ${TIMING_LABELS[a.timing] ?? a.timing} | ${scale("fatigue", a.fatigue)} | ${scale("concentration", a.concentration)} | ${scale("pain", a.pain)} | ${scale("confidence", a.confidence)} | ${a.anxiety ?? NA} | ${a.releaseFear ?? NA} | ${a.routineAdherence ?? NA} | ${a.uninterruptedThrowRate != null ? `${a.uninterruptedThrowRate}%` : NA} | ${a.releaseStopTiming ? RELEASE_STOP_TIMING_LABELS[a.releaseStopTiming] ?? a.releaseStopTiming : NA} | ${a.conditionChange ? CHANGE_LABELS[a.conditionChange] : NA} | ${a.note ?? ""} |`
    );
  }
  lines.push("");
  lines.push("(各項目は0〜10の自己評価。0=まったくない/非常に低い、10=非常に強い/非常に高い。医学的評価ではない)");
  if (hasUnanswered) {
    lines.push(
      "(「(未回答)」付きの数値はユーザーが操作しなかった既定値です。測定された自己申告値として扱わず、その項目に基づく傾向・原因の断定や、他タイミングとの差分評価を行わないでください)"
    );
  }
  lines.push("(止まらず投げられた割合は命中率ではなく、一連の動作を完了できたと本人が感じた主観割合。旧セッションの欠損値はN/Aとして扱う)");
  lines.push("(メンタル・投擲プロセス評価は主観記録であり、心理的・医学的診断ではない。分析時は投擲データとの関連を仮説として扱うこと)");
  return lines.join("\n") + "\n";
}

function errorStatsBlock(
  title: string,
  stats: SessionStatistics["coordinateError"]
): string {
  const lines = [
    `#### ${title}`,
    "",
    `- サンプル数: ${stats.sampleCount}`,
    `- 平均誤差距離: ${fmtNum(stats.averageErrorDistance)}`,
    `- 中央値誤差距離: ${fmtNum(stats.medianErrorDistance)}`,
    `- 平均誤差X: ${fmtNum(stats.averageErrorX)}`,
    `- 平均誤差Y: ${fmtNum(stats.averageErrorY)}`,
    "",
  ];
  return lines.join("\n");
}

function statsSection(stats: SessionStatistics, session?: TrainingSession): string {
  const s = stats;
  const out: string[] = [];
  const overallScorable = s.scorableThrows ?? s.completedThrows;
  out.push("### 全体");
  out.push("");
  out.push(`- 総投擲数(予定): ${s.totalThrows}`);
  out.push(`- 完了投擲数: ${s.completedThrows}`);
  out.push(`- 命中判定対象投擲数: ${s.scorableThrows ?? s.completedThrows}`);
  out.push(`- グルーピング専用投擲数: ${s.groupingOnlyThrows ?? 0}`);
  out.push(`- 完全命中数: ${overallScorable > 0 ? s.exactHits : NA}`);
  out.push(`- 命中判定対象の完全命中率: ${overallScorable > 0 ? fmtRate(s.scorableExactHitRate ?? s.exactHitRate) : NA}`);
  out.push(`- 誤差距離サンプル数: ${s.errorSampleCount ?? s.combinedError.sampleCount}`);
  out.push(`- アウトボード数: ${s.outboardCount} (${fmtRate(s.outboardRate)})`);
  out.push(`- バウンスアウト数: ${s.bounceOutCount}`);
  out.push(`- 座標入力数: ${s.coordinateInputCount} / 簡易入力数: ${s.approximateInputCount}`);
  out.push("");
  if (s.grouping) {
    out.push("### グルーピング実測値");
    out.push("");
    out.push("(グルーピング径=セット内3投の全ペア距離の最大値、距離は外側ダブル半径=1.0の正規化座標。3投すべてに詳細座標があるセットのみ対象)");
    out.push("");
    if (s.grouping.status === "unavailable_non_coordinate") {
      out.push("- 分析不能: 有効な詳細座標3投セットがありません。");
    } else if (s.grouping.status === "insufficient_data") {
      out.push("- 分析不能: 詳細座標の有効な3投セットが不足しています。");
    } else {
      out.push(`- 有効セット数: ${s.grouping.validSetCount}`);
      out.push(`- 評価対象投擲数: ${s.grouping.groupingThrowCount ?? s.grouping.validSetCount * 3}`);
      out.push(`- 平均グルーピング径(セット内最大距離の平均): ${fmtNum(s.grouping.averageDiameter)}`);
      out.push(`- 中央値グルーピング径: ${fmtNum(s.grouping.medianDiameter)}`);
      out.push(`- 平均ペア距離: ${fmtNum(s.grouping.averagePairDistance)}`);
      out.push(`- 最大ペア距離: ${fmtNum(s.grouping.maximumPairDistance)}`);
      out.push(`- 中央値ペア距離: ${fmtNum(s.grouping.medianPairDistance)}`);
      out.push(`- 前半の平均グルーピング径: ${fmtNum(s.grouping.firstHalfAverageDiameter)} / 後半: ${fmtNum(s.grouping.secondHalfAverageDiameter)}`);
      out.push("  (前半・後半は、3投すべてに詳細座標がある有効セットだけをセット番号順に並べ、その有効セット列を半分に割った区間です。奇数のときは前半を1セット多くし、各区間はセット内最大距離(グルーピング径)の平均、対象0件ならN/A)");
      out.push(`- 投順間平均距離: 1→2投目 ${fmtNum(s.grouping.interDartDistances?.d1d2)} / 2→3投目 ${fmtNum(s.grouping.interDartDistances?.d2d3)} / 1→3投目 ${fmtNum(s.grouping.interDartDistances?.d1d3)}`);
      if ((s.grouping.perSet?.length ?? 0) > 0) {
        out.push("");
        out.push("| セット(実施順) | 3投間最大距離 | 3投間平均距離 |");
        out.push("|---:|---:|---:|");
        s.grouping.perSet?.forEach((row, index) => {
          out.push(`| ${index + 1} | ${fmtNum(row.maxPairDistance)} | ${fmtNum(row.averagePairDistance)} |`);
        });
      }
    }
    const reasonLabels: Record<string, string> = {
      no_valid_three_dart_coordinate_set: "有効な詳細座標3投セットがない",
      bounce_out: "バウンスアウト",
      outboard: "アウトボード",
      unknown_position: "位置不明",
      fewer_than_three_throws: "3投未満",
      segment_approximation: "segment_approximationを含む",
    };
    for (const reason of s.grouping.unavailableReasons ?? []) {
      out.push(`- 分析不能理由: ${reasonLabels[reason] ?? reason}`);
    }
    out.push("");
  }
  out.push(errorStatsBlock("詳細座標入力による誤差統計", s.coordinateError));
  out.push(
    errorStatsBlock("簡易入力(概算)を含む誤差統計 ※簡易入力の座標はエリア代表点による概算値", s.combinedError)
  );
  out.push("### 1投目・2投目・3投目");
  out.push("");
  out.push("| 投順 | 総投擲数 | 命中判定対象数(命中率の分母) | 命中数 | 命中率 | 平均誤差距離 | アウトボード率 |");
  out.push("|---|---:|---:|---:|---:|---:|---:|");
  for (const order of ["1", "2", "3"] as const) {
    const d = s.byDartInSet[order];
    const scorable = d.scorableThrows ?? d.throwCount;
    out.push(
      `| ${order}投目 | ${d.throwCount} | ${scorable} | ${scorable > 0 ? d.hitCount : NA} | ${scorable > 0 ? fmtRate(d.hitRate) : NA} | ${fmtNum(d.averageErrorDistance)} | ${fmtRate(d.outboardRate)} |`
    );
  }
  out.push("");
  out.push("### ターゲット別");
  out.push("");
  out.push("| ターゲット | 総出題数 | 命中判定対象数(命中率の分母) | 命中数 | 命中率 | 平均誤差距離 | 主な外れ方向 | アウトボード数 |");
  out.push("|---|---:|---:|---:|---:|---:|---|---:|");
  for (const label of Object.keys(s.byTarget).sort()) {
    const g = s.byTarget[label];
    if (!g) continue;
    const scorable = g.scorableThrows ?? g.throwCount;
    out.push(
      `| ${label} | ${g.throwCount} | ${scorable} | ${scorable > 0 ? g.hitCount : NA} | ${scorable > 0 ? fmtRate(g.hitRate) : NA} | ${fmtNum(g.averageErrorDistance)} | ${directionLabel(g.mainMissDirection)} | ${g.outboardCount} |`
    );
  }
  out.push("");
  out.push("### 外れ方向");
  out.push("");
  out.push("| 方向 | 回数 |");
  out.push("|---|---:|");
  for (const dir of ALL_DIRECTIONS) {
    out.push(`| ${directionLabel(dir)} | ${s.byDirection[dir]} |`);
  }
  out.push("");
  out.push("### 前半・後半");
  out.push("");
  out.push("| 区間 | 総投擲数 | 命中判定対象数(命中率の分母) | 命中率 | 平均誤差距離 | アウトボード率 |");
  out.push("|---|---:|---:|---:|---:|---:|");
  out.push(
    `| 前半 | ${s.firstHalf.throwCount} | ${s.firstHalf.scorableThrows ?? s.firstHalf.throwCount} | ${(s.firstHalf.scorableThrows ?? s.firstHalf.throwCount) > 0 ? fmtRate(s.firstHalf.hitRate) : NA} | ${fmtNum(s.firstHalf.averageErrorDistance)} | ${fmtRate(s.firstHalf.outboardRate)} |`
  );
  out.push(
    `| 後半 | ${s.secondHalf.throwCount} | ${s.secondHalf.scorableThrows ?? s.secondHalf.throwCount} | ${(s.secondHalf.scorableThrows ?? s.secondHalf.throwCount) > 0 ? fmtRate(s.secondHalf.hitRate) : NA} | ${fmtNum(s.secondHalf.averageErrorDistance)} | ${fmtRate(s.secondHalf.outboardRate)} |`
  );
  out.push("");
  if (s.cricket) {
    const c = s.cricket;
    out.push("### クリケット統計(マーク換算: T=3, D=2, S=1, インナーブル=2, アウターブル=1)");
    out.push("");
    out.push(`- 総マーク数: ${c.totalMarks}`);
    out.push(`- 3投あたり平均マーク: ${fmtNum(c.marksPerThreeDarts, 2)}`);
    out.push(`- 有効マーク率(1マーク以上の投擲): ${fmtRate(c.effectiveMarkRate)}`);
    out.push(`- ノーマーク率: ${fmtRate(c.noMarkRate)}`);
    out.push("");
    out.push("| ターゲット | 投擲数 | 総マーク | 3投あたり平均マーク | 有効マーク率 | ノーマーク率 |");
    out.push("|---|---:|---:|---:|---:|---:|");
    for (const label of Object.keys(c.byTarget).sort()) {
      const g = c.byTarget[label];
      if (!g) continue;
      out.push(
        `| ${label} | ${g.throwCount} | ${g.totalMarks} | ${fmtNum(g.marksPerThreeDarts, 2)} | ${fmtRate(g.effectiveMarkRate)} | ${fmtRate(g.noMarkRate)} |`
      );
    }
    out.push("");
    out.push("#### セット内の同一ターゲット継続・切替直後");
    out.push("");
    out.push("| 条件 | 投擲数 | 総マーク | 1投平均マーク | ノーマーク率 | 測定状態 |");
    out.push("|---|---:|---:|---:|---:|---|");
    const continuity = c.continuity;
    for (const [label, g] of [
      ["同一ターゲット継続", continuity?.sameTarget],
      ["セット内切替直後", continuity?.afterSwitch],
    ] as const) {
      const measured = g != null && g.throwCount > 0;
      out.push(`| ${label} | ${g?.throwCount ?? 0} | ${g?.totalMarks ?? 0} | ${measured ? fmtNum(g?.marksPerDart, 2) : NA} | ${measured ? fmtRate(g?.noMarkRate) : NA} | ${measured ? "測定済み" : "未測定・分析不能"} |`);
    }
    out.push("");
  }
  if (s.zeroOne) {
    const z = s.zeroOne;
    out.push("### 01統計");
    out.push("");
    if (z.bullThrowCount > 0)
      out.push(`- Bull命中率: ${fmtRate(z.bullHitRate)} (${z.bullThrowCount}投)`);
    if (z.tripleThrowCount > 0)
      out.push(`- トリプル命中率: ${fmtRate(z.tripleHitRate)} (${z.tripleThrowCount}投)`);
    if (z.doubleThrowCount > 0)
      out.push(`- ダブル命中率: ${fmtRate(z.doubleHitRate)} (${z.doubleThrowCount}投)`);
    if (z.allHitSetRate != null)
      out.push(
        session?.arrangement === "fixed_three"
          ? `- フィニッシュ成立率(3投すべて命中したセット率): ${fmtRate(z.allHitSetRate)}`
          : `- 3投すべてターゲットに命中したセット率: ${fmtRate(z.allHitSetRate)}(同一ターゲット反復のためチェックアウト成立率ではない)`
      );
    out.push("");
  }
  out.push("### アウトボードとバウンスアウト");
  out.push("");
  out.push(`- アウトボード: ${s.outboardCount}回 (${fmtRate(s.outboardRate)})`);
  out.push(`- バウンスアウト: ${s.bounceOutCount}回 (着弾位置不明として記録)`);
  out.push("");
  return out.join("\n");
}

function skillDoubleStatsSection(throws: readonly ThrowRecord[]): string {
  const effectivePatterns = effectiveR4PatternMetadata(throws);
  const r4 = throws.flatMap((record) => {
    const pattern = effectivePatterns.get(record.setId);
    return pattern ? [{ record, pattern }] : [];
  });
  if (r4.length === 0) return "";
  const recordedCount = r4.filter(({ pattern }) =>
    pattern.source === "recorded"
  ).length;
  const inferredCount = r4.length - recordedCount;
  const out = [
    "### R4ダブル・パターン集計",
    "",
    `- 記録済みパターンメタデータ: ${recordedCount}投`,
    `- 観測ターゲット列からの旧データ補完: ${inferredCount}投`,
  ];
  if (inferredCount > 0) {
    out.push(
      "- ⚠️ inferred_from_observed_targets は実際のセット内ターゲット順だけからfixed/switch等を補完した値です。新標準R4の未実施パターンを測定済みとは扱わないでください。"
    );
  }
  out.push(
    "",
    "| 集計単位 | 種別 | 投擲数 | 命中数 | 命中率 | セット内切替直後投擲数 |",
    "|---|---|---:|---:|---:|---:|",
  );
  type R4Entry = { record: ThrowRecord; pattern: EffectivePatternMetadata };
  const groups = new Map<string, R4Entry[]>();
  for (const entry of r4) {
    const key = entry.pattern.patternId;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  const append = (label: string, entries: R4Entry[]) => {
    const hits = entries.filter(({ record }) => record.derived.exactHit).length;
    const switched = entries.filter(
      ({ record }) =>
        record.derived.sameSetAsPrevious === true &&
        record.derived.targetChangedFromPrevious
    ).length;
    out.push(
      `| ${label} | ${entries[0]?.pattern.patternKind ?? NA} | ${entries.length} | ${hits} | ${fmtRate(hits / entries.length)} | ${switched} |`
    );
  };
  for (const [patternId, entries] of groups) append(patternId, entries);
  for (const kind of ["fixed", "switch"] as const) {
    const entries = r4.filter(({ pattern }) => pattern.patternKind === kind);
    if (entries.length > 0) append(`${kind}全体`, entries);
  }
  const categories = new Map<string, R4Entry[]>();
  for (const entry of r4) {
    const group = categories.get(entry.pattern.analysisCategory) ?? [];
    group.push(entry);
    categories.set(entry.pattern.analysisCategory, group);
  }
  for (const [category, entries] of categories) append(`category:${category}`, entries);
  out.push("");
  for (const kind of ["fixed", "switch"] as const) {
    if (!r4.some(({ pattern }) => pattern.patternKind === kind)) {
      out.push(`- ${kind}パターン: 未測定（分析不能）`);
    }
  }
  out.push("個別ダブルの投擲数が少ない場合は得意・不得意と断定せず、fixed/switch、20系、16系、位置分散、ボード位置、ミス方向でまとめてください。");
  out.push("");
  return out.join("\n");
}

function throwTable(
  throws: readonly ThrowRecord[],
  setNumberOf: (setId: string) => number | undefined
): string {
  const out: string[] = [];
  out.push(
    "| No. | セット | 投順 | 狙い | 着弾 | 命中 | X | Y | 誤差X | 誤差Y | 誤差距離 | ズレ方向 | 入力精度 | evaluation_kind | round_id | round_kind | pattern_id | pattern_kind | analysis_category | pattern_metadata_source | same_set_as_previous | previous_throw_was_hit_in_same_set | same_target_as_previous | ターゲット変更 | 矢速(km/h) | 経過時間 | メモ |"
  );
  out.push(
    "|---:|---:|---:|---|---|---|---:|---:|---:|---:|---:|---|---|---|---|---|---|---|---|---|---|---|---|---|---:|---:|---|"
  );
  const sorted = throws
    .slice()
    .sort((a, b) => a.globalThrowNumber - b.globalThrowNumber);
  const effectivePatterns = effectiveR4PatternMetadata(sorted);
  for (const th of sorted) {
    const pattern = effectivePatterns.get(th.setId);
    const approx =
      th.landing.positionPrecision === "segment_approximation" ? "≈" : "";
    const num = (v: number | undefined) =>
      v == null ? NA : `${approx}${fmtNum(v)}`;
    const precisionLabel =
      th.landing.positionPrecision === "coordinate"
        ? "座標"
        : th.landing.positionPrecision === "segment_approximation"
          ? "概算"
          : th.landing.positionPrecision === "direction_only"
            ? "方向のみ"
            : "不明";
    const groupingOnly = isGroupingOnlyTarget(th.target);
    const sameSet = th.derived.sameSetAsPrevious === true;
    const boolMark = (value: boolean | undefined) =>
      value == null ? NA : value ? "○" : "×";
    const cells = [
        th.globalThrowNumber,
        setNumberOf(th.setId) ?? NA,
        th.dartInSet,
        th.target.label,
        landingLabel(th),
        groupingOnly ? NA : th.derived.exactHit ? "○" : "×",
        num(th.landing.x),
        num(th.landing.y),
        num(th.derived.errorX),
        num(th.derived.errorY),
        num(th.derived.errorDistance),
        directionLabel(th.derived.missDirection),
        precisionLabel,
        th.target.evaluationKind ?? NA,
        th.target.roundId ?? NA,
        th.target.roundKind ?? NA,
        pattern?.patternId ?? th.target.patternId ?? NA,
        pattern?.patternKind ?? th.target.patternKind ?? NA,
        pattern?.analysisCategory ?? th.target.analysisCategory ?? NA,
        pattern?.source ?? NA,
        sameSet ? "true" : "false",
        sameSet && !groupingOnly
          ? boolMark(th.derived.previousThrowWasHitInSameSet)
          : NA,
        sameSet ? boolMark(th.derived.sameTargetAsPrevious) : NA,
        sameSet
          ? th.derived.targetChangedFromPrevious
            ? "あり"
            : "なし"
          : NA,
        th.speedKmh != null ? th.speedKmh.toFixed(1) : NA,
        fmtElapsed(th.elapsedMs),
        th.note ?? "",
      ];
    out.push(`| ${cells.join(" | ")} |`);
  }
  out.push("");
  out.push("(座標は外側ダブル半径=1.0の正規化値。≈は簡易入力による概算値。X:右が正 / Y:上が正。矢速は任意入力のため未記録はN/A)");
  return out.join("\n");
}

export interface MarkdownInput {
  session: TrainingSession;
  player: PlayerProfile | undefined;
  equipment: EquipmentProfile | undefined;
  stats: SessionStatistics;
  throws: readonly ThrowRecord[];
  setNumberOf: (setId: string) => number | undefined;
  comparisons: {
    session: TrainingSession;
    stats: SessionStatistics;
  }[];
  /** 長期トレンド用: 同モードの過去セッション(古い順) */
  recentSessions?: {
    session: TrainingSession;
    stats: SessionStatistics;
  }[];
  /** 全データ埋め込み(true) or 集計+CSV別添(false) */
  embedAllThrows: boolean;
}

function comparisonSection(input: MarkdownInput): string {
  if (input.comparisons.length === 0) {
    return "比較対象セッションなし\n";
  }
  const out: string[] = [];
  for (const cmp of input.comparisons) {
    const c = compareStatistics(input.stats, cmp.stats);
    out.push(
      `### 比較対象: ${fmtDateTime(cmp.session.startedAt)} (${modeLabel(cmp.session.trainingMode)}, ${cmp.session.boardType === "steel" ? "スティール" : "ソフト"}${cmp.session.scoringStyle ? `, ${scoringStyleLabel(cmp.session.scoringStyle)}` : ""})`
    );
    out.push("");
    out.push(`- 完全命中率: 今回 ${fmtRate(c.hitRate.base)} / 過去 ${fmtRate(c.hitRate.other)} / 差 ${fmtRateDiff(c.hitRate.diff)}`);
    out.push(
      `- 平均誤差距離: 今回 ${fmtNum(c.averageErrorDistance.base)} / 過去 ${fmtNum(c.averageErrorDistance.other)} / 差 ${fmtNumDiff(c.averageErrorDistance.diff)}`
    );
    out.push("");
    out.push("| 投順 | 命中率(今回) | 命中率(過去) | 差 |");
    out.push("|---|---:|---:|---:|");
    for (const order of ["1", "2", "3"] as const) {
      const d = c.byDartInSet[order];
      out.push(
        `| ${order}投目 | ${fmtRate(d.hitRate.base)} | ${fmtRate(d.hitRate.other)} | ${fmtRateDiff(d.hitRate.diff)} |`
      );
    }
    out.push("");
    out.push(
      `- 前半命中率の差: ${fmtRateDiff(c.firstHalfHitRate.diff)} / 後半命中率の差: ${fmtRateDiff(c.secondHalfHitRate.diff)}`
    );
    const beforeBase = input.session.assessments.find((a) => a.timing === "before");
    const beforeOther = cmp.session.assessments.find((a) => a.timing === "before");
    if (beforeBase && beforeOther) {
      out.push(
        `- 開始前自己評価の差(今回-過去): 疲労度 ${fmtNumDiff(beforeBase.fatigue - beforeOther.fatigue, 0)} / 集中度 ${fmtNumDiff(beforeBase.concentration - beforeOther.concentration, 0)} / 痛み ${fmtNumDiff(beforeBase.pain - beforeOther.pain, 0)} / 自信度 ${fmtNumDiff(beforeBase.confidence - beforeOther.confidence, 0)}`
      );
    }
    out.push("");
  }
  return out.join("\n");
}

/**
 * 自己申告レーティングを、AIが具体的に扱える参照(PPD・MPRの目安と目標ギャップ)へ変換する。
 * これは判定ではなく、非公式の対応表に基づく参考値であることを明記する。
 */
function ratingReferenceLines(
  current: PlayerRating | undefined,
  target: PlayerRating | undefined
): string[] {
  if (!current && !target) return [];
  const out: string[] = [];
  const describe = (label: string, r: PlayerRating): string | undefined => {
    const row = ratingRowOf(r);
    if (!row) return `- ${label}: ${formatRating(r)}`;
    const cls = row.className ? ` / クラス ${row.className}` : "";
    return `- ${label}: ${formatRating(r)}(目安 PPD ${row.ppd.toFixed(2)}以上・MPR ${row.mpr.toFixed(2)}以上${cls})`;
  };
  if (current) {
    const line = describe("現在レーティング", current);
    if (line) out.push(line);
  }
  if (target) {
    const line = describe("目標レーティング", target);
    if (line) out.push(line);
  }
  // 同一体系で現在<目標なら、目標到達に必要なPPD・MPRの上げ幅を明示する
  if (
    current &&
    target &&
    current.system === target.system &&
    target.value > current.value
  ) {
    const cur = ratingRowOf(current);
    const tgt = ratingRowOf(target);
    if (cur && tgt) {
      out.push(
        `- 目標までの目安ギャップ(${RATING_SYSTEM_LABELS[current.system]} Rt${current.value}→Rt${target.value}): 01のPPDを約+${(tgt.ppd - cur.ppd).toFixed(2)}、クリケットのMPRを約+${(tgt.mpr - cur.mpr).toFixed(2)}`
      );
    }
  }
  out.push(
    "- ※レーティングの目安値(PPD・MPR)は非公式の対応表による参考値であり、公式の算出方式とは異なります。断定に使わず、目標との距離感の把握に用いてください。実戦のPPD・MPRは試合データがなければ算出できないため、練習データからは近い指標(クリケットのマーク換算=MPR相当等)で傾向を述べてください。"
  );
  return out;
}

/** AI分析依頼Markdown全体を生成する */
export function buildAnalysisMarkdown(input: MarkdownInput): string {
  const { session, stats } = input;
  const snapshot = session.contextSnapshot;
  const player = snapshot
    ? {
        displayName: snapshot.displayName,
        dominantEye: snapshot.dominantEye,
        stance: snapshot.stance,
        form: snapshot.form,
        goal: snapshot.goal,
        currentLevel: snapshot.currentLevel,
        targetLevel: snapshot.targetLevel,
        levelNote: snapshot.levelNote,
        currentRating: snapshot.currentRating,
        targetRating: snapshot.targetRating,
        concern: snapshot.concern,
      }
    : input.player;
  // A snapshot with no equipment means "none selected at session start";
  // never substitute equipment edited/selected later.
  const equipment = snapshot ? snapshot.equipmentSnapshot : input.equipment;
  const out: string[] = [];
  out.push("# ダーツ投擲データ分析依頼");
  out.push("");
  out.push("## AIへの分析指示");
  out.push("");
  out.push(ANALYSIS_PERSONA);
  out.push("");
  out.push(ANALYSIS_INSTRUCTIONS);
  out.push("");
  out.push(inputPrecisionSection(inputPrecisionModeOf(stats, session), stats, session));
  out.push("");
  const focusCategory = focusCategoryOf(session);
  if (focusCategory === "skill") {
    out.push(skillFocusSection(session.scoringStyle));
    out.push("");
  } else if (focusCategory) {
    out.push(FOCUS_SECTIONS[focusCategory]);
    out.push("");
  }
  const goalSection = player?.goal ? GOAL_SECTIONS[player.goal] : undefined;
  if (goalSection) {
    out.push(goalSection);
    out.push("");
  }
  out.push("## セッション概要");
  out.push("");
  // 中断セッションは予定投擲数と完了投擲数を最初に明示する
  if (session.status === "completed") {
    out.push(`- セッション状態: 完了(予定${session.plannedThrowCount}投中${stats.completedThrows}投を実施)`);
  } else {
    out.push(`- ⚠️ セッション状態: 中断(予定${session.plannedThrowCount}投中${stats.completedThrows}投で中断)。完了分のデータだけで分析し、標本の少なさを確からしさへ反映してください`);
  }
  if (!snapshot) {
    out.push("- ⚠️ このセッションには開始時プロフィールのスナップショットがなく、現在プロフィールを参照している");
  }
  out.push(`- セッションID: ${session.id}`);
  out.push(`- 実施日時: ${fmtDateTime(session.startedAt)}${session.endedAt ? ` 〜 ${fmtDateTime(session.endedAt)}` : ""}`);
  out.push(
    `- 練習モード: ${modeLabel(session.trainingMode)}${session.arrangement ? ` (出題方式: ${ARRANGEMENT_LABELS[session.arrangement] ?? session.arrangement})` : ""}`
  );
  out.push(`- ボード種別: ${session.boardType === "steel" ? "スティール" : "ソフト"}`);
  if (session.scoringStyle) {
    out.push(`- スコアリング形式: ${scoringStyleLabel(session.scoringStyle)}`);
  }
  out.push(`- セット数: ${session.setCount} (1セット3投)`);
  out.push(`- 総投擲数(予定): ${session.plannedThrowCount}`);
  out.push(`- セッティング: ${equipmentSummary(equipment)}`);
  const dominantHand = snapshot?.dominantHand ?? session.dominantHand;
  out.push(`- 利き腕: ${HAND_LABELS[dominantHand] ?? dominantHand}`);
  if (player?.dominantEye) {
    out.push(`- 利き目: ${EYE_LABELS[player.dominantEye] ?? player.dominantEye}`);
  }
  if (player?.stance) {
    out.push(`- スタンス: ${STANCE_LABELS[player.stance] ?? player.stance}`);
  }
  if (player?.form) {
    out.push("- フォーム情報（任意・自己申告。原因確定には使用しない）:");
    if (player.form.gripFingerCount)
      out.push(`  - グリップ本数: ${GRIP_FINGER_LABELS[player.form.gripFingerCount] ?? player.form.gripFingerCount}`);
    if (player.form.gripPosition)
      out.push(`  - グリップ位置: ${GRIP_POSITION_LABELS[player.form.gripPosition] ?? player.form.gripPosition}`);
    if (player.form.takeback)
      out.push(`  - テイクバック: ${TAKEBACK_LABELS[player.form.takeback] ?? player.form.takeback}`);
    if (player.form.throwingTempo)
      out.push(`  - 投擲テンポ: ${TEMPO_LABELS[player.form.throwingTempo] ?? player.form.throwingTempo}`);
    if (player.form.concern) out.push(`  - 主なフォーム上の悩み: ${player.form.concern}`);
  }
  const inputMethod = snapshot?.inputMethod ?? session.inputMethod;
  out.push(`- 入力方式: ${INPUT_LABELS[inputMethod] ?? inputMethod}`);
  out.push(`- 今日の調子: ${CONDITION_LABELS[session.dailyCondition] ?? session.dailyCondition}${session.dailyConditionNote ? ` (${session.dailyConditionNote})` : ""}`);
  if (player) out.push(`- プレイヤー: ${player.displayName}`);
  out.push("");
  const ratingLines = ratingReferenceLines(
    player?.currentRating,
    player?.targetRating
  );
  if (
    player &&
    (player.goal ||
      player.levelNote ||
      player.currentLevel ||
      player.targetLevel ||
      player.concern ||
      ratingLines.length > 0)
  ) {
    out.push("## ユーザーの目的・背景");
    out.push("");
    if (player.goal)
      out.push(`- 目的: ${GOAL_LABELS[player.goal] ?? player.goal}`);
    // levelNote(後継)があればそれを、なければ旧 currentLevel / targetLevel を出力する。
    if (player.levelNote) {
      out.push(`- 実力・目標メモ: ${player.levelNote}`);
    } else {
      if (player.currentLevel) out.push(`- 現在のレベル(自己申告): ${player.currentLevel}`);
      if (player.targetLevel) out.push(`- 目標レベル: ${player.targetLevel}`);
    }
    for (const line of ratingLines) out.push(line);
    if (player.concern) out.push(`- 主な悩み・重点課題: ${player.concern}`);
    out.push("");
    out.push("回答は、この目的と悩みに直接応える形で優先順位をつけてください。一般論よりも、この目的に対する具体的な示唆を優先してください。");
    out.push("");
  }
  out.push("## 環境情報");
  out.push("");
  const env = session.environment;
  if (
    env &&
    (env.location || env.boardName || env.lighting || env.temperatureC != null || env.ocheNote || env.formChangeNote || env.gripChangeNote || env.stanceChangeNote || env.otherNote)
  ) {
    if (env.location) out.push(`- 練習場所: ${env.location}`);
    if (env.boardName) out.push(`- ボード名称: ${env.boardName}`);
    if (env.lighting) out.push(`- 照明: ${env.lighting}`);
    if (env.temperatureC != null) out.push(`- 室温: ${env.temperatureC}℃`);
    if (env.ocheNote) out.push(`- スローライン環境: ${env.ocheNote}`);
    if (env.formChangeNote) out.push(`- フォーム変更: ${env.formChangeNote}`);
    if (env.gripChangeNote) out.push(`- グリップ変更: ${env.gripChangeNote}`);
    if (env.stanceChangeNote) out.push(`- 立ち位置変更: ${env.stanceChangeNote}`);
    if (env.otherNote) out.push(`- その他: ${env.otherNote}`);
  } else {
    out.push("記録なし");
  }
  out.push("");
  out.push("## 開始前・中間・終了後の自己評価");
  out.push("");
  out.push(assessmentSection(session.assessments));
  out.push("");
  out.push("## アプリ算出の基本統計");
  out.push("");
  out.push(statsSection(stats, session));
  out.push(skillDoubleStatsSection(input.throws));
  out.push("## 過去セッションとの比較");
  out.push("");
  out.push(comparisonSection(input));
  if (input.recentSessions && input.recentSessions.length > 0) {
    out.push("## 長期トレンド(同モードの直近セッション・古い順)");
    out.push("");
    out.push("| 日時 | 完了投擲数 | 完全命中率 | 平均誤差距離 | 3投あたり平均マーク |");
    out.push("|---|---:|---:|---:|---:|");
    for (const r of input.recentSessions) {
      out.push(
        `| ${fmtDateTime(r.session.startedAt)} | ${r.stats.completedThrows} | ${fmtRate(r.stats.exactHitRate)} | ${fmtNum(r.stats.combinedError.averageErrorDistance)} | ${r.stats.cricket ? fmtNum(r.stats.cricket.marksPerThreeDarts, 2) : NA} |`
      );
    }
    out.push(
      `| 今回 (${fmtDateTime(session.startedAt)}) | ${stats.completedThrows} | ${fmtRate(stats.exactHitRate)} | ${fmtNum(stats.combinedError.averageErrorDistance)} | ${stats.cricket ? fmtNum(stats.cricket.marksPerThreeDarts, 2) : NA} |`
    );
    out.push("");
    out.push("このトレンドから、改善中/停滞/悪化している指標を特定し、時系列の傾向として分析してください。");
    out.push("");
  }
  out.push("## 全投擲データ");
  out.push("");
  if (input.embedAllThrows) {
    out.push(throwTable(input.throws, input.setNumberOf));
  } else {
    out.push("全投擲データは添付のCSVファイルを参照してください。");
    out.push("");
    out.push("CSVの列: session_id, session_date, training_mode, board_type, scoring_style, set_number, global_throw_number, dart_in_set, dart_color, target_label, target_number, target_ring, landing_number, landing_ring, exact_hit, landing_x, landing_y, error_x, error_y, error_distance, miss_direction, position_precision, evaluation_kind, round_id, round_kind, pattern_id, pattern_kind, analysis_category, previous_throw_was_hit, same_set_as_previous, previous_throw_was_hit_in_same_set, same_target_as_previous, target_changed, speed_kmh, elapsed_ms, session_progress, throw_note");
  }
  out.push("");
  out.push("## セッションメモ");
  out.push("");
  out.push(session.sessionNote ? session.sessionNote : "記録なし");
  out.push("");
  out.push("## データ利用上の注意");
  out.push("");
  out.push("- 座標は外側ダブル外周の半径を1.0とする正規化値です(右が+X、上が+Y、20方向が角度0度で時計回り)。");
  out.push("- 入力精度が「概算」(segment_approximation)の投擲は、実際の着弾座標ではなく選択エリアの代表点(幾何学的中心)を使用しています。ズレ方向・誤差距離は概算値として扱ってください。");
  out.push("- バウンスアウトは着弾位置不明です。");
  out.push("- 矢速(speed_kmh)は任意入力です。未記録の投擲が多くても異常ではなく、記録がある投擲だけで傾向を評価してください。");
  out.push("- 自己評価(疲労度・痛み等)は主観的な記録であり、医学的評価ではありません。");
  out.push("- このデータは個人のトレーニング記録です。分析は運動学習の参考情報であり、医学的診断を行わないでください。");
  out.push("");
  out.push(OUTPUT_FORMAT_INSTRUCTIONS);
  out.push("");
  return out.join("\n");
}
