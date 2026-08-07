/**
 * ローカルコーチ分析（ルールベース）のMarkdown整形。
 *
 * 分析処理（src/domain/localCoach）とは分離し、ここでは表示だけを扱う。
 * 数値の丸めは既存の依頼文と同じ規則（fmtNum=小数3桁 / fmtRate=%小数1桁）に従う。
 */
import { MAX_LOCAL_COACH_SECTION_CHARS } from "../domain/localCoach/config";
import { CONFIDENCE_LABELS } from "../domain/localCoach/confidence";
import type {
  LocalCoachAction,
  LocalCoachEvidence,
  LocalCoachFinding,
  LocalCoachReport,
} from "../domain/localCoach/types";
import { fmtNum, fmtRate, fmtRateDiff } from "../utils/format";

/** ローカルコーチ節の見出し（重複出力の検査に使うため定数で持つ）。 */
export const LOCAL_COACH_SECTION_HEADING = "## ローカルコーチ事前分析（ルールベース）";

/** 外部AIへローカル分析の扱いを指示する節の見出し。 */
export const LOCAL_COACH_HANDLING_HEADING = "## ローカルコーチ分析の扱い";

const NA = "N/A";

/**
 * 相対差（比率）を符号付きパーセントで表示する。
 * 率そのものの差（ポイント）とは意味が違うため、fmtRateDiff の "pt" と
 * 混同しないよう別関数にする。undefined は N/A（0%として扱わない）。
 */
export function fmtRelativeDiff(value: number | undefined | null): string {
  if (value == null || Number.isNaN(value)) return NA;
  const sign = value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(1)}%`;
}

function formatValue(
  value: number | undefined,
  unit: LocalCoachEvidence["unit"]
): string {
  if (value == null || Number.isNaN(value)) return NA;
  switch (unit) {
    case "rate":
      return fmtRate(value);
    case "count":
      return String(Math.round(value));
    case "ratio":
      return fmtRelativeDiff(value);
    case "normalized":
    default:
      return fmtNum(value);
  }
}

/** 根拠1件を1行で表す。分母は必ず併記する（分母0はN/A扱い）。 */
function evidenceLine(evidence: LocalCoachEvidence): string {
  const parts: string[] = [];
  if (evidence.unit === "ratio" && evidence.difference != null) {
    parts.push(formatValue(evidence.difference, "ratio"));
    parts.push(
      `今回 ${formatValue(evidence.current, "normalized")} / 基準 ${formatValue(evidence.baseline, "normalized")}`
    );
  } else if (evidence.unit === "rate" && evidence.difference != null) {
    parts.push(formatValue(evidence.current, "rate"));
    parts.push(`差 ${fmtRateDiff(evidence.difference)}`);
  } else {
    parts.push(formatValue(evidence.current, evidence.unit));
  }
  parts.push(evidence.sampleSize > 0 ? `分母${evidence.sampleSize}` : `分母0(${NA})`);
  if (evidence.note) parts.push(evidence.note);
  return `- ${evidence.metric}: ${parts.join(" / ")}`;
}

function findingBlock(
  heading: string,
  finding: LocalCoachFinding,
  evidenceLimit: number
): string[] {
  const out: string[] = [heading, ""];
  out.push(`【統計的傾向・確からしさ：${CONFIDENCE_LABELS[finding.confidence]}】`);
  out.push("");
  out.push(finding.summary);
  out.push("");
  out.push("根拠:");
  for (const evidence of finding.evidence.slice(0, evidenceLimit)) {
    out.push(evidenceLine(evidence));
  }
  out.push("");
  return out;
}

function actionBlock(
  action: LocalCoachAction,
  includeStopCriteria: boolean
): string[] {
  const out: string[] = ["### 次回の推奨メニュー", ""];
  out.push(`目的: ${action.purpose}`);
  out.push(`実施方法: ${action.method}(合計${action.throwCount}投)`);
  out.push(`意識すること: ${action.focus}`);
  out.push(`意識してはいけないこと: ${action.avoid}`);
  out.push(`記録する項目: ${action.recordItems.join(" / ")}`);
  out.push("成功判定:");
  for (const criteria of action.successCriteria) out.push(`- ${criteria}`);
  if (includeStopCriteria) {
    out.push("中止・変更基準:");
    for (const criteria of action.stopOrChangeCriteria) out.push(`- ${criteria}`);
  }
  out.push("");
  return out;
}

/** ローカル分析では判断できないことの定型リスト（毎回同一）。 */
const CANNOT_JUDGE_ITEMS = [
  "身体動作上の直接原因",
  "グリップ圧の変化",
  "肘、肩、手首、リリース位置の変化",
  "医学的・心理的な状態",
];

interface RenderOptions {
  includePositive: boolean;
  issueLimit: number;
  evidenceLimit: number;
  includeStopCriteria: boolean;
  trimmed: boolean;
}

function renderSection(report: LocalCoachReport, options: RenderOptions): string {
  const g = report.generatedFrom;
  const out: string[] = [LOCAL_COACH_SECTION_HEADING, ""];
  out.push("> この分析は、アプリ内の決定ルールと統計計算による事前評価です。");
  out.push("> 生成AIによる回答ではありません。");
  out.push("");
  out.push(`- 分析エンジン: ${report.engineVersion}`);
  out.push(`- 対象投擲数: ${g.completedThrows}投(予定${g.plannedThrowCount}投)`);
  out.push(
    `- 入力精度: 詳細座標${g.coordinateInputCount}投 / 簡易入力${g.approximateInputCount}投`
  );
  out.push(
    g.comparisonSessionCount > 0
      ? `- 比較対象: 同条件の直近${g.comparisonSessionCount}セッション`
      : "- 比較対象: なし(条件が一致する過去セッションなし)"
  );
  out.push(`- 分析可能性: ${report.analyzable ? "十分" : "不足"}`);
  out.push("");

  if (!report.analyzable) {
    out.push("### 分析結果");
    out.push("");
    out.push("主要な傾向は判定できません。");
    out.push("");
    out.push("理由:");
    for (const reason of report.unavailableReasons) out.push(`- ${reason}`);
    out.push("");
    out.push("今回はフォームや技術上の結論を出さず、記録の継続を推奨します。");
    out.push("");
    return out.join("\n");
  }

  if (options.includePositive && report.positiveFinding) {
    out.push(
      ...findingBlock("### 良かった点", report.positiveFinding, options.evidenceLimit)
    );
  }
  const issues = report.issueFindings.slice(0, options.issueLimit);
  issues.forEach((finding, index) => {
    const heading = index === 0 ? "### 最優先の課題" : "### 次に優先する課題";
    out.push(...findingBlock(heading, finding, options.evidenceLimit));
  });
  if (issues.length === 0) {
    out.push("### 課題");
    out.push("");
    out.push("判定基準を超える課題傾向は検出されませんでした。");
    out.push("");
  }
  if (report.recommendedAction && issues.length > 0) {
    out.push(...actionBlock(report.recommendedAction, options.includeStopCriteria));
  }
  out.push("### ローカル分析では判断できないこと");
  out.push("");
  for (const item of CANNOT_JUDGE_ITEMS) out.push(`- ${item}`);
  if (report.unavailableReasons.length > 0) {
    out.push("");
    out.push("分析不能・未測定:");
    for (const reason of report.unavailableReasons.slice(0, 3)) {
      out.push(`- ${reason}`);
    }
  }
  if (options.trimmed) {
    out.push("");
    out.push("※文字数上限のため、優先度の低い項目は省略しています。");
  }
  out.push("");
  return out.join("\n");
}

/**
 * ローカルコーチ節のMarkdownを生成する。
 *
 * 依頼文全体が肥大化しないよう MAX_LOCAL_COACH_SECTION_CHARS 以内に収める。
 * 超過する場合は、優先度の低い項目から決定論的に省略する
 * （数値を丸めたり、内容を要約し直したりはしない）。
 */
export function buildLocalCoachMarkdown(report: LocalCoachReport): string {
  const ladder: RenderOptions[] = [
    { includePositive: true, issueLimit: 2, evidenceLimit: 4, includeStopCriteria: true, trimmed: false },
    { includePositive: true, issueLimit: 2, evidenceLimit: 4, includeStopCriteria: false, trimmed: true },
    { includePositive: true, issueLimit: 2, evidenceLimit: 3, includeStopCriteria: false, trimmed: true },
    { includePositive: true, issueLimit: 1, evidenceLimit: 3, includeStopCriteria: false, trimmed: true },
    { includePositive: false, issueLimit: 1, evidenceLimit: 3, includeStopCriteria: false, trimmed: true },
    { includePositive: false, issueLimit: 1, evidenceLimit: 2, includeStopCriteria: false, trimmed: true },
  ];
  let rendered = "";
  for (const options of ladder) {
    rendered = renderSection(report, options);
    if (rendered.length <= MAX_LOCAL_COACH_SECTION_CHARS) return rendered;
  }
  return rendered;
}

/**
 * 外部の生成AIへ、ローカルコーチ分析の扱い方を指示する節。
 *
 * ローカル分析を無条件の正解として採用させず、統計値と全投擲データから
 * 独立に検証させる。既存の「AIへの分析指示」と役割が重ならないよう、
 * ここではローカル分析との突き合わせ方だけを述べる。
 */
export const LOCAL_COACH_HANDLING_INSTRUCTIONS = `${LOCAL_COACH_HANDLING_HEADING}

上記のローカルコーチ分析は、アプリ内の決定ルールによる事前分析です。
生成AIによる推論結果ではなく、最終結論でもありません。

- ローカルコーチの結論を無条件に採用せず、後続の統計値と全投擲データから独立して検証してください。
- 一致する場合は、どのデータが裏付けているかを明示してください。
- 一致しない場合は、ローカルコーチ分析のどの判定または前提に問題があるかを明示してください。
- ローカルコーチが検出していない重要な傾向も探索してください。
- ローカルコーチの文章を言い換えるだけで終わらず、原因仮説、矛盾点、追加質問、改善実験まで深掘りしてください。
- ローカルコーチの出力に身体動作上の原因が書かれていないことを理由に、原因が存在しないとは判断しないでください。
- ローカルコーチは着弾データから観測できる状態だけを記述し、身体動作・感覚・心理面の原因を意図的に判定していません。原因仮説の提示は「## AIへの分析指示」の安全ルール（医学的・心理的・性格診断の禁止、根拠と確認方法をセットで示すこと）に従ってあなたが行ってください。`;
