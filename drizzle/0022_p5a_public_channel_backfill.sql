-- I-P5a 公共频道回填：每个 Project 至多一条 kind='public_channel' 的对话。
-- 幂等由 WHERE NOT EXISTS 与部分唯一索引 chat_public_channel_project_unique 共同保证，重复执行不报错也不补第二条。
-- id 用 cnv_ 前缀的 UUID v4 形状：contracts/chat.ts 的 chatId 校验（appIdPattern(ID_PREFIXES.chat)）
-- 会拒绝裁定 §5.3 草拟的 chat_<hex> 形状，见 reports/contracts.md 的偏差记录。
INSERT INTO chat (
  id,
  project_id,
  kind,
  title,
  owner_kind,
  owner_id,
  wake_policy,
  governance_revision,
  created_by,
  created_at,
  updated_at
)
SELECT
  'cnv_' || lower(hex(randomblob(4)))
    || '-' || lower(hex(randomblob(2)))
    || '-4' || substr(lower(hex(randomblob(2))), 2, 3)
    || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2, 3)
    || '-' || lower(hex(randomblob(6))) AS id,
  p.id AS project_id,
  'public_channel' AS kind,
  NULL AS title,
  'human' AS owner_kind,
  p.created_by AS owner_id,
  'owner_led' AS wake_policy,
  0 AS governance_revision,
  p.created_by AS created_by,
  unixepoch() AS created_at,
  unixepoch() AS updated_at
FROM project p
WHERE NOT EXISTS (
  SELECT 1 FROM chat c
  WHERE c.project_id = p.id AND c.kind = 'public_channel'
);
