-- CreateIndex
CREATE INDEX "Course_status_publishedAt_id_idx" ON "Course"("status", "publishedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Course_status_categoryId_publishedAt_id_idx" ON "Course"("status", "categoryId", "publishedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Course_status_ratingAverage_id_idx" ON "Course"("status", "ratingAverage" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Course_instructorId_updatedAt_idx" ON "Course"("instructorId", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "Course_title_idx" ON "Course" USING GIN ("title" gin_trgm_ops);
