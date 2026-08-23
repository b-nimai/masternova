-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateEnum
CREATE TYPE "CourseStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "CourseLevel" AS ENUM ('BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'ALL_LEVELS');

-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('INR', 'USD');

-- CreateEnum
CREATE TYPE "LectureKind" AS ENUM ('VIDEO', 'ARTICLE');

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Course" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "description" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "level" "CourseLevel" NOT NULL DEFAULT 'ALL_LEVELS',
    "status" "CourseStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMP(3),
    "priceMinor" INTEGER NOT NULL DEFAULT 0,
    "listPriceMinor" INTEGER,
    "currency" "Currency" NOT NULL DEFAULT 'INR',
    "thumbnailKey" TEXT,
    "promoVideoAssetId" TEXT,
    "instructorId" TEXT NOT NULL,
    "categoryId" TEXT,
    "topics" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ratingCount" INTEGER NOT NULL DEFAULT 0,
    "ratingSum" INTEGER NOT NULL DEFAULT 0,
    "ratingAverage" DECIMAL(3,2) NOT NULL DEFAULT 0,
    "enrollmentCount" INTEGER NOT NULL DEFAULT 0,
    "lectureCount" INTEGER NOT NULL DEFAULT 0,
    "totalDurationSeconds" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Course_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Section" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Section_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lecture" (
    "id" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "kind" "LectureKind" NOT NULL DEFAULT 'VIDEO',
    "position" INTEGER NOT NULL,
    "isPreview" BOOLEAN NOT NULL DEFAULT false,
    "durationSeconds" INTEGER NOT NULL DEFAULT 0,
    "assetId" TEXT,
    "articleBody" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lecture_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Category_slug_key" ON "Category"("slug");

-- CreateIndex
CREATE INDEX "Category_parentId_idx" ON "Category"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "Course_slug_key" ON "Course"("slug");

-- CreateIndex
CREATE INDEX "Section_courseId_position_idx" ON "Section"("courseId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "Section_courseId_position_key" ON "Section"("courseId", "position");

-- CreateIndex
CREATE INDEX "Lecture_sectionId_position_idx" ON "Lecture"("sectionId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "Lecture_sectionId_position_key" ON "Lecture"("sectionId", "position");

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Course" ADD CONSTRAINT "Course_instructorId_fkey" FOREIGN KEY ("instructorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Course" ADD CONSTRAINT "Course_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Section" ADD CONSTRAINT "Section_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lecture" ADD CONSTRAINT "Lecture_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "Section"("id") ON DELETE CASCADE ON UPDATE CASCADE;
