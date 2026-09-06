-- Apolla Work · 数据库角色分离（T-405）
-- 迁移用 owner 连接（DATABASE_URL_PRISMA）；应用运行时用 apolla_app（DATABASE_URL）；
-- 留存清理任务用 apolla_retention（DATABASE_URL_RETENTION，可选）。
-- 目的：应用凭据被盗也改不了、删不掉审计；DB 触发器（migration 20260906000000_audit_immutable）
-- 是第二道闸，两道都在才叫「不可变」。
--
-- 用法：psql -U <owner> -d apolla -v app_pw='...' -v ret_pw='...' -f infra/sql/roles.sql

\set ON_ERROR_STOP on

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'apolla_app') THEN
    EXECUTE format('CREATE ROLE apolla_app LOGIN PASSWORD %L', :'app_pw');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'apolla_retention') THEN
    EXECUTE format('CREATE ROLE apolla_retention LOGIN PASSWORD %L', :'ret_pw');
  END IF;
END $$;

-- 应用角色：日常读写；审计表只能 INSERT / SELECT
GRANT CONNECT ON DATABASE apolla TO apolla_app;
GRANT USAGE ON SCHEMA public TO apolla_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO apolla_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO apolla_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "AuditEvent" FROM apolla_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO apolla_app;

-- 留存清理角色：只碰会被清理的表；删审计前必须 SET LOCAL apolla.retention_job = 'on'（触发器要求）
GRANT CONNECT ON DATABASE apolla TO apolla_retention;
GRANT USAGE ON SCHEMA public TO apolla_retention;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO apolla_retention;
GRANT DELETE ON "AuditEvent", "UsageRecord", "Task", "TaskEventRow", "Approval", "Artifact" TO apolla_retention;

-- 校验：应用角色对审计表没有 UPDATE/DELETE
SELECT grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_name = 'AuditEvent' AND grantee IN ('apolla_app', 'apolla_retention')
ORDER BY grantee, privilege_type;
