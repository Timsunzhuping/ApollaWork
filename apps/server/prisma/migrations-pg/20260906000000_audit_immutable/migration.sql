-- T-405 审计不可变（DB 层机制，不再只是代码约定）
-- 任何连接对 "AuditEvent" 的 UPDATE / DELETE 一律拒绝；
-- 只有留存清理任务在同一事务内显式声明 SET LOCAL apolla.retention_job = 'on' 才能删除
-- （且它删除前已把行归档为带哈希链的 JSONL）。应用凭据被盗也抹不掉审计。

CREATE OR REPLACE FUNCTION apolla_audit_guard() RETURNS trigger AS $$
BEGIN
  IF current_setting('apolla.retention_job', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'AuditEvent 不可修改或删除（审计不可变，T-405）'
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_immutable ON "AuditEvent";
CREATE TRIGGER audit_immutable
  BEFORE UPDATE OR DELETE ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION apolla_audit_guard();

-- TRUNCATE 绕过行级触发器：单独拦
CREATE OR REPLACE FUNCTION apolla_audit_no_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditEvent 不可清空（审计不可变，T-405）' USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_no_truncate ON "AuditEvent";
CREATE TRIGGER audit_no_truncate
  BEFORE TRUNCATE ON "AuditEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION apolla_audit_no_truncate();
