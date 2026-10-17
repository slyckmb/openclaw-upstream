/**
 * Durable protected-execution identity, stored in the shared Gateway SQLite DB.
 *
 * This is a storage primitive, NOT authorization by itself: only a separate
 * trusted Gateway administrator writer may commit rows. Before execution,
 * a qualified runtime must also prove its OS boundary and active run ownership.
 */
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { ensureProtectedExecutionSchema } from "./openclaw-state-db-schema-additive.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB as StateDatabase } from "./openclaw-state-db.generated.js";

type ProtectedDb = Pick<StateDatabase, "protected_execution_cutovers" | "protected_execution_runs">;

export type ProtectedCutoverIdentity = Readonly<{
  generation: number;
  runtimeFingerprint: string;
}>;
export type ProtectedRunIdentity = ProtectedCutoverIdentity &
  Readonly<{ runId: string; instanceId: string; agentId: string }>;
type CreateCutover = ProtectedCutoverIdentity &
  Readonly<{ administratorRef: string; nowMs: number }>;
type CreateRun = ProtectedRunIdentity & Readonly<{ parentRunId?: string; nowMs: number }>;

function requireIdentifier(value: string, name: string): string {
  if (!value || !value.trim() || value !== value.trim() || value.length > 256) {
    throw new Error("protected execution " + name + " must be a bounded nonempty identifier");
  }
  return value;
}

function requireGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("protected execution generation must be a positive safe integer");
  }
  return value;
}

function requireTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("protected execution timestamp must be a nonnegative safe integer");
  }
  return value;
}

function requireFingerprint(value: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error("protected execution requires an exact SHA-256 runtime fingerprint");
  }
  return value;
}

function assertCanonicalProtectedSchema(database: DatabaseSync): void {
  for (const table of ["protected_execution_cutovers", "protected_execution_runs"]) {
    if (!tableExists(database, table)) {
      throw new Error("protected execution denied: durable " + table + " is missing");
    }
  }
  for (const trigger of [
    "protected_execution_cutovers_guard_update",
    "protected_execution_cutovers_guard_delete",
    "protected_execution_runs_guard_update",
    "protected_execution_runs_guard_delete",
  ]) {
    const row = database
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name = ?")
      .get(trigger);
    if (!row) {
      throw new Error("protected execution denied: guard " + trigger + " is missing");
    }
  }
}

function readCutover(database: DatabaseSync) {
  const db = getNodeSqliteKysely<ProtectedDb>(database);
  return executeSqliteQueryTakeFirstSync(
    database,
    db.selectFrom("protected_execution_cutovers").selectAll().where("id", "=", 1),
  );
}

/**
 * Trusted-writer only, within an existing synchronous IMMEDIATE transaction.
 * The monotonically increasing floor cannot be removed, replaced in place,
 * or advanced while old protected work is still active.
 */
export function advanceProtectedCutoverInTransaction(
  database: DatabaseSync,
  input: CreateCutover,
): void {
  const generation = requireGeneration(input.generation);
  const fingerprint = requireFingerprint(input.runtimeFingerprint);
  const administratorRef = requireIdentifier(input.administratorRef, "administrator reference");
  const nowMs = requireTimestamp(input.nowMs);
  ensureProtectedExecutionSchema(database);
  assertCanonicalProtectedSchema(database);
  const db = getNodeSqliteKysely<ProtectedDb>(database);
  const current = readCutover(database);
  if (current) {
    if (
      current.required === 1 &&
      current.generation === generation &&
      current.runtime_fingerprint === fingerprint &&
      current.administrator_ref === administratorRef
    ) {
      return;
    }
    if (generation <= current.generation) {
      throw new Error("protected execution denied: floor may only advance");
    }
    const active = executeSqliteQueryTakeFirstSync(
      database,
      db
        .selectFrom("protected_execution_runs")
        .select("run_id")
        .where("state", "=", "active")
        .limit(1),
    );
    if (active) {
      throw new Error("protected execution denied: active runs must be retired before cutover");
    }
    executeSqliteQuerySync(
      database,
      db
        .updateTable("protected_execution_cutovers")
        .set({
          generation,
          required: 1,
          runtime_fingerprint: fingerprint,
          administrator_ref: administratorRef,
          created_at_ms: nowMs,
        })
        .where("id", "=", 1),
    );
    return;
  }
  executeSqliteQuerySync(
    database,
    db.insertInto("protected_execution_cutovers").values({
      id: 1,
      generation,
      required: 1,
      runtime_fingerprint: fingerprint,
      administrator_ref: administratorRef,
      created_at_ms: nowMs,
    }),
  );
}

/** Store the exact run/child identity before queue acknowledgment or tool preparation. */
export function bindProtectedRunInTransaction(database: DatabaseSync, input: CreateRun): void {
  const runId = requireIdentifier(input.runId, "run ID");
  const instanceId = requireIdentifier(input.instanceId, "instance ID");
  const agentId = requireIdentifier(input.agentId, "agent ID");
  const parentRunId = input.parentRunId
    ? requireIdentifier(input.parentRunId, "parent run ID")
    : null;
  const generation = requireGeneration(input.generation);
  const fingerprint = requireFingerprint(input.runtimeFingerprint);
  const nowMs = requireTimestamp(input.nowMs);
  assertCanonicalProtectedSchema(database);
  const cutover = readCutover(database);
  if (
    !cutover ||
    cutover.required !== 1 ||
    cutover.generation !== generation ||
    cutover.runtime_fingerprint !== fingerprint
  ) {
    throw new Error("protected execution denied: active cutover disagrees with admitted run");
  }
  const db = getNodeSqliteKysely<ProtectedDb>(database);
  if (parentRunId !== null) {
    const parent = executeSqliteQueryTakeFirstSync(
      database,
      db.selectFrom("protected_execution_runs").selectAll().where("run_id", "=", parentRunId),
    );
    if (
      !parent ||
      parent.state !== "active" ||
      parent.generation !== generation ||
      parent.runtime_fingerprint !== fingerprint
    ) {
      throw new Error("protected execution denied: parent run is not actively bound");
    }
  }
  const previous = executeSqliteQueryTakeFirstSync(
    database,
    db.selectFrom("protected_execution_runs").selectAll().where("run_id", "=", runId),
  );
  if (previous) {
    // Retries cannot exchange or resurrect a run instance under a reused ID.
    throw new Error("protected execution denied: run ID already bound");
  }
  executeSqliteQuerySync(
    database,
    db.insertInto("protected_execution_runs").values({
      run_id: runId,
      instance_id: instanceId,
      agent_id: agentId,
      parent_run_id: parentRunId,
      generation,
      runtime_fingerprint: fingerprint,
      required: 1,
      state: "active",
      admitted_at_ms: nowMs,
      retired_at_ms: null,
    }),
  );
}

/** Read-only: missing, stale, corrupt or retired authority ALWAYS denies execution. */
export function assertProtectedRunState(
  database: DatabaseSync,
  identity: ProtectedRunIdentity,
): void {
  const runId = requireIdentifier(identity.runId, "run ID");
  const instanceId = requireIdentifier(identity.instanceId, "instance ID");
  const agentId = requireIdentifier(identity.agentId, "agent ID");
  const generation = requireGeneration(identity.generation);
  const fingerprint = requireFingerprint(identity.runtimeFingerprint);
  assertCanonicalProtectedSchema(database);
  const cutover = readCutover(database);
  if (
    !cutover ||
    cutover.required !== 1 ||
    cutover.generation !== generation ||
    cutover.runtime_fingerprint !== fingerprint
  ) {
    throw new Error("protected execution denied: required cutover missing or changed");
  }
  const db = getNodeSqliteKysely<ProtectedDb>(database);
  const run = executeSqliteQueryTakeFirstSync(
    database,
    db.selectFrom("protected_execution_runs").selectAll().where("run_id", "=", runId),
  );
  if (
    !run ||
    run.state !== "active" ||
    run.required !== 1 ||
    run.retired_at_ms !== null ||
    run.instance_id !== instanceId ||
    run.agent_id !== agentId ||
    run.generation !== generation ||
    run.runtime_fingerprint !== fingerprint
  ) {
    throw new Error("protected execution denied: active run authority missing or changed");
  }
}

/** A completed run stays recorded; its identity can never be reissued. */
export function retireProtectedRunInTransaction(
  database: DatabaseSync,
  identity: ProtectedRunIdentity,
  nowMs: number,
): void {
  assertProtectedRunState(database, identity);
  const retirement = requireTimestamp(nowMs);
  const db = getNodeSqliteKysely<ProtectedDb>(database);
  const activeChild = executeSqliteQueryTakeFirstSync(
    database,
    db
      .selectFrom("protected_execution_runs")
      .select("run_id")
      .where("parent_run_id", "=", identity.runId)
      .where("state", "=", "active")
      .limit(1),
  );
  if (activeChild) {
    throw new Error("protected execution denied: child runs remain active");
  }
  executeSqliteQuerySync(
    database,
    db
      .updateTable("protected_execution_runs")
      .set({ state: "retired", retired_at_ms: retirement })
      .where("run_id", "=", identity.runId)
      .where("instance_id", "=", identity.instanceId)
      .where("state", "=", "active"),
  );
}
