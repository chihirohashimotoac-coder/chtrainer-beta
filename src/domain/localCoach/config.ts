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
export const ENGINE_VERSION = "local-coach-v1.0";

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

/** 出力件数の上限（Markdownを簡潔に保つため）。 */
export const MAX_POSITIVE_FINDINGS = 1;
export const MAX_ISSUE_FINDINGS = 2;
export const MAX_ACTIONS = 1;
export const MAX_SUCCESS_CRITERIA = 3;

/** 1つの所見に表示する根拠行の上限。 */
export const MAX_EVIDENCE_PER_FINDING = 4;

/**
 * Markdownのローカルコーチ節の文字数上限。
 * 既存の統計セクションの再掲で依頼文が膨らむのを防ぐため、
 * 判断に直接使った数値だけを根拠として出す。
 */
export const MAX_LOCAL_COACH_SECTION_CHARS = 1800;
