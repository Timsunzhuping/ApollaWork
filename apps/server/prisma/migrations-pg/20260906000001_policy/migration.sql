-- T-413 策略中心：审批规则表
CREATE TABLE "Policy" (
    "id" TEXT NOT NULL,
    CONSTRAINT "Policy_pkey" PRIMARY KEY ("id"),
    "orgId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "builtinKey" TEXT,
    "kind" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "flags" TEXT NOT NULL DEFAULT '',
    "reason" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "Policy_orgId_idx" ON "Policy"("orgId");
CREATE INDEX "Policy_orgId_builtinKey_idx" ON "Policy"("orgId", "builtinKey");
