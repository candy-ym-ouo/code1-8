import { describe, expect, it } from 'vitest';
import {
  canTransitionRecordingStatus,
  encodeRecordingCursor,
  recordingListQuerySchema,
} from '../src/index.js';

describe('recordingListQuerySchema', () => {
  it('applies defaults and accepts a bare request', () => {
    const parsed = recordingListQuerySchema.parse({});
    expect(parsed.limit).toBe(20);
    expect(parsed.status).toBeUndefined();
    expect(parsed.cursor).toBeUndefined();
  });

  it('accepts ACTIVE as a virtual filtering status', () => {
    const parsed = recordingListQuerySchema.parse({ status: 'ACTIVE' });
    expect(parsed.status).toBe('ACTIVE');
  });

  it('coerces limit and rejects values out of range', () => {
    expect(recordingListQuerySchema.parse({ limit: '50' }).limit).toBe(50);
    expect(recordingListQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(recordingListQuerySchema.safeParse({ limit: 101 }).success).toBe(
      false,
    );
  });

  it('round-trips an opaque keyset cursor', () => {
    const cursor = encodeRecordingCursor({
      createdAt: '2026-09-18T03:00:00.000Z',
      id: '00000000-0000-4000-8000-000000000000',
    });
    const parsed = recordingListQuerySchema.parse({ cursor });
    expect(parsed.cursor?.id).toBe('00000000-0000-4000-8000-000000000000');
    expect(parsed.cursor?.createdAt).toBe('2026-09-18T03:00:00.000Z');
  });

  it('rejects a tampered cursor', () => {
    expect(
      recordingListQuerySchema.safeParse({ cursor: 'not-base64-json' }).success,
    ).toBe(false);
  });

  it('rejects unknown query parameters', () => {
    expect(
      recordingListQuerySchema.safeParse({ workspaceId: 'other' }).success,
    ).toBe(false);
  });
});

describe('canTransitionRecordingStatus', () => {
  it('allows forward transitions while processing', () => {
    expect(canTransitionRecordingStatus('UPLOADING', 'PROCESSING')).toBe(true);
    expect(canTransitionRecordingStatus('PROCESSING', 'READY')).toBe(true);
    expect(canTransitionRecordingStatus('PROCESSING', 'FAILED')).toBe(true);
  });

  it('never rolls a completed recording back to an old value', () => {
    expect(canTransitionRecordingStatus('READY', 'PROCESSING')).toBe(false);
    expect(canTransitionRecordingStatus('READY', 'FAILED')).toBe(false);
    expect(canTransitionRecordingStatus('READY', 'UPLOADING')).toBe(false);
    expect(canTransitionRecordingStatus('FAILED', 'PROCESSING')).toBe(false);
    expect(canTransitionRecordingStatus('PROCESSING', 'UPLOADING')).toBe(false);
  });

  it('keeps a terminal state idempotent', () => {
    expect(canTransitionRecordingStatus('READY', 'READY')).toBe(true);
    expect(canTransitionRecordingStatus('FAILED', 'FAILED')).toBe(true);
  });
});
