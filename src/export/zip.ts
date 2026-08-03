import JSZip from "jszip";
import type { TrainingSession } from "../types/models";
import { normalizeScoringStyle } from "../types/models";
import { csvWithBom } from "./csv";

/** Builds a portable analysis bundle without mutating persisted data. */
export async function buildAnalysisZip(
  markdown: string,
  csv: string,
  session: TrainingSession
): Promise<Blob> {
  const zip = new JSZip();
  zip.file("analysis-request.md", markdown);
  // 単独ダウンロードのCSV(csvToBlob)と同一バイト列にするためBOMを前置する。
  // BOMがないとZIPを展開したCSVだけが日本語版Excelで文字化けする。
  zip.file("throws.csv", csvWithBom(csv));
  zip.file(
    "metadata.json",
    JSON.stringify(
      {
        schemaVersion: session.schemaVersion,
        sessionId: session.id,
        startedAt: session.startedAt,
        trainingMode: session.trainingMode,
        // 外部向けの機械可読値は正式値へ正規化する(旧 fit_bull → fat_bull)。
        scoringStyle: normalizeScoringStyle(session.scoringStyle) ?? null,
        contextSnapshot: session.contextSnapshot ?? null,
        assessments: session.assessments,
      },
      null,
      2
    )
  );
  return zip.generateAsync({ type: "blob", compression: "DEFLATE" });
}
