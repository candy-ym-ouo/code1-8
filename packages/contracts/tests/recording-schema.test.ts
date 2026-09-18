import { describe, expect, it } from 'vitest';
import {
  decodeRecordingCursor,
  encodeRecordingCursor,
  isTerminalRecordingStatus,
  mergePolledRecordings,
  mergeRecordingSnapshot,
  recordingListQuerySchema,
} from '../src/index.js';

describe('recordingListQuerySchema', () => {
  it('applies defaults when no query is given', () => {
    const parsed = recordingListQuerySchema.parse({});

    expect(parsed.limit).toBe(30);
    expect(parsed.status).toBeUndefined();
    expect(parsed.cursor).toBeUndefined();
  });

  it('parses a comma separated status filter and dedupes values', () => {
    const parsed = recordingListQuerySchema.parse({
      status: 'READY, PROCESSING,READY',
    });

    expect(parsed.status).toEqual(['READY', 'PROCESSING']);
  });

  it('rejects unknown statuses', () => {
    const parsed = recordingListQuerySchema.safeParse({ status: 'READY,NOPE' });

    expect(parsed.success).toBe(false);
  });

  it('rejects unknown query keys instead of silently ignoring them', () => {
    const parsed = recordingListQuerySchema.safeParse({ offset: '10' });

    expect(parsed.success).toBe(false);
  });

  it('enforces limit bounds', () => {
    expect(recordingListQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(recordingListQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(recordingListQuerySchema.parse({ limit: '50' }).limit).toBe(50);
  });
});

describe('recording cursor codec', () => {
  it('round-trips a cursor', () => {
    const cursor = { createdAtMs: 1758096000000, id: 'b2c3d4e5-1234-4abc-8def-0123456789ab' };

    expect(decodeRecordingCursor(encodeRecordingCursor(cursor))).toEqual(cursor);
  });

  it('rejects malformed cursors', () => {
    expect(decodeRecordingCursor('')).toBeNull();
    expect(decodeRecordingCursor('not-a-cursor')).toBeNull();
    expect(decodeRecordingCursor('abc.123')).toBeNull();
    expect(decodeRecordingCursor('123.')).toBeNull();
    expect(decodeRecordingCursor('123.has space')).toBeNull();
  });
});

describe('mergeRecordingSnapshot', () => {
  it('keeps the terminal status when a stale poll regresses', () => {
    const merged = mergeRecordingSnapshot(
      { status: 'READY' as const, processingProgress: 100 },
      { status: 'PROCESSING' as const, processingProgress: 40 },
    );

    expect(merged.status).toBe('READY');
    expect(merged.processingProgress).toBe(100);
  });

  it('never decreases progress', () => {
    const merged = mergeRecordingSnapshot(
      { status: 'PROCESSING' as const, processingProgress: 80 },
      { status: 'PROCESSING' as const, processingProgress: 30 },
    );

    expect(merged.processingProgress).toBe(80);
  });

  it('jumps once to READY and forces progress to 100', () => {
    const merged = mergeRecordingSnapshot(
      { status: 'PROCESSING' as const, processingProgress: 55 },
      { status: 'READY' as const, processingProgress: 70 },
    );

    expect(merged.status).toBe('READY');
    expect(merged.processingProgress).toBe(100);
  });

  it('keeps FAILED terminal and takes newer fields from incoming', () => {
    const merged = mergeRecordingSnapshot(
      { status: 'FAILED' as const, processingProgress: 20, title: '旧标题' },
      { status: 'PROCESSING' as const, processingProgress: 90, title: '新标题' },
    );

    expect(merged.status).toBe('FAILED');
    expect(merged.processingProgress).toBe(90);
    expect(merged.title).toBe('新标题');
  });

  it('marks only READY and FAILED as terminal', () => {
    expect(isTerminalRecordingStatus('READY')).toBe(true);
    expect(isTerminalRecordingStatus('FAILED')).toBe(true);
    expect(isTerminalRecordingStatus('PROCESSING')).toBe(false);
    expect(isTerminalRecordingStatus('UPLOADING')).toBe(false);
  });
});

describe('mergePolledRecordings', () => {
  const row = (
    id: string,
    createdAt: string,
    status: 'UPLOADING' | 'PROCESSING' | 'READY' | 'FAILED' = 'READY',
    processingProgress = 100,
  ) => ({ id, createdAt, status, processingProgress });

  it('updates existing rows in place without reordering them', () => {
    const current = [
      row('a', '2026-09-18T03:00:00.000Z', 'PROCESSING', 40),
      row('b', '2026-09-18T02:00:00.000Z'),
    ];
    const incoming = [
      row('a', '2026-09-18T03:00:00.000Z', 'PROCESSING', 60),
      row('b', '2026-09-18T02:00:00.000Z'),
    ];

    const merged = mergePolledRecordings(current, incoming);

    expect(merged.map((item) => item.id)).toEqual(['a', 'b']);
    expect(merged[0].processingProgress).toBe(60);
  });

  it('prepends genuinely new rows and keeps the cursor window stable', () => {
    const current = [row('b', '2026-09-18T02:00:00.000Z')];
    const incoming = [
      row('c', '2026-09-18T04:00:00.000Z', 'PROCESSING', 10),
      row('b', '2026-09-18T02:00:00.000Z'),
    ];

    const merged = mergePolledRecordings(current, incoming);

    expect(merged.map((item) => item.id)).toEqual(['c', 'b']);
  });

  it('removes rows that left the filter inside the polled window', () => {
    const current = [
      row('a', '2026-09-18T03:00:00.000Z', 'PROCESSING', 90),
      row('b', '2026-09-18T02:00:00.000Z', 'PROCESSING', 10),
    ];
    // 筛选 PROCESSING 时 a 已变为 READY，不再出现在响应里
    const incoming = [row('b', '2026-09-18T02:00:00.000Z', 'PROCESSING', 20)];

    const merged = mergePolledRecordings(current, incoming);

    expect(merged.map((item) => item.id)).toEqual(['b']);
  });

  it('keeps rows that fall outside the polled window', () => {
    const current = [
      row('a', '2026-09-18T03:00:00.000Z'),
      row('b', '2026-09-18T02:00:00.000Z'),
      row('c', '2026-09-18T01:00:00.000Z'),
    ];
    // 新上传的 d 把 c 挤出了轮询窗口
    const incoming = [
      row('d', '2026-09-18T04:00:00.000Z', 'PROCESSING', 5),
      row('a', '2026-09-18T03:00:00.000Z'),
      row('b', '2026-09-18T02:00:00.000Z'),
    ];

    const merged = mergePolledRecordings(current, incoming);

    expect(merged.map((item) => item.id)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('clears the list when nothing matches the filter anymore', () => {
    const merged = mergePolledRecordings(
      [row('a', '2026-09-18T03:00:00.000Z', 'PROCESSING', 10)],
      [],
    );

    expect(merged).toEqual([]);
  });

  it('does not regress a row when poll responses arrive out of order', () => {
    const current = [row('a', '2026-09-18T03:00:00.000Z', 'READY', 100)];
    const stale = [row('a', '2026-09-18T03:00:00.000Z', 'PROCESSING', 70)];

    const merged = mergePolledRecordings(current, stale);

    expect(merged[0].status).toBe('READY');
    expect(merged[0].processingProgress).toBe(100);
  });
});
