-- CreateEnum
CREATE TYPE "PipelineStatus" AS ENUM ('PENDING', 'RUNNING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "RenditionKind" AS ENUM ('VIDEO', 'MASTER', 'POSTER', 'SPRITE');

-- AlterTable
ALTER TABLE "Asset" ADD COLUMN     "pipeline" "PipelineStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "pipelineError" TEXT,
ADD COLUMN     "pipelinePercent" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pipelineStage" TEXT;

-- CreateTable
CREATE TABLE "MediaRendition" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "kind" "RenditionKind" NOT NULL,
    "name" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "bitrateBps" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaRendition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MediaRendition_storageKey_key" ON "MediaRendition"("storageKey");

-- CreateIndex
CREATE INDEX "MediaRendition_assetId_kind_idx" ON "MediaRendition"("assetId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "MediaRendition_assetId_name_key" ON "MediaRendition"("assetId", "name");

-- AddForeignKey
ALTER TABLE "MediaRendition" ADD CONSTRAINT "MediaRendition_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
