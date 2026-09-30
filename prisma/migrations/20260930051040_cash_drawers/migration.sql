-- ═══ backfill: cash drawers ═══

-- ١) درج افتراضي لكل فرع
INSERT INTO cash_drawers (
  tenant_id, branch_id, name, is_active,
  last_counted_balance, last_counted_at,
  created_at, updated_at, sync_status
)
SELECT
  b.tenant_id, b.id, 'الدرج الرئيسي', true,
  0, NOW(),
  NOW(), NOW(), 'synced'::"SyncStatus"
FROM branches b
WHERE NOT EXISTS (
  SELECT 1 FROM cash_drawers d WHERE d.branch_id = b.id
);

-- ٢) الورديات القديمة تتربط بدرج فرعها
UPDATE shifts s
SET drawer_id = d.id
FROM cash_drawers d
WHERE d.branch_id = s.branch_id
  AND s.drawer_id IS NULL;

-- ٣) تنضيف الورديات المفتوحة المكررة قبل الـ index
UPDATE shifts s
SET closed_at   = NOW(),
    closed_by   = s.user_id,
    sync_status = 'synced'::"SyncStatus"
WHERE s.closed_at IS NULL
  AND s.id <> (
    SELECT s2.id FROM shifts s2
    WHERE s2.user_id = s.user_id AND s2.closed_at IS NULL
    ORDER BY s2.opened_at DESC, s2.id DESC
    LIMIT 1
  );

-- ٤) وردية واحدة مفتوحة لكل موظف
CREATE UNIQUE INDEX IF NOT EXISTS shifts_one_open_per_user
  ON shifts (user_id)
  WHERE closed_at IS NULL;