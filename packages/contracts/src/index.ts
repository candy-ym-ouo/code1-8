import { z } from 'zod';

export const roleSchema = z.enum(['OWNER', 'EDITOR', 'COMMENTER', 'VIEWER']);

export const recordingStatusSchema = z.enum([
  'UPLOADING',
  'PROCESSING',
  'READY',
  'FAILED',
]);

/**
 * `ACTIVE` 是仅用于筛选的虚拟状态，等价于 UPLOADING + PROCESSING。
 * 录音本身不会落库为 ACTIVE。
 */
export const recordingStatusFilterSchema = z.enum([
  'UPLOADING',
  'PROCESSING',
  'READY',
  'FAILED',
  'ACTIVE',
]);

export const recordingProgressSchema = z
  .number()
  .int()
  .min(0)
  .max(100);

const cursorSchema = z
  .object({
    createdAt: z.string().datetime(),
    id: z.string().uuid(),
  })
  .strict();

export const recordingListQuerySchema = z
  .object({
    status: recordingStatusFilterSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z
      .string()
      .trim()
      .min(1)
      .max(400)
      .transform((value, context) => {
        try {
          const json = JSON.parse(base64UrlDecode(value)) as unknown;
          const parsed = cursorSchema.safeParse(json);
          if (!parsed.success) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'cursor 无效',
            });
            return z.NEVER;
          }
          return parsed.data;
        } catch {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'cursor 无效',
          });
          return z.NEVER;
        }
      })
      .optional(),
  })
  .strict();

export type RecordingStatus = z.infer<typeof recordingStatusSchema>;
export type RecordingStatusFilter = z.infer<typeof recordingStatusFilterSchema>;
export type RecordingListQuery = z.infer<typeof recordingListQuerySchema>;

const RECORDING_STATUS_RANK: Record<RecordingStatus, number> = {
  UPLOADING: 0,
  PROCESSING: 1,
  FAILED: 2,
  READY: 3,
};

/** 终态状态一旦写入就不允许再被旧任务回退 */
export const TERMINAL_RECORDING_STATUSES: readonly RecordingStatus[] = [
  'READY',
  'FAILED',
];

/**
 * 任务完成后状态只能向前跃迁：READY 为最高优先级，任何旧写入都不能让它回退。
 */
export function canTransitionRecordingStatus(
  from: RecordingStatus,
  to: RecordingStatus,
): boolean {
  return RECORDING_STATUS_RANK[to] >= RECORDING_STATUS_RANK[from];
}

export function encodeRecordingCursor(input: {
  createdAt: Date | string;
  id: string;
}): string {
  const createdAt =
    input.createdAt instanceof Date
      ? input.createdAt.toISOString()
      : new Date(input.createdAt).toISOString();
  return base64UrlEncode(JSON.stringify({ createdAt, id: input.id }));
}

const BASE64URL_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function utf8Encode(text: string): number[] {
  const bytes: number[] = [];
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x80) {
      bytes.push(codePoint);
    } else if (codePoint < 0x800) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return bytes;
}

function utf8Decode(bytes: number[]): string {
  let result = '';
  for (let index = 0; index < bytes.length; ) {
    const first = bytes[index];
    if (first < 0x80) {
      result += String.fromCodePoint(first);
      index += 1;
    } else if (first < 0xe0) {
      result += String.fromCodePoint(
        ((first & 0x1f) << 6) | (bytes[index + 1] & 0x3f),
      );
      index += 2;
    } else if (first < 0xf0) {
      result += String.fromCodePoint(
        ((first & 0x0f) << 12) |
          ((bytes[index + 1] & 0x3f) << 6) |
          (bytes[index + 2] & 0x3f),
      );
      index += 3;
    } else {
      result += String.fromCodePoint(
        ((first & 0x07) << 18) |
          ((bytes[index + 1] & 0x3f) << 12) |
          ((bytes[index + 2] & 0x3f) << 6) |
          (bytes[index + 3] & 0x3f),
      );
      index += 4;
    }
  }
  return result;
}

function base64UrlEncode(text: string): string {
  const bytes = utf8Encode(text);
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const chunk =
      (bytes[index] << 16) |
      ((bytes[index + 1] ?? 0) << 8) |
      (bytes[index + 2] ?? 0);
    output += BASE64URL_ALPHABET[(chunk >> 18) & 63];
    output += BASE64URL_ALPHABET[(chunk >> 12) & 63];
    if (index + 1 < bytes.length) output += BASE64URL_ALPHABET[(chunk >> 6) & 63];
    if (index + 2 < bytes.length) output += BASE64URL_ALPHABET[chunk & 63];
  }
  return output;
}

function base64UrlDecode(value: string): string {
  const lookup = new Map(
    [...BASE64URL_ALPHABET].map((character, index) => [character, index]),
  );
  const bytes: number[] = [];
  let chunk = 0;
  let accumulated = 0;
  for (const character of value) {
    const sextet = lookup.get(character);
    if (sextet === undefined) {
      throw new Error('非法的 base64url 字符');
    }
    chunk = (chunk << 6) | sextet;
    accumulated += 6;
    if (accumulated >= 8) {
      accumulated -= 8;
      bytes.push((chunk >> accumulated) & 0xff);
    }
  }
  return utf8Decode(bytes);
}

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

export type Role = z.infer<typeof roleSchema>;
export type ClipInput = z.infer<typeof clipSchema>;
export type ClipUpdateInput = z.infer<typeof clipUpdateSchema>;
export type ChapterCreateInput = z.infer<typeof chapterCreateSchema>;
export type ChapterUpdateInput = z.infer<typeof chapterUpdateSchema>;
export type ChapterBlockCreateInput = z.infer<typeof chapterBlockCreateSchema>;

export const apiError = (code: string, message: string, details?: unknown) => ({
  error: { code, message, details },
  requestId: '',
});
