/**
 * ローカルコーチ分析（ルールベース）のMarkdown整形。
 *
 * 分析処理（src/domain/localCoach）とは分離し、ここでは表示だけを扱う。
 * 数値の丸めは既存の依頼文と同じ規則（fmtNum=小数3桁 / fmtRate=%小数1桁）に従う。
 *
 * 表示方針:
 *  - 観測事実と原因仮説を別の行・別の見出しに分ける。
 *  - 見出しは「優先候補」とし、ローカルの順位が最終結論に見えないようにする。
 *  - 既存統計の再掲はせず、判断に直接使った数値だけを出す。
 *  - 上限を超える場合は、優先度の低い項目から決定論的に省略する。
 */
import {
  MAX_INSUFFICIENT_SECTION_CHARS,
  MAX_LOCAL_COACH_SECTION_CHARS,
} from "../domain/localCoach/config";
import { CONFIDENCE_LABELS } from "../domain/localCoach/confidence";
import { BASELINE_PATTERN_LABELS } from "../domain/localCoach/personalBaseline";
import type {
  CoachHypothesis,
  LocalCoachAction,
  LocalCoachEvidence,
  LocalCoachFinding,
  LocalCoachReport,
  PersonalBaseline,
} from "../domain/localCoach/types";
import { fmtNum, fmtRate, fmtRateDiff } from "../utils/format";

/** ローカルコーチ節の見出し（重複出力の検査に使うため定数で持つ）。 */
export const LOCAL_COACH_SECTION_HEADING = "## ローカルコーチ事前分析（ルールベース）";

/** 外部AIへローカル分析の扱いを指示する節の見出し。 */
export const LOCAL_COACH_HANDLING_HEADING = "## ローカルコーチ分析の扱い";

/** 優先候補の見出し（ローカルルール上の順位であることを明示する）。 */
export function candidateHeading(rank: number): string {
  return `### ローカルルール上の優先候補${rank}`;
}

const NA = "N/A";

/**
 * 相対差（比率）を符号付きパーセントで表示する。
 * 率そのものの差（ポイント）とは意味が違うため、fmtRateDiff の "pt" と
 * 混同しないよう別関数にする。undefined は N/A（0%として扱わない）。
 */
export function fmtRelativeDiff(value: number | undefined | null): string {
  if (value == null || Number.isNaN(value) || !Number.isFinite(value)) return NA;
  const sign = value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(1)}%`;
}

function formatValue(
  value: number | undefined,
  unit: LocalCoachEvidence["unit"]
): string {
  if (value == null || Number.isNaN(value) || !Number.isFinite(value)) return NA;
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

/**
 * 推定の95%区間を短く表す。
 * 「有意」とは述べず、推定がどれだけぶれ得るかの目安としてのみ示す。
 */
function formatInterval(
  interval: LocalCoachEvidence["interval"],
  unit: LocalCoachEvidence["unit"]
): string | undefined {
  if (!interval) return undefined;
  const format = unit === "rate" ? "rate" : "normalized";
  return `95%区間 ${formatValue(interval.low, format)}〜${formatValue(interval.high, format)}`;
}

/** 観測事実1件を1行で表す。分母は必ず併記する（分母0はN/A扱い）。 */
function factLine(evidence: LocalCoachEvidence): string {
  const parts: string[] = [];
  if (evidence.unit === "ratio" && evidence.difference != null) {
    // 先頭は必ず「その指標の実測値」にする。相対差を先に置くと、
    // 指標名の直後の数値が指標の値だと読み違えられる。
    parts.push(formatValue(evidence.current, "normalized"));
    parts.push(
      `基準比 ${formatValue(evidence.difference, "ratio")} (基準 ${formatValue(evidence.baseline, "normalized")})`
    );
  } else if (evidence.unit === "rate" && evidence.difference != null) {
    parts.push(formatValue(evidence.current, "rate"));
    parts.push(`差 ${fmtRateDiff(evidence.difference)}`);
  } else {
    parts.push(formatValue(evidence.current, evidence.unit));
  }
  parts.push(evidence.sampleSize > 0 ? `分母${evidence.sampleSize}` : `分母0(${NA})`);
  const interval = formatInterval(evidence.interval, evidence.unit);
  if (interval) parts.push(interval);
  if (evidence.note) parts.push(evidence.note);
  return `- ${evidence.metric}: ${parts.join(" / ")}`;
}

/** 個人基準を1行で表す。履歴不足なら理由とともに N/A を示す。 */
function baselineLine(baseline: PersonalBaseline): string {
  if (baseline.pattern === "unavailable") {
    return `本人基準(${baseline.metric}): ${NA} — ${baseline.unavailableReason ?? "履歴不足"}`;
  }
  const range =
    baseline.range != null
      ? `変動幅 ${fmtNum(baseline.range.low)}〜${fmtNum(baseline.range.high)}`
      : `変動幅 ${NA}`;
  return [
    `本人基準(${baseline.metric}): 今回 ${fmtNum(baseline.currentValue)}`,
    `過去中央値 ${fmtNum(baseline.median)}(${baseline.sessionCount}件)`,
    range,
    `差 ${fmtRelativeDiff(baseline.differenceFromMedian)}`,
    BASELINE_PATTERN_LABELS[baseline.pattern],
  ].join(" / ");
}

/**
 * 原因仮説をコンパクトに表す（観測事実とは別ブロックに置く）。
 * compact のときは1行へ畳むが、支持・矛盾・反証条件は必ず残す
 * （断定に見えないための最低要素なので省略しない）。
 */
function hypothesisLines(
  hypothesis: CoachHypothesis,
  index: number,
  compact: boolean
): string[] {
  if (compact) {
    return [
      `仮説${index + 1} ${hypothesis.label}: ${hypothesis.statement}`,
      `- 支持: ${hypothesis.supporting[0] ?? NA} / 矛盾: ${hypothesis.contradicting[0] ?? NA} / 誤りなら${hypothesis.ifFalse}`,
    ];
  }
  const out = [`仮説${index + 1} ${hypothesis.label}: ${hypothesis.statement}`];
  out.push(
    `- 支持: ${hypothesis.supporting[0] ?? NA} / 矛盾: ${hypothesis.contradicting[0] ?? NA}`
  );
  out.push(
    `- 不足: ${hypothesis.missingData[0] ?? NA} / 正なら${hypothesis.ifTrue} / 誤りなら${hypothesis.ifFalse}`
  );
  if (hypothesis.requiresExternalCheck) {
    out.push(`- ${hypothesis.requiresExternalCheck}`);
  }
  return out;
}

interface CandidateOptions {
  factLimit: number;
  hypothesisLimit: number;
  includeCounterEvidence: boolean;
  includeUnmeasured: boolean;
  /** 2件目以降は情報量を上位候補へ寄せ、1行形式へ畳む */
  compact: boolean;
}

function candidateBlock(
  finding: LocalCoachFinding,
  rank: number,
  options: CandidateOptions
): string[] {
  const out: string[] = [candidateHeading(rank), ""];
  out.push(
    `観測事実【確からしさ：${CONFIDENCE_LABELS[finding.confidence]}】${finding.summary}`
  );
  for (const evidence of finding.evidence.slice(0, options.factLimit)) {
    out.push(factLine(evidence));
  }
  // 本人基準は上位候補にのみ全文で出す。2件目以降は位置づけだけを1語で示し、
  // 数値は上の観測事実行と全投擲データから追えるようにする。
  if (finding.personalBaseline) {
    out.push(
      options.compact
        ? `本人基準: ${BASELINE_PATTERN_LABELS[finding.personalBaseline.pattern]}(${finding.personalBaseline.sessionCount}件)`
        : baselineLine(finding.personalBaseline)
    );
  }
  if (finding.priorityReason) {
    out.push(
      options.compact
        ? `優先理由: 優先度${rank}位 / 効果量${Math.round(finding.effect * 100)}%相当`
        : `優先理由: ${finding.priorityReason}`
    );
  }
  if (options.includeCounterEvidence && finding.counterEvidence?.length) {
    out.push(`反証・矛盾: ${finding.counterEvidence.join(" / ")}`);
  }
  if (options.includeUnmeasured && finding.unmeasured?.length) {
    out.push(`未測定: ${finding.unmeasured.join(" / ")}`);
  }
  const hypotheses = (finding.hypotheses ?? []).slice(0, options.hypothesisLimit);
  if (hypotheses.length > 0) {
    out.push("");
    if (!options.compact) {
      out.push("原因候補(未検証。次回の実験で確認する)");
    }
    hypotheses.forEach((hypothesis, index) => {
      out.push(...hypothesisLines(hypothesis, index, options.compact));
    });
  }
  out.push("");
  return out;
}

/** 1変数実験をコンパクトに表す。 */
function experimentBlock(action: LocalCoachAction): string[] {
  const out: string[] = ["### 次回の1変数実験(原因候補を区別する)", ""];
  out.push(`目的: ${action.purpose}`);
  if (action.changedFactor) {
    out.push(`変える要因(これ以外は変えない): ${action.changedFactor}`);
  }
  // label は既に "A: ..." 形式のため、接頭辞を二重に付けない
  if (action.control) {
    out.push(
      `${action.control.label}: ${action.control.description}(${action.control.throwCount}投)`
    );
  }
  if (action.intervention) {
    out.push(
      `${action.intervention.label}: ${action.intervention.description}(${action.intervention.throwCount}投)`
    );
  }
  if (action.blockOrder) out.push(`実施順: ${action.blockOrder}`);
  if (action.primaryMetric) out.push(`主要指標: ${action.primaryMetric}`);
  out.push(`記録: ${action.recordItems.slice(0, 2).join(" / ")}`);
  if (action.guardrailMetrics?.length) {
    out.push(`悪化させない指標: ${action.guardrailMetrics.join(" / ")}`);
  }
  out.push(`成功: ${action.successCriteria.slice(0, 2).join(" / ")}`);
  if (action.falsificationCriteria?.length) {
    out.push(`仮説の否定: ${action.falsificationCriteria[0]}`);
  }
  out.push(`中止・変更: ${action.stopOrChangeCriteria[0] ?? NA}`);
  if (action.nextBranch) out.push(`次の分岐: ${action.nextBranch}`);
  out.push("");
  return out;
}

interface RenderOptions {
  includePositive: boolean;
  candidateLimit: number;
  factLimit: number;
  hypothesisLimit: number;
  includeCounterEvidence: boolean;
  includeUnmeasured: boolean;
  includeExperiment: boolean;
  trimmed: boolean;
}

/**
 * データ不足時の節。
 * 判定できないときに長い仮説や定型の身体原因リストを繰り返さない。
 * 出力は「不足した分母 / 判定できない項目 / 次回必要な投擲数 / 必要な入力精度」に限る。
 */
function renderInsufficient(report: LocalCoachReport): string {
  const g = report.generatedFrom;
  const out: string[] = [LOCAL_COACH_SECTION_HEADING, ""];
  out.push("> アプリ内の決定ルールによる事前評価です。生成AIの回答ではありません。");
  out.push("");
  out.push(
    `- エンジン: ${report.engineVersion} / 対象 ${g.completedThrows}投(予定${g.plannedThrowCount}投) / 分析可能性: 不足`
  );
  out.push(
    `- 入力精度: 詳細座標${g.coordinateInputCount}投 / 簡易入力${g.approximateInputCount}投`
  );
  out.push("");
  out.push("判定できない項目と理由:");
  for (const reason of report.unavailableReasons.slice(0, 4)) {
    out.push(`- ${reason}`);
  }
  out.push("");
  out.push(
    "次回の必要条件: 同条件で最低30投(投順別に各10投)。左右・上下の評価には詳細座標入力が必要です。"
  );
  out.push(
    "今回は原因仮説・練習メニューを生成しません（判定に必要な分母がないため）。"
  );
  out.push("");
  return out.join("\n");
}

/** 課題が0件だった場合の節（問題を作らない）。 */
function stableLines(report: LocalCoachReport): string[] {
  const out: string[] = ["### 判定基準を超える課題なし", ""];
  out.push("今回のデータでは、判定基準を超える課題傾向は検出されていません。");
  for (const line of report.stableRange ?? []) out.push(`- ${line}`);
  if (report.unavailableReasons.length > 0) {
    out.push(`未測定・一般化できない条件: ${report.unavailableReasons[0]}`);
  }
  out.push(
    "次回は改善実験ではなく再現確認を推奨します。成功条件: 同条件でもう1セッション実施し、上記の指標が同じ範囲に収まること。"
  );
  out.push("");
  return out;
}

function renderSection(report: LocalCoachReport, options: RenderOptions): string {
  const g = report.generatedFrom;
  const out: string[] = [LOCAL_COACH_SECTION_HEADING, ""];
  out.push(
    "> アプリ内の決定ルールと統計計算による事前評価です。生成AIの回答でも最終結論でもありません。"
  );
  out.push("");
  out.push(
    `- エンジン: ${report.engineVersion} / 対象 ${g.completedThrows}投(予定${g.plannedThrowCount}投) / 詳細座標${g.coordinateInputCount}投・簡易入力${g.approximateInputCount}投`
  );
  out.push(
    g.comparisonSessionCount > 0
      ? `- 比較可能な過去セッション: ${g.comparisonSessionCount}件 / 検出候補${report.allCandidates.length}件(詳細表示${Math.min(report.issueFindings.length, options.candidateLimit)}件)`
      : `- 比較可能な過去セッション: 0件(本人基準はN/A) / 検出候補${report.allCandidates.length}件(詳細表示${Math.min(report.issueFindings.length, options.candidateLimit)}件)`
  );
  out.push("- 95%区間はぶれ幅の目安です(有意性の判定ではありません)。");
  out.push("");

  const candidates = report.issueFindings.slice(0, options.candidateLimit);
  candidates.forEach((finding, index) => {
    out.push(
      ...candidateBlock(finding, index + 1, {
        // 2件目以降は事実・仮説を絞り、情報量を上位候補へ寄せる
        factLimit: index === 0 ? options.factLimit : 2,
        hypothesisLimit: index === 0 ? options.hypothesisLimit : 1,
        includeCounterEvidence: options.includeCounterEvidence && index === 0,
        includeUnmeasured: options.includeUnmeasured && index === 0,
        compact: index > 0,
      })
    );
  });

  if (candidates.length === 0) {
    out.push(...stableLines(report));
  }

  if (options.includeExperiment && report.recommendedAction && candidates.length > 0) {
    out.push(...experimentBlock(report.recommendedAction));
  }

  // 上位に入らなかった候補も、存在自体は必ず伝える。
  // 文字数上限で表示件数が減った場合も取りこぼさないよう、
  // report の固定値ではなく「実際に詳細表示した件数」を基準にする。
  const unranked = report.allCandidates.slice(candidates.length);
  if (unranked.length > 0) {
    out.push("未掲載の検出候補(詳細は全投擲データで確認):");
    for (const candidate of unranked.slice(0, 3)) {
      out.push(
        `- ${candidate.title}（優先度${candidate.rank}位・確からしさ${CONFIDENCE_LABELS[candidate.confidence]}）`
      );
    }
    out.push("");
  }
  if (options.trimmed) {
    out.push("※上限のため優先度の低い項目を省略しています。");
    out.push("");
  }
  return out.join("\n");
}

/**
 * ローカルコーチ節のMarkdownを生成する。
 *
 * 依頼文全体が肥大化しないよう上限内に収める。超過する場合は、
 * 優先度の低い項目から決定論的に省略する
 * （数値を丸めたり、内容を要約し直したりはしない）。
 */
export function buildLocalCoachMarkdown(report: LocalCoachReport): string {
  if (!report.analyzable) {
    const rendered = renderInsufficient(report);
    return rendered.length <= MAX_INSUFFICIENT_SECTION_CHARS
      ? rendered
      : rendered.slice(0, MAX_INSUFFICIENT_SECTION_CHARS);
  }
  const ladder: RenderOptions[] = [
    { includePositive: true, candidateLimit: 2, factLimit: 4, hypothesisLimit: 2, includeCounterEvidence: true, includeUnmeasured: true, includeExperiment: true, trimmed: false },
    { includePositive: true, candidateLimit: 2, factLimit: 3, hypothesisLimit: 2, includeCounterEvidence: true, includeUnmeasured: true, includeExperiment: true, trimmed: true },
    { includePositive: true, candidateLimit: 2, factLimit: 3, hypothesisLimit: 2, includeCounterEvidence: true, includeUnmeasured: false, includeExperiment: true, trimmed: true },
    { includePositive: true, candidateLimit: 2, factLimit: 2, hypothesisLimit: 1, includeCounterEvidence: true, includeUnmeasured: false, includeExperiment: true, trimmed: true },
    { includePositive: true, candidateLimit: 1, factLimit: 3, hypothesisLimit: 2, includeCounterEvidence: true, includeUnmeasured: false, includeExperiment: true, trimmed: true },
    { includePositive: true, candidateLimit: 1, factLimit: 2, hypothesisLimit: 1, includeCounterEvidence: false, includeUnmeasured: false, includeExperiment: true, trimmed: true },
  ];
  let rendered = "";
  for (const options of ladder) {
    rendered = renderSection(report, options);
    if (rendered.length <= MAX_LOCAL_COACH_SECTION_CHARS) return rendered;
  }
  return rendered;
}

/**
 * 外部の生成AIへ、ローカル分析の扱い方と分析手順を指示する節。
 *
 * ローカル分析を無条件の正解として採用させず、依頼文の統計値と全投擲データから
 * 独立に上位傾向を作らせたうえで照合させる。
 *
 * 注: この節はローカルコーチ節より後ろに置くが、統計値・全投擲データは
 * ローカルコーチ節より「前」に出力される。そのため「後続の統計値」ではなく
 * 「この依頼文に含まれる統計値」と表現し、Markdownの実際の順序と矛盾させない。
 */
export const LOCAL_COACH_HANDLING_INSTRUCTIONS = `${LOCAL_COACH_HANDLING_HEADING}

上記はアプリ内の決定ルールによる事前分析です。生成AIの推論結果でも最終結論でもありません。次の順序で扱ってください。

1. ローカル所見を最終結論として採用しない（順位も暫定）。
2. この依頼文に含まれる統計値と全投擲データ(または添付CSV)から、あなた自身で上位の傾向を独立に作る。
3. ローカルの候補(未掲載の検出候補を含む)と、あなたの候補を照合する。
4. 一致した候補・一致しなかった候補・ローカルが検出していない候補を明示する。
5. 観測事実と原因仮説を分けて書く。ローカルの「観測事実」は算出値、「原因候補」は未検証の仮説。
6. 最終的な優先順位は、あなた自身の検証結果で決める(ローカルの順位に引きずられない)。
7. 残った原因候補を区別できる1変数実験(対照条件・介入条件・成功基準・否定基準)を提示する。

ローカルの文章を言い換えるだけで終わらせず、矛盾点・追加質問・実験計画まで踏み込んでください。ローカルコーチは着弾データから観測できる状態だけを記述し、身体動作・感覚・心理面の原因を意図的に判定していません(原因が存在しないという意味ではありません)。原因仮説の提示は「## AIへの分析指示」の安全ルール(医学的・心理的・性格診断の禁止、根拠と確認方法をセットで示すこと)に従ってあなたが行ってください。`;
