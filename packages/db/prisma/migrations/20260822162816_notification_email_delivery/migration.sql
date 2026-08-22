-- CreateEnum
CREATE TYPE "NotificationCategory" AS ENUM ('ACCOUNT_SECURITY', 'PURCHASE', 'COURSE_ACTIVITY', 'ENGAGEMENT', 'PRODUCT_NEWS');

-- CreateEnum
CREATE TYPE "EmailDeliveryStatus" AS ENUM ('SENDING', 'SENT', 'FAILED', 'SUPPRESSED', 'BOUNCED', 'COMPLAINED');

-- CreateEnum
CREATE TYPE "SuppressionReason" AS ENUM ('HARD_BOUNCE', 'COMPLAINT', 'MANUAL');

-- CreateTable
CREATE TABLE "EmailDelivery" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "userId" TEXT,
    "category" "NotificationCategory" NOT NULL,
    "subject" TEXT NOT NULL,
    "status" "EmailDeliveryStatus" NOT NULL DEFAULT 'SENDING',
    "providerMessageId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "detail" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailSuppression" (
    "email" TEXT NOT NULL,
    "reason" "SuppressionReason" NOT NULL,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailSuppression_pkey" PRIMARY KEY ("email")
);

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "userId" TEXT NOT NULL,
    "category" "NotificationCategory" NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("userId","category")
);

-- CreateIndex
CREATE INDEX "EmailDelivery_recipient_createdAt_idx" ON "EmailDelivery"("recipient", "createdAt");

-- CreateIndex
CREATE INDEX "EmailDelivery_status_createdAt_idx" ON "EmailDelivery"("status", "createdAt");

-- CreateIndex
CREATE INDEX "EmailDelivery_providerMessageId_idx" ON "EmailDelivery"("providerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailDelivery_eventId_template_recipient_key" ON "EmailDelivery"("eventId", "template", "recipient");

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
