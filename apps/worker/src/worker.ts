import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { PrismaClient, type RecordingStatus } from '@prisma/client';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseFile } from 'music-metadata';

const execFileAsync = promisify(execFile);
const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

/**
 * 有条件的原子状态写入：只有当前状态允许跃迁时才更新。
 * 终态（READY/FAILED）一旦落库，任何重试、延迟回调或 stalled 复活的旧任务
 * 都无法把它改回 PROCESSING。返回 true 表示本次写入确实生效。
 *
 * 允许的跃迁（与 contracts.canTransitionRecordingStatus 一致，rank 单调不减）：
 * - -> PROCESSING：仅 UPLOADING / PROCESSING（含幂等自写）
 * - -> READY：任意非 READY 状态（FAILED 可被重新入队的任务挽回）
 * - -> FAILED：UPLOADING / PROCESSING / FAILED，但永远不能覆盖 READY
 */
async function transitionRecording(
  recordingId: string,
  nextStatus: RecordingStatus,
  data: {
    durationMs?: number;
    playbackPath?: string | null;
    processingError?: string | null;
  } = {},
): Promise<boolean> {
  const allowedCurrent: RecordingStatus[] =
    nextStatus === 'PROCESSING'
      ? ['UPLOADING', 'PROCESSING']
      : nextStatus === 'READY'
        ? ['UPLOADING', 'PROCESSING', 'FAILED']
        : ['UPLOADING', 'PROCESSING', 'FAILED'];

  const result = await prisma.recording.updateMany({
    where: { id: recordingId, status: { in: allowedCurrent } },
    data: { status: nextStatus, ...data },
  });
  return result.count > 0;
}

/** 进度只允许单调递增，重试任务不能把已经看到的进度刷回更低的值 */
async function reportProgress(
  recordingId: string,
  progress: number,
): Promise<void> {
  await prisma.recording.updateMany({
    where: { id: recordingId, progress: { lt: progress } },
    data: { progress: Math.min(100, Math.max(0, Math.round(progress))) },
  });
}

async function probeWithFfprobe(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      filePath,
    ],
    { timeout: 60_000, maxBuffer: 1024 * 1024 },
  );
  const seconds = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error('ffprobe 未返回有效时长');
  }
  return Math.round(seconds * 1000);
}

async function probeWithMusicMetadata(filePath: string): Promise<number> {
  const metadata = await parseFile(filePath, { duration: true });
  const seconds = metadata.format.duration;
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    throw new Error('无法读取音频时长');
  }
  return Math.round(seconds * 1000);
}

async function probeDurationMs(
  filePath: string,
  onProgress?: (progress: number) => Promise<void>,
): Promise<number> {
  await onProgress?.(10);
  try {
    const durationMs = await probeWithFfprobe(filePath);
    await onProgress?.(90);
    return durationMs;
  } catch (ffprobeError) {
    await onProgress?.(40);
    let durationMs: number;
    try {
      durationMs = await probeWithMusicMetadata(filePath);
    } catch (metadataError) {
      const ffprobeMessage =
        ffprobeError instanceof Error ? ffprobeError.message : String(ffprobeError);
      const metadataMessage =
        metadataError instanceof Error ? metadataError.message : String(metadataError);
      throw new Error(
        `无法解析音频元数据（ffprobe: ${ffprobeMessage}; fallback: ${metadataMessage}）`,
      );
    }
    await onProgress?.(90);
    return durationMs;
  }
}

async function processMediaJob(job: Job) {
  const recordingId = String(job.data?.recordingId || '');
  if (!recordingId) throw new Error('任务缺少 recordingId');

  const recording = await prisma.recording.findUnique({ where: { id: recordingId } });
  if (!recording) throw new Error(`录音不存在: ${recordingId}`);

  // 仅当仍处于非终态时才把状态推进到 PROCESSING；已是 READY 的记录直接放行，
  // 不做任何回退写入。
  await transitionRecording(recordingId, 'PROCESSING', { processingError: null });

  const durationMs = await probeDurationMs(recording.originalPath, (progress) =>
    reportProgress(recordingId, progress),
  );
  if (durationMs <= 0) throw new Error('音频时长为 0，无法进入编辑');

  // 终态跃迁，一次到位；若已被其他执行路径置为终态，则不再覆盖。
  const applied = await transitionRecording(recordingId, 'READY', {
    durationMs,
    playbackPath: recording.playbackPath || recording.originalPath,
    processingError: null,
  });
  if (applied) {
    await reportProgress(recordingId, 100);
  }

  return { recordingId, durationMs };
}

const worker = new Worker('media', processMediaJob, {
  connection: redis,
  concurrency: 2,
});

worker.on('completed', (job) => {
  console.log(`media job ${job.id} completed`);
});

worker.on('failed', async (job, error) => {
  const recordingId = job?.data?.recordingId;
  if (!recordingId) return;

  const maxAttempts = job.opts.attempts ?? 1;
  const hasAttemptsLeft = job.attemptsMade < maxAttempts;
  try {
    if (hasAttemptsLeft) {
      // 仍可能重试：仅在非终态时回到 PROCESSING。
      await transitionRecording(String(recordingId), 'PROCESSING', {
        processingError: error.message,
      });
    } else {
      // 最终失败也是终态：READY 的录音永远不会被失败回调覆盖。
      await transitionRecording(String(recordingId), 'FAILED', {
        processingError: error.message,
      });
    }
  } catch (updateError) {
    console.error(`failed to persist media job error for ${recordingId}`, updateError);
  }
});

worker.on('error', (error) => {
  console.error('media worker error', error);
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`received ${signal}, shutting down media worker`);
  await worker.close();
  if (redis.status !== 'end') redis.disconnect();
  await prisma.$disconnect();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

console.log('media worker listening');
