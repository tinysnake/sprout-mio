ALTER TABLE `feishu_route` ADD `opened_at_ms` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `feishu_route` SET `opened_at_ms` = CAST(round((julianday('now') - 2440587.5) * 86400000) AS INTEGER);
--> statement-breakpoint
DROP TRIGGER feishu_route_immutable;
--> statement-breakpoint
CREATE TRIGGER feishu_route_immutable BEFORE UPDATE ON feishu_route
WHEN NEW.id IS NOT OLD.id OR NEW.human_id IS NOT OLD.human_id OR NEW.revision IS NOT OLD.revision OR NEW.app_id IS NOT OLD.app_id OR NEW.tenant_key IS NOT OLD.tenant_key OR NEW.open_id IS NOT OLD.open_id OR NEW.project_id IS NOT OLD.project_id OR NEW.chat_id IS NOT OLD.chat_id OR NEW.opened_at_ms IS NOT OLD.opened_at_ms OR (OLD.closed_at_ms IS NOT NULL AND NEW.closed_at_ms IS NOT OLD.closed_at_ms)
BEGIN SELECT RAISE(ABORT, 'feishu route is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER feishu_route_activation_required BEFORE INSERT ON feishu_route
WHEN NEW.opened_at_ms <= 0
BEGIN SELECT RAISE(ABORT, 'feishu route activation required'); END;
