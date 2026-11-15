CREATE TRIGGER `lease_grant_run_instance_guard` BEFORE INSERT ON lease_grant
WHEN NOT EXISTS (
  SELECT 1 FROM agent_run r
  WHERE r.id = NEW.grantee_run_id
    AND r.project_id = NEW.project_id
    AND r.instance_id = NEW.grantee_instance_id
)
BEGIN
  SELECT RAISE(ABORT, 'lease_grant_run_instance_mismatch');
END;--> statement-breakpoint
CREATE TRIGGER `lease_grant_run_instance_guard_update` BEFORE UPDATE OF grantee_run_id, grantee_instance_id, project_id ON lease_grant
WHEN NOT EXISTS (
  SELECT 1 FROM agent_run r
  WHERE r.id = NEW.grantee_run_id
    AND r.project_id = NEW.project_id
    AND r.instance_id = NEW.grantee_instance_id
)
BEGIN
  SELECT RAISE(ABORT, 'lease_grant_run_instance_mismatch');
END;
