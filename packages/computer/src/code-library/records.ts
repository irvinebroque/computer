import type { WorkspaceRuntimeValue } from "../runtime/types";
import type { CodeLibraryRun } from "./library";

type SavedRecord = { [field: string]: WorkspaceRuntimeValue };

export function parseRun(text: string): CodeLibraryRun {
  const record = parseRecord(text);
  const status = stringField(record, "status");

  if (status !== "started" && status !== "succeeded" && status !== "failed")
    throw new Error("Invalid input: unknown code library status");

  const exitCode = record.exitCode;

  if (exitCode !== undefined && (typeof exitCode !== "number" || !Number.isSafeInteger(exitCode)))
    throw new Error("Invalid input: code library exit code must be a safe integer");

  const finishedAt = optionalString(record, "finishedAt");

  const outcomeMatches =
    status === "started"
      ? exitCode === undefined && finishedAt === undefined
      : exitCode !== undefined &&
        finishedAt !== undefined &&
        (status === "succeeded") === (exitCode === 0);

  if (!outcomeMatches) throw new Error("Invalid input: inconsistent code library outcome");

  const createdAt = stringField(record, "createdAt");
  validateTime(createdAt);

  if (finishedAt !== undefined) validateTime(finishedAt);

  return {
    id: runId(record, "id"),
    executionId: stringField(record, "executionId"),
    backend: stringField(record, "backend"),
    purpose: stringField(record, "purpose"),
    createdAt,
    status,
    sessionId: optionalString(record, "sessionId"),
    conversationId: optionalString(record, "conversationId"),
    toolCallId: optionalString(record, "toolCallId"),
    cwd: optionalString(record, "cwd"),
    finishedAt,
    exitCode,
  };
}

function parseRecord(text: string): SavedRecord {
  const value: WorkspaceRuntimeValue = JSON.parse(text);

  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid input: code library record must be an object");

  return value;
}

function stringField(record: SavedRecord, field: string): string {
  const value = record[field];

  if (typeof value !== "string") throw new Error(`Invalid input: ${field} must be a string`);

  return value;
}

function optionalString(record: SavedRecord, field: string): string | undefined {
  return record[field] === undefined ? undefined : stringField(record, field);
}

function runId(record: SavedRecord, field: string): string {
  const id = stringField(record, field);

  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid input: invalid code library run id");

  return id;
}

function validateTime(value: string): void {
  const date = new Date(value);

  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value)
    throw new Error("Invalid input: invalid code library timestamp");
}
