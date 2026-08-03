import type { ThrowRecord, TrainingSession } from "../types/models";
import { normalizeScoringStyle } from "../types/models";
import { isGroupingOnlyTarget } from "../domain/targets";
import { effectiveR4PatternMetadata } from "./patternMetadata";

export const CSV_COLUMNS = [
  "session_id",
  "session_date",
  "training_mode",
  "board_type",
  "scoring_style",
  "assessment_before_uninterrupted_throw_rate_percent",
  "assessment_before_release_stop_timing",
  "assessment_middle_uninterrupted_throw_rate_percent",
  "assessment_middle_release_stop_timing",
  "assessment_after_uninterrupted_throw_rate_percent",
  "assessment_after_release_stop_timing",
  "set_number",
  "global_throw_number",
  "dart_in_set",
  "dart_color",
  "target_label",
  "target_number",
  "target_ring",
  "landing_number",
  "landing_ring",
  "exact_hit",
  "landing_x",
  "landing_y",
  "error_x",
  "error_y",
  "error_distance",
  "miss_direction",
  "position_precision",
  "evaluation_kind",
  "round_id",
  "round_kind",
  "pattern_id",
  "pattern_kind",
  "analysis_category",
  "pattern_metadata_source",
  "previous_throw_was_hit",
  "same_set_as_previous",
  "previous_throw_was_hit_in_same_set",
  "same_target_as_previous",
  "target_changed",
  "speed_kmh",
  "elapsed_ms",
  "session_progress",
  "throw_note",
] as const;

/** CSVフィールドのエスケープ(RFC4180準拠) */
export function escapeCsvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function cell(value: string | number | boolean | undefined | null): string {
  if (value == null) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  return escapeCsvField(value);
}

export interface SetNumberLookup {
  (setId: string): number | undefined;
}

function isGroupingOnly(record: ThrowRecord): boolean {
  return isGroupingOnlyTarget(record.target);
}

/** セッションの全投擲をCSV文字列(BOMなし)に変換する */
export function buildSessionCsv(
  session: TrainingSession,
  throws: readonly ThrowRecord[],
  setNumberOf: SetNumberLookup
): string {
  const lines: string[] = [CSV_COLUMNS.join(",")];
  const sorted = throws
    .slice()
    .sort((a, b) => a.globalThrowNumber - b.globalThrowNumber);
  const effectivePatterns = effectiveR4PatternMetadata(sorted);
  const assessment = (timing: "before" | "middle" | "after") =>
    session.assessments.find((item) => item.timing === timing);
  const before = assessment("before");
  const middle = assessment("middle");
  const after = assessment("after");
  // 外部向けの機械可読値は正式値へ正規化する(旧 fit_bull → fat_bull)。
  const scoringStyle = normalizeScoringStyle(session.scoringStyle);
  for (const t of sorted) {
    const pattern = effectivePatterns.get(t.setId);
    // グルーピング専用(R1)は命中を評価しないため、命中判定に依存する項目は空欄(N/A)。
    const groupingOnly = isGroupingOnly(t);
    const previousHitCell =
      !groupingOnly && t.derived.sameSetAsPrevious
        ? t.derived.previousThrowWasHitInSameSet
        : undefined;
    const row = [
      cell(session.id),
      cell(session.startedAt),
      cell(session.trainingMode),
      cell(session.boardType),
      cell(scoringStyle),
      cell(before?.uninterruptedThrowRate),
      cell(before?.releaseStopTiming),
      cell(middle?.uninterruptedThrowRate),
      cell(middle?.releaseStopTiming),
      cell(after?.uninterruptedThrowRate),
      cell(after?.releaseStopTiming),
      cell(setNumberOf(t.setId)),
      cell(t.globalThrowNumber),
      cell(t.dartInSet),
      cell(t.dartColor),
      cell(t.target.label),
      cell(t.target.number),
      cell(t.target.ring),
      cell(t.landing.number),
      cell(t.landing.ring),
      cell(groupingOnly ? undefined : t.derived.exactHit),
      cell(t.landing.x),
      cell(t.landing.y),
      cell(t.derived.errorX),
      cell(t.derived.errorY),
      cell(t.derived.errorDistance),
      cell(t.derived.missDirection),
      cell(t.landing.positionPrecision),
      cell(t.target.evaluationKind),
      cell(t.target.roundId),
      cell(t.target.roundKind),
      cell(pattern?.patternId ?? t.target.patternId),
      cell(pattern?.patternKind ?? t.target.patternKind),
      cell(pattern?.analysisCategory ?? t.target.analysisCategory),
      cell(pattern?.source),
      cell(previousHitCell),
      cell(t.derived.sameSetAsPrevious),
      cell(previousHitCell),
      cell(t.derived.sameSetAsPrevious ? t.derived.sameTargetAsPrevious : undefined),
      cell(t.derived.sameSetAsPrevious ? t.derived.targetChangedFromPrevious : undefined),
      cell(t.speedKmh),
      cell(t.elapsedMs),
      cell(t.derived.sessionProgress),
      cell(t.note),
    ];
    lines.push(row.join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

/**
 * UTF-8 BOM。日本語版Excelがエンコーディングを誤判定しないために付ける。
 * CSVを外部へ出す経路(単独ダウンロード・ZIP同梱)では必ずこれを前置し、
 * 経路によってBOMの有無が食い違わないようにする。
 */
export const UTF8_BOM = "﻿";

/** BOMを前置したCSV文字列を返す(ファイルとして書き出す直前に使う)。 */
export function csvWithBom(csv: string): string {
  return csv.startsWith(UTF8_BOM) ? csv : UTF8_BOM + csv;
}

/**
 * UTF-8 BOM付きのCSV Blobを作る。
 * 日本語版Excelで文字化けしないようBOMを付ける。
 */
export function csvToBlob(csv: string): Blob {
  return new Blob([csvWithBom(csv)], { type: "text/csv;charset=utf-8" });
}
