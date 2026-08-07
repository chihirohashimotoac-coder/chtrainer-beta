/**
 * ローカルコーチ分析の閾値を一元管理する。
 *
 * ここに集約する理由:
 *  - 判定基準をコード全体へ散らすと、同じ「10投未満は断定しない」規則が
 *    ルールごとにずれて、根拠の追跡ができなくなるため。
 *  - 閾値を変更したときは ENGINE_VERSION を必ず更新する（過去の出力と
 *    現在の出力の差が、データ差なのかルール差なのか判別できなくなるため）。
 */

/**
 * 分析エンジンのバージョン。判定ルール・閾値・出力構造を変えたら更新する。
 * 分析結果はIndexedDBへ保存せず毎回再計算するため、この版数は
 * 「そのMarkdownを生成した時点のルール」を示す唯一の手掛かりになる。
 */
export const ENGINE_VERSION = "local-coach-v3.0";

/**
 * 傾向を語ってよい最小サンプル数。
 * これ未満の該当サンプルでは、差が大きく見えても所見にしない
 * （3投中2投の差が66.7ptに見える、といった読み違いを防ぐ）。
 */
export const MIN_ANALYZABLE_SAMPLE = 10;

/**
 * 確からしさ「高」を許可する最小サンプル数。
 * これを満たしても、裏付け条件が1つだけなら「高」にはしない
 * （MIN_CORROBORATING_CONDITIONS_FOR_HIGH を参照）。
 */
export const MIN_HIGH_CONFIDENCE_SAMPLE = 30;

/**
 * 確からしさ「高」に必要な、独立した裏付け条件の数。
 * 例: 「3投目の横ばらつき増大」が、投順別SDと過去セッション比較の
 * 2系統で同じ向きに出ている場合に2となる。1系統だけなら最大「中」。
 */
export const MIN_CORROBORATING_CONDITIONS_FOR_HIGH = 2;

/**
 * 完了率がこれを下回る中断セッションでは、確からしさを1段階下げる。
 * 予定の半分も投げていないセッションは、疲労・集中の時間変化を
 * 通常セッションと同じ重みで扱えないため。
 */
export const LOW_COMPLETION_RATIO = 0.5;

/** 比較対象として採用する、条件が一致する過去セッションの上限数。 */
export const MAX_COMPARISON_SESSIONS = 5;

/**
 * 比較対象として採用する過去セッションの最小完了投擲数。
 * これ未満のセッションは平均値が不安定なため基準線に使わない。
 */
export const MIN_COMPARISON_SESSION_THROWS = MIN_ANALYZABLE_SAMPLE;

/**
 * 命中率の差を「傾向」として扱う最小の差（絶対値・ポイント）。
 * 0.10 = 10ポイント。これ未満は誤差の範囲として所見にしない。
 */
export const HIT_RATE_DIFF_THRESHOLD = 0.1;

/**
 * 誤差距離・ばらつきの差を「傾向」として扱う最小の相対差。
 * 0.3 = 基準より30%大きい/小さい。正規化座標の絶対差ではなく
 * 相対差で見るのは、ボード種別・ターゲットで基準値の大きさが変わるため。
 */
export const RELATIVE_DIFF_THRESHOLD = 0.3;

/**
 * 相対差を意味のある差として扱うための、値そのものの下限（正規化座標）。
 *
 * 相対差だけで判定すると、ほぼ同一の着弾（標準偏差がほぼ0）でも
 * 浮動小数点の丸め誤差が「+100%の悪化」に見えてしまう。
 * 0.01 は外側ダブル半径=1.0 に対する比率で、スティール約1.7mm /
 * ソフト約2.0mm 相当。入力の分解能として意味を持たない差を
 * 傾向として扱わないための下限とする。
 */
export const MIN_MEANINGFUL_DISTANCE = 0.01;

/**
 * グルーピング径の差を「傾向」として扱う最小の相対差。
 * グルーピングは投擲ごとのノイズが平均化されるため、
 * 誤差距離(RELATIVE_DIFF_THRESHOLD)より小さい差でも意味を持つ。
 */
export const GROUPING_RELATIVE_DIFF_THRESHOLD = 0.15;

/** グルーピングを所見に使う最小の有効セット数（3投すべて詳細座標のセット）。 */
export const MIN_GROUPING_SETS = 5;

/**
 * 平均位置の「偏り」と判定する最小の平均誤差（正規化座標）。
 * 外側ダブル半径=1.0。0.06 ≒ スティール10mm / ソフト12mm 相当。
 */
export const BIAS_MEAN_THRESHOLD = 0.06;

/**
 * 「偏り」と「再現性不足」を区別する比率。
 * |平均| >= BIAS_MEAN_TO_SD_RATIO × 標準偏差 なら、散らばりではなく
 * 片側への偏りとして扱う。逆に平均が0付近で標準偏差が大きい場合は
 * 「偏り」ではなく「再現性不足」と記述する（両者を混同しない）。
 */
export const BIAS_MEAN_TO_SD_RATIO = 0.5;

/**
 * 「再現性不足」と判定する最小の標準偏差（正規化座標）。
 * 0.12 ≒ スティール20mm / ソフト24mm 相当のばらつき。
 */
export const DISPERSION_SD_THRESHOLD = 0.12;

/**
 * 簡易入力で外れ方向の偏りとみなす最小の頻度比。
 * 簡易入力の座標はエリア代表点の概算値なので、ミリ単位の平均ではなく
 * 「どの方向へ外れたか」の頻度分布だけを根拠にする。
 */
export const DIRECTION_BIAS_RATIO_THRESHOLD = 0.4;

/**
 * 区間推定に使う分位点（1.96 = 95%区間）。
 * 出力では「95%区間」とだけ呼び、「有意」という語は使わない
 * （多数の指標を同時に見ているため、単独の区間で有意性は主張できない）。
 */
export const CONFIDENCE_INTERVAL_Z = 1.96;

/**
 * ばらつきの比を「差がある」と扱う最小の対数比。
 * log(1.3) ≒ 0.262。標準偏差が1.3倍を超えたときに検討対象とする。
 */
export const LOG_SD_RATIO_THRESHOLD = Math.log(1.3);

/** ターゲット別の弱点・強みを扱う最小の命中判定対象数。 */
export const MIN_TARGET_SAMPLE = MIN_ANALYZABLE_SAMPLE;

/**
 * 投擲テンポ（同一セット内の投擲間隔）の変化を扱う最小の相対差。
 * 個々の間隔は中断・休憩で大きく振れるため、平均ではなく中央値で比較する。
 */
export const TEMPO_RELATIVE_DIFF_THRESHOLD = 0.25;

/**
 * 長期トレンドを「一貫した方向」と扱うための最小セッション数（今回を含む）。
 * 4点が偶然に単調へ並ぶ確率は約1/12。これ未満では方向を語らない。
 */
export const MIN_TREND_SESSIONS = 4;

/**
 * 優先度付けに使う、効果量の正規化基準。
 * 「これだけ差があれば大きい」とみなす値で、0〜1へ丸める分母になる。
 */
export const EFFECT_SCALE_RATE = 0.3;        // 命中率などの率の差(30ポイント)
export const EFFECT_SCALE_RELATIVE = 1.0;    // 相対差(100%)
export const EFFECT_SCALE_MARKS = 1.0;       // 1投あたりマーク数の差

/** 確からしさごとの重み。効果量と掛け合わせて課題の順位を決める。 */
export const CONFIDENCE_WEIGHTS = {
  high: 1,
  medium: 0.7,
  low: 0.4,
} as const;

/**
 * 個人基準（本人の過去中央値・変動幅）を作るために必要な最小セッション数。
 * 2件では中央値も変動幅も1点の外れ値で動くため、3件を下限とする。
 * これを満たさない場合は基準を捏造せず N/A とする。
 */
export const MIN_PERSONAL_BASELINE_SESSIONS = 3;

/**
 * 1つの候補につき生成する原因仮説の上限。
 * 候補を多く並べるほど外部AIが検証しきれず、
 * 「もっともらしい候補の羅列」になるため2件に絞る。
 */
export const MAX_HYPOTHESES_PER_CANDIDATE = 2;

/**
 * 分析不能時のローカルコーチ節の文字数上限。
 * 判定できないときに長い仮説や定型の身体原因リストを繰り返すと、
 * 情報量ゼロのまま依頼文だけが膨らむため、通常時より強く絞る。
 */
export const MAX_INSUFFICIENT_SECTION_CHARS = 600;

/** 出力件数の上限（Markdownを簡潔に保つため）。 */
export const MAX_POSITIVE_FINDINGS = 1;
export const MAX_ISSUE_FINDINGS = 2;
export const MAX_ACTIONS = 1;
export const MAX_SUCCESS_CRITERIA = 3;

/** 1つの所見に表示する根拠行の上限。 */
export const MAX_EVIDENCE_PER_FINDING = 4;

/**
 * Markdownのローカルコーチ節の文字数上限。
 * v3で構造化要素（観測事実・本人基準・仮説・実験）を追加したぶん、
 * 依頼文全体のトークン量が v2 を上回らないよう上限を 1800 から引き下げた。
 * 既存の統計セクションの再掲で依頼文が膨らむのを防ぐため、
 * 判断に直接使った数値だけを根拠として出す。
 */
export const MAX_LOCAL_COACH_SECTION_CHARS = 1500;
