-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "location" TEXT,
    "country" TEXT,
    "roleCategory" TEXT NOT NULL,
    "sector" TEXT NOT NULL DEFAULT 'TECH',
    "workMode" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "seniority" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "employmentType" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "description" TEXT NOT NULL,
    "skills" JSONB NOT NULL,
    "requirements" JSONB NOT NULL,
    "salaryMin" INTEGER,
    "salaryMax" INTEGER,
    "salaryCurrency" TEXT,
    "sourceName" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "applyUrl" TEXT,
    "externalId" TEXT,
    "dedupeHash" TEXT NOT NULL,
    "postedAt" DATETIME,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "user_profiles" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fullName" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "location" TEXT,
    "headline" TEXT,
    "summary" TEXT,
    "linkedinUrl" TEXT,
    "githubUrl" TEXT,
    "portfolioUrl" TEXT,
    "baseResumeText" TEXT,
    "baseResumeFileName" TEXT,
    "baseResumePath" TEXT,
    "baseResumeMime" TEXT,
    "baseResumeSize" INTEGER,
    "skills" JSONB NOT NULL,
    "experience" JSONB NOT NULL,
    "education" JSONB NOT NULL,
    "targetRoles" JSONB NOT NULL,
    "preferredWorkModes" JSONB NOT NULL,
    "preferredLocations" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "applications" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SAVED',
    "appliedAt" DATETIME,
    "followUpAt" DATETIME,
    "nextStep" TEXT,
    "notes" TEXT,
    "atsScore" INTEGER,
    "atsReport" JSONB,
    "atsRulesVersion" TEXT,
    "atsAnalyzedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "applications_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "applications_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "user_profiles" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "application_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "applicationId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "note" TEXT,
    "occurredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "application_events_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "generated_documents" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "applicationId" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "contentMarkdown" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "model" TEXT,
    "promptFile" TEXT,
    "promptHash" TEXT,
    "atsScore" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "generated_documents_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "generated_documents_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "jobs_dedupeHash_key" ON "jobs"("dedupeHash");

-- CreateIndex
CREATE INDEX "jobs_roleCategory_idx" ON "jobs"("roleCategory");

-- CreateIndex
CREATE INDEX "jobs_sector_idx" ON "jobs"("sector");

-- CreateIndex
CREATE INDEX "jobs_workMode_idx" ON "jobs"("workMode");

-- CreateIndex
CREATE INDEX "jobs_isActive_postedAt_idx" ON "jobs"("isActive", "postedAt");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_sourceName_externalId_key" ON "jobs"("sourceName", "externalId");

-- CreateIndex
CREATE INDEX "applications_profileId_idx" ON "applications"("profileId");

-- CreateIndex
CREATE INDEX "applications_status_idx" ON "applications"("status");

-- CreateIndex
CREATE INDEX "applications_followUpAt_idx" ON "applications"("followUpAt");

-- CreateIndex
CREATE UNIQUE INDEX "applications_jobId_profileId_key" ON "applications"("jobId", "profileId");

-- CreateIndex
CREATE INDEX "application_events_applicationId_occurredAt_idx" ON "application_events"("applicationId", "occurredAt");

-- CreateIndex
CREATE INDEX "generated_documents_jobId_type_idx" ON "generated_documents"("jobId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "generated_documents_applicationId_type_version_key" ON "generated_documents"("applicationId", "type", "version");
