# تقرير بقايا بيانات الاختبار (قراءة فقط) — قاعدة التطوير المحلية

**القاعدة:** `moroccan_taste_pos`@`DESKTOP-PG1F13S` — **تاريخ التوليد:** 2026-07-20T09:32:49.649Z

> هذا التقرير **قراءة فقط بالكامل**. لا يحذف ولا يعدّل أي شيء. أي تنظيف فعلي لما يظهر هنا قرار منفصل يحتاج مراجعة بشرية صريحة.

## الفحص المعروف (جداول/أعمدة محددة سلفًا حسب أنماط fixtures الفعلية)

- `users.username LIKE 'itest_%'` — **0** صفًا
- `gl_accounts.id LIKE 'ITEST-%'` — **0** صفًا
- `gl_accounts.code LIKE 'ITEST%'` — **0** صفًا
- `gl_journals.id LIKE 'ITEST-%'` — **0** صفًا
- `gl_journals.journal_number LIKE 'ITEST-%'` — **0** صفًا
- `gl_entries.id LIKE 'ITEST-%'` — **0** صفًا
- `account_roles.id LIKE 'AR-%'` — **0** صفًا
- `account_role_history.id LIKE 'ARH-%'` — **0** صفًا
- `companies.id LIKE 'ITEST-%'` — **0** صفًا
- `settings.setting_key = 'user_meta'` — غير موجود (فحص وجود فقط؛ وجوده ليس بالضرورة بقايا — قد يكون إعدادًا حقيقيًا. existence check only — a present row is not automatically residue, see report note)
- `audit_logs.entity_id LIKE 'ITEST-%'` — **39** صفًا (عيّنة أدناه)
  ```json
  [
    {
      "id": 2091,
      "user_username": "itest_mc_checker",
      "action": "approve_post_journal",
      "entity_type": "gl_journal",
      "entity_id": "ITEST-MC-J-SELF",
      "details": "{\"bulk\":true}",
      "ip_address": "::ffff:127.0.0.1",
      "user_agent": null,
      "created_at": "2026-07-20T08:59:00.000Z"
    },
    {
      "id": 2089,
      "user_username": "itest_mc_maker",
      "action": "approve_journal_denied_sod",
      "entity_type": "gl_journal",
      "entity_id": "ITEST-MC-J-SELF",
      "details": "{\"bulk\":true,\"status\":\"draft\",\"code\":\"sod-self-approval-denied\"}",
      "ip_address": "::ffff:127.0.0.1",
      "user_agent": null,
      "created_at": "2026-07-20T08:59:00.000Z"
    },
    {
      "id": 1976,
      "user_username": "itest_mc_checker",
      "action": "approve_post_journal",
      "entity_type": "gl_journal",
      "entity_id": "ITEST-MC-J-SELF",
      "details": "{\"bulk\":true}",
      "ip_address": "::ffff:127.0.0.1",
      "user_agent": null,
      "created_at": "2026-07-20T07:27:32.000Z"
    },
    {
      "id": 1974,
      "user_username": "itest_mc_maker",
      "action": "approve_journal_denied_sod",
      "entity_type": "gl_journal",
      "entity_id": "ITEST-MC-J-SELF",
      "details": "{\"bulk\":true,\"status\":\"draft\",\"code\":\"sod-self-approval-denied\"}",
      "ip_address": "::ffff:127.0.0.1",
      "user_agent": null,
      "created_at": "2026-07-20T07:27:31.000Z"
    },
    {
      "id": 1940,
      "user_username": "itest_mc_checker",
      "action": "approve_post_journal",
      "entity_type": "gl_journal",
      "entity_id": "ITEST-MC-J-SELF",
      "details": "{\"bulk\":true}",
      "ip_address": "::ffff:127.0.0.1",
      "user_agent": null,
      "created_at": "2026-07-20T07:17:44.000Z"
    },
    {
      "id": 1938,
      "user_username": "itest_mc_maker",
      "action": "approve_journal_denied_sod",
      "entity_type": "gl_journal",
      "entity_id": "ITEST-MC-J-SELF",
      "details": "{\"bulk\":true,\"status\":\"draft\",\"code\":\"sod-self-approval-denied\"}",
      "ip_address": "::ffff:127.0.0.1",
      "user_agent": null,
      "created_at": "2026-07-20T07:17:44.000Z"
    },
    {
      "id": 693,
      "user_username": "itest_per_admin",
      "action": "CREATE",
      "entity_type": "erp",
      "entity_id": "ITEST-PER-1",
      "details": "{\"method\":\"POST\",\"path\":\"/api/erp/periods/ITEST-PER-1/lock\",\"body\":{\"status\":\"soft_closed\"}}",
      "ip_address": "::ffff:127.0.0.1",
      "user_agent": null,
      "created_at": "2026-07-18T23:01:52.000Z"
    },
    {
      "id": 694,
      "user_username": "itest_per_admin",
      "action": "CREATE",
      "entity_type": "erp",
      "entity_id": "ITEST-PER-1",
      "details": "{\"method\":\"POST\",\"path\":\"/api/erp/periods/ITEST-PER-1/lock\",\"body\":{\"status\":\"closed\",\"username\":\"someone_else\"}}",
      "ip_address": "::ffff:127.0.0.1",
      "user_agent": null,
      "created_at": "2026-07-18T23:01:52.000Z"
    },
    {
      "id": 695,
      "user_username": "itest_per_admin",
      "action": "CREATE",
      "entity_type": "erp",
      "entity_id": "ITEST-PER-1",
      "details": "{\"method\":\"POST\",\"path\":\"/api/erp/periods/ITEST-PER-1/lock\",\"body\":{\"status\":\"open\",\"force\":true}}",
      "ip_address": "::ffff:127.0.0.1",
      "user_agent": null,
      "created_at": "2026-07-18T23:01:52.000Z"
    },
    {
      "id": 1227,
      "user_username": "itest_per_admin",
      "action": "CREATE",
      "entity_type": "erp",
      "entity_id": "ITEST-PER-1",
      "details": "{\"method\":\"POST\",\"path\":\"/api/erp/periods/ITEST-PER-1/lock\",\"body\":{\"status\":\"soft_closed\"}}",
      "ip_address": "::ffff:127.0.0.1",
      "user_agent": null,
      "created_at": "2026-07-18T23:24:58.000Z"
    }
  ]
  ```

**إجمالي البقايا المعروفة:** 39 صفًا عبر الجداول المفحوصة أعلاه (باستثناء فحص settings الذي هو وجود لا عدّ).

## الفحص الشامل (كل عمود VARCHAR/TEXT في كل جدول، بحثًا عن ITEST-/itest_ خارج القائمة أعلاه)

لا شيء — لم يُعثر على أي عمود إضافي يحوي بادئة ITEST-/itest_ خارج الجداول المفحوصة أعلاه.

**إجمالي بقايا الفحص الشامل الإضافية:** 0 صفًا.

## الخلاصة

**39 صفًا من البقايا المحتملة مكتشفة.** هذا التقرير لا يحذفها — راجع القوائم أعلاه وقرر يدويًا.
