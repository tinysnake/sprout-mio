-- 裁定 d12：insert 触发器与 `chat_kind_immutable` 已封死频道成员行的产生路径，delete 分支不可达、无法被验证，故删除；裁定 d13：0021 已合入 integration/p5a，按 docs/p1/conventions.md「已合并迁移不得原地编辑」用新迁移推进，`IF EXISTS` 让新旧库收敛到同一集合。
DROP TRIGGER IF EXISTS chat_member_no_channel_delete;
