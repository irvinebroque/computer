import { z } from "zod";
import type { CodeLibraryRun, PromotedCode } from "./library";

const runId = z.string().regex(/^[a-f0-9]{64}$/);
const toolName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

export const run = z.object({
  id: runId,
  executionId: z.string(),
  backend: z.string(),
  purpose: z.string(),
  createdAt: z.iso.datetime(),
  status: z.enum(["started", "succeeded", "failed"]),
  conversationId: z.string().optional(),
  toolCallId: z.string().optional(),
  cwd: z.string().optional(),
  finishedAt: z.iso.datetime().optional(),
  exitCode: z.number().int().optional(),
}) satisfies z.ZodType<CodeLibraryRun>;

export const promoted = z.object({
  name: toolName,
  description: z.string().trim().min(1),
  runId,
  backend: z.string(),
  code: z.string(),
  cwd: z.string().optional(),
}) satisfies z.ZodType<PromotedCode>;
