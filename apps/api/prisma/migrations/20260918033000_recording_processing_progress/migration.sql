-- AlterTable
ALTER TABLE "Recording" ADD COLUMN "processingProgress" INTEGER NOT NULL DEFAULT 0;

-- Backfill：已就绪的录音处理进度视为 100
UPDATE "Recording" SET "processingProgress" = 100 WHERE "status" = 'READY';

-- CreateIndex：录音列表按工作区 + 状态筛选、按创建时间倒序分页
CREATE INDEX "Recording_workspaceId_status_createdAt_idx" ON "Recording"("workspaceId", "status", "createdAt");
