-- CreateTable
CREATE TABLE "CourseEdit" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "command" JSONB NOT NULL,
    "inverse" JSONB NOT NULL,
    "version" INTEGER NOT NULL,
    "undoneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CourseEdit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CourseEdit_courseId_undoneAt_version_idx" ON "CourseEdit"("courseId", "undoneAt", "version" DESC);

-- AddForeignKey
ALTER TABLE "CourseEdit" ADD CONSTRAINT "CourseEdit_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;
