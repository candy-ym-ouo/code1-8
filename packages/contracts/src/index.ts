import { z } from 'zod';

export const roleSchema = z.enum(['OWNER', 'EDITOR', 'COMMENTER', 'VIEWER']);

const titleSchema = z.string().trim().min(1).max(160);
const summarySchema = z.string().max(4000);
const transcriptSchema = z.string().max(20_000);
const speakerPersonIdSchema = z.string().uuid().nullable();

export const clipSchema = z
  .object({
    title: titleSchema,
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
    summary: summarySchema.default(''),
    transcript: transcriptSchema.default(''),
    speakerPersonId: speakerPersonIdSchema.optional(),
    version: z.number().int().positive().optional(),
  })
  .strict()
  .refine((value) => value.endMs > value.startMs, {
    message: 'endMs must be greater than startMs',
    path: ['endMs'],
  });

export const clipUpdateSchema = z
  .object({
    title: titleSchema.optional(),
    startMs: z.number().int().nonnegative().optional(),
    endMs: z.number().int().positive().optional(),
    summary: summarySchema.optional(),
    transcript: transcriptSchema.optional(),
    speakerPersonId: speakerPersonIdSchema.optional(),
    version: z.number().int().positive(),
  })
  .strict();

export const chapterCreateSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    intro: z.string().max(10_000).default(''),
  })
  .strict();

export const chapterUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    intro: z.string().max(10_000).optional(),
    version: z.number().int().positive(),
  })
  .strict();

export const chapterBlockCreateSchema = z
  .object({
    type: z.string().trim().min(1).max(40).default('paragraph'),
    position: z.string().trim().min(1).max(100).optional(),
    content: z.unknown().optional(),
    clipId: z.string().uuid().nullable().optional(),
  })
  .strict();

export const RECORDING_STATUSES = ['UPLOADING', 'PROCESSING', 'READY', 'FAILED'] as const;
export const recordingStatusSchema = z.enum(RECORDING_STATUSES);
export type RecordingStatus = z.infer<typeof recordingStatusSchema>;

// 录音状态机：UPLOADING/PROCESSING 为进行中，READY/FAILED 为终态。
// 状态只能沿 rank 单调前进，到达终态后不允许回退到进行中的旧值。
export const recordingStatusRank: Record<RecordingStatus, number> = {
  UPLOADING: 0,
  PROCESSING: 1,
  READY: 2,
  FAILED: 2,
};

export const isTerminalRecordingStatus = (status: RecordingStatus): boolean =>
  recordingStatusRank[status] >= recordingStatusRank.READY;

export interface RecordingProgressSnapshot {
  status: RecordingStatus;
  processingProgress?: number | null;
}

// 合并同一条录音的两份快照（本地当前值 + 轮询返回值），保证状态与进度单调不回退。
export function mergeRecordingSnapshot<T extends RecordingProgressSnapshot>(
  current: T,
  incoming: T,
): T {
  const status =
    recordingStatusRank[incoming.status] >= recordingStatusRank[current.status]
      ? incoming.status
      : current.status;
  const processingProgress = Math.min(
    100,
    Math.max(
      0,
      current.processingProgress ?? 0,
      incoming.processingProgress ?? 0,
      status === 'READY' ? 100 : 0,
    ),
  );
  return { ...incoming, status, processingProgress };
}

export interface RecordingCursorSnapshot extends RecordingProgressSnapshot {
  id: string;
  createdAt?: string | null;
}

// 与列表接口的排序保持一致：createdAt 倒序，id 倒序作为次序兜底。
export function compareRecordingCursor(
  a: RecordingCursorSnapshot,
  b: RecordingCursorSnapshot,
): number {
  const timeA = a.createdAt ? Date.parse(a.createdAt) : Number.NaN;
  const timeB = b.createdAt ? Date.parse(b.createdAt) : Number.NaN;
  if (Number.isFinite(timeA) && Number.isFinite(timeB) && timeA !== timeB) {
    return timeB - timeA;
  }
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

// 把轮询得到的最新一页合并进已加载列表：
// - 已存在的条目按 id 原地合并（状态/进度单调），保持既有顺序，游标不漂移；
// - 响应中出现的新条目（如刚上传）按服务端顺序插入头部；
// - 轮询窗口覆盖范围内却缺席的条目说明已不再匹配筛选条件，移除；
// - 窗口之外的本地条目保持原样，避免误删。
export function mergePolledRecordings<T extends RecordingCursorSnapshot>(
  current: T[],
  incoming: T[],
): T[] {
  if (incoming.length === 0) return [];

  const currentById = new Map(current.map((item) => [item.id, item]));
  const incomingIds = new Set(incoming.map((item) => item.id));
  const merged = incoming.map((item) => {
    const existing = currentById.get(item.id);
    return existing ? mergeRecordingSnapshot(existing, item) : item;
  });

  const windowOldest = incoming[incoming.length - 1];
  const overflow = current.filter(
    (item) => !incomingIds.has(item.id) && compareRecordingCursor(item, windowOldest) > 0,
  );
  return [...merged, ...overflow];
}

export type RecordingCursor = { createdAtMs: number; id: string };

const CURSOR_PATTERN = /^(\d{1,15})\.([A-Za-z0-9-]{1,64})$/;

export function encodeRecordingCursor(cursor: RecordingCursor): string {
  return `${cursor.createdAtMs}.${cursor.id}`;
}

export function decodeRecordingCursor(value: string): RecordingCursor | null {
  const match = CURSOR_PATTERN.exec(value);
  if (!match) return null;
  const createdAtMs = Number(match[1]);
  if (!Number.isSafeInteger(createdAtMs)) return null;
  return { createdAtMs, id: match[2] };
}

const statusFilterSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .transform((value, ctx) => {
    const statuses = [
      ...new Set(value.split(',').map((item) => item.trim()).filter(Boolean)),
    ];
    const parsed = z.array(recordingStatusSchema).safeParse(statuses);
    if (!parsed.success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid recording status' });
      return z.NEVER;
    }
    return parsed.data;
  });

export const recordingListQuerySchema = z
  .object({
    status: statusFilterSchema.optional(),
    q: z.string().trim().min(1).max(120).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
    cursor: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export type Role = z.infer<typeof roleSchema>;
export type ClipInput = z.infer<typeof clipSchema>;
export type ClipUpdateInput = z.infer<typeof clipUpdateSchema>;
export type ChapterCreateInput = z.infer<typeof chapterCreateSchema>;
export type ChapterUpdateInput = z.infer<typeof chapterUpdateSchema>;
export type ChapterBlockCreateInput = z.infer<typeof chapterBlockCreateSchema>;
export type RecordingListQuery = z.infer<typeof recordingListQuerySchema>;

export const apiError = (code: string, message: string, details?: unknown) => ({
  error: { code, message, details },
  requestId: '',
});
