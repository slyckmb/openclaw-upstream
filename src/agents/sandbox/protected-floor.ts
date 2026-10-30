import fs from "node:fs";
import path from "node:path";

// Operator-owned trust floor for protected execution (M0 decision B1). The path is
// an explicit operator contract, so it is a constant rather than a config knob:
// a config or environment override would let the protected floor be redirected.
export const PROTECTED_FLOOR_DIR = "/dump/openclaw-protected";
const PROTECTED_FLOOR_FILE = "floor.json";
const PROTECTED_FLOOR_SCHEMA = "openclaw-protected-floor/v1";
const PROTECTED_FLOOR_MARKER = "operator-only";

export type ProtectedFloorState =
  | { status: "absent" }
  | { status: "active" }
  | { status: "invalid"; reason: string };

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function invalid(reason: string): ProtectedFloorState {
  return { status: "invalid", reason };
}

/**
 * Read the operator floor without writing. Absent means no floor is configured on
 * this host. Present but unverifiable (wrong owner, group/other-writable, missing
 * or malformed record) is invalid, and protected work must not start.
 */
export function readProtectedFloor(dir: string = PROTECTED_FLOOR_DIR): ProtectedFloorState {
  const uid = process.getuid?.();
  if (uid === undefined) {
    return invalid("owner check unavailable on this platform");
  }
  let dirStat: fs.Stats;
  try {
    dirStat = fs.lstatSync(dir);
  } catch (err) {
    return isMissing(err) ? { status: "absent" } : invalid("floor directory unreadable");
  }
  if (!dirStat.isDirectory()) {
    return invalid("floor path is not a real directory");
  }
  if (dirStat.uid !== uid) {
    return invalid("floor directory is not owned by the service user");
  }
  if ((dirStat.mode & 0o777) !== 0o700) {
    return invalid("floor directory mode must be 0700");
  }
  const filePath = path.join(dir, PROTECTED_FLOOR_FILE);
  let fileStat: fs.Stats;
  try {
    fileStat = fs.lstatSync(filePath);
  } catch {
    return invalid("floor record is missing");
  }
  if (!fileStat.isFile() || fileStat.uid !== uid || (fileStat.mode & 0o022) !== 0) {
    return invalid(
      "floor record must be a regular file owned by the service user, not group- or other-writable",
    );
  }
  let record: unknown;
  try {
    record = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return invalid("floor record is not valid JSON");
  }
  const fields = record as { schema?: unknown; floor?: unknown } | null;
  if (fields?.schema !== PROTECTED_FLOOR_SCHEMA || fields.floor !== PROTECTED_FLOOR_MARKER) {
    return invalid("floor record has an unexpected schema or marker");
  }
  return { status: "active" };
}

/** Whether this host has any operator floor directory at all. */
export function isProtectedFloorPresent(dir: string = PROTECTED_FLOOR_DIR): boolean {
  return readProtectedFloor(dir).status !== "absent";
}

/** Fail closed before protected provisioning: only a verified floor allows it. */
export function assertProtectedFloorActive(dir: string = PROTECTED_FLOOR_DIR): void {
  const state = readProtectedFloor(dir);
  if (state.status !== "active") {
    const detail = state.status === "invalid" ? state.reason : "no operator floor is configured";
    throw new Error(`Protected execution denied: ${detail}`);
  }
}
