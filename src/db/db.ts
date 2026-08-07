import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type {
  AppSettings,
  EquipmentProfile,
  PlayerProfile,
  SessionStatistics,
  ThrowRecord,
  ThrowSet,
  TrainingPlan,
  TrainingSession,
  UUID,
} from "../types/models";
import { SCHEMA_VERSION, normalizeScoringStyle } from "../types/models";
import type { BackupData } from "../export/backup";
import { nowIso } from "../utils/id";

/** IndexedDBのスキーマバージョン(データ移行用) */
const DB_VERSION = 5;

/**
 * セッションのスコアリング形式を正式値へ正規化する(後方互換)。
 * 旧 fit_bull を fat_bull へ。未設定はそのまま。内部・外部で一貫して fat_bull を扱う。
 */
function normalizeSession(session: TrainingSession): TrainingSession {
  if (session.scoringStyle == null) return session;
  const normalized = normalizeScoringStyle(session.scoringStyle);
  if (normalized === session.scoringStyle) return session;
  return { ...session, scoringStyle: normalized };
}
/**
 * IndexedDBのデータベース名。
 *
 * ベータ版は本番版と同一オリジン(github.io)配下で公開されるため、パスが違う
 * だけではブラウザの保存領域が分離されない。本番版が使うDB名(末尾に -beta が
 * 付かない名前)は絶対に開かず、この -beta 付きの名前だけを使うことで、
 * 同じブラウザで本番版とベータ版を同時に利用してもデータが混ざらないようにする。
 * 本番版の識別子をここへ書き写すと分離の保証が崩れるため、コメントにも含めない
 * (src/beta/betaIsolation.test.ts が機械的に検査する)。
 *
 * 本番データをベータ版で使いたい場合は、本番版のJSONバックアップを書き出し、
 * ベータ版の復元機能から取り込む(自動コピー・自動移行は行わない)。
 */
const DB_NAME = "darts-training-analyzer-beta";

interface DtaDb extends DBSchema {
  settings: { key: string; value: AppSettings };
  players: { key: UUID; value: PlayerProfile };
  equipmentProfiles: { key: UUID; value: EquipmentProfile };
  trainingPlans: { key: UUID; value: TrainingPlan };
  sessions: {
    key: UUID;
    value: TrainingSession;
    indexes: { byStatus: string; byStartedAt: string };
  };
  throwSets: {
    key: UUID;
    value: ThrowSet;
    indexes: { bySession: UUID };
  };
  throws: {
    key: UUID;
    value: ThrowRecord;
    indexes: { bySession: UUID };
  };
  sessionStatistics: { key: UUID; value: SessionStatistics };
  appMetadata: { key: string; value: { key: string; value: unknown } };
}

let dbPromise: Promise<IDBPDatabase<DtaDb>> | undefined;

export function getDb(): Promise<IDBPDatabase<DtaDb>> {
  if (!dbPromise) {
    dbPromise = openDB<DtaDb>(DB_NAME, DB_VERSION, {
      async upgrade(db, oldVersion, _newVersion, transaction) {
        if (oldVersion < 1) {
          db.createObjectStore("settings", { keyPath: "id" });
          db.createObjectStore("players", { keyPath: "id" });
          db.createObjectStore("equipmentProfiles", { keyPath: "id" });
          db.createObjectStore("trainingPlans", { keyPath: "id" });
          const sessions = db.createObjectStore("sessions", { keyPath: "id" });
          sessions.createIndex("byStatus", "status");
          sessions.createIndex("byStartedAt", "startedAt");
          const sets = db.createObjectStore("throwSets", { keyPath: "id" });
          sets.createIndex("bySession", "sessionId");
          const throws = db.createObjectStore("throws", { keyPath: "id" });
          throws.createIndex("bySession", "sessionId");
          db.createObjectStore("sessionStatistics", { keyPath: "sessionId" });
          db.createObjectStore("appMetadata", { keyPath: "key" });
        }
        if (oldVersion < 2) {
          // Statistics are derived data. Schema v2 changes grouping-only and
          // scorable denominators, so stale v1 rows must be recalculated on use.
          void transaction.objectStore("sessionStatistics").clear();
        }
        if (oldVersion < 3) {
          // v3 adds per-target scorable counts and detailed grouping reasons.
          // Statistics are derived, so only the cache is cleared; source throws remain untouched.
          void transaction.objectStore("sessionStatistics").clear();
        }
        if (oldVersion < 4) {
          // v4: 分母0の率は0ではなくundefined(N/A)へ変更。旧キャッシュには
          // hitRate:0が焼き込まれているため破棄し、参照時に再計算させる。
          void transaction.objectStore("sessionStatistics").clear();
        }
        if (oldVersion < 5) {
          // v5: スコアリング形式の正式値を fat_bull に統一。旧誤記由来の
          // fit_bull を保存済みセッションから fat_bull へ書き換える(後方互換)。
          // 読み込み時にも normalizeSession で正規化するが、保存値も揃えておく。
          const store = transaction.objectStore("sessions");
          let cursor = await store.openCursor();
          while (cursor) {
            const session = cursor.value as TrainingSession;
            // 旧値は型に存在しないため文字列比較で判定する(後方互換専用)。
            if ((session.scoringStyle as string | undefined) === "fit_bull") {
              await cursor.update({ ...session, scoringStyle: "fat_bull" });
            }
            cursor = await cursor.continue();
          }
        }
      },
    });
  }
  return dbPromise;
}

// ---- settings ----

export async function getAppSettings(): Promise<AppSettings | undefined> {
  const db = await getDb();
  return db.get("settings", "app");
}

export async function saveAppSettings(
  settings: Omit<AppSettings, "updatedAt" | "schemaVersion" | "id">
): Promise<AppSettings> {
  const db = await getDb();
  const value: AppSettings = {
    ...settings,
    id: "app",
    schemaVersion: SCHEMA_VERSION,
    updatedAt: nowIso(),
  };
  await db.put("settings", value);
  return value;
}

// ---- players ----

export async function getPlayers(): Promise<PlayerProfile[]> {
  const db = await getDb();
  return db.getAll("players");
}

export async function getPlayer(id: UUID): Promise<PlayerProfile | undefined> {
  const db = await getDb();
  return db.get("players", id);
}

export async function savePlayer(player: PlayerProfile): Promise<void> {
  const db = await getDb();
  await db.put("players", { ...player, updatedAt: nowIso() });
}

// ---- equipment ----

export async function getEquipmentProfiles(): Promise<EquipmentProfile[]> {
  const db = await getDb();
  return db.getAll("equipmentProfiles");
}

export async function getEquipmentProfile(
  id: UUID
): Promise<EquipmentProfile | undefined> {
  const db = await getDb();
  return db.get("equipmentProfiles", id);
}

export async function saveEquipmentProfile(
  profile: EquipmentProfile
): Promise<void> {
  const db = await getDb();
  await db.put("equipmentProfiles", { ...profile, updatedAt: nowIso() });
}

export async function deleteEquipmentProfile(id: UUID): Promise<void> {
  const db = await getDb();
  await db.delete("equipmentProfiles", id);
}

// ---- training plans ----

export async function saveTrainingPlan(plan: TrainingPlan): Promise<void> {
  const db = await getDb();
  await db.put("trainingPlans", { ...plan, updatedAt: nowIso() });
}

export async function getTrainingPlans(): Promise<TrainingPlan[]> {
  const db = await getDb();
  return db.getAll("trainingPlans");
}

// ---- sessions ----

export async function getSessions(): Promise<TrainingSession[]> {
  const db = await getDb();
  const all = await db.getAll("sessions");
  return all
    .map(normalizeSession)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function getSession(
  id: UUID
): Promise<TrainingSession | undefined> {
  const db = await getDb();
  const session = await db.get("sessions", id);
  return session ? normalizeSession(session) : undefined;
}

export async function saveSession(session: TrainingSession): Promise<void> {
  const db = await getDb();
  await db.put("sessions", { ...session, updatedAt: nowIso() });
}

export async function getActiveSession(): Promise<TrainingSession | undefined> {
  const db = await getDb();
  const actives = await db.getAllFromIndex("sessions", "byStatus", "active");
  const latest = actives.sort((a, b) =>
    b.startedAt.localeCompare(a.startedAt)
  )[0];
  return latest ? normalizeSession(latest) : undefined;
}

/** セッションと関連データを削除する */
export async function deleteSessionCascade(id: UUID): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(
    ["sessions", "throwSets", "throws", "sessionStatistics"],
    "readwrite"
  );
  const setKeys = await tx
    .objectStore("throwSets")
    .index("bySession")
    .getAllKeys(id);
  for (const key of setKeys) await tx.objectStore("throwSets").delete(key);
  const throwKeys = await tx
    .objectStore("throws")
    .index("bySession")
    .getAllKeys(id);
  for (const key of throwKeys) await tx.objectStore("throws").delete(key);
  await tx.objectStore("sessionStatistics").delete(id);
  await tx.objectStore("sessions").delete(id);
  await tx.done;
}

// ---- throw sets ----

export async function saveThrowSet(set: ThrowSet): Promise<void> {
  const db = await getDb();
  await db.put("throwSets", set);
}

/**
 * 1セット分を単一トランザクションで保存する。
 * 同じ set.id の既存投擲は先に削除してから挿入するため、
 * 同一セットを何度保存しても二重保存にならない(置換保存)。
 */
export async function saveCommittedSet(
  set: ThrowSet,
  records: ThrowRecord[]
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(["throwSets", "throws"], "readwrite");
  const throwStore = tx.objectStore("throws");
  const existing = await throwStore.index("bySession").getAll(set.sessionId);
  for (const record of existing) {
    if (record.setId === set.id) await throwStore.delete(record.id);
  }
  await tx.objectStore("throwSets").put(set);
  const now = nowIso();
  for (const r of records) {
    await throwStore.put({ ...r, updatedAt: now });
  }
  await tx.done;
}

export async function getThrowSets(sessionId: UUID): Promise<ThrowSet[]> {
  const db = await getDb();
  const sets = await db.getAllFromIndex("throwSets", "bySession", sessionId);
  return sets.sort((a, b) => a.setNumber - b.setNumber);
}

// ---- throws ----

export async function saveThrow(record: ThrowRecord): Promise<void> {
  const db = await getDb();
  await db.put("throws", { ...record, updatedAt: nowIso() });
}

export async function saveThrows(records: ThrowRecord[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("throws", "readwrite");
  const now = nowIso();
  for (const r of records) {
    await tx.store.put({ ...r, updatedAt: now });
  }
  await tx.done;
}

export async function getThrows(sessionId: UUID): Promise<ThrowRecord[]> {
  const db = await getDb();
  const throws = await db.getAllFromIndex("throws", "bySession", sessionId);
  return throws.sort((a, b) => a.globalThrowNumber - b.globalThrowNumber);
}

export async function getThrow(id: UUID): Promise<ThrowRecord | undefined> {
  const db = await getDb();
  return db.get("throws", id);
}

// ---- statistics ----

export async function saveStatistics(stats: SessionStatistics): Promise<void> {
  const db = await getDb();
  await db.put("sessionStatistics", stats);
}

export async function getStatistics(
  sessionId: UUID
): Promise<SessionStatistics | undefined> {
  const db = await getDb();
  return db.get("sessionStatistics", sessionId);
}

// ---- backup / restore ----

export async function exportAllData(): Promise<BackupData> {
  const db = await getDb();
  return {
    settings: await db.getAll("settings"),
    players: await db.getAll("players"),
    equipmentProfiles: await db.getAll("equipmentProfiles"),
    trainingPlans: await db.getAll("trainingPlans"),
    // 外部向けバックアップも正式値へ正規化する(旧 fit_bull → fat_bull)。
    sessions: (await db.getAll("sessions")).map(normalizeSession),
    throwSets: await db.getAll("throwSets"),
    throws: await db.getAll("throws"),
    sessionStatistics: await db.getAll("sessionStatistics"),
  };
}

/**
 * バックアップをインポートする。
 * mode "replace": 全ストアをクリアしてから投入
 * mode "merge": 既存データへ追加(同IDは上書き)
 * 単一トランザクションで実行し、失敗時は既存データを維持する。
 */
export async function importAllData(
  data: BackupData,
  mode: "replace" | "merge"
): Promise<void> {
  const db = await getDb();
  const storeNames = [
    "settings",
    "players",
    "equipmentProfiles",
    "trainingPlans",
    "sessions",
    "throwSets",
    "throws",
    "sessionStatistics",
  ] as const;
  const tx = db.transaction(storeNames, "readwrite");
  if (mode === "replace") {
    for (const name of storeNames) {
      await tx.objectStore(name).clear();
    }
  }
  for (const item of data.settings) await tx.objectStore("settings").put(item);
  for (const item of data.players) await tx.objectStore("players").put(item);
  for (const item of data.equipmentProfiles)
    await tx.objectStore("equipmentProfiles").put(item);
  for (const item of data.trainingPlans)
    await tx.objectStore("trainingPlans").put(item);
  // 旧バックアップの fit_bull は取り込み時に fat_bull へ正規化する(後方互換)。
  for (const item of data.sessions)
    await tx.objectStore("sessions").put(normalizeSession(item));
  for (const item of data.throwSets)
    await tx.objectStore("throwSets").put(item);
  for (const item of data.throws) await tx.objectStore("throws").put(item);
  for (const item of data.sessionStatistics)
    await tx.objectStore("sessionStatistics").put(item);
  await tx.done;
}

/** 全データを削除する */
export async function clearAllData(): Promise<void> {
  const db = await getDb();
  const storeNames = [
    "settings",
    "players",
    "equipmentProfiles",
    "trainingPlans",
    "sessions",
    "throwSets",
    "throws",
    "sessionStatistics",
    "appMetadata",
  ] as const;
  const tx = db.transaction(storeNames, "readwrite");
  for (const name of storeNames) {
    await tx.objectStore(name).clear();
  }
  await tx.done;
}
