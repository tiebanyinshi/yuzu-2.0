# 数据字典

> 由 `scripts/gen-data-dictionary.mjs` 从迁移跑完的库生成，**不要手改**。说明取自库内注释（`COMMENT ON`，迁移 `481` 起），
> 改表的迁移里同时写注释，再按脚本开头的命令重新生成；`tests/schema-health.test.ts` 核对这份文档与库一致。评估与规则见 `docs/DB_REVIEW_V8147.md`。

通用约定：金额一律整数「分」（`*_cents`、`amount`、`price` 等整数列）；时刻一律 `timestamptz`；营业日用 `date`；
「只追加」的表（账本、流水、审批动作、归档表）有触发器拒绝改删，改错走冲正或作废登记。
列表里「键」：`PK` 主键；「引用」是外键指向的表。

共 469 张表、5579 列。

## 目录

- **核心与其他**（337）：[acceptance_templates](#acceptance_templates) · [ai_questions](#ai_questions) · [ai_summaries](#ai_summaries) · [ap_entries](#ap_entries) · [ap_offset_lines](#ap_offset_lines) · [ap_offsets](#ap_offsets) · [approval_actions](#approval_actions) · [approval_delegations](#approval_delegations) · [approval_logs](#approval_logs) · [approval_requests](#approval_requests) · [approval_rules](#approval_rules) · [ar_accounts](#ar_accounts) · [ar_allocations](#ar_allocations) · [ar_charges](#ar_charges) · [ar_collections](#ar_collections) · [asset_cards](#asset_cards) · [asset_changes](#asset_changes) · [asset_stocktake_scans](#asset_stocktake_scans) · [asset_stocktakes](#asset_stocktakes) · [audit_logs](#audit_logs) · [auth_grants](#auth_grants) · [backfill_entries](#backfill_entries) · [bank_accounts](#bank_accounts) · [bank_imports](#bank_imports) · [bank_matches](#bank_matches) · [bank_statement_lines](#bank_statement_lines) · [benefit_grants](#benefit_grants) · [benefit_uses](#benefit_uses) · [benefits](#benefits) · [bill_line_discounts](#bill_line_discounts) · [bill_line_moves](#bill_line_moves) · [bill_lines](#bill_lines) · [bill_supplements](#bill_supplements) · [bills](#bills) · [bonus_expiries](#bonus_expiries) · [bonus_lot_moves](#bonus_lot_moves) · [bonus_lots](#bonus_lots) · [bookings](#bookings) · [checkout_bills](#checkout_bills) · [checkout_items](#checkout_items) · [checkout_payments](#checkout_payments) · [checkouts](#checkouts) · [commission_rule_versions](#commission_rule_versions) · [consumption_lines](#consumption_lines) · [consumptions](#consumptions) · [contract_acceptances](#contract_acceptances) · [contract_changes](#contract_changes) · [contract_files](#contract_files) · [contract_lines](#contract_lines) · [contract_payouts](#contract_payouts) · [contract_quality_issues](#contract_quality_issues) · [contract_reviews](#contract_reviews) · [contract_revisions](#contract_revisions) · [contract_seals](#contract_seals) · [contract_templates](#contract_templates) · [contract_versions](#contract_versions) · [contracts](#contracts) · [count_card_moves](#count_card_moves) · [count_card_refunds](#count_card_refunds) · [count_card_types](#count_card_types) · [count_cards](#count_cards) · [coupon_campaign_members](#coupon_campaign_members) · [coupon_campaigns](#coupon_campaigns) · [coupon_events](#coupon_events) · [coupon_gift_outs](#coupon_gift_outs) · [coupon_issues](#coupon_issues) · [coupon_rules](#coupon_rules) · [coupon_templates](#coupon_templates) · [coupons](#coupons) · [current_locations](#current_locations) · [custom_field_defs](#custom_field_defs) · [custom_field_values](#custom_field_values) · [customer_binding_events](#customer_binding_events) · [customer_binding_requests](#customer_binding_requests) · [customer_bindings](#customer_bindings) · [customer_credit_events](#customer_credit_events) · [customer_month_targets](#customer_month_targets) · [customer_recharge_credits](#customer_recharge_credits) · [customer_service_notes](#customer_service_notes) · [customer_target_versions](#customer_target_versions) · [daily_settlements](#daily_settlements) · [departments](#departments) · [design_asset_versions](#design_asset_versions) · [design_assets](#design_assets) · [design_assign_fences](#design_assign_fences) · [design_slot_assignments](#design_slot_assignments) · [device_events](#device_events) · [device_jobs](#device_jobs) · [devices](#devices) · [dining_room_types](#dining_room_types) · [dining_tables](#dining_tables) · [dish_addons](#dish_addons) · [dish_combo_items](#dish_combo_items) · [dish_combo_swaps](#dish_combo_swaps) · [dish_limits](#dish_limits) · [dish_method_groups](#dish_method_groups) · [dish_methods](#dish_methods) · [dish_ops](#dish_ops) · [dish_price_changes](#dish_price_changes) · [dish_station_windows](#dish_station_windows) · [doc_counters](#doc_counters) · [emenu_categories](#emenu_categories) · [emenu_dish_specs](#emenu_dish_specs) · [emenu_dishes](#emenu_dishes) · [emenu_images](#emenu_images) · [emenu_orders](#emenu_orders) · [emenu_page_dishes](#emenu_page_dishes) · [emenu_pages](#emenu_pages) · [entry_claims](#entry_claims) · [erp_drafts](#erp_drafts) · [erp_files](#erp_files) · [erp_images](#erp_images) · [erp_imports](#erp_imports) · [expense_budgets](#expense_budgets) · [expense_claim_lines](#expense_claim_lines) · [expense_claim_petty_uses](#expense_claim_petty_uses) · [expense_claims](#expense_claims) · [floorplan_activations](#floorplan_activations) · [floorplan_batches](#floorplan_batches) · [floorplan_floors](#floorplan_floors) · [floorplan_originals](#floorplan_originals) · [floorplan_room_outlines](#floorplan_room_outlines) · [floorplan_rooms](#floorplan_rooms) · [floors](#floors) · [gift_card_batches](#gift_card_batches) · [gift_receipts](#gift_receipts) · [group_buy_coupons](#group_buy_coupons) · [guest_blacklist](#guest_blacklist) · [guest_preferences](#guest_preferences) · [guide_markers](#guide_markers) · [hall_zones](#hall_zones) · [hand_tag_generate_ops](#hand_tag_generate_ops) · [hand_tags](#hand_tags) · [idempotency_keys](#idempotency_keys) · [integration_calls](#integration_calls) · [inv_doc_attachments](#inv_doc_attachments) · [inv_doc_lines](#inv_doc_lines) · [inv_docs](#inv_docs) · [invoice_requests](#invoice_requests) · [item_recipe_lines](#item_recipe_lines) · [item_recipes](#item_recipes) · [kitchen_item_parts](#kitchen_item_parts) · [kitchen_items](#kitchen_items) · [kitchen_stations](#kitchen_stations) · [ledger_entries](#ledger_entries) · [ledger_imports](#ledger_imports) · [legal_entities](#legal_entities) · [linen_doc_lines](#linen_doc_lines) · [linen_docs](#linen_docs) · [linen_items](#linen_items) · [location_events](#location_events) · [location_readers](#location_readers) · [location_tracks](#location_tracks) · [marketing_cost_params](#marketing_cost_params) · [material_images](#material_images) · [materials](#materials) · [meal_entries](#meal_entries) · [member_card_deposits](#member_card_deposits) · [member_card_returns](#member_card_returns) · [member_cards](#member_cards) · [member_grade_events](#member_grade_events) · [member_history_imports](#member_history_imports) · [member_history_rows](#member_history_rows) · [member_merges](#member_merges) · [member_notices](#member_notices) · [member_phone_changes](#member_phone_changes) · [member_refund_lines](#member_refund_lines) · [member_refunds](#member_refunds) · [member_status_events](#member_status_events) · [member_tag_links](#member_tag_links) · [member_tags](#member_tags) · [member_trials](#member_trials) · [members](#members) · [membership_job_runs](#membership_job_runs) · [op_fences](#op_fences) · [opening_balances](#opening_balances) · [opening_imports](#opening_imports) · [opening_payables](#opening_payables) · [org_departments](#org_departments) · [ota_channels](#ota_channels) · [ota_imports](#ota_imports) · [ota_order_bookings](#ota_order_bookings) · [ota_orders](#ota_orders) · [patrol_checkin_repeats](#patrol_checkin_repeats) · [patrol_checkins](#patrol_checkins) · [patrol_points](#patrol_points) · [pay_refunds](#pay_refunds) · [pay_transactions](#pay_transactions) · [pay_tx_events](#pay_tx_events) · [payment_allocations](#payment_allocations) · [payment_batch_items](#payment_batch_items) · [payment_batches](#payment_batches) · [payment_request_targets](#payment_request_targets) · [payment_requests](#payment_requests) · [payments](#payments) · [petty_accounts](#petty_accounts) · [petty_advances](#petty_advances) · [petty_merge_log](#petty_merge_log) · [petty_settlements](#petty_settlements) · [petty_uses](#petty_uses) · [platform_recon_issues](#platform_recon_issues) · [platform_recon_runs](#platform_recon_runs) · [platform_redemptions](#platform_redemptions) · [platform_settlements](#platform_settlements) · [platform_verifications](#platform_verifications) · [po_match_releases](#po_match_releases) · [po_supplier_confirmations](#po_supplier_confirmations) · [position_catalog](#position_catalog) · [position_config_log](#position_config_log) · [position_suggestions](#position_suggestions) · [purchase_order_line_images](#purchase_order_line_images) · [purchase_order_line_requests](#purchase_order_line_requests) · [purchase_order_lines](#purchase_order_lines) · [purchase_order_revisions](#purchase_order_revisions) · [purchase_orders](#purchase_orders) · [purchase_request_imports](#purchase_request_imports) · [purchase_request_line_images](#purchase_request_line_images) · [purchase_request_lines](#purchase_request_lines) · [purchase_request_progress_marks](#purchase_request_progress_marks) · [purchase_request_versions](#purchase_request_versions) · [purchase_requests](#purchase_requests) · [receipt_imports](#receipt_imports) · [recharge_plans](#recharge_plans) · [recharges](#recharges) · [recon_links](#recon_links) · [refund_items](#refund_items) · [refund_payments](#refund_payments) · [refunds](#refunds) · [replenish_runs](#replenish_runs) · [request_fix_items](#request_fix_items) · [request_line_issues](#request_line_issues) · [request_line_stock](#request_line_stock) · [request_terminations](#request_terminations) · [reversals](#reversals) · [room_audits](#room_audits) · [room_categories](#room_categories) · [room_deposits](#room_deposits) · [room_fee_charges](#room_fee_charges) · [room_housekeeping_events](#room_housekeeping_events) · [room_moves](#room_moves) · [room_order_lines](#room_order_lines) · [room_order_outlets](#room_order_outlets) · [room_orders](#room_orders) · [room_registrations](#room_registrations) · [room_stay_charges](#room_stay_charges) · [room_stays](#room_stays) · [room_type_member_prices](#room_type_member_prices) · [room_types](#room_types) · [rooms](#rooms) · [schema_migrations](#schema_migrations) · [service_item_prices](#service_item_prices) · [service_item_store_prices](#service_item_store_prices) · [service_items](#service_items) · [sessions](#sessions) · [settings](#settings) · [shift_members](#shift_members) · [shifts](#shifts) · [sms_outbox](#sms_outbox) · [sourcing_events](#sourcing_events) · [sourcing_line_requests](#sourcing_line_requests) · [sourcing_lines](#sourcing_lines) · [sourcing_quote_lines](#sourcing_quote_lines) · [sourcing_quotes](#sourcing_quotes) · [space_aliases](#space_aliases) · [space_imports](#space_imports) · [space_room_events](#space_room_events) · [space_room_states](#space_room_states) · [space_usage_charges](#space_usage_charges) · [space_usages](#space_usages) · [spaces](#spaces) · [staff](#staff) · [staff_order_pins](#staff_order_pins) · [staff_profiles](#staff_profiles) · [staff_stores](#staff_stores) · [stock_moves](#stock_moves) · [stock_transfer_lines](#stock_transfer_lines) · [stock_transfers](#stock_transfers) · [stock_usage_batches](#stock_usage_batches) · [stock_usage_events](#stock_usage_events) · [store_settings](#store_settings) · [stores](#stores) · [studio_assets](#studio_assets) · [studio_comments](#studio_comments) · [studio_designs](#studio_designs) · [studio_preview_codes](#studio_preview_codes) · [studio_version_cancels](#studio_version_cancels) · [studio_versions](#studio_versions) · [supplier_contract_files](#supplier_contract_files) · [supplier_invoice_attachments](#supplier_invoice_attachments) · [supplier_invoice_lines](#supplier_invoice_lines) · [supplier_invoices](#supplier_invoices) · [supplier_licenses](#supplier_licenses) · [supplier_link_replies](#supplier_link_replies) · [supplier_links](#supplier_links) · [supplier_reconciliation_docs](#supplier_reconciliation_docs) · [supplier_reconciliations](#supplier_reconciliations) · [supplier_refunds](#supplier_refunds) · [suppliers](#suppliers) · [table_events](#table_events) · [table_session_moves](#table_session_moves) · [table_session_returns](#table_session_returns) · [table_sessions](#table_sessions) · [tag_deposits](#tag_deposits) · [technician_announcer](#technician_announcer) · [technician_calls](#technician_calls) · [technician_events](#technician_events) · [technician_groups](#technician_groups) · [technician_leaves](#technician_leaves) · [technician_photos](#technician_photos) · [technician_schedule](#technician_schedule) · [technician_schedule_changes](#technician_schedule_changes) · [technician_session_changes](#technician_session_changes) · [technician_sessions](#technician_sessions) · [technician_shifts](#technician_shifts) · [technician_status](#technician_status) · [technician_targets](#technician_targets) · [technicians](#technicians) · [ticket_types](#ticket_types) · [visit_category_changes](#visit_category_changes) · [visit_group_events](#visit_group_events) · [visit_groups](#visit_groups) · [visit_incident_events](#visit_incident_events) · [visit_incidents](#visit_incidents) · [visit_remark_removals](#visit_remark_removals) · [visit_remark_resolutions](#visit_remark_resolutions) · [visit_remarks](#visit_remarks) · [visit_risk_alerts](#visit_risk_alerts) · [visit_tag_changes](#visit_tag_changes) · [visit_tag_locks](#visit_tag_locks) · [visit_ticket_changes](#visit_ticket_changes) · [visits](#visits) · [warehouse_stock](#warehouse_stock) · [warehouses](#warehouses) · [web_push_keys](#web_push_keys) · [wecom_pushes](#wecom_pushes) · [wormhole_stays](#wormhole_stays) · [zones](#zones)
- **业财法审批（gf_）**（30）：[gf_alloc_rule_versions](#gf_alloc_rule_versions) · [gf_alloc_rules](#gf_alloc_rules) · [gf_alloc_runs](#gf_alloc_runs) · [gf_cc](#gf_cc) · [gf_contract_versions](#gf_contract_versions) · [gf_dept_quotas](#gf_dept_quotas) · [gf_docs](#gf_docs) · [gf_files](#gf_files) · [gf_flow_actions](#gf_flow_actions) · [gf_flows](#gf_flows) · [gf_hr_batch_lines](#gf_hr_batch_lines) · [gf_hr_batches](#gf_hr_batches) · [gf_hr_checks](#gf_hr_checks) · [gf_hr_payouts](#gf_hr_payouts) · [gf_license_loans](#gf_license_loans) · [gf_licenses](#gf_licenses) · [gf_materials](#gf_materials) · [gf_overdue_reviews](#gf_overdue_reviews) · [gf_payouts](#gf_payouts) · [gf_quota_ledger](#gf_quota_ledger) · [gf_quota_specials](#gf_quota_specials) · [gf_role_members](#gf_role_members) · [gf_settings](#gf_settings) · [gf_sku_prices](#gf_sku_prices) · [gf_skus](#gf_skus) · [gf_specials](#gf_specials) · [gf_supplier_versions](#gf_supplier_versions) · [gf_suppliers](#gf_suppliers) · [gf_travel_budgets](#gf_travel_budgets) · [gf_travel_ledger](#gf_travel_ledger)
- **办公 OA（oa_）**（35）：[oa_announcement_reads](#oa_announcement_reads) · [oa_announcements](#oa_announcements) · [oa_approval_cc](#oa_approval_cc) · [oa_approval_events](#oa_approval_events) · [oa_approval_steps](#oa_approval_steps) · [oa_approval_templates](#oa_approval_templates) · [oa_approvals](#oa_approvals) · [oa_attachments](#oa_attachments) · [oa_attendance_covers](#oa_attendance_covers) · [oa_attendance_daily](#oa_attendance_daily) · [oa_attendance_groups](#oa_attendance_groups) · [oa_face_enrollments](#oa_face_enrollments) · [oa_group_locations](#oa_group_locations) · [oa_group_members](#oa_group_members) · [oa_holiday_years](#oa_holiday_years) · [oa_holidays](#oa_holidays) · [oa_im_conversations](#oa_im_conversations) · [oa_im_members](#oa_im_members) · [oa_im_messages](#oa_im_messages) · [oa_leave_balances](#oa_leave_balances) · [oa_leave_entries](#oa_leave_entries) · [oa_leave_types](#oa_leave_types) · [oa_locations](#oa_locations) · [oa_notifications](#oa_notifications) · [oa_payroll_audit](#oa_payroll_audit) · [oa_payroll_batches](#oa_payroll_batches) · [oa_payroll_files](#oa_payroll_files) · [oa_payslip_templates](#oa_payslip_templates) · [oa_payslips](#oa_payslips) · [oa_punches](#oa_punches) · [oa_schedule_grants](#oa_schedule_grants) · [oa_schedule_publishes](#oa_schedule_publishes) · [oa_schedules](#oa_schedules) · [oa_shifts](#oa_shifts) · [oa_staff_imports](#oa_staff_imports)
- **小程序（mp_，小程序线）**（17）：[mp_banners](#mp_banners) · [mp_bindings](#mp_bindings) · [mp_booking_ops](#mp_booking_ops) · [mp_coupon_claims](#mp_coupon_claims) · [mp_food_orders](#mp_food_orders) · [mp_images](#mp_images) · [mp_invites](#mp_invites) · [mp_item_intros](#mp_item_intros) · [mp_op_fences](#mp_op_fences) · [mp_recharge_events](#mp_recharge_events) · [mp_recharge_orders](#mp_recharge_orders) · [mp_recharge_recons](#mp_recharge_recons) · [mp_refund_events](#mp_refund_events) · [mp_refund_orders](#mp_refund_orders) · [mp_reminder_consents](#mp_reminder_consents) · [mp_reminder_messages](#mp_reminder_messages) · [mp_stores](#mp_stores)
- **员工食堂（canteen_）**（11）：[canteen_checkins](#canteen_checkins) · [canteen_employees](#canteen_employees) · [canteen_feedback](#canteen_feedback) · [canteen_feedback_reply_ops](#canteen_feedback_reply_ops) · [canteen_likes](#canteen_likes) · [canteen_menus](#canteen_menus) · [canteen_push_prefs](#canteen_push_prefs) · [canteen_push_subscriptions](#canteen_push_subscriptions) · [canteen_reminder_deliveries](#canteen_reminder_deliveries) · [canteen_reminder_runs](#canteen_reminder_runs) · [canteen_sessions](#canteen_sessions)
- **客户关系（concierge_）**（9）：[concierge_balance_evidence](#concierge_balance_evidence) · [concierge_members](#concierge_members) · [concierge_operations](#concierge_operations) · [concierge_praise](#concierge_praise) · [concierge_praise_evidence](#concierge_praise_evidence) · [concierge_records](#concierge_records) · [concierge_revisions](#concierge_revisions) · [concierge_sync](#concierge_sync) · [concierge_uploads](#concierge_uploads)
- **价目表（price_catalog_）**（7）：[price_catalog_changes](#price_catalog_changes) · [price_catalog_entries](#price_catalog_entries) · [price_catalog_import_ops](#price_catalog_import_ops) · [price_catalog_link_ops](#price_catalog_link_ops) · [price_catalog_links](#price_catalog_links) · [price_catalog_set_ops](#price_catalog_set_ops) · [price_catalog_sets](#price_catalog_sets)
- **员工培训（training_）**（8）：[training_blob_chunks](#training_blob_chunks) · [training_blobs](#training_blobs) · [training_file_versions](#training_file_versions) · [training_files](#training_files) · [training_folders](#training_folders) · [training_upload_chunks](#training_upload_chunks) · [training_uploads](#training_uploads) · [training_views](#training_views)
- **采购商城（mall_）**（4）：[mall_request_quotes](#mall_request_quotes) · [mall_request_sourcing](#mall_request_sourcing) · [mall_sku_changes](#mall_sku_changes) · [mall_skus](#mall_skus)
- **旧系统导入（legacy_）**（7）：[legacy_brand_requests](#legacy_brand_requests) · [legacy_images](#legacy_images) · [legacy_imports](#legacy_imports) · [legacy_ledger_lines](#legacy_ledger_lines) · [legacy_material_lines](#legacy_material_lines) · [legacy_ordered_lines](#legacy_ordered_lines) · [legacy_payment_days](#legacy_payment_days)
- **归档（archived_）**（4）：[archived_integration_calls](#archived_integration_calls) · [archived_location_events](#archived_location_events) · [archived_location_tracks](#archived_location_tracks) · [archived_wecom_pushes](#archived_wecom_pushes)

## 核心与其他

### acceptance_templates

8.0.7 供应链收尾 2.5 与 A4（docs/ERP_V807.md）： · 验收标准模板：名称与逐条标准；合同的「验收」一节可以选模板，逐条标准写进合同内容（随合同版本走，不在这里存）； · 验收登记的逐条结果（合格 / 不合格）：有一条不合格整次就是不合格；之前的登记为空（没有逐条）； （建表：099_acceptance_templates）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('acceptance_templates_id_seq'::regclass) |  |  |
| name | text |  |  |  |  |  |
| items | jsonb |  |  |  |  |  |
| active | boolean |  |  | true |  |  |
| version | integer |  |  | 1 |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_by | bigint |  | 是 |  | staff |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### ai_questions

8.0.22 AI 辅助（docs/AI_V8022.md，MD-D）：每天的经营小结、问数的记录；对外调用记录多一种「ai」。 只读、只出文字：这两张表只记 AI 写的文字与用到的汇总数，不碰任何业务表。 （建表：158_ai）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('ai_questions_id_seq'::regclass) |  |  |
| staff_id | bigint |  |  |  | staff |  |
| store_id | bigint |  |  |  | stores |  |
| client_key | uuid |  |  |  |  |  |
| question | text |  |  |  |  |  |
| answer | text |  | 是 |  |  |  |
| tool_calls | jsonb |  |  | '[]'::jsonb |  |  |
| model | text |  | 是 |  |  |  |
| input_tokens | integer |  |  | 0 |  |  |
| output_tokens | integer |  |  | 0 |  |  |
| status | text |  |  |  |  |  |
| error | text |  | 是 |  |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| finished_at | timestamp with time zone |  | 是 |  |  |  |

### ai_summaries

8.0.22 AI 辅助（docs/AI_V8022.md，MD-D）：每天的经营小结、问数的记录；对外调用记录多一种「ai」。 只读、只出文字：这两张表只记 AI 写的文字与用到的汇总数，不碰任何业务表。 （建表：158_ai）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('ai_summaries_id_seq'::regclass) |  |  |
| store_id | bigint |  | 是 |  | stores | 空 = 全公司合并的那一份 |
| business_date | date |  |  |  |  |  |
| kind | text |  |  | 'daily'::text |  |  |
| facts | jsonb |  |  |  |  |  |
| facts_hash | text |  |  |  |  |  |
| text | text |  | 是 |  |  |  |
| model | text |  | 是 |  |  |  |
| input_tokens | integer |  |  | 0 |  |  |
| output_tokens | integer |  |  | 0 |  |  |
| status | text |  |  |  |  |  |
| attempts | smallint |  |  | 0 |  |  |
| lease_until | timestamp with time zone |  | 是 |  |  |  |
| error | text |  | 是 |  |  |  |
| pushed_at | timestamp with time zone |  | 是 |  |  | 推企业微信（MD11）：推出去的时间；没推出去的原因（只推一次，不重试） |
| push_error | text |  | 是 |  |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### ap_entries

应付流水：正数增加应付（期初、收货），负数减少（退货扣款、付款） （建表：002_inventory）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('ap_entries_id_seq'::regclass) |  |  |
| supplier_id | bigint |  |  |  | suppliers |  |
| entry_type | text |  |  |  |  |  |
| amount_delta_cents | bigint |  |  |  |  | 单位：分 |
| inv_doc_id | bigint |  | 是 |  | inv_docs |  |
| opening_payable_id | bigint |  | 是 |  | opening_payables |  |
| payment_id | bigint |  | 是 |  | payments |  |
| entry_date | date |  |  |  |  |  |
| operator_id | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| supplier_refund_id | bigint |  | 是 |  | supplier_refunds | 应付流水加「供应商退款」（正数，把负的往来余额补回来） |

### ap_offset_lines

核销到哪几笔应付（收货单或期初未付）；只追加 （建表：030_supplier_settlement）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('ap_offset_lines_id_seq'::regclass) |  |  |
| offset_id | bigint |  |  |  | ap_offsets |  |
| receipt_doc_id | bigint |  | 是 |  | inv_docs |  |
| opening_payable_id | bigint |  | 是 |  | opening_payables |  |
| amount_cents | bigint |  |  |  |  | 单位：分 |

### ap_offsets

核销：预付款、退货余额抵扣以后的应付（#25、#20） （建表：030_supplier_settlement）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('ap_offsets_id_seq'::regclass) |  |  |
| doc_no | text |  |  |  |  |  |
| supplier_id | bigint |  |  |  | suppliers |  |
| offset_date | date |  |  |  |  |  |
| credit_payment_id | bigint |  | 是 |  | payments | 可抵扣的一方：预付款（付款没核销完的部分）或退货余额（挂账的退货单） |
| credit_return_id | bigint |  | 是 |  | inv_docs |  |
| amount_cents | bigint |  |  |  |  | 单位：分 |
| note | text |  |  | ''::text |  |  |
| status | text |  |  |  |  |  |
| client_key | uuid |  | 是 |  |  |  |
| is_synthetic | boolean |  |  | false |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| voided_by | bigint |  | 是 |  | staff |  |
| voided_at | timestamp with time zone |  | 是 |  |  |  |
| void_reason | text |  | 是 |  |  |  |

### approval_actions

v0.7.30（主线）审批中心（docs/APPROVALS.md，默认 A1–A10 待确认）： · 审批规则：单据类型 × 金额区间（含下限、不含上限）× 部门 → 一到三级审批链（每级一个岗位组或指定的人，或签 / 会签）； （建表：073_approval_center）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('approval_actions_id_seq'::regclass) |  |  |
| request_id | bigint |  |  |  | approval_requests |  |
| level | integer |  |  |  |  |  |
| action | text |  |  |  |  |  |
| actor_id | bigint |  |  |  | staff |  |
| on_behalf_of | bigint |  | 是 |  | staff |  |
| comment | text |  |  | ''::text |  |  |
| batch | boolean |  |  | false |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### approval_delegations

v0.7.30（主线）审批中心（docs/APPROVALS.md，默认 A1–A10 待确认）： · 审批规则：单据类型 × 金额区间（含下限、不含上限）× 部门 → 一到三级审批链（每级一个岗位组或指定的人，或签 / 会签）； （建表：073_approval_center）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('approval_delegations_id_seq'::regclass) |  |  |
| staff_id | bigint |  |  |  | staff |  |
| delegate_id | bigint |  |  |  | staff |  |
| starts_on | date |  |  |  |  |  |
| ends_on | date |  |  |  |  |  |
| reason | text |  |  | ''::text |  |  |
| client_key | uuid |  |  |  |  |  |
| request_hash | text |  |  |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| revoked_by | bigint |  | 是 |  | staff |  |
| revoked_at | timestamp with time zone |  | 是 |  |  |  |

### approval_logs

审批记录（提交、确认、退回、撤回、冲销） （建表：002_inventory）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('approval_logs_id_seq'::regclass) |  |  |
| doc_kind | text |  |  |  |  |  |
| doc_id | bigint |  |  |  |  |  |
| action | text |  |  |  |  |  |
| actor_id | bigint |  |  |  | staff |  |
| reason | text |  |  | ''::text |  |  |
| revision | integer |  | 是 |  |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### approval_requests

v0.7.30（主线）审批中心（docs/APPROVALS.md，默认 A1–A10 待确认）： · 审批规则：单据类型 × 金额区间（含下限、不含上限）× 部门 → 一到三级审批链（每级一个岗位组或指定的人，或签 / 会签）； （建表：073_approval_center）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('approval_requests_id_seq'::regclass) |  |  |
| doc_kind | text |  |  |  |  |  |
| doc_id | bigint |  |  |  |  |  |
| doc_type | text |  |  |  |  |  |
| doc_no | text |  |  |  |  |  |
| amount_cents | bigint |  | 是 |  |  | 单位：分 |
| department_id | bigint |  | 是 |  | departments |  |
| rule_id | bigint |  | 是 |  | approval_rules |  |
| rule_version | integer |  | 是 |  |  |  |
| steps | jsonb |  |  |  |  |  |
| allow_self | boolean |  |  |  |  |  |
| current_level | integer |  |  | 1 |  |  |
| level_started_at | timestamp with time zone |  |  | now() |  |  |
| status | text |  |  | 'pending'::text |  |  |
| submitted_by | bigint |  |  |  | staff |  |
| submitted_at | timestamp with time zone |  |  | now() |  |  |
| finished_at | timestamp with time zone |  | 是 |  |  |  |
| finished_by | bigint |  | 是 |  | staff |  |

### approval_rules

v0.7.30（主线）审批中心（docs/APPROVALS.md，默认 A1–A10 待确认）： · 审批规则：单据类型 × 金额区间（含下限、不含上限）× 部门 → 一到三级审批链（每级一个岗位组或指定的人，或签 / 会签）； （建表：073_approval_center）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('approval_rules_id_seq'::regclass) |  |  |
| doc_type | text |  |  |  |  |  |
| min_cents | bigint |  |  | 0 |  | 单位：分 |
| max_cents | bigint |  | 是 |  |  | 单位：分 |
| department_id | bigint |  | 是 |  | departments |  |
| steps | jsonb |  |  |  |  | 审批链：[{ "group": "manager" \| "finance" \| "store_manager" \| "owner" } 或 { "staffIds": [..] }，加 "mode": "any" \| "all"]，一到三级 |
| allow_self | boolean |  |  | false |  |  |
| note | text |  |  | ''::text |  |  |
| active | boolean |  |  | true |  |  |
| version | integer |  |  | 1 |  |  |
| client_key | uuid |  |  |  |  | 新建时的操作编号与原请求摘要（同一编号重提返回原来那条，内容不一样拒绝） |
| request_hash | text |  |  |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_by | bigint |  | 是 |  | staff |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### ar_accounts

8.0.7 ERP P2 3.1（docs/ERP_V807.md）：应收与挂账。 · 协议单位 ar_accounts：名称、联系人、电话、挂账额度（空 = 不限，V11）、启用；不能删，不用了停用。 · 结账多一种收款方式「挂账」（on_account）：选协议单位、写签单人；要岗位权限「挂账」（V12）。 （建表：101_receivables）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('ar_accounts_id_seq'::regclass) |  |  |
| code | text |  |  |  |  |  |
| name | text |  |  |  |  |  |
| contact | text |  |  | ''::text |  |  |
| phone | text |  |  | ''::text |  |  |
| credit_limit_cents | bigint |  | 是 |  |  | 挂账额度（分）：空 = 不限 |
| active | boolean |  |  | true |  |  |
| note | text |  |  | ''::text |  |  |
| version | integer |  |  | 1 |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### ar_allocations

8.0.7 ERP P2 3.1（docs/ERP_V807.md）：应收与挂账。 · 协议单位 ar_accounts：名称、联系人、电话、挂账额度（空 = 不限，V11）、启用；不能删，不用了停用。 · 结账多一种收款方式「挂账」（on_account）：选协议单位、写签单人；要岗位权限「挂账」（V12）。 （建表：101_receivables）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| collection_id | bigint | PK |  |  | ar_collections |  |
| charge_id | bigint | PK |  |  | ar_charges |  |
| amount_cents | bigint |  |  |  |  | 单位：分 |

### ar_charges

挂账 （建表：101_receivables）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('ar_charges_id_seq'::regclass) |  |  |
| account_id | bigint |  |  |  | ar_accounts |  |
| checkout_id | bigint |  |  |  | checkouts |  |
| payment_id | bigint |  |  |  | checkout_payments |  |
| amount_cents | bigint |  |  |  |  | 单位：分 |
| business_date | date |  |  |  |  |  |
| signer | text |  |  |  |  |  |
| status | text |  |  | 'open'::text |  |  |
| voided_by | bigint |  | 是 |  | staff |  |
| voided_at | timestamp with time zone |  | 是 |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### ar_collections

回款与核销 （建表：101_receivables）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('ar_collections_id_seq'::regclass) |  |  |
| doc_no | text |  |  |  |  |  |
| account_id | bigint |  |  |  | ar_accounts |  |
| collected_on | date |  |  |  |  |  |
| method | text |  |  |  |  |  |
| amount_cents | bigint |  |  |  |  | 单位：分 |
| evidence | text |  |  | ''::text |  |  |
| note | text |  |  | ''::text |  |  |
| client_key | uuid |  |  |  |  |  |
| request_hash | text |  |  |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| voided_by | bigint |  | 是 |  | staff |  |
| voided_at | timestamp with time zone |  | 是 |  |  |  |
| void_reason | text |  | 是 |  |  |  |

### asset_cards

8.0.7 ERP P2 3.2（docs/ERP_V807.md）：资产与易耗台账。 · 资产卡片 asset_cards：编号（ZC…）、名称、类别（固定资产 / 低值易耗）、使用部门、存放位置、保管人、原值、取得日期、 状态（在用 / 闲置 / 维修 / 报废）； （建表：102_assets）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('asset_cards_id_seq'::regclass) |  |  |
| asset_no | text |  |  |  |  |  |
| name | text |  |  |  |  |  |
| category | text |  |  |  |  |  |
| department_id | bigint |  | 是 |  | departments |  |
| location | text |  |  | ''::text |  |  |
| keeper | text |  |  | ''::text |  |  |
| original_cents | bigint |  |  |  |  | 单位：分 |
| acquired_on | date |  |  |  |  |  |
| status | text |  |  | 'in_use'::text |  |  |
| material_id | bigint |  | 是 |  | materials |  |
| receipt_line_id | bigint |  | 是 |  | inv_doc_lines |  |
| note | text |  |  | ''::text |  |  |
| client_key | uuid |  |  |  |  |  |
| request_hash | text |  |  |  |  |  |
| version | integer |  |  | 1 |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### asset_changes

8.0.7 ERP P2 3.2（docs/ERP_V807.md）：资产与易耗台账。 · 资产卡片 asset_cards：编号（ZC…）、名称、类别（固定资产 / 低值易耗）、使用部门、存放位置、保管人、原值、取得日期、 状态（在用 / 闲置 / 维修 / 报废）； （建表：102_assets）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('asset_changes_id_seq'::regclass) |  |  |
| asset_id | bigint |  |  |  | asset_cards |  |
| kind | text |  |  |  |  |  |
| detail | jsonb |  |  | '{}'::jsonb |  |  |
| reason | text |  |  | ''::text |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### asset_stocktake_scans

8.0.7 ERP P2 3.2（docs/ERP_V807.md）：资产与易耗台账。 · 资产卡片 asset_cards：编号（ZC…）、名称、类别（固定资产 / 低值易耗）、使用部门、存放位置、保管人、原值、取得日期、 状态（在用 / 闲置 / 维修 / 报废）； （建表：102_assets）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| stocktake_id | bigint | PK |  |  | asset_stocktakes |  |
| code | text | PK |  |  |  |  |
| asset_id | bigint |  | 是 |  | asset_cards |  |
| scanned_by | bigint |  |  |  | staff |  |
| scanned_at | timestamp with time zone |  |  | now() |  |  |

### asset_stocktakes

8.0.7 ERP P2 3.2（docs/ERP_V807.md）：资产与易耗台账。 · 资产卡片 asset_cards：编号（ZC…）、名称、类别（固定资产 / 低值易耗）、使用部门、存放位置、保管人、原值、取得日期、 状态（在用 / 闲置 / 维修 / 报废）； （建表：102_assets）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('asset_stocktakes_id_seq'::regclass) |  |  |
| doc_no | text |  |  |  |  |  |
| department_id | bigint |  | 是 |  | departments |  |
| status | text |  |  | 'open'::text |  |  |
| note | text |  |  | ''::text |  |  |
| started_by | bigint |  |  |  | staff |  |
| started_at | timestamp with time zone |  |  | now() |  |  |
| closed_by | bigint |  | 是 |  | staff |  |
| closed_at | timestamp with time zone |  | 是 |  |  |  |
| result | jsonb |  | 是 |  |  |  |
| client_key | uuid |  | 是 |  |  | 8.0.7 合并前 Codex 审查（0048165）：开始扫码盘点也带操作编号（AGENTS.md：写操作带幂等键）。 · 回复丢了以后按原内容重提，返回原来那次盘点，不再多开一次（盘点记录不能删）； · 「确认作废」加业务类型 asset_stocktake（查回、作废与资产建卡一样，编号记在盘点上）。 只加两列、放宽约束：已有的盘点没有编号（为空）。 |
| request_hash | text |  | 是 |  |  |  |

### audit_logs

操作审计 （建表：001_init）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('audit_logs_id_seq'::regclass) |  |  |
| staff_id | bigint |  | 是 |  | staff |  |
| action | text |  |  |  |  |  |
| target_type | text |  | 是 |  |  |  |
| target_id | text |  | 是 |  |  |  |
| detail | jsonb |  |  | '{}'::jsonb |  |  |
| ip | text |  | 是 |  |  |  |
| business_date | date |  | 是 |  |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| request_id | text |  | 是 |  |  | 写这条审计的那次请求的编号（响应头 x-request-id、日志里的 reqId）；自动任务写的为空（迁移 490） |

### auth_grants

当场授权凭据（Batch 2.4 的单笔超限授权也使用） （建表：008_locker_pool）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | uuid | PK |  | gen_random_uuid() |  |  |
| purpose | text |  |  |  |  |  |
| requested_by | bigint |  |  |  | staff |  |
| approved_by | bigint |  |  |  | staff |  |
| scope | jsonb |  |  |  |  | 授权对象，例如 {"tagCodes": ["9058"], "memberId": 12} |
| created_at | timestamp with time zone |  |  | now() |  |  |
| expires_at | timestamp with time zone |  |  |  |  |  |
| used_at | timestamp with time zone |  | 是 |  |  |  |
| used_ref | text |  | 是 |  |  | 用在哪一笔业务（操作编号） |
| store_id | bigint |  |  | yuzu_store() | stores |  |

### backfill_entries

R1.9 按实际时间补录纸质单（店主 2026-10-29 决定要做，见 docs/PENDING_DECISIONS.md「按实际时间补录纸质单」）（增量迁移） · 系统停用期间前台用预编号的纸质应急单记录接待、挂账与结账，恢复后按纸质单上的实际时间补录： 门票按实际在店时长计价，营业日、日结、对账都按实际时间归属； （建表：018_backfill）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('backfill_entries_id_seq'::regclass) |  |  |
| slip_no | text |  |  |  |  |  |
| kind | text |  |  |  |  |  |
| op_key | uuid |  |  |  |  | 这一步的操作编号：接待的 visits.checkin_key、挂账的 bill_lines.post_key、结账的 checkouts.client_key |
| visit_id | bigint |  | 是 |  | visits |  |
| checkout_id | bigint |  | 是 |  | checkouts |  |
| actual_at | timestamp with time zone |  |  |  |  |  |
| business_date | date |  |  |  |  |  |
| entered_by | bigint |  |  |  | staff |  |
| entered_at | timestamp with time zone |  |  | now() |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |

### bank_accounts

8.0.21 银行账户与网银流水（docs/FINANCE_V8021.md 第 4 节，CW-C / CW3 / CW16 / CW17）。 · bank_accounts：本公司的银行账户。只存开户行与账号后四位（CW16），完整账号不进库；记住这个账户导入时列怎么对（column_map）。 （建表：144_bank_statements）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | identity always |  |  |
| name | text |  |  |  |  |  |
| bank_name | text |  |  |  |  |  |
| account_tail | text |  |  |  |  |  |
| template | text |  |  | 'generic'::text |  | 网银导出 / 批量付款用哪家的格式（第 5 节的批量付款文件也按它） |
| column_map | jsonb |  |  | '{}'::jsonb |  |  |
| active | boolean |  |  | true |  |  |
| version | integer |  |  | 1 |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| entity_id | bigint |  |  | yuzu_entity() | legal_entities |  |

### bank_imports

8.0.21 银行账户与网银流水（docs/FINANCE_V8021.md 第 4 节，CW-C / CW3 / CW16 / CW17）。 · bank_accounts：本公司的银行账户。只存开户行与账号后四位（CW16），完整账号不进库；记住这个账户导入时列怎么对（column_map）。 （建表：144_bank_statements）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | identity always |  |  |
| account_id | bigint |  |  |  | bank_accounts |  |
| file_sha256 | text |  |  |  |  |  |
| file_name | text |  |  |  |  |  |
| line_count | integer |  |  |  |  |  |
| new_count | integer |  |  |  |  |  |
| dup_count | integer |  |  |  |  |  |
| client_key | uuid |  |  |  |  |  |
| request_hash | text |  |  |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### bank_matches

8.0.21 银行账户与网银流水（docs/FINANCE_V8021.md 第 4 节，CW-C / CW3 / CW16 / CW17）。 · bank_accounts：本公司的银行账户。只存开户行与账号后四位（CW16），完整账号不进库；记住这个账户导入时列怎么对（column_map）。 （建表：144_bank_statements）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | identity always |  |  |
| line_id | bigint |  |  |  | bank_statement_lines |  |
| target_type | text |  |  |  |  |  |
| target_id | bigint |  |  |  |  |  |
| amount_cents | bigint |  |  |  |  | 单位：分 |
| auto | boolean |  |  | false |  |  |
| status | text |  |  | 'active'::text |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| voided_by | bigint |  | 是 |  | staff |  |
| voided_at | timestamp with time zone |  | 是 |  |  |  |
| void_reason | text |  | 是 |  |  |  |

### bank_statement_lines

8.0.21 银行账户与网银流水（docs/FINANCE_V8021.md 第 4 节，CW-C / CW3 / CW16 / CW17）。 · bank_accounts：本公司的银行账户。只存开户行与账号后四位（CW16），完整账号不进库；记住这个账户导入时列怎么对（column_map）。 （建表：144_bank_statements）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | identity always |  |  |
| account_id | bigint |  |  |  | bank_accounts |  |
| import_id | bigint |  |  |  | bank_imports |  |
| txn_date | date |  |  |  |  |  |
| direction | text |  |  |  |  |  |
| amount_cents | bigint |  |  |  |  | 单位：分 |
| balance_cents | bigint |  | 是 |  |  | 单位：分 |
| counterparty | text |  |  | ''::text |  |  |
| counterparty_account | text |  |  | ''::text |  |  |
| summary | text |  |  | ''::text |  |  |
| bank_ref | text |  |  | ''::text |  |  |
| dedupe_key | text |  |  |  |  |  |
| status | text |  |  | 'open'::text |  |  |
| ignore_reason | text |  | 是 |  |  |  |
| version | integer |  |  | 1 |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### benefit_grants

发放记录：一次发放一条（只追加），对应一条发券记录。 · 券类：这一期（2026-11 / 2026）与发完以后这一期应得的累计张数（target）； （建表：041_benefits）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('benefit_grants_id_seq'::regclass) |  |  |
| benefit_id | bigint |  |  |  | benefits |  |
| benefit_version | integer |  |  |  |  |  |
| member_id | bigint |  |  |  | members |  |
| reason | text |  |  |  |  |  |
| period_key | text |  | 是 |  |  |  |
| target | smallint |  | 是 |  |  |  |
| event_key | text |  | 是 |  |  |  |
| quantity | smallint |  |  |  |  |  |
| coupon_issue_id | bigint |  |  |  | coupon_issues |  |
| grade | smallint |  |  |  |  | 发放时会员的档阶 |
| tier | smallint |  | 是 |  |  |  |
| business_date | date |  |  |  |  |  |
| dedupe_key | text |  |  |  |  |  |
| staff_id | bigint |  | 是 |  | staff | 触发它的员工（手动调整档阶的店主）；自动的为空 |
| created_at | timestamp with time zone |  |  | now() |  |  |

### benefit_uses

使用登记：服务的同事点「登记使用」一次一条；设了次数的记下这一期与当时的上限（自检核对没有超过），不计次的两者都空。 登记错的只能作废（写原因、记经办人），不能改、不能删 （建表：041_benefits）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('benefit_uses_id_seq'::regclass) |  |  |
| benefit_id | bigint |  |  |  | benefits |  |
| member_id | bigint |  |  |  | members |  |
| business_date | date |  |  |  |  |  |
| period_key | text |  | 是 |  |  |  |
| quantity | smallint |  |  |  |  |  |
| limit_at | smallint |  | 是 |  |  |  |
| note | text |  |  | ''::text |  |  |
| staff_id | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| client_key | uuid |  |  |  |  | 页面的操作编号（没收到结果再提交返回原来那条；结果待确认时可以确认作废） |
| status | text |  |  | 'active'::text |  |  |
| voided_by | bigint |  | 是 |  | staff |  |
| voided_at | timestamp with time zone |  | 是 |  |  |  |
| void_reason | text |  | 是 |  |  |  |
| plate | text |  | 是 |  |  |  |
| hours | smallint |  | 是 |  |  |  |

### benefits

041 会员体系 v2 第二期（v0.7.24，docs/BENEFITS.md）：本店权益自动发放。 ① 权益清单 benefits：会员文档附录三 A「汤崎洗浴与会员服务」57 项与 F 补充 2 项（导入为草稿，店主、店总逐项发布； （建表：041_benefits）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('benefits_id_seq'::regclass) |  |  |
| code | text |  |  |  |  |  |
| name | text |  |  |  |  |  |
| category | text |  |  |  |  |  |
| start_grade | smallint |  | 是 |  |  | 配置起点：档级 L0–L6 与阶位（L0 没有阶位）；空 = 未配置（设好才能发布） |
| start_tier | smallint |  | 是 |  |  |  |
| period | text |  |  | 'none'::text |  | 券类按月、按年发；服务类次数按天、月、年数；不计次（none）只列出来 |
| quantity | smallint |  | 是 |  |  | 券类：每期张数；事件礼：每次张数；服务类：每期上限（空 = 不限次） |
| tier_quantities | jsonb |  |  | '[]'::jsonb |  | 各档阶数量：[{grade, tier, quantity}]，从这个状态起（含更高的）按它，不相加 |
| template_id | bigint |  | 是 |  | coupon_templates |  |
| events | text[] |  |  | '{}'::text[] |  |  |
| festival_dates | date[] |  |  | '{}'::date[] |  | 节日关怀的日期（农历节日每年由店主填当年的日期） |
| content | text |  |  | ''::text |  |  |
| conditions | text |  |  | ''::text |  |  |
| status | text |  |  | 'draft'::text |  |  |
| version | integer |  |  | 1 |  |  |
| sort_order | integer |  |  | 0 |  |  |
| created_by | bigint |  | 是 |  | staff | 导入的人（命令行导入为空）、最后修改的人 |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_by | bigint |  | 是 |  | staff |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| published_at | timestamp with time zone |  | 是 |  |  |  |
| discount_target | text |  | 是 |  |  |  |
| weekdays | smallint[] |  |  | '{}'::smallint[] |  |  |
| month_days | smallint[] |  |  | '{}'::smallint[] |  |  |
| companion_count | smallint |  | 是 |  |  |  |
| companion_counts | jsonb |  |  | '[]'::jsonb |  |  |
| visit_target | smallint |  | 是 |  |  |  |
| is_parking | boolean |  |  | false |  |  |
| parking_hours | smallint |  | 是 |  |  |  |
| parking_hours_by_tier | jsonb |  |  | '[]'::jsonb |  |  |

### bill_line_discounts

单项打折（8.2.1）：账单的一行打折；金额单位分。明细本身不改，折掉的钱结账时记一笔「单项折扣」；只能撤下、不能改

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('bill_line_discounts_id_seq'::regclass) |  |  |
| line_id | bigint |  |  |  | bill_lines | 打折的那一行明细 |
| bill_id | bigint |  |  |  | bills | 明细所在的账单（结账时按账单汇总） |
| list_amount | bigint |  |  |  |  | 打折前这一行的金额（分，= 明细金额） |
| final_amount | bigint |  |  |  |  | 折后这一行收多少（分）；0 = 这一行免单 |
| rate | smallint |  | 是 |  |  | 按折扣打的：收原价的百分之几（80 = 八折，0 = 免单）；按折后价填的为空 |
| reason | text |  |  | ''::text |  | 打折的原因（选填） |
| tier | text |  |  |  |  | 打折人当时的折扣档：cashier 前台收银 / duty 值班经理 / lead 部门负责人、店总 / owner 店主 |
| floor_pct | smallint |  |  |  |  | 打折人当时那一档的下限（收原价的百分之几）；超了要当场授权 |
| staff_id | bigint |  |  |  | staff | 打折的人 |
| approved_by | bigint |  | 是 |  | staff | 超过打折人下限时当场授权的人；没超的为空 |
| grant_id | uuid |  | 是 |  | auth_grants | 当场授权的编号（只能用一次） |
| client_key | uuid |  |  |  |  | 操作编号（同一编号只记一次） |
| business_date | date |  |  |  |  | 营业日 |
| created_at | timestamp with time zone |  |  | now() |  | 打折的时间 |
| status | text |  |  | 'active'::text |  | active 有效 / revoked 已撤下（恢复原价或改了别的折扣） |
| revoked_by | bigint |  | 是 |  | staff | 撤下的人 |
| revoked_at | timestamp with time zone |  | 是 |  |  | 撤下的时间 |
| revoke_reason | text |  | 是 |  |  | 撤下的原因 |
| rule | text |  | 是 |  |  | 8.2.8：系统按规则打的自动折扣（档 auto）是哪条规则：included_meal 含餐、buffet 自助、first_cup 首杯赠；人工打的为空 |

### bill_line_moves

② 明细转到另一张手牌 （建表：025_cashier）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('bill_line_moves_id_seq'::regclass) |  |  |
| op_key | uuid |  |  |  |  | 转单的操作编号（同一次转的几条明细共用） |
| from_line_id | bigint |  |  |  | bill_lines |  |
| to_line_id | bigint |  |  |  | bill_lines |  |
| from_visit_id | bigint |  |  |  | visits |  |
| to_visit_id | bigint |  |  |  | visits |  |
| reason | text |  |  |  |  |  |
| operator_id | bigint |  |  |  | staff |  |
| business_date | date |  |  |  |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### bill_lines

账单明细（挂账）：价格随明细留存，后续改价不影响 （建表：004_frontdesk）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('bill_lines_id_seq'::regclass) |  |  |
| bill_id | bigint |  |  |  | bills |  |
| source | text |  |  |  |  | 消费来源：洗浴与项目 / 餐饮（S5）/ 技师（S6）/ 客房（S7）/ 其他 |
| item_id | bigint |  | 是 |  | service_items |  |
| name | text |  |  |  |  |  |
| unit_price | bigint |  |  |  |  |  |
| quantity | integer |  |  |  |  |  |
| amount | bigint |  |  |  |  |  |
| status | text |  |  | 'active'::text |  |  |
| post_key | uuid |  |  |  |  | 同一次挂账提交（可能多行）共用一个操作编号 |
| business_date | date |  |  |  |  |  |
| posted_by | bigint |  |  |  | staff |  |
| posted_at | timestamp with time zone |  |  | now() |  |  |
| void_reason | text |  | 是 |  |  |  |
| voided_by | bigint |  | 是 |  | staff |  |
| voided_at | timestamp with time zone |  | 是 |  |  |  |
| tier | text |  | 是 |  |  |  |
| ticket_type_id | bigint |  | 是 |  | ticket_types |  |
| ticket_segments | smallint |  | 是 |  |  |  |
| technician_id | bigint |  | 是 |  | technicians |  |
| call_type | text |  | 是 |  |  |  |
| session_id | bigint |  | 是 |  | technician_sessions |  |
| addon_of | bigint |  | 是 |  | bill_lines |  |
| charge_kind | text |  | 是 |  |  |  |
| clock_extension | boolean |  |  | false |  | 加钟（8.2.2）：这条技师明细是在上钟中的钟单上后加的钟；报表与提成里单列「加钟」 |
| tech_star | smallint |  | 是 |  |  | 挂账时技师的星级（1–10，8.2.2）；没设星级为空。提成按星级取规则时用它 |

### bill_supplements

补单（8.2.3）：有「补单」权限的人按实际时间、出单员给在店客人补录的挂账（餐饮不打厨房单）；明细（bill_lines.post_key = op_key）与 backfill_entries 照旧记

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('bill_supplements_id_seq'::regclass) |  |  |
| op_key | uuid |  |  |  |  | 这一笔挂账的操作编号（= bill_lines.post_key） |
| visit_id | bigint |  |  |  | visits | 补到哪一次来访 |
| issuer_id | bigint |  |  |  | staff | 出单员（实际下单、开单的人） |
| actual_at | timestamp with time zone |  |  |  |  | 实际时间（明细的 posted_at 也是它） |
| created_by | bigint |  |  |  | staff | 录入补单的人 |
| created_at | timestamp with time zone |  |  | now() |  | 录入时间 |

### bills

共同账单：各模块消费明细的汇聚点（S5 餐饮、S7 客房可新增账单类型） （建表：004_frontdesk）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('bills_id_seq'::regclass) |  |  |
| bill_no | text |  |  |  |  |  |
| kind | text |  |  |  |  |  |
| status | text |  |  | 'open'::text |  |  |
| amount_cents | bigint |  |  | 0 |  | 有效明细的合计与行数（同一事务内随明细更新；自检核对与明细一致）；单位：分 |
| line_count | integer |  |  | 0 |  |  |
| business_date | date |  |  |  |  |  |
| opened_at | timestamp with time zone |  |  | now() |  |  |
| closed_at | timestamp with time zone |  | 是 |  |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |

### bonus_expiries

Batch 2.4c：赠金有效期（店主 2026-10-27 #2：档位、赠送金额和赠金有效期——包括不设有效期——都由店主在后台维护） · 充值套餐可设赠金有效期（天），不设为长期有效；自定义赠金按经营规则里的默认有效期（默认不设）； · 每笔赠金是一个「赠金批次」，记下金额、剩余与到期时间； （建表：012_bonus_expiry）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('bonus_expiries_id_seq'::regclass) |  |  |
| doc_no | text |  |  |  |  |  |
| member_id | bigint |  |  |  | members |  |
| amount | bigint |  |  |  |  |  |
| business_date | date |  |  |  |  |  |
| reversal_id | bigint |  | 是 |  | reversals | 撤销消费时恢复到已到期批次、随即作废的，记下是哪张撤销单 |
| created_at | timestamp with time zone |  |  | now() |  |  |

### bonus_lot_moves

批次的每一笔变动：消费扣用（负）、撤销恢复（正）、到期作废（负） （建表：012_bonus_expiry）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('bonus_lot_moves_id_seq'::regclass) |  |  |
| lot_id | bigint |  |  |  | bonus_lots |  |
| kind | text |  |  |  |  |  |
| amount | bigint |  |  |  |  |  |
| consumption_id | bigint |  | 是 |  | consumptions |  |
| reversal_id | bigint |  | 是 |  | reversals |  |
| expiry_id | bigint |  | 是 |  | bonus_expiries |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| opening_id | bigint |  | 是 |  | opening_balances |  |
| member_refund_id | bigint |  | 是 |  | member_refunds |  |
| member_merge_id | bigint |  | 是 |  | member_merges |  |

### bonus_lots

Batch 2.4c：赠金有效期（店主 2026-10-27 #2：档位、赠送金额和赠金有效期——包括不设有效期——都由店主在后台维护） · 充值套餐可设赠金有效期（天），不设为长期有效；自定义赠金按经营规则里的默认有效期（默认不设）； · 每笔赠金是一个「赠金批次」，记下金额、剩余与到期时间； （建表：012_bonus_expiry）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('bonus_lots_id_seq'::regclass) |  |  |
| member_id | bigint |  |  |  | members |  |
| source | text |  |  |  |  |  |
| recharge_id | bigint |  | 是 |  | recharges |  |
| amount | bigint |  |  |  |  |  |
| remaining | bigint |  |  |  |  |  |
| expires_at | timestamp with time zone |  | 是 |  |  | 空为长期有效 |
| created_at | timestamp with time zone |  |  | now() |  |  |
| opening_id | bigint |  | 是 |  | opening_balances | 期初赠金进入赠金批次；批次作废（整批期初作废时）记一笔 void 变动 |
| member_merge_id | bigint |  | 是 |  | member_merges |  |
| origin_lot_id | bigint |  | 是 |  | bonus_lots |  |

### bookings

v0.7.28 ③（主线）：预约（设计见 docs/SCHEDULE_FINISH.md 第 4 节；小程序第三期 3d，docs/MP_PHASE3.md 第 4 节，MP34–MP37；客房电话预订，飞书 Q17）。 （建表：053_bookings）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('bookings_id_seq'::regclass) |  |  |
| booking_no | text |  |  |  |  |  |
| kind | text |  |  |  |  |  |
| source | text |  |  |  |  |  |
| status | text |  |  | 'confirmed'::text |  |  |
| member_id | bigint |  | 是 |  | members |  |
| guest_name | text |  |  | ''::text |  |  |
| guest_phone | text |  |  | ''::text |  |  |
| guests | integer |  |  | 1 |  |  |
| item_id | bigint |  | 是 |  | service_items |  |
| technician_id | bigint |  | 是 |  | technicians |  |
| space_id | bigint |  | 是 |  | spaces |  |
| room_type_id | bigint |  | 是 |  | room_types |  |
| starts_at | timestamp with time zone |  |  |  |  |  |
| ends_at | timestamp with time zone |  |  |  |  |  |
| hold_until | timestamp with time zone |  | 是 |  |  | 客房：保留到几点（过了自动释放、记爽约） |
| note | text |  |  | ''::text |  |  |
| business_date | date |  |  |  |  | 开始那一刻的营业日（看板按它分天） |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| client_key | uuid |  |  |  |  |  |
| request_hash | text |  |  |  |  |  |
| confirmed_by | bigint |  | 是 |  | staff |  |
| confirmed_at | timestamp with time zone |  | 是 |  |  |  |
| arrived_by | bigint |  | 是 |  | staff |  |
| arrived_at | timestamp with time zone |  | 是 |  |  |  |
| arrival_visit_id | bigint |  | 是 |  | visits |  |
| arrival_ref | text |  | 是 |  |  | 到店转成的单据：派对房的使用单号（技师、客房到店后由前台另行派钟、开房，这里记手牌号） |
| cancelled_by | bigint |  | 是 |  | staff |  |
| cancelled_at | timestamp with time zone |  | 是 |  |  |  |
| cancel_reason | text |  | 是 |  |  |  |
| no_show_at | timestamp with time zone |  | 是 |  |  |  |
| no_show_by | bigint |  | 是 |  | staff |  |
| version | integer |  |  | 1 |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| tag_code | text |  |  | ''::text |  | 预约时报的手牌号（8.2.2 一报多，可空）：到店时参考，不锁手牌 |
| technician_overlap | boolean |  |  | false |  | 8.2.5：一报多（8.2.2）建的技师预约——指定技师时有意不查他同一时段别的预约；前台自检「预约不重叠」不把它当错误 |

### checkout_bills

结账单包含的账单（一张或同行多张），记下结账时的门票计算 （建表：014_checkout）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| checkout_id | bigint | PK |  |  | checkouts |  |
| bill_id | bigint | PK |  |  | bills |  |
| visit_id | bigint |  | 是 |  | visits |  |
| amount | bigint |  |  |  |  | 该账单结账时的合计（含门票） |
| stay_minutes | integer |  |  |  |  |  |
| ticket_type_id | bigint |  | 是 |  | ticket_types |  |
| ticket_name | text |  | 是 |  |  |  |
| ticket_segments | smallint |  | 是 |  |  |  |
| ticket_amount | bigint |  | 是 |  |  |  |
| table_session_id | bigint |  | 是 |  | table_sessions |  |
| guests | smallint |  |  | 1 |  |  |
| ticket_extension_minutes | smallint |  |  | 0 |  |  |
| ticket_extension_benefit_id | bigint |  | 是 |  | benefits |  |

### checkout_items

① 部门营业额快照 （建表：025_cashier）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| checkout_id | bigint | PK |  |  | checkouts |  |
| category | text | PK |  |  |  | 部门：门票、客房、其他（手动金额、赔偿等）、价目里的分类（没填的记「未分类」） |
| name | text | PK |  |  |  | 项目：明细名称；房费按种类合并（房费（全天房）、超时半天、钟点房） |
| quantity | integer |  |  |  |  |  |
| amount | bigint |  |  |  |  |  |
| discount | bigint |  |  |  |  | 分摊到这一项的优惠 / 免单 |

### checkout_payments

④ 收款明细 （建表：014_checkout）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('checkout_payments_id_seq'::regclass) |  |  |
| checkout_id | bigint |  |  |  | checkouts |  |
| method | text |  |  |  |  |  |
| amount | bigint |  |  |  |  |  |
| ref | text |  |  | ''::text |  |  |
| member_id | bigint |  | 是 |  | members |  |
| consumption_id | bigint |  | 是 |  | consumptions |  |
| coupon_id | bigint |  | 是 |  | group_buy_coupons |  |
| approved_by | bigint |  | 是 |  | staff |  |
| grant_id | uuid |  | 是 |  | auth_grants |  |
| store_coupon_id | bigint |  | 是 |  | coupons |  |
| coupon_lines | bigint[] |  | 是 |  |  |  |
| discount_member_id | bigint |  | 是 |  | members |  |
| benefit_id | bigint |  | 是 |  | benefits |  |
| benefit_version | integer |  | 是 |  |  |  |
| discount_rate | smallint |  | 是 |  |  |  |
| count_card_id | bigint |  | 是 |  | count_cards |  |
| count_card_uses | integer |  | 是 |  |  |  |
| ar_account_id | bigint |  | 是 |  | ar_accounts |  |
| pay_tx_id | bigint |  | 是 |  | pay_transactions | 收款明细、充值单记下用的是哪一笔扫码收款 |
| company_reason | text |  | 是 |  |  | 8.2.4 公司承担的原因：unwell 客人身体不适 / hosting 招待 / other 其他（说明写在 ref）；别的收款方式为空 |

### checkouts

② 结账单 （建表：014_checkout）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('checkouts_id_seq'::regclass) |  |  |
| checkout_no | text |  |  |  |  |  |
| client_key | uuid |  |  |  |  |  |
| status | text |  |  | 'completed'::text |  |  |
| total_amount | bigint |  |  |  |  | 账单合计（含门票）= 收款合计：结清才能离店 |
| paid_amount | bigint |  |  |  |  |  |
| note | text |  |  | ''::text |  |  |
| business_date | date |  |  |  |  |  |
| operator_id | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  |  |  |  |
| voided_at | timestamp with time zone |  | 是 |  |  |  |
| voided_by | bigint |  | 是 |  | staff |  |
| void_reason | text |  | 是 |  |  |  |
| void_business_date | date |  | 是 |  |  | 反结账记入的营业日（日结按它汇总） |
| shift_id | bigint |  | 是 |  | shifts |  |
| void_shift_id | bigint |  | 是 |  | shifts |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |

### commission_rule_versions

v0.7.1 S6 技师第二步（ROADMAP 第 10 节）：钟房看板、轮钟排队、上下钟计时、提成。 · 钟单（technician_sessions）：一位技师给一位客人的一段连续服务（含加钟）。钱仍只在账单明细里，钟单只记钟数、时长与状态； 明细挂账时写上钟单编号（随明细只追加、不可改）。 （建表：021_clockroom）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('commission_rule_versions_id_seq'::regclass) |  |  |
| rules | jsonb |  |  |  |  |  |
| effective_at | timestamp with time zone |  |  | now() |  |  |
| note | text |  |  | ''::text |  |  |
| created_by | bigint |  | 是 |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| store_id | bigint |  | 是 |  | stores | 门店（8.2.2，各店提成不同）；为空是 8.2.2 以前全公司一份的规则，本店没保存过自己的规则时用它 |

### consumption_lines

浴族 yuzu 初始结构 约定：金额一律为整数「分」(bigint)；已入账的单据与流水只追加，不修改、不删除， 纠错通过新增撤销/冲正记录完成。 （建表：001_init）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('consumption_lines_id_seq'::regclass) |  |  |
| consumption_id | bigint |  |  |  | consumptions |  |
| item_id | bigint |  | 是 |  | service_items |  |
| name | text |  |  |  |  |  |
| unit_price | bigint |  |  |  |  |  |
| quantity | integer |  |  |  |  |  |
| amount | bigint |  |  |  |  |  |
| tier | text |  | 是 |  |  |  |

### consumptions

消费单 （建表：001_init）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('consumptions_id_seq'::regclass) |  |  |
| doc_no | text |  |  |  |  |  |
| member_id | bigint |  |  |  | members |  |
| total_amount | bigint |  |  |  |  |  |
| principal_amount | bigint |  |  |  |  |  |
| bonus_amount | bigint |  |  |  |  |  |
| deduction_rule | text |  |  |  |  |  |
| note | text |  |  | ''::text |  |  |
| status | text |  |  | 'completed'::text |  |  |
| business_date | date |  |  |  |  |  |
| operator_id | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| over_limit_approved_by | bigint |  | 是 |  | staff |  |
| checkout_id | bigint |  | 是 |  | checkouts | 会员储值支付生成的消费单指向结账单 |
| store_id | bigint |  |  | yuzu_store() | stores |  |

### contract_acceptances

验收登记（只追加；登错了作废，以最近一条没作废的为准） （建表：080_payment_requests）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('contract_acceptances_id_seq'::regclass) |  |  |
| contract_id | bigint |  |  |  | contracts |  |
| accepted_on | date |  |  |  |  |  |
| result | text |  |  |  |  |  |
| signer | text |  |  |  |  |  |
| note | text |  |  | ''::text |  |  |
| voided_by | bigint |  | 是 |  | staff |  |
| voided_at | timestamp with time zone |  | 是 |  |  |  |
| void_reason | text |  | 是 |  |  |  |
| client_key | uuid |  |  |  |  |  |
| request_hash | text |  |  |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| items | jsonb |  | 是 |  |  | 验收登记的逐条结果 |

### contract_changes

变更单（改价、改量、延期；C10） （建表：077_contracts）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('contract_changes_id_seq'::regclass) |  |  |
| change_no | text |  |  |  |  |  |
| contract_id | bigint |  |  |  | contracts |  |
| base_version | integer |  |  |  |  | 在第几版上改 |
| kinds | text[] |  |  |  |  |  |
| reason | text |  |  |  |  |  |
| draft | jsonb |  |  |  |  | 改后的全部内容（与合同的草稿同一个格式） |
| total_cents | bigint |  |  |  |  | 单位：分 |
| delta_cents | bigint |  |  |  |  | 改后与改前总价之差的绝对值（审批规则按它匹配）；单位：分 |
| status | text |  |  | 'draft'::text |  |  |
| version | integer |  |  | 1 |  |  |
| result_version | integer |  | 是 |  |  | 同意后合同的第几版 |
| closed_reason | text |  | 是 |  |  |  |
| closed_by | bigint |  | 是 |  | staff |  |
| closed_at | timestamp with time zone |  | 是 |  |  |  |
| client_key | uuid |  | 是 |  |  |  |
| request_hash | text |  | 是 |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### contract_files

扫描件（按页拍照，图片沿用 erp_images；不删，传错的标记删掉） （建表：077_contracts）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('contract_files_id_seq'::regclass) |  |  |
| contract_id | bigint |  |  |  | contracts |  |
| image_id | bigint |  | 是 |  | erp_images |  |
| sort_no | integer |  |  |  |  |  |
| added_by | bigint |  |  |  | staff |  |
| added_at | timestamp with time zone |  |  | now() |  |  |
| removed_by | bigint |  | 是 |  | staff |  |
| removed_at | timestamp with time zone |  | 是 |  |  |  |
| file_id | bigint |  | 是 |  | erp_files |  |
| name | text |  |  | ''::text |  |  |

### contract_lines

单价表（挂在提交记录上；只追加） （建表：077_contracts）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('contract_lines_id_seq'::regclass) |  |  |
| revision_id | bigint |  |  |  | contract_revisions |  |
| line_no | integer |  |  |  |  |  |
| material_id | bigint |  | 是 |  | materials |  |
| item_name | text |  |  |  |  |  |
| spec | text |  |  | ''::text |  |  |
| unit | text |  |  |  |  |  |
| price_cents | bigint |  |  |  |  | 含税单价（每个单位，整数分）、税率（万分比） |
| tax_rate_bp | integer |  |  |  |  |  |
| qty_milli | bigint |  | 是 |  |  | 合同数量（千分之一单位；空 = 不限量） |

### contract_payouts

合同付款（服务、租赁、其他合同：没有收货单、不记应付，不进供应商往来） （建表：080_payment_requests）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('contract_payouts_id_seq'::regclass) |  |  |
| doc_no | text |  |  |  |  |  |
| payment_request_id | bigint |  |  |  | payment_requests |  |
| pay_date | date |  |  |  |  |  |
| amount_cents | bigint |  |  |  |  | 单位：分 |
| method | text |  |  |  |  |  |
| evidence | text |  |  |  |  |  |
| note | text |  |  | ''::text |  |  |
| status | text |  |  | 'confirmed'::text |  |  |
| voided_by | bigint |  | 是 |  | staff |  |
| voided_at | timestamp with time zone |  | 是 |  |  |  |
| void_reason | text |  | 是 |  |  |  |
| client_key | uuid |  |  |  |  |  |
| request_hash | text |  |  |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| entity_id | bigint |  |  | yuzu_entity() | legal_entities |  |

### contract_quality_issues

质量问题登记（未处理 → 已处理，或登错了作废） （建表：080_payment_requests）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('contract_quality_issues_id_seq'::regclass) |  |  |
| contract_id | bigint |  |  |  | contracts |  |
| found_on | date |  |  |  |  |  |
| description | text |  |  |  |  |  |
| status | text |  |  | 'open'::text |  |  |
| resolved_on | date |  | 是 |  |  |  |
| resolution | text |  | 是 |  |  |  |
| resolved_by | bigint |  | 是 |  | staff |  |
| resolved_at | timestamp with time zone |  | 是 |  |  |  |
| void_reason | text |  | 是 |  |  |  |
| voided_by | bigint |  | 是 |  | staff |  |
| voided_at | timestamp with time zone |  | 是 |  |  |  |
| client_key | uuid |  |  |  |  |  |
| request_hash | text |  |  |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### contract_reviews

法务审查清单的结论（C3；法务那一级同意或退回时逐条给，挂在提交记录上；只追加） （建表：077_contracts）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('contract_reviews_id_seq'::regclass) |  |  |
| revision_id | bigint |  |  |  | contract_revisions |  |
| approval_request_id | bigint |  |  |  | approval_requests |  |
| level | integer |  |  |  |  |  |
| action | text |  |  |  |  |  |
| items | jsonb |  |  |  |  | [{ key, verdict: pass \| revise \| risk, note }] |
| reviewer_id | bigint |  |  |  | staff |  |
| on_behalf_of | bigint |  | 是 |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### contract_revisions

提交记录（每次提交审查存一份当时的内容；只追加） （建表：077_contracts）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('contract_revisions_id_seq'::regclass) |  |  |
| contract_id | bigint |  |  |  | contracts |  |
| change_id | bigint |  | 是 |  | contract_changes | 变更单的提交记录记下是哪张变更单（合同本身的提交为空） |
| seq | integer |  |  |  |  | 这份合同的第几次提交（合同与变更单的提交一起排） |
| content | jsonb |  |  |  |  | 标题、起止日、总价、税率、运费卸货、付款节点、质保、验收标准、备注（单价表在 contract_lines） |
| approval_request_id | bigint |  | 是 |  | approval_requests |  |
| submitted_by | bigint |  |  |  | staff |  |
| submitted_at | timestamp with time zone |  |  | now() |  |  |

### contract_seals

用印登记（C7；提交即走审批） （建表：077_contracts）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('contract_seals_id_seq'::regclass) |  |  |
| seal_no | text |  |  |  |  |  |
| contract_id | bigint |  |  |  | contracts |  |
| seal_type | text |  |  |  |  |  |
| copies | integer |  |  |  |  |  |
| operator_id | bigint |  |  |  | staff | 用印人 |
| seal_date | date |  |  |  |  |  |
| purpose | text |  |  | ''::text |  |  |
| status | text |  |  | 'reviewing'::text |  |  |
| version | integer |  |  | 1 |  |  |
| client_key | uuid |  | 是 |  |  |  |
| request_hash | text |  | 是 |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### contract_templates

8.0.21 合同模板与起草（docs/FINANCE_V8021.md 第 6 节，CW-E / CW20）。 · contract_templates：合同正文的模板。正文是纯文本加段落，用 {{字段}} 占位（内置字段 + 模板自己的可填字段）；可选条款起草时勾选。 （建表：146_contract_templates）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | identity always |  |  |
| code | text |  |  |  |  |  |
| version | integer |  |  |  |  |  |
| name | text |  |  |  |  |  |
| category | text |  |  |  |  |  |
| body | text |  |  |  |  |  |
| fields | jsonb |  |  | '[]'::jsonb |  | 可填字段：[{ key, label, type: text\|number\|date, required }] |
| clauses | jsonb |  |  | '[]'::jsonb |  | 可选条款：[{ key, title, text, default }] |
| status | text |  |  | 'active'::text |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| retired_by | bigint |  | 是 |  | staff |  |
| retired_at | timestamp with time zone |  | 是 |  |  |  |

### contract_versions

版本：审批通过的提交记录（第 1 版是合同审批通过的那份，之后每张同意的变更单加一版；只追加） （建表：077_contracts）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('contract_versions_id_seq'::regclass) |  |  |
| contract_id | bigint |  |  |  | contracts |  |
| version_no | integer |  |  |  |  |  |
| revision_id | bigint |  |  |  | contract_revisions |  |
| change_id | bigint |  | 是 |  | contract_changes |  |
| approved_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### contracts

合同 （建表：077_contracts）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('contracts_id_seq'::regclass) |  |  |
| contract_no | text |  |  |  |  |  |
| category | text |  |  |  |  |  |
| supplier_id | bigint |  | 是 |  | suppliers |  |
| counterparty | text |  |  |  |  |  |
| department_id | bigint |  | 是 |  | departments |  |
| handler_id | bigint |  |  |  | staff |  |
| renewal_of | bigint |  | 是 |  | contracts | 续签：新合同指向被续签的旧合同 |
| status | text |  |  | 'draft'::text |  |  |
| draft | jsonb |  |  |  |  | 起草中、已退回时编辑的内容（标题、起止日、总价、税率、运费卸货、四要素、单价表、备注）；审批通过以后改走变更单 |
| title | text |  |  |  |  | 台账用的当前内容：没生效前取草稿，生效后取生效的那一版 |
| start_date | date |  | 是 |  |  |  |
| end_date | date |  | 是 |  |  |  |
| total_cents | bigint |  |  |  |  | 单位：分 |
| current_revision_id | bigint |  | 是 |  | contract_revisions | 生效的那份提交记录与版本号（审批通过以后才有；变更单同意后换成新的一份、版本号加 1） |
| current_version | integer |  |  | 0 |  |  |
| version | integer |  |  | 1 |  | 改内容、改状态的乐观锁（两人同时改，后保存的被拒） |
| signed_on | date |  | 是 |  |  | 签署登记 |
| our_signatory | text |  | 是 |  |  |  |
| their_signatory | text |  | 是 |  |  |  |
| signed_by | bigint |  | 是 |  | staff |  |
| signed_at | timestamp with time zone |  | 是 |  |  |  |
| archive_no | text |  | 是 |  |  | 归档 |
| archive_location | text |  | 是 |  |  |  |
| archived_by | bigint |  | 是 |  | staff |  |
| archived_at | timestamp with time zone |  | 是 |  |  |  |
| closed_reason | text |  | 是 |  |  | 作废（没签署的）、终止（签署以后的） |
| closed_on | date |  | 是 |  |  |  |
| closed_by | bigint |  | 是 |  | staff |  |
| closed_at | timestamp with time zone |  | 是 |  |  |  |
| client_key | uuid |  | 是 |  |  |  |
| request_hash | text |  | 是 |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| entity_id | bigint |  |  | yuzu_entity() | legal_entities |  |

### count_card_moves

v0.7.28 ④（主线）：次卡（设计见 docs/SCHEDULE_FINISH.md 第 5 节，N5 待确认）。 · count_card_types：卡种——能抵的价目项目、票种，几次、售价、有效期（天，空为长期）；改了只影响之后卖的卡； （建表：054_count_cards）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('count_card_moves_id_seq'::regclass) |  |  |
| card_id | bigint |  |  |  | count_cards |  |
| kind | text |  |  |  |  |  |
| delta | integer |  |  |  |  |  |
| amount | bigint |  |  | 0 |  | 售卡：售价；结账使用、反结账退回：抵的金额（按明细的价钱）；退卡：退的钱；期初、过期：0 |
| checkout_id | bigint |  | 是 |  | checkouts |  |
| refund_id | bigint |  | 是 |  | count_card_refunds |  |
| note | text |  |  | ''::text |  |  |
| staff_id | bigint |  |  |  | staff |  |
| at | timestamp with time zone |  |  |  |  |  |
| business_date | date |  |  |  |  |  |

### count_card_refunds

v0.7.28 ④（主线）：次卡（设计见 docs/SCHEDULE_FINISH.md 第 5 节，N5 待确认）。 · count_card_types：卡种——能抵的价目项目、票种，几次、售价、有效期（天，空为长期）；改了只影响之后卖的卡； （建表：054_count_cards）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('count_card_refunds_id_seq'::regclass) |  |  |
| refund_no | text |  |  |  |  |  |
| card_id | bigint |  |  |  | count_cards |  |
| uses | integer |  |  |  |  |  |
| amount | bigint |  |  |  |  |  |
| method | text |  |  |  |  |  |
| ref | text |  |  | ''::text |  |  |
| reason | text |  |  |  |  |  |
| operator_id | bigint |  |  |  | staff |  |
| shift_id | bigint |  | 是 |  | shifts |  |
| business_date | date |  |  |  |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| client_key | uuid |  |  |  |  |  |
| request_hash | text |  |  |  |  |  |

### count_card_types

v0.7.28 ④（主线）：次卡（设计见 docs/SCHEDULE_FINISH.md 第 5 节，N5 待确认）。 · count_card_types：卡种——能抵的价目项目、票种，几次、售价、有效期（天，空为长期）；改了只影响之后卖的卡； （建表：054_count_cards）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('count_card_types_id_seq'::regclass) |  |  |
| name | text |  |  |  |  |  |
| item_ids | bigint[] |  |  | '{}'::bigint[] |  |  |
| ticket_type_ids | bigint[] |  |  | '{}'::bigint[] |  |  |
| uses | integer |  |  |  |  |  |
| price | bigint |  |  |  |  |  |
| valid_days | integer |  | 是 |  |  |  |
| active | boolean |  |  | true |  |  |
| note | text |  |  | ''::text |  |  |
| version | integer |  |  | 1 |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_by | bigint |  | 是 |  | staff |  |
| updated_at | timestamp with time zone |  | 是 |  |  |  |

### count_cards

v0.7.28 ④（主线）：次卡（设计见 docs/SCHEDULE_FINISH.md 第 5 节，N5 待确认）。 · count_card_types：卡种——能抵的价目项目、票种，几次、售价、有效期（天，空为长期）；改了只影响之后卖的卡； （建表：054_count_cards）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('count_cards_id_seq'::regclass) |  |  |
| card_no | text |  |  |  |  |  |
| member_id | bigint |  |  |  | members |  |
| type_id | bigint |  | 是 |  | count_card_types |  |
| name | text |  |  |  |  |  |
| item_ids | bigint[] |  |  | '{}'::bigint[] |  |  |
| ticket_type_ids | bigint[] |  |  | '{}'::bigint[] |  |  |
| total_uses | integer |  |  |  |  |  |
| remaining | integer |  |  |  |  |  |
| price | bigint |  |  |  |  |  |
| expires_on | date |  | 是 |  |  |  |
| source | text |  |  |  |  |  |
| status | text |  |  | 'active'::text |  |  |
| payment_method | text |  | 是 |  |  |  |
| payment_ref | text |  |  | ''::text |  |  |
| shift_id | bigint |  | 是 |  | shifts |  |
| business_date | date |  |  |  |  |  |
| sold_by | bigint |  |  |  | staff |  |
| sold_at | timestamp with time zone |  |  |  |  |  |
| note | text |  |  | ''::text |  |  |
| client_key | uuid |  | 是 |  |  |  |
| request_hash | text |  | 是 |  |  |  |
| version | integer |  |  | 1 |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |

### coupon_campaign_members

圈到的会员（新建时按圈选条件定下来，之后按名单发；跳过的写原因） （建表：089_coupon_campaigns）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| campaign_id | bigint | PK |  |  | coupon_campaigns |  |
| member_id | bigint | PK |  |  | members |  |
| status | text |  |  | 'pending'::text |  |  |
| issue_id | bigint |  | 是 |  | coupon_issues |  |
| skip_reason | text |  | 是 |  |  |  |

### coupon_campaigns

8.0.4 会员体系整改（docs/MEMBERSHIP_V804.md）： · 第 9.1 节 买一赠一券：券模板加种类 bogo——买的项目 buy_item_id，赠的项目沿用 exchange_item_id； 可选的赠品出库设置（物料、每份出库数量、出哪个仓）； （建表：089_coupon_campaigns）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('coupon_campaigns_id_seq'::regclass) |  |  |
| campaign_no | text |  |  |  |  |  |
| template_id | bigint |  |  |  | coupon_templates |  |
| quantity | integer |  |  |  |  | 每人几张 |
| audience | jsonb |  |  |  |  | 圈选条件（发券当时的）：{"grades": [..], "tagIds": [..], "tagNames": [..]} |
| reason | text |  |  |  |  |  |
| notify_sms | boolean |  |  |  |  |  |
| notify_popup | boolean |  |  |  |  |  |
| remind_days | integer |  | 是 |  |  | 会员端弹窗：到期前几天再提醒一次 |
| status | text |  |  |  |  |  |
| targeted | integer |  |  |  |  |  |
| client_key | uuid |  |  |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| business_date | date |  |  |  |  |  |
| finished_at | timestamp with time zone |  | 是 |  |  |  |

### coupon_events

券的变动：用（结账）、退回（反结账）、作废，只追加；券的状态与这些记录一致（自检核对） （建表：037_refunds_coupons）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('coupon_events_id_seq'::regclass) |  |  |
| coupon_id | bigint |  |  |  | coupons |  |
| kind | text |  |  |  |  |  |
| checkout_id | bigint |  | 是 |  | checkouts |  |
| amount | bigint |  | 是 |  |  |  |
| reason | text |  |  | ''::text |  |  |
| staff_id | bigint |  |  |  | staff |  |
| at | timestamp with time zone |  |  |  |  |  |
| business_date | date |  |  |  |  |  |

### coupon_gift_outs

8.0.4 会员体系整改（docs/MEMBERSHIP_V804.md）： · 第 9.1 节 买一赠一券：券模板加种类 bogo——买的项目 buy_item_id，赠的项目沿用 exchange_item_id； 可选的赠品出库设置（物料、每份出库数量、出哪个仓）； （建表：089_coupon_campaigns）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('coupon_gift_outs_id_seq'::regclass) |  |  |
| coupon_id | bigint |  |  |  | coupons |  |
| checkout_id | bigint |  |  |  | checkouts |  |
| template_id | bigint |  |  |  | coupon_templates |  |
| item_id | bigint |  | 是 |  | service_items |  |
| material_id | bigint |  |  |  | materials |  |
| qty_milli | bigint |  |  |  |  |  |
| warehouse_id | bigint |  |  |  | warehouses |  |
| status | text |  |  | 'pending'::text |  | 待出库 → 已出库 / 出库失败（补完库存后重试）；反结账：待出库的取消，已出库的冲销（失败的记下来由仓库手工处理） |
| client_key | uuid |  |  | gen_random_uuid() |  | 开库存单用的操作编号（重试也用它，不会开出两张） |
| inv_doc_id | bigint |  | 是 |  | inv_docs |  |
| attempts | integer |  |  | 0 |  |  |
| last_error | text |  | 是 |  |  |  |
| business_date | date |  |  |  |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### coupon_issues

发券记录：一次发券一条（手动、无记名批次、自动规则），只追加 （建表：037_refunds_coupons）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('coupon_issues_id_seq'::regclass) |  |  |
| issue_no | text |  |  |  |  |  |
| kind | text |  |  |  |  |  |
| template_id | bigint |  |  |  | coupon_templates |  |
| member_id | bigint |  | 是 |  | members |  |
| quantity | integer |  |  |  |  |  |
| rule_id | bigint |  | 是 |  | coupon_rules |  |
| recharge_id | bigint |  | 是 |  | recharges |  |
| level | smallint |  | 是 |  |  | 升级礼：达到的等级；生日礼：发券时的等级 |
| reason | text |  |  | ''::text |  |  |
| client_key | uuid |  | 是 |  |  | 手动、批次：页面的操作编号（重复提交返回原记录）；自动：去重键（规则 + 会员 + 年份 / 充值单） |
| dedupe_key | text |  | 是 |  |  |  |
| issued_by | bigint |  | 是 |  | staff | 自动发券记触发它的员工（建档、充值的经办人）；生日礼由定时任务发，为空 |
| issued_at | timestamp with time zone |  |  |  |  |  |
| business_date | date |  |  |  |  |  |
| campaign_id | bigint |  | 是 |  | coupon_campaigns |  |
| authorized_by | bigint |  | 是 |  | staff |  |
| gift_channel | text |  | 是 |  |  |  |

### coupon_rules

发券规则：开卡礼（不分等级）、升级礼（达到的等级）、生日礼（发券时的等级）、充值赠券（充值套餐）。 规则不能改，只能停用后另加；自动发券按「规则 + 会员 + 年份 / 充值单」去重 （建表：037_refunds_coupons）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('coupon_rules_id_seq'::regclass) |  |  |
| kind | text |  |  |  |  |  |
| level | smallint |  | 是 |  |  |  |
| plan_id | bigint |  | 是 |  | recharge_plans |  |
| template_id | bigint |  |  |  | coupon_templates |  |
| quantity | integer |  |  |  |  |  |
| active | boolean |  |  | true |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| deactivated_by | bigint |  | 是 |  | staff |  |
| deactivated_at | timestamp with time zone |  | 是 |  |  |  |
| client_key | uuid |  | 是 |  |  | 新建时页面的操作编号（没收到结果再提交返回原来那条：重复的规则会重复发券） |

### coupon_templates

② 券与会员权益 （建表：037_refunds_coupons）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('coupon_templates_id_seq'::regclass) |  |  |
| name | text |  |  |  |  |  |
| kind | text |  |  |  |  | 代金券 / 折扣券 / 兑换券 |
| face_value | bigint |  | 是 |  |  |  |
| rate_percent | integer |  | 是 |  |  | 折扣券：按百分比，88 = 8.8 折 |
| max_off | bigint |  | 是 |  |  | 折扣券「最多减」、兑换券「最多抵」；空 = 不限 |
| threshold | bigint |  |  | 0 |  | 满多少可用（按适用的明细算）；0 = 不限 |
| scope | text |  |  | 'all'::text |  |  |
| scope_categories | text[] |  |  | '{}'::text[] |  |  |
| scope_items | bigint[] |  |  | '{}'::bigint[] |  |  |
| exchange_item_id | bigint |  | 是 |  | service_items |  |
| exchange_ticket_type_id | bigint |  | 是 |  | ticket_types |  |
| validity | text |  |  |  |  | 有效期按营业日：固定起止日期，或发券后 N 天（发券当天算第 1 天） |
| valid_from | date |  | 是 |  |  |  |
| valid_to | date |  | 是 |  |  |  |
| valid_days | integer |  | 是 |  |  |  |
| levels | smallint[] |  |  | '{}'::smallint[] |  | 限定发放等级（空 = 不限） |
| note | text |  |  | ''::text |  |  |
| active | boolean |  |  | true |  |  |
| version | integer |  |  | 1 |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| client_key | uuid |  | 是 |  |  | 新建时页面的操作编号（没收到结果再提交返回原来那个，不会多建一个） |
| buy_item_id | bigint |  | 是 |  | service_items |  |
| gift_material_id | bigint |  | 是 |  | materials |  |
| gift_qty_milli | bigint |  | 是 |  |  |  |
| gift_warehouse_id | bigint |  | 是 |  | warehouses |  |
| gift | boolean |  |  | false |  |  |
| gift_segment | text |  |  | ''::text |  |  |
| gift_content | text |  |  | ''::text |  |  |
| gift_rules | text |  |  | ''::text |  |  |
| weekdays | smallint[] |  |  | '{}'::smallint[] |  |  |
| time_from | integer |  | 是 |  |  |  |
| time_to | integer |  | 是 |  |  |  |
| store_ids | bigint[] |  |  | '{}'::bigint[] |  |  |
| designated_only | boolean |  |  | false |  |  |

### coupons

券：12 位券码（去掉易混的 0、O、1、I）；有效期按营业日（发券时按模板算好）。 状态是变动记录的结果：可用 → 已用（结账）→ 可用（反结账退回）；可用 → 作废。过期不改数据，按日期算 （建表：037_refunds_coupons）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('coupons_id_seq'::regclass) |  |  |
| code | text |  |  |  |  |  |
| issue_id | bigint |  |  |  | coupon_issues |  |
| template_id | bigint |  |  |  | coupon_templates |  |
| member_id | bigint |  | 是 |  | members |  |
| valid_from | date |  |  |  |  |  |
| valid_to | date |  |  |  |  |  |
| status | text |  |  | 'available'::text |  |  |
| checkout_id | bigint |  | 是 |  | checkouts | 用在哪张结账单（已用时） |
| created_at | timestamp with time zone |  |  |  |  |  |

### current_locations

当前位置：每人一行（当前所在空间）；离店、下牌后清空位置，行留着作为这个人的写入锁 （建表：035_locations）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('current_locations_id_seq'::regclass) |  |  |
| visit_id | bigint |  | 是 |  |  |  |
| technician_id | bigint |  | 是 |  |  |  |
| state | text |  |  | 'none'::text |  | 还没有事件 / 在某处 / 离开了某处（位置不明）/ 离店 |
| floor_id | bigint |  | 是 |  |  |  |
| zone_id | bigint |  | 是 |  |  |  |
| space_id | bigint |  | 是 |  |  |  |
| since | timestamp with time zone |  | 是 |  |  | 进入这里的时刻与当前轨迹段 |
| track_id | bigint |  | 是 |  | location_tracks |  |
| last_at | timestamp with time zone |  | 是 |  |  | 最近一条生效事件 |
| last_event_id | bigint |  | 是 |  | location_events |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |

### custom_field_defs

8.0.21 自定义字段（docs/FINANCE_V8021.md 第 1 节，CW-J / CW10 / CW12）：会员、供应商、物料、合同四类，每类启用的最多 10 个。 · custom_field_defs：定义。编号 key（f1…f99，按建的先后取）建了就不改；名称在启用的里面不重名； （建表：141_custom_fields）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | identity always |  |  |
| entity | text |  |  |  |  |  |
| key | text |  |  |  |  |  |
| label | text |  |  |  |  |  |
| type | text |  |  |  |  |  |
| options | jsonb |  |  | '[]'::jsonb |  | 选项类的可选值（其余为空数组） |
| in_list | boolean |  |  | false |  | 列表里显示这一列 |
| active | boolean |  |  | true |  |  |
| sort | integer |  |  | 0 |  |  |
| version | integer |  |  | 1 |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### custom_field_values

8.0.21 自定义字段（docs/FINANCE_V8021.md 第 1 节，CW-J / CW10 / CW12）：会员、供应商、物料、合同四类，每类启用的最多 10 个。 · custom_field_defs：定义。编号 key（f1…f99，按建的先后取）建了就不改；名称在启用的里面不重名； （建表：141_custom_fields）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| field_id | bigint | PK |  |  | custom_field_defs |  |
| entity_id | bigint | PK |  |  |  | 会员、供应商、物料、合同的编号（不用外键：四类分在四张表；对象停用、作废也留着值） |
| value | text |  |  |  |  |  |
| updated_by | bigint |  |  |  | staff |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### customer_binding_events

客户部仅扩展服务、维护、归属试算与目标；不改原生财务数据。 （建表：162_customer_workbench）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('customer_binding_events_id_seq'::regclass) |  |  |
| member_id | bigint |  |  |  | members |  |
| from_staff_id | bigint |  | 是 |  | staff |  |
| to_staff_id | bigint |  |  |  | staff |  |
| request_id | bigint |  |  |  | customer_binding_requests |  |
| version | integer |  |  |  |  |  |
| effective_at | timestamp with time zone |  |  | clock_timestamp() |  |  |
| approved_by | bigint |  |  |  | staff |  |

### customer_binding_requests

客户部仅扩展服务、维护、归属试算与目标；不改原生财务数据。 （建表：162_customer_workbench）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('customer_binding_requests_id_seq'::regclass) |  |  |
| member_id | bigint |  |  |  | members |  |
| from_staff_id | bigint |  | 是 |  | staff |  |
| to_staff_id | bigint |  |  |  | staff |  |
| expected_version | integer |  |  |  |  |  |
| reason | text |  |  |  |  |  |
| status | text |  |  | 'pending'::text |  |  |
| version | integer |  |  | 1 |  |  |
| requested_by | bigint |  |  |  | staff |  |
| requested_at | timestamp with time zone |  |  | clock_timestamp() |  |  |
| reviewed_by | bigint |  | 是 |  | staff |  |
| reviewed_at | timestamp with time zone |  | 是 |  |  |  |
| review_reason | text |  |  | ''::text |  |  |

### customer_bindings

客户部仅扩展服务、维护、归属试算与目标；不改原生财务数据。 （建表：162_customer_workbench）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| member_id | bigint | PK |  |  | members |  |
| maintainer_staff_id | bigint |  | 是 |  | staff |  |
| version | integer |  |  | 0 |  |  |
| updated_at | timestamp with time zone |  |  | clock_timestamp() |  |  |

### customer_credit_events

客户部仅扩展服务、维护、归属试算与目标；不改原生财务数据。 （建表：162_customer_workbench）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('customer_credit_events_id_seq'::regclass) |  |  |
| credit_id | bigint |  |  |  | customer_recharge_credits |  |
| version | integer |  |  |  |  |  |
| action | text |  |  |  |  |  |
| snapshot | jsonb |  |  |  |  |  |
| actor_id | bigint |  |  |  | staff |  |
| reason | text |  |  |  |  |  |
| created_at | timestamp with time zone |  |  | clock_timestamp() |  |  |

### customer_month_targets

客户部仅扩展服务、维护、归属试算与目标；不改原生财务数据。 （建表：162_customer_workbench）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('customer_month_targets_id_seq'::regclass) |  |  |
| month | date |  |  |  |  |  |
| staff_id | bigint |  | 是 |  | staff |  |
| group_name | text |  |  | ''::text |  |  |
| target_cents | bigint |  |  |  |  | 单位：分 |
| version | integer |  |  | 1 |  |  |
| updated_by | bigint |  |  |  | staff |  |
| updated_at | timestamp with time zone |  |  | clock_timestamp() |  |  |

### customer_recharge_credits

客户部仅扩展服务、维护、归属试算与目标；不改原生财务数据。 （建表：162_customer_workbench）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('customer_recharge_credits_id_seq'::regclass) |  |  |
| recharge_id | bigint |  |  |  | recharges |  |
| member_id | bigint |  |  |  | members |  |
| occurred_at | timestamp with time zone |  |  |  |  |  |
| seller_staff_id | bigint |  | 是 |  | staff |  |
| first_kind | text |  |  |  |  |  |
| owner_department | text |  |  |  |  |  |
| status | text |  |  | 'pending'::text |  |  |
| version | integer |  |  | 1 |  |  |
| reason | text |  |  |  |  |  |
| maintainer_at_event | bigint |  | 是 |  | staff |  |
| claimed_by | bigint |  |  |  | staff |  |
| claimed_at | timestamp with time zone |  |  | clock_timestamp() |  |  |
| reviewed_by | bigint |  | 是 |  | staff |  |
| reviewed_at | timestamp with time zone |  | 是 |  |  |  |
| review_reason | text |  |  | ''::text |  |  |
| canonical_member_id | bigint |  |  |  | members |  |

### customer_service_notes

客户部仅扩展服务、维护、归属试算与目标；不改原生财务数据。 （建表：162_customer_workbench）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('customer_service_notes_id_seq'::regclass) |  |  |
| member_id | bigint |  | 是 |  | members |  |
| visit_id | bigint |  | 是 |  | visits |  |
| staff_id | bigint |  |  |  | staff |  |
| kind | text |  |  |  |  |  |
| occurred_at | timestamp with time zone |  |  |  |  |  |
| outcome | text |  |  |  |  |  |
| content | text |  |  |  |  |  |
| feedback | text |  |  | ''::text |  |  |
| next_contact_on | date |  | 是 |  |  |  |
| maintainer_at_event | bigint |  | 是 |  | staff |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | clock_timestamp() |  |  |

### customer_target_versions

客户部仅扩展服务、维护、归属试算与目标；不改原生财务数据。 （建表：162_customer_workbench）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('customer_target_versions_id_seq'::regclass) |  |  |
| target_id | bigint |  |  |  | customer_month_targets |  |
| version | integer |  |  |  |  |  |
| snapshot | jsonb |  |  |  |  |  |
| actor_id | bigint |  |  |  | staff |  |
| reason | text |  |  |  |  |  |
| created_at | timestamp with time zone |  |  | clock_timestamp() |  |  |

### daily_settlements

日结确认 （建表：001_init）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| business_date | date | PK |  |  |  |  |
| closed_by | bigint |  |  |  | staff |  |
| closed_at | timestamp with time zone |  |  | now() |  |  |
| note | text |  |  | ''::text |  |  |
| snapshot | jsonb |  |  |  |  |  |
| revision | integer |  |  | 1 |  |  |
| store_id | bigint | PK |  | yuzu_store() | stores |  |

### departments

档案：部门、供应商、物料 （建表：002_inventory）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('departments_id_seq'::regclass) |  |  |
| name | text |  |  |  |  |  |
| active | boolean |  |  | true |  |  |
| sort_order | integer |  |  | 0 |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| head_id | bigint |  | 是 |  | staff |  |

### design_asset_versions

Design 素材库（店主 2026-11-24，docs/BOARDS.md 第 4、9 节）：字体、图片、视频按用途设「当前使用」的一份，一键切换、可切回。 · design_assets：一份素材（种类、名字、标签、说明——字体写授权说明）；归档以后不再出现在选择里，被用途用着的不能归档。 （建表：265_design_assets）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('design_asset_versions_id_seq'::regclass) |  |  |
| asset_id | bigint |  |  |  | design_assets |  |
| version_no | integer |  |  |  |  |  |
| sha256 | text |  |  |  |  |  |
| mime | text |  |  |  |  |  |
| size_bytes | integer |  |  |  |  |  |
| data | bytea |  |  |  |  |  |
| width | integer |  | 是 |  |  |  |
| height | integer |  | 是 |  |  |  |
| font_family | text |  | 是 |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### design_assets

Design 素材库（店主 2026-11-24，docs/BOARDS.md 第 4、9 节）：字体、图片、视频按用途设「当前使用」的一份，一键切换、可切回。 · design_assets：一份素材（种类、名字、标签、说明——字体写授权说明）；归档以后不再出现在选择里，被用途用着的不能归档。 （建表：265_design_assets）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('design_assets_id_seq'::regclass) |  |  |
| kind | text |  |  |  |  |  |
| name | text |  |  |  |  |  |
| tags | text[] |  |  | '{}'::text[] |  |  |
| note | text |  |  | ''::text |  |  |
| archived_at | timestamp with time zone |  | 是 |  |  |  |
| archived_by | bigint |  | 是 |  | staff |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### design_assign_fences

切换的「确认作废」（Codex 审查）：结果不确定的一笔，查回没有、员工确认不要了，就登记这个操作编号； 之后原请求晚到也不会换（切换在同一把用途锁里先查这张表）。只追加 （建表：265_design_assets）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| op_key | uuid | PK |  |  |  |  |
| slot | text |  |  |  |  |  |
| staff_id | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |

### design_slot_assignments

Design 素材库（店主 2026-11-24，docs/BOARDS.md 第 4、9 节）：字体、图片、视频按用途设「当前使用」的一份，一键切换、可切回。 · design_assets：一份素材（种类、名字、标签、说明——字体写授权说明）；归档以后不再出现在选择里，被用途用着的不能归档。 （建表：265_design_assets）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('design_slot_assignments_id_seq'::regclass) |  |  |
| slot | text |  |  |  |  |  |
| version_id | bigint |  | 是 |  | design_asset_versions |  |
| op_key | uuid |  |  |  |  |  |
| reason | text |  |  | ''::text |  |  |
| staff_id | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |

### device_events

038 硬件连接（v0.7.21，飞书需求 RQ-001，docs/HARDWARE.md）： ① 设备登记：打印机、标签机、读卡器、扫码、终端、打印服务器，每台一行（编号、型号、区域、接法、IP 与端口、挂在哪台终端或打印服务器下） ② 打印任务：测试页、测试标签（按台排队； （建表：038_devices）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('device_events_id_seq'::regclass) |  |  |
| device_id | bigint |  | 是 |  | devices |  |
| type | text |  |  |  |  |  |
| data | jsonb |  |  | '{}'::jsonb |  |  |
| event_key | uuid |  | 是 |  |  | 终端上报的读卡、扫码事件带编号，重发不会记两次 |
| staff_id | bigint |  | 是 |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### device_jobs

038 硬件连接（v0.7.21，飞书需求 RQ-001，docs/HARDWARE.md）： ① 设备登记：打印机、标签机、读卡器、扫码、终端、打印服务器，每台一行（编号、型号、区域、接法、IP 与端口、挂在哪台终端或打印服务器下） ② 打印任务：测试页、测试标签（按台排队； （建表：038_devices）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('device_jobs_id_seq'::regclass) |  |  |
| device_id | bigint |  |  |  | devices |  |
| kind | text |  |  |  |  |  |
| status | text |  |  | 'queued'::text |  |  |
| attempts | integer |  |  | 0 |  |  |
| error_code | text |  | 是 |  |  |  |
| error_message | text |  | 是 |  |  |  |
| client_key | uuid |  |  |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| started_at | timestamp with time zone |  | 是 |  |  |  |
| finished_at | timestamp with time zone |  | 是 |  |  |  |
| doc_ref | text |  | 是 |  |  |  |
| doc_label | text |  | 是 |  |  |  |
| payload | bytea |  | 是 |  |  |  |
| first_waited_at | timestamp with time zone |  | 是 |  |  |  |
| wait_code | text |  | 是 |  |  |  |
| canceled_by | bigint |  | 是 |  | staff |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |

### devices

038 硬件连接（v0.7.21，飞书需求 RQ-001，docs/HARDWARE.md）： ① 设备登记：打印机、标签机、读卡器、扫码、终端、打印服务器，每台一行（编号、型号、区域、接法、IP 与端口、挂在哪台终端或打印服务器下） ② 打印任务：测试页、测试标签（按台排队； （建表：038_devices）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('devices_id_seq'::regclass) |  |  |
| code | text |  |  |  |  |  |
| name | text |  |  |  |  |  |
| kind | text |  |  |  |  |  |
| brand | text |  |  | ''::text |  |  |
| model | text |  |  | ''::text |  |  |
| area | text |  |  |  |  |  |
| connection | text |  |  |  |  |  |
| host | text |  | 是 |  |  | 网口直连、经打印服务器：IP（或主机名）与端口；现场填，没填时状态「还没配好」 |
| port | integer |  | 是 |  |  |  |
| host_device_id | bigint |  | 是 |  | devices | 挂在哪台终端（读卡、扫码）或打印服务器（USB 打印机）下；桥里这台设备的键（同一台终端下唯一） |
| bridge_key | text |  | 是 |  |  |  |
| options | jsonb |  |  | '{}'::jsonb |  | 纸宽、标签语言与尺寸（打印机、标签机） |
| enabled | boolean |  |  | true |  |  |
| status | text |  |  | 'unknown'::text |  | 状态：心跳（网口）与终端上报（桥）维护；原因码见 src/shared/devices.ts |
| status_code | text |  | 是 |  |  |  |
| last_seen_at | timestamp with time zone |  | 是 |  |  |  |
| status_changed_at | timestamp with time zone |  | 是 |  |  |  |
| catalog_key | text |  | 是 |  |  | 采购清单的哪一行（按清单导入的） |
| note | text |  |  | ''::text |  |  |
| client_key | uuid |  | 是 |  |  |  |
| version | integer |  |  | 1 |  |  |
| created_by | bigint |  | 是 |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |

### dining_room_types

8.2.4 包房房型（小房、中房、大房……，可加）：按房型收低消（另有中消档）或只收房费；桌台挂房型后低消取房型的（桌台自己设了低消的优先）。金额单位：分

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('dining_room_types_id_seq'::regclass) |  |  |
| store_id | bigint |  |  | yuzu_store() | stores | 门店 |
| name | text |  |  |  |  | 房型名称（同一家店不重名） |
| charge_mode | text |  |  | 'min_spend'::text |  | min_spend 按低消收（不够的结账时补足或返台）/ room_fee 只收房费（不设低消，结账时记一行房费） |
| min_spend | bigint |  |  | 0 |  | 低消（分，0 为不设） |
| mid_spend | bigint |  |  | 0 |  | 中消（分，0 为不设）：开台时刻落在中消时段、或人数不超过中消人数的，低消按中消算 |
| mid_start_minute | integer |  | 是 |  |  | 中消时段开始（一天里的第几分钟，含）；空为不按时段 |
| mid_end_minute | integer |  | 是 |  |  | 中消时段结束（一天里的第几分钟，不含；比开始早的是跨零点） |
| mid_max_guests | integer |  | 是 |  |  | 人数不超过这个数用中消；空为不按人数 |
| room_fee | bigint |  |  | 0 |  | 房费（分）：只收房费的房型结账时记一行「房费」 |
| sort_order | integer |  |  | 0 |  | 排序 |
| active | boolean |  |  | true |  | 启用；不用了停用，不删（挂着的桌台照旧按它算） |
| created_by | bigint |  |  |  | staff | 新建的员工 |
| created_at | timestamp with time zone |  |  | now() |  | 新建时间 |
| updated_at | timestamp with time zone |  |  | now() |  | 最近修改时间 |

### dining_tables

桌台 （建表：023_dining_tables）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('dining_tables_id_seq'::regclass) |  |  |
| name | text |  |  |  |  |  |
| area | text |  |  | ''::text |  |  |
| seats | integer |  |  | 4 |  |  |
| sort_order | integer |  |  | 0 |  |  |
| active | boolean |  |  | true |  |  |
| created_by | bigint |  | 是 |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| state | text |  |  | 'available'::text |  |  |
| maintenance_reason | text |  | 是 |  |  |  |
| maintenance_until | timestamp with time zone |  | 是 |  |  |  |
| state_since | timestamp with time zone |  | 是 |  |  |  |
| min_spend | bigint |  |  | 0 |  |  |
| service_fee_bp | integer |  | 是 |  |  | 服务费比例（万分之几，最多 30%）；空为跟门店默认（餐饮规则 serviceFeeBp，8.2.4），0 为这张桌不收 |
| room_type_id | bigint |  | 是 |  | dining_room_types | 8.2.4：包房的房型（空为不是包房）；低消、中消、房费按房型算，桌台自己设了低消的优先 |

### dish_addons

② 加料 （建表：189_dishes）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| item_id | bigint | PK |  |  | service_items |  |
| addon_item_id | bigint | PK |  |  | service_items | 加的料：另外一个价目项目（自己的价格、沽清、出品档口） |
| sort_no | integer |  |  | 0 |  |  |

### dish_combo_items

③ 套餐 一道菜有「含哪几样」就是套餐；价格是套餐这个价目项目自己的价格，子项不另算钱 （建表：189_dishes）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| combo_item_id | bigint | PK |  |  | service_items |  |
| item_id | bigint | PK |  |  | service_items |  |
| quantity | integer |  |  |  |  | 每份套餐含几份 |
| sort_no | integer |  |  | 0 |  |  |
| swappable | boolean |  |  | false |  | ① 可换菜 |

### dish_combo_swaps

保存套餐内容时整批换（删套餐子项时跟着删） （建表：197_combo_parts_v8117）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| combo_item_id | bigint | PK |  |  | dish_combo_items |  |
| item_id | bigint | PK |  |  | dish_combo_items |  |
| to_item_id | bigint | PK |  |  | service_items | 换成的那一样（另外的菜品） |
| price_diff | bigint |  |  | 0 |  | 每份套餐补多少差价（分；0 = 同价，最多 ¥999） |
| sort_no | integer |  |  | 0 |  |  |

### dish_limits

S5 餐饮第一步（ROADMAP 第 10 节）：出品档口、菜品的出品档口、估清、厨房出品单（KDS）。 · 出品档口（kitchen_stations）：热菜、凉菜、主食、水吧……菜品挂在哪个档口，下单后就到哪个档口的厨房屏； （建表：022_dining）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| item_id | bigint | PK |  |  | service_items |  |
| business_date | date |  |  |  |  |  |
| remaining | integer |  |  |  |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| updated_by | bigint |  |  |  | staff |  |

### dish_method_groups

① 做法分组、加价、必选 保存一道菜时与做法一起整批换（先删做法、再删分组，再按新的写） （建表：196_dishes_v8117）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| item_id | bigint | PK |  |  | service_items |  |
| name | text | PK |  |  |  | 辣度、冰量、甜度……最多 6 个字，前后不带空格 |
| required | boolean |  |  | false |  | 必选：点单时这一组不选一个不能下单 |
| sort_no | integer |  |  | 0 |  |  |

### dish_methods

① 做法 保存一道菜时整批换（先删后建） （建表：189_dishes）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| item_id | bigint | PK |  |  | dish_method_groups, service_items |  |
| name | text | PK |  |  |  | 少冰、去冰、微辣、免葱……最多 8 个字，前后不带空格 |
| sort_no | integer |  |  | 0 |  |  |
| group_name | text |  | 是 |  | dish_method_groups |  |
| price | bigint |  |  | 0 |  |  |

### dish_ops

⑥ 菜品管理的操作编号（只追加） 新增、编辑、上下架、改价、导入各带一个操作编号：同一个编号、同样的内容重提返回第一次的结果（result），内容不同拒绝。 菜品维护不是收款，不进门店的「结果待确认」（没有「确认作废」），所以不占 idempotency_keys / op_fences 的类型 （建表：189_dishes）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| client_key | uuid | PK |  |  |  |  |
| op_type | text |  |  |  |  |  |
| request_hash | text |  |  |  |  |  |
| item_id | bigint |  | 是 |  | service_items | 哪道菜（导入是整批，为空） |
| result | jsonb |  |  | '{}'::jsonb |  | 第一次的结果（导入：新建、修改、没变各几道） |
| staff_id | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### dish_price_changes

⑤ 改价记录（只追加） 以前的订单照下单时的价：明细上本来就留着当时的单价（bill_lines.unit_price），改价不碰明细 （建表：189_dishes）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('dish_price_changes_id_seq'::regclass) |  |  |
| item_id | bigint |  |  |  | service_items |  |
| item_name | text |  |  |  |  | 当时的菜名（以后改了名，记录里还是当时的） |
| tier | text |  |  |  |  | 规格 = 价目里的档 |
| old_price | bigint |  | 是 |  |  | 改前、改后（分）。改前为空 = 原来没有这一档（新建菜品的定价也记一条）；改后为空 = 去掉了这一档 |
| new_price | bigint |  | 是 |  |  |  |
| reason | text |  |  |  |  |  |
| source | text |  |  |  |  | 从哪里改的：菜品管理、菜品导入、后台价目（单个项目）、后台价目表导入 |
| staff_id | bigint |  | 是 |  | staff | 命令行导入价目表时没有经办人 |
| created_at | timestamp with time zone |  |  | now() |  |  |
| store_id | bigint |  | 是 |  | stores |  |
| base_price | bigint |  | 是 |  |  |  |

### dish_station_windows

8.1.39（餐饮 B，docs/V8139_DINING_B.md）：菜品的售卖时段（分时段自动沽清，R3）与按时段切换出品档口（《门店系统需求梳理》）。 （建表：315_dish_windows）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| item_id | bigint | PK |  |  | service_items |  |
| start_minute | integer | PK |  |  |  |  |
| end_minute | integer |  |  |  |  |  |
| station_id | bigint |  |  |  | kitchen_stations |  |

### doc_counters

单号计数（按单据类型 + 营业日） （建表：001_init）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| doc_type | text | PK |  |  |  |  |
| business_date | date | PK |  |  |  |  |
| last_no | integer |  |  |  |  |  |

### emenu_categories

⑤ 分类与版面 （建表：121_emenu）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('emenu_categories_id_seq'::regclass) |  |  |
| name | text |  |  |  |  | 最多 16 个字（与价目表的分类一样长：「从价目表生成初稿」直接用价目表的分类名）；顶栏放得下的大约 6 个字 |
| name_en | text |  |  | ''::text |  |  |
| start_minute | integer |  | 是 |  |  | 供应时段：一天里的第几分钟（门店时区）。都为空 = 全天；start_minute > end_minute = 跨零点（22:00–02:00） |
| end_minute | integer |  | 是 |  |  |  |
| sort_order | integer |  |  | 0 |  |  |
| active | boolean |  |  | true |  |  |
| version | integer |  |  | 1 |  | 分类自己的信息与它的各页共用一个版本号：保存各页、改名、改时段都加一 |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_by | bigint |  |  |  | staff |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| periods | text[] |  |  | '{}'::text[] |  |  |

### emenu_dish_specs

规格：一道菜的每个规格对应价目表里的一个项目（各自的价格、估清）；一个项目只能在一道菜里。修改菜品时整批换 （建表：121_emenu）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| dish_id | bigint | PK |  |  | emenu_dishes |  |
| item_id | bigint | PK |  |  | service_items |  |
| label | text |  |  | ''::text |  | 规格名：大份、小份……只有一个规格的留空 |
| sort_no | integer |  |  | 0 |  |  |
| label_en | text |  |  | ''::text |  |  |

### emenu_dishes

④ 菜品图文与规格 （建表：121_emenu）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('emenu_dishes_id_seq'::regclass) |  |  |
| name | text |  |  |  |  | 展示名（平板上显示的菜名；账单上记的仍是价目项目的名称） |
| name_en | text |  |  | ''::text |  |  |
| tagline | text |  |  | ''::text |  | 名称后面的小字：（煎档）、(2只)、(姜茸焗，水煮鱼，酸菜鱼) |
| description | text |  |  | ''::text |  |  |
| attrs | text[] |  |  | '{}'::text[] |  | 属性行（文字陈列版面用）：产地：法国 / 年份：NV，最多 3 行 |
| unit | text |  |  | '份'::text |  | 价格后面的单位：¥42/份 |
| image_id | bigint |  | 是 |  | emenu_images |  |
| detail_image_id | bigint |  | 是 |  | emenu_images |  |
| active | boolean |  |  | true |  |  |
| version | integer |  |  | 1 |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_by | bigint |  |  |  | staff |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| tagline_en | text |  |  | ''::text |  |  |
| description_en | text |  |  | ''::text |  |  |
| attrs_en | text[] |  |  | '{}'::text[] |  |  |
| unit_en | text |  |  | ''::text |  |  |

### emenu_images

③ 图片 （建表：121_emenu）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('emenu_images_id_seq'::regclass) |  |  |
| sha256 | text |  |  |  |  | 内容摘要：同一张图只存一份 |
| mime | text |  |  |  |  |  |
| data | bytea |  |  |  |  |  |
| size_bytes | integer |  |  |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### emenu_orders

⑥ 点餐单（只追加） （建表：121_emenu）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('emenu_orders_id_seq'::regclass) |  |  |
| client_key | uuid |  |  |  |  | 这次下单的操作编号，也是这次挂账的编号（bill_lines.post_key、idempotency_keys.key） |
| visit_id | bigint |  |  |  | visits |  |
| tag_code | text |  |  |  |  |  |
| table_name | text |  |  | ''::text |  | 送到哪张桌（桌台名称；没建桌台时是输入的桌号；没填为空） |
| guests | integer |  |  |  |  |  |
| avoid | text[] |  |  | '{}'::text[] |  | 整单备注的三部分，与拼好的一句（写在每道菜的口味备注上） |
| serve | text |  |  | ''::text |  |  |
| custom_note | text |  |  | ''::text |  |  |
| note | text |  |  | ''::text |  |  |
| order_no | text |  | 是 |  |  | 厨房出品单号 |
| total | bigint |  |  |  |  |  |
| line_count | integer |  |  |  |  |  |
| quantity | integer |  |  |  |  |  |
| waiter_id | bigint |  |  |  | staff | 输点单密码确认的服务员（账单明细的经办人也是他）、这台平板登录的账号 |
| device_staff_id | bigint |  |  |  | staff |  |
| business_date | date |  |  |  |  |  |
| created_at | timestamp with time zone |  |  |  |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |

### emenu_page_dishes

121 点餐系统 · 平板电子菜单（8.0.10，docs/EMENU.md）。 ① 岗位「点餐平板」（tablet）：只能打开平板点餐页； ② 点单密码（staff_order_pins）：服务员在平板上确认下单用的 6 位数字，系统生成； （建表：121_emenu）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| page_id | bigint | PK |  |  | emenu_pages |  |
| slot_no | integer | PK |  |  |  |  |
| dish_id | bigint |  |  |  | emenu_dishes |  |

### emenu_pages

分类的各页：版面与竖排小标题。保存一个分类时整批换（先删后建），所以页的编号会变，页面按「第几页」记位置 （建表：121_emenu）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('emenu_pages_id_seq'::regclass) |  |  |
| category_id | bigint |  |  |  | emenu_categories |  |
| sort_no | integer |  |  |  |  |  |
| layout | text |  |  |  |  |  |
| title | text |  |  | ''::text |  |  |
| title_en | text |  |  | ''::text |  |  |

### entry_claims

v0.7.28 ①（主线）：给小程序第三期的入口（设计见 docs/SCHEDULE_FINISH.md 第 2 节、docs/MP_PHASE3.md 第 2–4 节） · entry_claims：小程序线调主线入口时带的 claimKey 的去重记录（同一个 claimKey 只生效一次，再调用返回第一次的结果）… （建表：051_mp_entries）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| claim_key | text | PK |  |  |  |  |
| request_hash | text |  |  |  |  |  |
| ref_id | bigint |  |  |  |  |  |
| ref_key | uuid |  | 是 |  |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### erp_drafts

草稿：不是单据，能改能删；只有本人看得到 （建表：130_request_drafts_imports）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('erp_drafts_id_seq'::regclass) |  |  |
| key | uuid |  |  |  |  | 草稿编号：页面生成，继续填写、刷新都用它 |
| kind | text |  |  |  |  |  |
| staff_id | bigint |  |  |  | staff |  |
| ref_id | bigint |  | 是 |  |  | 修改已有单据的草稿：那张单据（需求单的 id）；新提的为空 |
| payload | jsonb |  |  |  |  | 页面上填到哪算哪（不按提交的规则核对，只限长度与行数） |
| image_ids | bigint[] |  |  | '{}'::bigint[] |  | 草稿里用到的图片（看图片的权限按它核对） |
| title | text |  |  | ''::text |  | 草稿箱里显示的摘要：前几行的名称、行数 |
| line_count | integer |  |  | 0 |  |  |
| rev | integer |  |  | 1 |  | 版本号：别处存过以后这边再存对不上、拒绝；最后一次保存的编号：没收到回复再发一次的同一次保存只算一次 |
| last_save_id | uuid |  |  |  |  |  |
| closed_at | timestamp with time zone |  | 是 |  |  | 关闭（提交成需求单、手动删除、单据已结束）：先留着挡住迟到的保存请求，第二天由自动任务清掉 |
| closed_reason | text |  | 是 |  |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### erp_files

文件（PDF）：存在数据库里，随备份、异地副本与数据指纹走；同一用途下同一份文件（内容摘要相同）只存一份；只追加 supplier_contract：签约供应商的合同（08）；receipt：收货单的附件（11，迁移 084） （建表：083_suppliers_contracts）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('erp_files_id_seq'::regclass) |  |  |
| scope | text |  |  |  |  |  |
| sha256 | text |  |  |  |  |  |
| mime | text |  |  |  |  |  |
| size_bytes | integer |  |  |  |  |  |
| data | bytea |  |  |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### erp_images

图片 （建表：027_requisitions）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('erp_images_id_seq'::regclass) |  |  |
| sha256 | text |  |  |  |  | 内容摘要：同一张图只存一份 |
| mime | text |  |  |  |  |  |
| data | bytea |  |  |  |  |  |
| size_bytes | integer |  |  |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| scope | text |  |  | 'general'::text |  |  |

### erp_imports

供应商与期初未付批量导入（#16） （建表：030_supplier_settlement）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('erp_imports_id_seq'::regclass) |  |  |
| kind | text |  |  |  |  |  |
| file_name | text |  |  |  |  |  |
| file_sha256 | text |  |  |  |  |  |
| row_count | integer |  |  |  |  |  |
| total_cents | bigint |  |  | 0 |  | 单位：分 |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### expense_budgets

8.0.3 费用预算（docs/BUDGET_INVOICES.md 第 2 节，默认 BI01–BI06 待确认）： · 部门 × 费用科目 × 起始月的额度：从那个月起生效、之后每月沿用，直到下一次修改；额度为空 = 从那个月起不控制； · 报销单记下登记（或退回后再提交）时的超预算核对； （建表：086_expense_budgets）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('expense_budgets_id_seq'::regclass) |  |  |
| department_id | bigint |  |  |  | departments |  |
| category | text |  |  |  |  |  |
| from_month | date |  |  |  |  | 从哪个月起（当月 1 号） |
| amount_cents | bigint |  | 是 |  |  | 额度（分）；为空 = 从这个月起不控制 |
| version | integer |  |  | 1 |  |  |
| updated_by | bigint |  |  |  | staff |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### expense_claim_lines

飞书需求 RQ-005「采购与费用闭环」第一步（v0.7.7，见 docs/EXPENSES.md）： ① 费用报销（BX）：按采购单或按次；发票类型、税点、费用科目、用途、部门、经办人、购买与到货数量；超门槛要负责人确认。 ② 备用金：打款（BY）按部门、经办人留名；退回（TH）/ 补付（BF）记在对应的打款上； （建表：026_expenses）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('expense_claim_lines_id_seq'::regclass) |  |  |
| claim_id | bigint |  |  |  | expense_claims |  |
| line_no | integer |  |  |  |  |  |
| name | text |  |  |  |  |  |
| category | text |  |  |  |  | 费用科目：办公费 / 固定资产 / 低值易耗 |
| unit | text |  |  |  |  |  |
| bought_milli | bigint |  |  |  |  | 购买数量与到货数量（千分之一单位）；不一致时必须写差异原因 |
| received_milli | bigint |  |  |  |  |  |
| diff_reason | text |  |  | ''::text |  |  |
| amount_cents | bigint |  |  |  |  | 单位：分 |
| po_line_id | bigint |  | 是 |  | purchase_order_lines | 按采购单报销：对应的采购单行与物料 |
| material_id | bigint |  | 是 |  | materials |  |

### expense_claim_petty_uses

报销单报的是哪几笔申用（报销单登记时一起写，之后不改；报销单撤回、冲销后这条关联不再有效） （建表：182_petty_pool）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| claim_id | bigint | PK |  |  | expense_claims |  |
| use_id | bigint | PK |  |  | petty_uses |  |

### expense_claims

费用报销（BX） （建表：026_expenses）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('expense_claims_id_seq'::regclass) |  |  |
| doc_no | text |  |  |  |  |  |
| expense_date | date |  |  |  |  |  |
| department_id | bigint |  |  |  | departments |  |
| handler_id | bigint |  |  |  | staff |  |
| purpose | text |  |  |  |  | 用途（固定选项，记下登记时的文字） |
| pay_source | text |  |  |  |  | 钱从哪来：petty = 备用金（必须指明出自哪一笔打款），company = 公司直付 |
| advance_id | bigint |  | 是 |  | petty_advances |  |
| invoice_type | text |  |  |  |  | 发票：类型（固定选项的键与登记时的名称）、税点（万分之一，1300 = 13%）、发票号 |
| invoice_label | text |  |  |  |  |  |
| tax_rate_bp | integer |  |  |  |  |  |
| invoice_no | text |  |  | ''::text |  |  |
| purchase_order_id | bigint |  | 是 |  | purchase_orders | 按采购单报销（只能是现付供应商的采购单） |
| amount_cents | bigint |  |  |  |  | 单位：分 |
| note | text |  |  | ''::text |  |  |
| needs_approval | boolean |  |  |  |  | 登记时是否超过确认门槛（超过的要负责人确认） |
| status | text |  |  |  |  |  |
| client_key | uuid |  | 是 |  |  |  |
| is_synthetic | boolean |  |  | false |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| confirmed_by | bigint |  | 是 |  | staff |  |
| confirmed_at | timestamp with time zone |  | 是 |  |  |  |
| returned_reason | text |  | 是 |  |  | 退回或撤回的原因 |
| voided_by | bigint |  | 是 |  | staff |  |
| voided_at | timestamp with time zone |  | 是 |  |  |  |
| void_reason | text |  | 是 |  |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| channel | text |  | 是 |  |  |  |
| channel_label | text |  | 是 |  |  |  |
| channel_note | text |  |  | ''::text |  |  |
| over_budget | boolean |  |  | false |  |  |
| budget_check | jsonb |  | 是 |  |  |  |
| invoice_id | bigint |  | 是 |  | supplier_invoices | 报销单关联台账的发票（8.0.3 起登记的、有号码的专票普票）；一张发票同时只挂一张有效报销单 |

### floorplan_activations

在用历史：启用、换下、换回，每次一行（只追加）；启用、换回时记下当时与空间台账的比对（底图档案里看「当时的台账比对」） （建表：036_floorplan_finish）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('floorplan_activations_id_seq'::regclass) |  |  |
| batch_id | bigint |  |  |  | floorplan_batches |  |
| kind | text |  |  |  |  |  |
| at | timestamp with time zone |  |  |  |  |  |
| staff_id | bigint |  | 是 |  | staff |  |
| reason | text |  |  | ''::text |  |  |
| ledger_diff | jsonb |  | 是 |  |  |  |

### floorplan_batches

v0.7.15 · 飞书需求 RQ-004 第二段（docs/FLOORPLAN.md）：底图转换——转换批次、每层底图（简化 SVG）、房间轮廓。 上传的图纸本身不进数据库（只记文件名、大小、摘要）；转换结果只追加，启用、换下只改批次的状态。只加表。 （建表：033_floorplans）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('floorplan_batches_id_seq'::regclass) |  |  |
| file_name | text |  |  |  |  |  |
| file_sha256 | text |  |  |  |  |  |
| file_bytes | bigint |  |  |  |  |  |
| file_format | text |  |  |  |  |  |
| converter | text |  |  |  |  | 转换程序的版本（同一份图纸、同一版程序只转换一次） |
| status | text |  |  | 'converting'::text |  |  |
| error | text |  | 是 |  |  |  |
| report | jsonb |  | 是 |  |  | 转换报告：图元与图层统计、图层分类、提示、参数 |
| read_ms | integer |  | 是 |  |  |  |
| convert_ms | integer |  | 是 |  |  |  |
| note | text |  |  | ''::text |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| finished_at | timestamp with time zone |  | 是 |  |  |  |
| activated_by | bigint |  | 是 |  | staff |  |
| activated_at | timestamp with time zone |  | 是 |  |  |  |
| retired_by | bigint |  | 是 |  | staff |  |
| retired_at | timestamp with time zone |  | 是 |  |  |  |
| source_kind | text |  | 是 |  |  | 入库登记：图纸来源、版本或说明、收图日期；PDF 的比例（1:N）；是否保存了原图纸；换下的原因 |
| source_note | text |  |  | ''::text |  |  |
| received_on | date |  | 是 |  |  |  |
| pdf_scale | integer |  | 是 |  |  |  |
| original_saved | boolean |  |  | false |  |  |
| retire_reason | text |  | 是 |  |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |

### floorplan_floors

每层底图：本地坐标 10 毫米一单位，原点在图框左上角，y 向下；frame 是图框的图纸坐标 [x0, y0, x1, y1] （建表：033_floorplans）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('floorplan_floors_id_seq'::regclass) |  |  |
| batch_id | bigint |  |  |  | floorplan_batches |  |
| floor_code | text |  |  |  |  |  |
| title | text |  |  | ''::text |  |  |
| width | integer |  |  |  |  |  |
| height | integer |  |  |  |  |  |
| frame | jsonb |  |  |  |  |  |
| svg | text |  |  |  |  |  |
| svg_bytes | integer |  |  |  |  |  |
| path_count | integer |  |  |  |  |  |

### floorplan_originals

保存的原图纸（上传时勾了才有），与批次分表；只追加 （建表：036_floorplan_finish）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| batch_id | bigint | PK |  |  | floorplan_batches |  |
| content | bytea |  |  |  |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### floorplan_room_outlines

④ 例外房间补画的轮廓 按批次存（转换结果本身不改），本地坐标与 floorplan_rooms 同一套；重画时旧的作废、留历史 （建表：036_floorplan_finish）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('floorplan_room_outlines_id_seq'::regclass) |  |  |
| batch_id | bigint |  |  |  | floorplan_batches, floorplan_rooms |  |
| floor_code | text |  |  |  | floorplan_rooms |  |
| code | text |  |  |  | floorplan_rooms |  |
| polygon | jsonb |  |  |  |  |  |
| area_centi_m2 | integer |  |  |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| voided_by | bigint |  | 是 |  | staff |  |
| voided_at | timestamp with time zone |  | 是 |  |  |  |

### floorplan_rooms

房间轮廓：每个编码一行；没配上轮廓的（例外）只有文字位置 （建表：033_floorplans）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('floorplan_rooms_id_seq'::regclass) |  |  |
| batch_id | bigint |  |  |  | floorplan_batches, floorplan_floors |  |
| floor_code | text |  |  |  | floorplan_floors |  |
| code | text |  |  |  |  |  |
| label | text |  |  | ''::text |  |  |
| status | text |  |  |  |  |  |
| merged_with | text[] |  |  | '{}'::text[] |  |  |
| close_mm | integer |  | 是 |  |  |  |
| polygon | jsonb |  | 是 |  |  |  |
| label_x | integer |  |  |  |  |  |
| label_y | integer |  |  |  |  |  |
| area_centi_m2 | integer |  | 是 |  |  |  |

### floors

楼层 （建表：032_spaces）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('floors_id_seq'::regclass) |  |  |
| code | text |  |  |  |  |  |
| name | text |  |  |  |  |  |
| sort_order | integer |  |  | 0 |  |  |
| active | boolean |  |  | true |  |  |
| version | integer |  |  | 1 |  | 版本号：每次修改加 1；页面提交读到的版本号，对不上就拒绝（迟到的旧请求、别人同时修改都不会悄悄覆盖新的修改） |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |

### gift_card_batches

8.1.40（docs/V8140.md 第 5 节）：礼品卡先出卡、后绑手机号（《门店系统需求梳理与优化方案》「礼品卡批量生成」）。 不另建一套卡：礼品卡就是匿名卡会员（不要手机号，会员号就是卡号，迁移前就有），一批一次生成； 送出去以后在会员资料里「转实名」填手机号（转实名、改手机号的规矩照旧）。 （建表：321_gift_cards）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('gift_card_batches_id_seq'::regclass) |  |  |
| batch_no | text |  |  |  |  |  |
| label | text |  |  |  |  |  |
| quantity | integer |  |  |  |  |  |
| note | text |  |  | ''::text |  |  |
| client_key | uuid |  |  |  |  |  |
| request_hash | text |  |  |  |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### gift_receipts

8.0.1 采购组整改 09（CG09，docs/PURCHASING_V801.md）：赠品入库台账——记赠品名称、数量（与单位）、哪家供应商、随哪张收货单。 只记台账，不进库存结存、不记成本（要不要进库存以后再定，CG09）。登记以后只能作废（写原因，一次），不能改、不能删。 （建表：085_gift_receipts）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('gift_receipts_id_seq'::regclass) |  |  |
| doc_no | text |  |  |  |  |  |
| received_on | date |  |  |  |  |  |
| material_id | bigint |  | 是 |  | materials | 赠品名称可以从物料里选（选了记物料），也可以直接写 |
| name | text |  |  |  |  |  |
| qty_milli | bigint |  |  |  |  |  |
| unit | text |  |  |  |  |  |
| supplier_id | bigint |  | 是 |  | suppliers |  |
| receipt_doc_id | bigint |  | 是 |  | inv_docs |  |
| note | text |  |  | ''::text |  |  |
| status | text |  |  | 'valid'::text |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| void_reason | text |  | 是 |  |  |  |
| voided_by | bigint |  | 是 |  | staff |  |
| voided_at | timestamp with time zone |  | 是 |  |  |  |

### group_buy_coupons

③ 团购券：完整券码，同一平台同一券码只能有一笔有效登记 （建表：014_checkout）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('group_buy_coupons_id_seq'::regclass) |  |  |
| platform | text |  |  |  |  |  |
| code | text |  |  |  |  | 规范化后的完整券码（去掉空格与连字符、字母大写） |
| deal_name | text |  |  | ''::text |  |  |
| amount | bigint |  |  |  |  | 抵扣金额：这张券在本次结账中抵扣的金额 |
| status | text |  |  | 'active'::text |  |  |
| checkout_id | bigint |  |  |  | checkouts |  |
| business_date | date |  |  |  |  |  |
| registered_by | bigint |  |  |  | staff |  |
| registered_at | timestamp with time zone |  |  |  |  |  |
| voided_at | timestamp with time zone |  | 是 |  |  |  |
| voided_by | bigint |  | 是 |  | staff |  |
| void_reason | text |  | 是 |  |  |  |
| verification_id | bigint |  | 是 |  | platform_verifications | 团购券记录记下用的是哪一次验券 |

### guest_blacklist

2. 黑名单 跟着会员走，全公司一份（不按店分）。认会员的记 member_id；只知道手机号的记 phone（这个号码以后办了会员照样拦）。 （建表：187_frontdesk_risk）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('guest_blacklist_id_seq'::regclass) |  |  |
| member_id | bigint |  | 是 |  | members |  |
| phone | text |  | 是 |  |  |  |
| name | text |  |  |  |  |  |
| reason | text |  |  |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| lifted_by | bigint |  | 是 |  | staff |  |
| lifted_at | timestamp with time zone |  | 是 |  |  |  |
| lift_reason | text |  | 是 |  |  |  |

### guest_preferences

客人偏好（8.2.3）：忌口、按摩力度等（字段在后台「客人与提醒」）。会员的记在会员上、跟着会员走；散客的记在这次来访上。一格一行，清空就删掉这一行（改动记审计）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('guest_preferences_id_seq'::regclass) |  |  |
| member_id | bigint |  | 是 |  | members | 会员（会员的偏好）；散客为空 |
| visit_id | bigint |  | 是 |  | visits | 来访（散客的偏好）；会员为空 |
| field_key | text |  |  |  |  | 字段编号（后台字段的 key，改名不丢值） |
| value | text |  |  |  |  | 填的内容（最多 60 字） |
| updated_by | bigint |  |  |  | staff | 最后改的人 |
| updated_at | timestamp with time zone |  |  | now() |  | 最后改的时间 |

### guide_markers

设施图标：按楼层、存图纸坐标（毫米，换了底图也能对上位置）；自动识别的可以挪、藏，手工的可以加 （建表：036_floorplan_finish）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('guide_markers_id_seq'::regclass) |  |  |
| floor_code | text |  |  |  |  |  |
| kind | text |  |  |  |  |  |
| x_mm | integer |  |  |  |  |  |
| y_mm | integer |  |  |  |  |  |
| label | text |  |  | ''::text |  |  |
| label_en | text |  |  | ''::text |  |  |
| source | text |  |  |  |  |  |
| hidden | boolean |  |  | false |  |  |
| version | integer |  |  | 1 |  |  |
| created_by | bigint |  | 是 |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| client_key | uuid |  | 是 |  |  | 后台补加的操作编号（自动识别的没有）：同一次补加重提不会多出一个 |
| store_id | bigint |  |  | yuzu_store() | stores |  |

### hall_zones

福田店整改批次 4（2026-11-26《福田店餐饮与房态中心整改需求文档》，docs/FUTIAN_1126.md）： · 休息大厅分区（FT-15）：后台自定义分区（A 区、第一排……），床位（休息大厅一类的空间）归到分区里；开单选床位时按分区列； （建表：471_hall_wormhole）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('hall_zones_id_seq'::regclass) |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| name | text |  |  |  |  |  |
| sort_order | integer |  |  | 0 |  |  |
| active | boolean |  |  | true |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### hand_tag_generate_ops

手牌管理审查修正（Codex 审查 PR #189，docs/FRONTDESK_TAGS_V8127.md 第 3 节）：按规则批量添加带操作编号。 生成提交了、回复丢了或超时时，页面按原编号查回、原样重提（返回第一次的结果，不会再建一批）或确认作废。 （建表：261_hand_tag_generate_ops）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('hand_tag_generate_ops_id_seq'::regclass) |  |  |
| op_key | uuid |  |  |  |  |  |
| store_id | bigint |  |  | 1 | stores |  |
| request_hash | text |  |  |  |  |  |
| codes | text[] |  |  |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### hand_tags

手牌池 （建表：004_frontdesk）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('hand_tags_id_seq'::regclass) |  |  |
| code | text |  |  |  |  | 牌号：0–2 位大写字母前缀 + 1–5 位数字，例如 A023、1088 |
| zone | text |  |  |  |  | 分区：男宾 / 女宾 / 儿童。接待时宾客分区必须与手牌一致（防发错男女牌） |
| locked | boolean |  |  | false |  |  |
| lock_reason | text |  | 是 |  |  |  |
| locked_by | bigint |  | 是 |  | staff |  |
| locked_at | timestamp with time zone |  | 是 |  |  |  |
| active | boolean |  |  | true |  |  |
| is_synthetic | boolean |  |  | false |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| kind | text |  |  | 'normal'::text |  |  |
| vip_level | smallint |  | 是 |  |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| card_uid | text |  | 是 |  |  | 1. 手牌芯片号 读卡器读到的卡号（NFC 的 UID，或 IC / ID 卡的十进制卡号）：去掉分隔符、转大写后存，4–32 位数字或大写字母 |
| service_status | text |  |  | 'normal'::text |  |  |
| service_note | text |  | 是 |  |  |  |
| service_by | bigint |  | 是 |  | staff |  |
| service_at | timestamp with time zone |  | 是 |  |  |  |
| deleted_at | timestamp with time zone |  | 是 |  |  |  |
| deleted_by | bigint |  | 是 |  | staff |  |

### idempotency_keys

幂等键：重复点击 / 超时重试只会得到同一张单 （建表：001_init）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| key | uuid | PK |  |  |  |  |
| op_type | text |  |  |  |  |  |
| request_hash | text |  |  |  |  |  |
| ref_id | bigint |  |  |  |  |  |
| staff_id | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### integration_calls

8.0.21 开票申请（docs/FINANCE_V8021.md 第 3 节，CW-B / CW2 / CW13–CW15）与对外调用记录（docs/INTEGRATIONS_V8021.md 第 1 节）。 · invoice_requests：给客人开票（销项）的申请。来源是结账单、会员充值、协议单位回款； （建表：143_invoice_requests）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | identity always |  |  |
| kind | text |  |  |  |  |  |
| provider | text |  |  |  |  |  |
| action | text |  |  |  |  |  |
| mode | text |  |  |  |  |  |
| ref_type | text |  | 是 |  |  |  |
| ref_id | bigint |  | 是 |  |  |  |
| request_summary | jsonb |  |  | '{}'::jsonb |  |  |
| ok | boolean |  |  |  |  |  |
| result_summary | jsonb |  |  | '{}'::jsonb |  |  |
| error | text |  | 是 |  |  |  |
| duration_ms | integer |  |  |  |  |  |
| staff_id | bigint |  | 是 |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### inv_doc_attachments

8.0.1 采购组整改 11（CG11，docs/PURCHASING_V801.md）：收货单的附件（货物、送货单、小票的照片与 PDF）。 （建表：084_receipt_attachments）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('inv_doc_attachments_id_seq'::regclass) |  |  |
| doc_id | bigint |  |  |  | inv_docs |  |
| image_id | bigint |  | 是 |  | erp_images |  |
| file_id | bigint |  | 是 |  | erp_files |  |
| name | text |  |  | ''::text |  |  |
| uploaded_by | bigint |  |  |  | staff |  |
| uploaded_at | timestamp with time zone |  |  | now() |  |  |

### inv_doc_lines

浴族 yuzu · 库存与采购（增量迁移，不改动会员与储值数据） 约定： · 数量一律为整数「千分之一库存单位」(*_milli，bigint)，金额一律为整数「分」，不使用浮点数； · 单据行保存当时的单位与换算快照，物料包装变更不会改写历史； （建表：002_inventory）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('inv_doc_lines_id_seq'::regclass) |  |  |
| doc_id | bigint |  |  |  | inv_docs |  |
| line_no | integer |  |  |  |  |  |
| material_id | bigint |  |  |  | materials |  |
| qty_milli | bigint |  |  |  |  | 本行生效数量（库存单位，千分之一）：收货 = 合格实收；领用/退回/耗用/报损/退货 = 数量；盘点 = 调整数（可负）；期初 = 期初数 |
| inventory_unit | text |  |  |  |  |  |
| purchase_unit | text |  |  |  |  |  |
| factor_milli | bigint |  |  |  |  |  |
| entered_qty_milli | bigint |  | 是 |  |  | 员工录入时使用的数量与单位，例如「8 箱」，用于原样展示 |
| entered_unit | text |  | 是 |  |  |  |
| delivered_milli | bigint |  | 是 |  |  | 收货 |
| rejected_milli | bigint |  | 是 |  |  |  |
| reject_reason | text |  |  | ''::text |  |  |
| price_cents | bigint |  | 是 |  |  | 每采购单位；单位：分 |
| amount_cents | bigint |  | 是 |  |  | 单位：分 |
| po_line_id | bigint |  | 是 |  | purchase_order_lines |  |
| book_milli | bigint |  | 是 |  |  | 盘点 |
| counted_milli | bigint |  | 是 |  |  |  |
| book_move_id | bigint |  | 是 |  |  | 记录账面数时该物料最后一条流水 |
| diff_reason | text |  | 是 |  |  |  |
| source_line_id | bigint |  | 是 |  | inv_doc_lines | 退回 / 退货对应原单行 |
| note | text |  |  | ''::text |  |  |
| diff_note | text |  |  | ''::text |  | v0.7.30（主线）盘点差异审批（清单 #2，docs/APPROVALS.md 第 6 节，A8 待确认）： 盘点行的「大差异」（差异超过账面的 2%，账面是 0 的有差异就算；或差异金额超过 ¥500，「库存规则」里可改）提交时要写原因： 原因类别照旧记在 diff_reason（提交时就记下，确认时可以改），说明记在新加的 diff_note（至少 2 个字，接口里核对）。 |
| batch_no | text |  | 是 |  |  |  |
| produced_on | date |  | 是 |  |  |  |
| expires_on | date |  | 是 |  |  |  |
| redeliver_milli | bigint |  |  | 0 |  | 收货拒收里供应商要补发的数量（待补，库存单位千分；不超过拒收数，8.1.51） |
| hold_milli | bigint |  |  | 0 |  | 收货里待判 / 待检、暂不入库的数量（库存单位千分；8.2.6）；验完以后合格的再做一张收货单 |

### inv_docs

库存单据（期初、收货、领用、领用退回、直接耗用、报损、盘点、退供应商） （建表：002_inventory）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('inv_docs_id_seq'::regclass) |  |  |
| doc_no | text |  |  |  |  |  |
| doc_type | text |  |  |  |  |  |
| status | text |  |  |  |  |  |
| doc_date | date |  |  |  |  |  |
| supplier_id | bigint |  | 是 |  | suppliers |  |
| purchase_order_id | bigint |  | 是 |  | purchase_orders |  |
| department_id | bigint |  | 是 |  | departments |  |
| handler | text |  |  | ''::text |  |  |
| source_doc_id | bigint |  | 是 |  | inv_docs | 退回、退货、冲销对应的原单 |
| note | text |  |  | ''::text |  |  |
| amount_cents | bigint |  |  | 0 |  | 收货货款 / 退货扣款；单位：分 |
| no_po | boolean |  |  | false |  | 直接收货：缺少采购依据 |
| client_key | uuid |  | 是 |  |  |  |
| is_synthetic | boolean |  |  | false |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| submitted_by | bigint |  | 是 |  | staff |  |
| submitted_at | timestamp with time zone |  | 是 |  |  |  |
| confirmed_by | bigint |  | 是 |  | staff |  |
| confirmed_at | timestamp with time zone |  | 是 |  |  |  |
| returned_reason | text |  | 是 |  |  |  |
| voided_by | bigint |  | 是 |  | staff |  |
| voided_at | timestamp with time zone |  | 是 |  |  |  |
| void_reason | text |  | 是 |  |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| price_basis | text |  |  | ''::text |  |  |
| settlement | text |  | 是 |  |  |  |
| warehouse_id | bigint |  | 是 |  | warehouses |  |
| urgent | boolean |  |  | false |  |  |
| urgent_cap_cents | bigint |  | 是 |  |  | 单位：分 |
| co_acceptor_id | bigint |  | 是 |  | staff |  |
| dept_signed_by | bigint |  | 是 |  | staff |  |
| dept_signed_at | timestamp with time zone |  | 是 |  |  |  |
| dept_sign_note | text |  | 是 |  |  |  |
| supplier_answer_by | bigint |  | 是 |  | staff |  |
| supplier_answer_at | timestamp with time zone |  | 是 |  |  |  |
| supplier_answer_date | date |  | 是 |  |  |  |
| supplier_answer_note | text |  | 是 |  |  |  |
| return_applied_cents | bigint |  | 是 |  |  | 单位：分 |
| urgent_approved_at | timestamp with time zone |  | 是 |  |  | 急采：按金额分级审批（审批中心），批了以后仓库到部门验收 |
| use_purpose | text |  | 是 |  |  |  |
| use_handler_id | bigint |  | 是 |  | staff |  |
| direct | boolean |  |  | false |  |  |
| import_id | bigint |  | 是 |  | receipt_imports |  |
| needs_contract | boolean |  |  | false |  |  |
| ledger_import_id | bigint |  | 是 |  | ledger_imports |  |

### invoice_requests

8.0.21 开票申请（docs/FINANCE_V8021.md 第 3 节，CW-B / CW2 / CW13–CW15）与对外调用记录（docs/INTEGRATIONS_V8021.md 第 1 节）。 · invoice_requests：给客人开票（销项）的申请。来源是结账单、会员充值、协议单位回款； （建表：143_invoice_requests）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | identity always |  |  |
| request_no | text |  |  |  |  |  |
| source_type | text |  |  |  |  |  |
| source_id | bigint |  |  |  |  |  |
| source_no | text |  |  |  |  | 来源的单号（结账单号、充值单号、回款单号），页面上显示用 |
| amount_cents | bigint |  |  |  |  | 单位：分 |
| title_type | text |  |  |  |  |  |
| title | text |  |  |  |  |  |
| tax_no | text |  |  | ''::text |  |  |
| email | text |  |  | ''::text |  |  |
| phone | text |  |  | ''::text |  |  |
| invoice_kind | text |  |  |  |  |  |
| note | text |  |  | ''::text |  |  |
| status | text |  |  | 'requested'::text |  |  |
| invoice_no | text |  | 是 |  |  | 开出以后 |
| invoice_date | date |  | 是 |  |  |  |
| file_id | bigint |  | 是 |  | erp_files |  |
| issued_via | text |  | 是 |  |  | manual 手工开好登记；mock / 服务商名：交给服务商开的 |
| provider_ref | text |  | 是 |  |  |  |
| reject_reason | text |  | 是 |  |  |  |
| void_reason | text |  | 是 |  |  |  |
| version | integer |  |  | 1 |  |  |
| client_key | uuid |  |  |  |  |  |
| request_hash | text |  |  |  |  |  |
| requested_by | bigint |  |  |  | staff |  |
| requested_at | timestamp with time zone |  |  | now() |  |  |
| handled_by | bigint |  | 是 |  | staff |  |
| handled_at | timestamp with time zone |  | 是 |  |  |  |
| voided_by | bigint |  | 是 |  | staff |  |
| voided_at | timestamp with time zone |  | 是 |  |  |  |
| entity_id | bigint |  |  | yuzu_entity() | legal_entities |  |

### item_recipe_lines

8.0.20 用料与配方、销售与出品扣库存（docs/ERP_V8020.md 第 2 节，JX-A / JX-B）。 · item_recipes / item_recipe_lines：价目项目的用料（零售品就是只有一行的配方），带版本——改用料 = 旧的停用、写一份新的。 （建表：128_stock_usage）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | identity always |  |  |
| recipe_id | bigint |  |  |  | item_recipes |  |
| material_id | bigint |  |  |  | materials |  |
| qty_milli | bigint |  |  |  |  | 一份用多少（库存单位的千分之一）；损耗率是万分比 |
| loss_bp | integer |  |  | 0 |  |  |

### item_recipes

8.0.20 用料与配方、销售与出品扣库存（docs/ERP_V8020.md 第 2 节，JX-A / JX-B）。 · item_recipes / item_recipe_lines：价目项目的用料（零售品就是只有一行的配方），带版本——改用料 = 旧的停用、写一份新的。 （建表：128_stock_usage）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | identity always |  |  |
| item_id | bigint |  |  |  | service_items |  |
| version | integer |  |  |  |  |  |
| status | text |  |  | 'active'::text |  |  |
| warehouse_id | bigint |  | 是 |  | warehouses | 从哪个仓扣；空 = 按规则里的默认仓 |
| note | text |  |  | ''::text |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| retired_by | bigint |  | 是 |  | staff |  |
| retired_at | timestamp with time zone |  | 是 |  |  |  |

### kitchen_item_parts

② 子项出品 （建表：197_combo_parts_v8117）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('kitchen_item_parts_id_seq'::regclass) |  |  |
| kitchen_item_id | bigint |  |  |  | kitchen_items | 套餐那一张出品单（主档口看整份套餐） |
| item_id | bigint |  |  |  | service_items |  |
| name | text |  |  |  |  | 下单当时的菜名（换过的是换成的那一样）；换过的记原来是哪一样 |
| swapped_from | text |  | 是 |  |  |  |
| per_combo | integer |  |  |  |  | 每份套餐几份；这一张出品单一共几份（套餐的份数 × 每份几份） |
| quantity | integer |  |  |  |  |  |
| station_id | bigint |  |  |  | kitchen_stations | 在哪个档口做；split：与套餐的档口不一样，在那个档口的厨房屏上单独出一张子项单 |
| split | boolean |  |  |  |  |  |
| limit_taken | boolean |  |  | false |  | 下单时扣过这一样的沽清（退菜时按原份数加回） |
| status | text |  |  | 'queued'::text |  |  |
| business_date | date |  |  |  |  |  |
| created_at | timestamp with time zone |  |  |  |  |  |
| started_by | bigint |  | 是 |  | staff |  |
| started_at | timestamp with time zone |  | 是 |  |  |  |
| done_by | bigint |  | 是 |  | staff |  |
| done_at | timestamp with time zone |  | 是 |  |  |  |
| cancelled_by | bigint |  | 是 |  | staff |  |
| cancelled_at | timestamp with time zone |  | 是 |  |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |

### kitchen_items

S5 餐饮第一步（ROADMAP 第 10 节）：出品档口、菜品的出品档口、估清、厨房出品单（KDS）。 · 出品档口（kitchen_stations）：热菜、凉菜、主食、水吧……菜品挂在哪个档口，下单后就到哪个档口的厨房屏； （建表：022_dining）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('kitchen_items_id_seq'::regclass) |  |  |
| order_no | text |  |  |  |  | 同一次下单（同一操作编号）的出品单号，厨房按单显示 |
| bill_line_id | bigint |  |  |  | bill_lines |  |
| visit_id | bigint |  | 是 |  | visits |  |
| item_id | bigint |  | 是 |  | service_items | 菜品；手工下的临时项目（8.2.4，选了档口的手动金额）为空，菜名看账单明细 bill_lines.name |
| station_id | bigint |  |  |  | kitchen_stations |  |
| quantity | integer |  |  |  |  |  |
| note | text |  |  | ''::text |  |  |
| status | text |  |  | 'queued'::text |  |  |
| rush_count | integer |  |  | 0 |  |  |
| rushed_at | timestamp with time zone |  | 是 |  |  |  |
| business_date | date |  |  |  |  |  |
| limit_taken | boolean |  |  | false |  | 下单时扣过估清（退菜时按原份数加回）；补录纸质单与不限量的菜为 false |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  |  |  |  |
| started_by | bigint |  | 是 |  | staff |  |
| started_at | timestamp with time zone |  | 是 |  |  |  |
| done_by | bigint |  | 是 |  | staff |  |
| done_at | timestamp with time zone |  | 是 |  |  |  |
| served_by | bigint |  | 是 |  | staff |  |
| served_at | timestamp with time zone |  | 是 |  |  |  |
| cancelled_by | bigint |  | 是 |  | staff |  |
| cancelled_at | timestamp with time zone |  | 是 |  |  |  |
| cancel_reason | text |  | 是 |  |  |  |
| table_session_id | bigint |  | 是 |  | table_sessions |  |
| deliver_to | text |  |  | ''::text |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| order_note | text |  |  | ''::text |  |  |
| deliver_room | text |  |  | ''::text |  |  |
| parts | jsonb |  |  | '[]'::jsonb |  | 出品单上的套餐内容 下单当时套餐含哪几样（[{ "name": "柠檬茶", "quantity": 1 }]，每份套餐的份数）；不是套餐的为空数组。 记快照：以后改了套餐的内容，已经下的单还是当时的 |

### kitchen_stations

S5 餐饮第一步（ROADMAP 第 10 节）：出品档口、菜品的出品档口、估清、厨房出品单（KDS）。 · 出品档口（kitchen_stations）：热菜、凉菜、主食、水吧……菜品挂在哪个档口，下单后就到哪个档口的厨房屏； （建表：022_dining）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('kitchen_stations_id_seq'::regclass) |  |  |
| name | text |  |  |  |  |  |
| sort_order | integer |  |  | 0 |  |  |
| active | boolean |  |  | true |  |  |
| created_by | bigint |  | 是 |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### ledger_entries

余额流水：唯一的记账来源，每笔余额变化一行 （建表：001_init）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('ledger_entries_id_seq'::regclass) |  |  |
| member_id | bigint |  |  |  | members |  |
| entry_type | text |  |  |  |  |  |
| recharge_id | bigint |  | 是 |  | recharges |  |
| consumption_id | bigint |  | 是 |  | consumptions |  |
| reversal_id | bigint |  | 是 |  | reversals |  |
| doc_no | text |  |  |  |  |  |
| principal_delta | bigint |  |  |  |  |  |
| bonus_delta | bigint |  |  |  |  |  |
| principal_after | bigint |  |  |  |  |  |
| bonus_after | bigint |  |  |  |  |  |
| business_date | date |  |  |  |  |  |
| operator_id | bigint |  | 是 |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| expiry_id | bigint |  | 是 |  | bonus_expiries | 余额流水：新增「赠金过期」（只减赠金）；过期由系统处理，没有经办员工 |
| opening_id | bigint |  | 是 |  | opening_balances | 余额流水：「期初导入」只增不减，「期初作废」只减不增；都指向期初明细 |
| member_refund_id | bigint |  | 是 |  | member_refunds |  |
| member_merge_id | bigint |  | 是 |  | member_merges |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |

### ledger_imports

8.1.20 出入库台账（docs/ERP_V8120.md，PENDING_DECISIONS「8.1.20」LD1–LD10）： 「库管入库」页右上角的「导入出入库台账 / 导出台账 / 下载模板」，模板换成门店的《仓库出入库记录》格式（一种物料一行，按月记入库、出库）。 物料档案加「库位」； （建表：200_ledger_imports）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('ledger_imports_id_seq'::regclass) |  |  |
| client_key | uuid |  |  |  |  |  |
| file_sha256 | text |  |  |  |  |  |
| file_name | text |  |  |  |  |  |
| row_count | integer |  |  |  |  |  |
| receipt_count | integer |  |  |  |  |  |
| issue_count | integer |  |  |  |  |  |
| amount_cents | bigint |  |  |  |  | 单位：分 |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### legal_entities

8.0.22 多门店：公司主体、门店、员工挂门店、门店设置、会话的当前门店（docs/MULTISTORE_V8022.md 第 1–4 节，MD-A / MD-C）。 只有一家店时与现在完全一样：现有数据都归「本店」（编号 1）与「本公司」（编号 1）；本店不设门店上下文。 （建表：153_stores）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('legal_entities_id_seq'::regclass) |  |  |
| name | text |  |  |  |  |  |
| tax_no | text |  |  | ''::text |  |  |
| address_phone | text |  |  | ''::text |  |  |
| bank_name | text |  |  | ''::text |  |  |
| bank_account | text |  |  | ''::text |  |  |
| active | boolean |  |  | true |  |  |
| version | integer |  |  | 1 |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### linen_doc_lines

8.0.20 布草洗涤（docs/ERP_V8020.md 第 4 节，JX-E / JX6 / JX11）：布草品类、送洗 / 收回 / 新增 / 报废四种单据。 （建表：138_linen）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | identity always |  |  |
| doc_id | bigint |  |  |  | linen_docs |  |
| item_id | bigint |  |  |  | linen_items |  |
| qty | integer |  |  |  |  | 新增、送洗、报废：数量；收回：完好收回的件数 |
| damaged_qty | integer |  |  | 0 |  |  |
| lost_qty | integer |  |  | 0 |  |  |
| price_cents | integer |  |  | 0 |  | 单位：分 |
| amount_cents | bigint |  |  | 0 |  | 单位：分 |

### linen_docs

8.0.20 布草洗涤（docs/ERP_V8020.md 第 4 节，JX-E / JX6 / JX11）：布草品类、送洗 / 收回 / 新增 / 报废四种单据。 （建表：138_linen）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | identity always |  |  |
| doc_no | text |  |  |  |  |  |
| kind | text |  |  |  |  |  |
| supplier_id | bigint |  | 是 |  | suppliers | 洗涤厂（供应商档案）：送洗、收回必填 |
| doc_date | date |  |  |  |  |  |
| note | text |  |  | ''::text |  |  |
| amount_cents | bigint |  |  | 0 |  | 单位：分 |
| status | text |  |  | 'confirmed'::text |  |  |
| client_key | uuid |  |  |  |  |  |
| request_hash | text |  |  |  |  | 原请求的摘要：同一个操作编号、内容不同的拒绝 |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| voided_by | bigint |  | 是 |  | staff |  |
| voided_at | timestamp with time zone |  | 是 |  |  |  |
| void_reason | text |  | 是 |  |  |  |

### linen_items

8.0.20 布草洗涤（docs/ERP_V8020.md 第 4 节，JX-E / JX6 / JX11）：布草品类、送洗 / 收回 / 新增 / 报废四种单据。 （建表：138_linen）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | identity always |  |  |
| name | text |  |  |  |  |  |
| total_qty | integer |  |  | 0 |  |  |
| at_laundry_qty | integer |  |  | 0 |  |  |
| wash_price_cents | integer |  |  | 0 |  | 单位：分 |
| active | boolean |  |  | true |  |  |
| version | integer |  |  | 1 |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### location_events

位置事件（只追加）：谁、在哪、怎么知道的、什么时候 （建表：035_locations）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('location_events_id_seq'::regclass) |  |  |
| visit_id | bigint |  | 是 |  |  | 谁：在店客人（来访）或技师 |
| technician_id | bigint |  | 是 |  |  |  |
| tag_code | text |  | 是 |  |  | 当时的手牌号（客人换牌后，旧事件里仍是当时那张） |
| kind | text |  |  |  |  | 在某处 / 离开某处、去向不明（退房、没设休息区时下钟）/ 离店（客人结账、撤销来访；技师下牌） |
| floor_id | bigint |  | 是 |  |  |  |
| zone_id | bigint |  | 是 |  |  |  |
| space_id | bigint |  | 是 |  |  |  |
| source | text |  |  |  |  | 怎么知道的：刷卡、定位上报（第二级预留）、发牌、消费、开房、换房、退房、上钟、换服务的房间、下钟、技师上牌 / 下牌、结账、撤销来访 |
| ref_type | text |  | 是 |  |  | 哪条业务单据：来访、账单明细、入住单、钟单、结账单 |
| ref_id | bigint |  | 是 |  |  |  |
| reader_id | bigint |  | 是 |  |  |  |
| at | timestamp with time zone |  |  |  |  | 发生时刻（刷卡时刻、业务时刻）与写入时刻 |
| recorded_at | timestamp with time zone |  |  | now() |  |  |
| applied | boolean |  |  |  |  | 生效：比这个人最近一次位置还早的（迟到的刷卡）只记事件、不改当前位置与轨迹 |
| op_key | uuid |  | 是 |  |  | 上报的操作编号与内容摘要：同一个编号原样重发返回原结果、不重复记（业务动作推导的为空） |
| op_hash | text |  | 是 |  |  |  |
| x_mm | integer |  | 是 |  |  | 第二级精确定位预留（UWB、蓝牙信标）：底图坐标（毫米）、精度（毫米）、设备编号；第一级为空 |
| y_mm | integer |  | 是 |  |  |  |
| accuracy_mm | integer |  | 是 |  |  |  |
| device_id | text |  | 是 |  |  |  |
| staff_id | bigint |  | 是 |  |  | 经办人：业务动作的操作员、模拟刷卡的人或设备桥的账号 |

### location_readers

刷卡点：读卡器装在哪（区域或空间，二选一） （建表：035_locations）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('location_readers_id_seq'::regclass) |  |  |
| code | text |  |  |  |  | 编号：读卡器上贴的号或设备序列号（大写字母、数字、横线） |
| name | text |  |  |  |  |  |
| zone_id | bigint |  | 是 |  | zones |  |
| space_id | bigint |  | 是 |  | spaces |  |
| note | text |  |  | ''::text |  |  |
| active | boolean |  |  | true |  |  |
| version | integer |  |  | 1 |  | 版本号：每次修改加 1；页面提交读到的版本号，对不上就拒绝 |
| created_by | bigint |  | 是 |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |

### location_tracks

轨迹段：同一个地方连续的事件并成一段（进入—离开）；每人最多一段没结束 （建表：035_locations）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('location_tracks_id_seq'::regclass) |  |  |
| visit_id | bigint |  | 是 |  |  |  |
| technician_id | bigint |  | 是 |  |  |  |
| floor_id | bigint |  |  |  |  |  |
| zone_id | bigint |  | 是 |  |  |  |
| space_id | bigint |  | 是 |  |  |  |
| entered_at | timestamp with time zone |  |  |  |  | 进入：这一段的第一条事件 |
| first_event_id | bigint |  |  |  | location_events |  |
| last_at | timestamp with time zone |  |  |  |  | 这一段最近的一条事件与事件数（第二级来了事件更密，段还是按进入—离开） |
| last_event_id | bigint |  |  |  | location_events |  |
| event_count | integer |  |  | 1 |  |  |
| left_at | timestamp with time zone |  | 是 |  |  | 离开：换到别处、离开、离店的那一条事件；还在这里为空 |
| end_event_id | bigint |  | 是 |  | location_events |  |

### marketing_cost_params

8.0.4 会员体系整改（docs/MEMBERSHIP_V804.md）： · 第 9.1 节 买一赠一券：券模板加种类 bogo——买的项目 buy_item_id，赠的项目沿用 exchange_item_id； 可选的赠品出库设置（物料、每份出库数量、出哪个仓）； （建表：089_coupon_campaigns）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| benefit_id | bigint | PK |  |  | benefits |  |
| unit_cost | bigint |  |  |  |  | 服务类权益每登记一次按多少钱测算（分） |
| updated_by | bigint |  |  |  | staff |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### material_images

物料的商品图（8.1.50 采购商城）：每样物料最多 6 张，sort_no=1 是封面；图片本身在 erp_images。物料主档里整组换（删了重写），改动记审计 material_images

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| material_id | bigint | PK |  |  | materials |  |
| sort_no | integer | PK |  |  |  | 第几张（1–6），1 是封面 |
| image_id | bigint |  |  |  | erp_images | 图片（erp_images，scope=general） |

### materials

浴族 yuzu · 库存与采购（增量迁移，不改动会员与储值数据） 约定： · 数量一律为整数「千分之一库存单位」(*_milli，bigint)，金额一律为整数「分」，不使用浮点数； · 单据行保存当时的单位与换算快照，物料包装变更不会改写历史； （建表：002_inventory）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('materials_id_seq'::regclass) |  |  |
| code | text |  |  |  |  |  |
| name | text |  |  |  |  |  |
| category | text |  |  | ''::text |  |  |
| specification | text |  |  | ''::text |  |  |
| inventory_unit | text |  |  |  |  |  |
| decimals | smallint |  |  | 0 |  | 库存单位允许的小数位：0 = 只能整数（双、瓶、桶），最多 3 位（kg 等） |
| purchase_unit | text |  |  |  |  |  |
| purchase_factor_milli | bigint |  |  |  |  | 1 个采购单位 = 多少库存单位（千分之一精度），例如 1 箱 = 100 双 → 100000 |
| ref_price_cents | bigint |  | 是 |  |  | 参考价，按采购单位；单位：分 |
| default_supplier_id | bigint |  | 是 |  | suppliers |  |
| low_stock_milli | bigint |  | 是 |  |  | 人工设定的低库存提醒阈值 |
| tracked | boolean |  |  | true |  | false = 候选物料，不产生库存流水 |
| active | boolean |  |  | true |  |  |
| stock_milli | bigint |  |  | 0 |  |  |
| last_move_id | bigint |  | 是 |  |  | 盘点时据此判断账面是否又有变动 |
| note | text |  |  | ''::text |  |  |
| is_synthetic | boolean |  |  | false |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| cover_days | integer |  | 是 |  |  | 按可用天数提醒（#22） |
| counter_use | boolean |  |  | false |  |  |
| weighed | boolean |  |  | false |  |  |
| expiry_tracked | boolean |  |  | false |  |  |
| shelf_life_days | integer |  | 是 |  |  |  |
| avg_cost_e4 | bigint |  |  | 0 |  |  |
| cost_estimated | boolean |  |  | true |  |  |
| replenish_mode | text |  |  | 'auto'::text |  |  |
| replenish_rev | integer |  |  | 0 |  | 补货方式的版本号：每改一次加一。页面改补货方式时带上看到的版本号，对不上拒绝—— 没等到回音的旧请求晚到时，只要这之后补货方式被改过（哪怕改走又改回原来的值）就不会生效。 |
| location | text |  |  | ''::text |  |  |

### meal_entries

8.2.8 餐厅入口刷手牌登记进餐：同一来访同一营业日同一餐段一条（那一行餐费作废了的可以重新登记）；含餐的那一行餐费自动折成 0，裸票照价收；只追加。金额单位分

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('meal_entries_id_seq'::regclass) |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| visit_id | bigint |  |  |  | visits |  |
| business_date | date |  |  |  |  |  |
| period | text |  |  |  |  | 餐段：breakfast 早餐 / lunch 午餐 / dinner 晚餐 / supper 夜宵（时间与价钱在餐饮规则里） |
| kind | text |  |  |  |  | included 含餐抵扣（餐费折成 0）/ paid 裸票照价收 |
| price | bigint |  |  |  |  | 这一餐段的餐费（分，记在那一行明细上的原价） |
| line_id | bigint |  |  |  | bill_lines | 记在手牌上的那一行餐费明细 |
| client_key | uuid |  |  |  |  |  |
| staff_id | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  |  |  |  |

### member_card_deposits

会员卡押金台账（只追加） 收：建档选实体卡、给没有押金的会员发卡时；退：退卡（卡丢了没卡可退的也在这里退）。挂失不退，补卡沿用原来的押金。 「其他」方式收的要写明收的是什么；退的写原因；非现金退的登记退款单号（服务端核对） （建表：192_member_cards_v8115）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('member_card_deposits_id_seq'::regclass) |  |  |
| doc_no | text |  |  |  |  |  |
| member_id | bigint |  |  |  | members |  |
| card_id | bigint |  | 是 |  | member_cards | 收：发的那张卡；退：退回的那张卡（卡丢了没卡可退的为空） |
| kind | text |  |  |  |  |  |
| method | text |  |  |  |  |  |
| amount | integer |  |  |  |  |  |
| ref | text |  |  | ''::text |  |  |
| reason | text |  | 是 |  |  |  |
| shift_id | bigint |  | 是 |  | shifts |  |
| business_date | date |  |  |  |  |  |
| operator_id | bigint |  |  |  | staff |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| client_key | uuid |  |  |  |  | 操作编号：收的记建档 / 发卡那一次的编号，退的记退卡那一次的编号 |
| request_hash | text |  |  |  |  |  |

### member_card_returns

退卡记录 一次退卡一行：退回哪张卡（卡丢了没卡可退的为空）、退了多少押金（没押金的为 0，这时没有押金台账的行） （建表：192_member_cards_v8115）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('member_card_returns_id_seq'::regclass) |  |  |
| member_id | bigint |  |  |  | members |  |
| card_id | bigint |  | 是 |  | member_cards |  |
| deposit_id | bigint |  | 是 |  | member_card_deposits |  |
| amount | integer |  |  |  |  |  |
| reason | text |  |  |  |  |  |
| operator_id | bigint |  |  |  | staff |  |
| business_date | date |  |  |  |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| client_key | uuid |  |  |  |  |  |
| request_hash | text |  |  |  |  |  |

### member_cards

v0.7.28 ⑦（主线）：会员实体卡——发卡、刷卡找会员、挂失、补卡（设计见 docs/SCHEDULE_FINISH.md 第 8 节，N8 待确认）。 · member_cards：一张实体卡一行。卡号是读卡器读到的号（或手输），规整成大写数字字母； （建表：057_member_cards）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('member_cards_id_seq'::regclass) |  |  |
| card_no | text |  |  |  |  |  |
| member_id | bigint |  |  |  | members |  |
| status | text |  |  | 'active'::text |  |  |
| issued_by | bigint |  |  |  | staff |  |
| issued_at | timestamp with time zone |  |  | now() |  |  |
| replaces_id | bigint |  | 是 |  | member_cards | 补卡：换下的那一张（挂失的、损坏的） |
| note | text |  |  | ''::text |  |  |
| client_key | uuid |  |  |  |  |  |
| request_hash | text |  |  |  |  |  |
| ended_by | bigint |  | 是 |  | staff | 挂失、换下：谁、什么时候、为什么 |
| ended_at | timestamp with time zone |  | 是 |  |  |  |
| end_reason | text |  | 是 |  |  |  |

### member_grade_events

状态变化记录：每一次档阶或会籍变化一条，只追加。to_* 与 cycle_* 是变化之后的状态；会员当前状态 = 最后一条的结果（自检核对） （建表：040_membership_v2）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('member_grade_events_id_seq'::regclass) |  |  |
| member_id | bigint |  |  |  | members |  |
| kind | text |  |  |  |  |  |
| business_date | date |  |  |  |  |  |
| from_grade | smallint |  |  |  |  |  |
| from_tier | smallint |  | 是 |  |  |  |
| to_grade | smallint |  |  |  |  |  |
| to_tier | smallint |  | 是 |  |  |  |
| cycle_start | date |  | 是 |  |  |  |
| cycle_end | date |  | 是 |  |  |  |
| grace_until | date |  | 是 |  |  |  |
| cycle_spend | bigint |  |  | 0 |  | 当时的周期净储值消费（分）；上线定档、期初导入、充值升档另记当时的累计充值 |
| rolling_recharge | bigint |  | 是 |  |  |  |
| recharge_id | bigint |  | 是 |  | recharges |  |
| consumption_id | bigint |  | 是 |  | consumptions |  |
| staff_id | bigint |  | 是 |  | staff | 经办人；空 = 系统自动 |
| reason | text |  |  | ''::text |  |  |
| client_key | uuid |  | 是 |  |  | 手动调整的操作编号（没收到结果再提交返回原来那条） |
| created_at | timestamp with time zone |  |  | now() |  |  |
| member_refund_id | bigint |  | 是 |  | member_refunds |  |
| member_merge_id | bigint |  | 是 |  | member_merges |  |

### member_history_imports

v0.7.28 ⑩（主线）：旧 EBC 逐笔流水只读导入（N12，设计见 docs/SCHEDULE_FINISH.md 第 11 节）。 · 旧系统（EBC）导出的会员逐笔流水（充值、消费、赠送、退款、调整……）按模板导入两张只读表，会员详情「旧系统流水」里看； （建表：060_member_history）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('member_history_imports_id_seq'::regclass) |  |  |
| import_no | text |  |  |  |  |  |
| client_key | uuid |  | 是 |  |  | 页面上的「确认导入」带操作编号：同一编号重提返回第一次的结果 |
| source | text |  |  |  |  |  |
| file_name | text |  |  | ''::text |  |  |
| file_sha256 | text |  |  |  |  |  |
| note | text |  |  | ''::text |  |  |
| total_rows | integer |  |  |  |  | 文件里的数据行、导入的行、认不出会员没导入的行、涉及几位会员 |
| imported_rows | integer |  |  |  |  |  |
| skipped_rows | integer |  |  |  |  |  |
| member_count | integer |  |  |  |  |  |
| first_at | timestamp with time zone |  | 是 |  |  |  |
| last_at | timestamp with time zone |  | 是 |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| status | text |  |  | 'active'::text |  |  |
| voided_at | timestamp with time zone |  | 是 |  |  |  |
| voided_by | bigint |  | 是 |  | staff |  |
| void_reason | text |  | 是 |  |  |  |

### member_history_rows

v0.7.28 ⑩（主线）：旧 EBC 逐笔流水只读导入（N12，设计见 docs/SCHEDULE_FINISH.md 第 11 节）。 · 旧系统（EBC）导出的会员逐笔流水（充值、消费、赠送、退款、调整……）按模板导入两张只读表，会员详情「旧系统流水」里看； （建表：060_member_history）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('member_history_rows_id_seq'::regclass) |  |  |
| import_id | bigint |  |  |  | member_history_imports |  |
| line_no | integer |  |  |  |  | 文件里的行号（含表头，从 1 开始） |
| member_id | bigint |  |  |  | members |  |
| matched_by | text |  |  |  |  | 怎么认出的会员：旧卡号（期初导入记下的）或手机号 |
| occurred_at | timestamp with time zone |  |  |  |  |  |
| type_label | text |  |  |  |  | 类型：原文（旧系统写的）与归类（充值、消费、赠送、退款、调整、其他，只用于显示） |
| kind | text |  |  |  |  |  |
| amount | bigint |  |  |  |  | 金额（分，按旧系统的正负）；赠金、余额、赠金余额没有时为空 |
| bonus | bigint |  | 是 |  |  |  |
| balance | bigint |  | 是 |  |  |  |
| bonus_balance | bigint |  | 是 |  |  |  |
| doc_no | text |  |  | ''::text |  |  |
| store | text |  |  | ''::text |  |  |
| operator | text |  |  | ''::text |  |  |
| note | text |  |  | ''::text |  |  |
| raw | jsonb |  |  |  |  | 原始内容（表头 → 单元格） |

### member_merges

④ 合并（表要先建：余额流水、赠金批次引用它） 一位会员只能被并走一次；并了不能撤销。余额与赠金批次在同一事务里转过去，目标会员取两位里高的状态（grade_event_id） （建表：047_membership_finish）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('member_merges_id_seq'::regclass) |  |  |
| merge_no | text |  |  |  |  |  |
| source_id | bigint |  |  |  | members |  |
| target_id | bigint |  |  |  | members |  |
| principal | bigint |  |  |  |  |  |
| bonus | bigint |  |  |  |  |  |
| reason | text |  |  |  |  |  |
| staff_id | bigint |  |  |  | staff |  |
| business_date | date |  |  |  |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| client_key | uuid |  |  |  |  |  |
| request_hash | text |  |  |  |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |

### member_notices

8.0.4 会员体系整改（docs/MEMBERSHIP_V804.md）： · 第 9.1 节 买一赠一券：券模板加种类 bogo——买的项目 buy_item_id，赠的项目沿用 exchange_item_id； 可选的赠品出库设置（物料、每份出库数量、出哪个仓）； （建表：089_coupon_campaigns）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('member_notices_id_seq'::regclass) |  |  |
| member_id | bigint |  |  |  | members |  |
| kind | text |  |  |  |  | 到账（您收到 N 张券）、快到期（您的券 N 天后到期） |
| title | text |  |  |  |  |  |
| body | text |  |  |  |  |  |
| campaign_id | bigint |  | 是 |  | coupon_campaigns |  |
| issue_id | bigint |  | 是 |  | coupon_issues |  |
| show_from | date |  |  |  |  | 哪几天弹（营业日，含两头） |
| show_until | date |  |  |  |  |  |
| dedupe_key | text |  |  |  |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| read_at | timestamp with time zone |  | 是 |  |  | 会员在会员端看过（只记一次） |

### member_phone_changes

047 会员体系收尾（v0.7.26；店主 2026-11-04：这次 PR 把会员体系都做完；设计 docs/MEMBERSHIP_FINISH.md，默认做法 PENDING_DECISIONS M50、M69–M81）。 （建表：047_membership_finish）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('member_phone_changes_id_seq'::regclass) |  |  |
| member_id | bigint |  |  |  | members |  |
| old_phone | text |  | 是 |  |  |  |
| new_phone | text |  |  |  |  |  |
| reason | text |  |  |  |  |  |
| staff_id | bigint |  |  |  | staff |  |
| approved_by | bigint |  | 是 |  | staff | 当场授权的人；经办人自己有「改会员手机号」权限时为空 |
| business_date | date |  |  |  |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### member_refund_lines

每一行：退的是哪一笔的本金（充值 / 期初余额 / 合并转入）、按什么方式退、退款单号（扫码、银行卡）或怎么退的（其他） （建表：047_membership_finish）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('member_refund_lines_id_seq'::regclass) |  |  |
| refund_id | bigint |  |  |  | member_refunds |  |
| source | text |  |  |  |  |  |
| recharge_id | bigint |  | 是 |  | recharges |  |
| opening_id | bigint |  | 是 |  | opening_balances |  |
| member_merge_id | bigint |  | 是 |  | member_merges |  |
| method | text |  |  |  |  |  |
| amount | bigint |  |  |  |  |  |
| ref | text |  |  | ''::text |  |  |
| route | text |  |  | 'manual'::text |  | 2. 2d 线上充值的原路退回（docs/MP_RECHARGE.md 第 9 节，MP21）：退储值的每一行记「怎么退」。 manual 员工退：现金从钱箱退；扫码、银行卡在商户后台原路退回后登记退款单号（v0.7.26 的做法）； mp_auto 门店系统原路退回：来源是线上充值的那一行，由小程序线按行调微信支付的退款接口，退款单号空着。 |

### member_refunds

② 储值退回 退储值单：退的本金、扣回的赠金、经办人、当场授权的人、记到的班次（退现金时是所选钱箱当班的班次，否则是经办人的班次） （建表：047_membership_finish）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('member_refunds_id_seq'::regclass) |  |  |
| refund_no | text |  |  |  |  |  |
| member_id | bigint |  |  |  | members |  |
| principal | bigint |  |  |  |  |  |
| bonus | bigint |  |  | 0 |  |  |
| reason | text |  |  |  |  |  |
| operator_id | bigint |  |  |  | staff |  |
| approved_by | bigint |  |  |  | staff |  |
| shift_id | bigint |  | 是 |  | shifts |  |
| business_date | date |  |  |  |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| client_key | uuid |  |  |  |  |  |
| request_hash | text |  |  |  |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |

### member_status_events

④ 停用 / 启用、换手机号（合并的表在上面） （建表：047_membership_finish）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('member_status_events_id_seq'::regclass) |  |  |
| member_id | bigint |  |  |  | members |  |
| from_status | text |  |  |  |  |  |
| to_status | text |  |  |  |  |  |
| member_merge_id | bigint |  | 是 |  | member_merges | 合并时停用来源会员也记一条（member_merge_id 指向合并单） |
| reason | text |  |  |  |  |  |
| staff_id | bigint |  |  |  | staff |  |
| business_date | date |  |  |  |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| client_key | uuid |  | 是 |  |  |  |
| request_hash | text |  | 是 |  |  |  |

### member_tag_links

会员挂了哪些标签（编辑会员时整组替换；挂、摘留在会员的审计里） （建表：088_member_tags_vip）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| member_id | bigint | PK |  |  | members |  |
| tag_id | bigint | PK |  |  | member_tags |  |
| created_by | bigint |  | 是 |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### member_tags

8.0.4 会员体系整改（docs/MEMBERSHIP_V804.md）： · 第 5 节 会员标签：自定义字段全部转成标签（字段名做分组，填过的值做标签，单选的可选值都建好）； 原来的 custom_fields 原样留在会员档案里不删（只读、不再显示），一个值也不会丢； （建表：088_member_tags_vip）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('member_tags_id_seq'::regclass) |  |  |
| group_name | text |  |  | ''::text |  | 分组（转来的标签是原来的字段名，例如「了解渠道」；手工建的可以不分组） |
| name | text |  |  |  |  | 手工建的最多 16 个字（页面与接口限制）；转来的是原来字段里填的值，文字字段最多 100 个字 |
| source | text |  |  | 'manual'::text |  |  |
| field_key | text |  | 是 |  |  | 转来的标签记着原来的字段编号（f1、f2……） |
| active | boolean |  |  | true |  |  |
| sort_order | integer |  |  | 0 |  |  |
| version | integer |  |  | 1 |  |  |
| created_by | bigint |  | 是 |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_by | bigint |  | 是 |  | staff |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### member_trials

④ 临时身份：邀请体验、赠送会籍 只享权益（本月可享的服务类、结账会员折扣、VIP 柜按体验档级），不发每月券与事件礼，不进升档、升阶、保级； 到期由每天的到期处理结束，自己的档级升到体验档级或更高时转正，店主 / 店总可以撤销（写原因） （建表：042_member_discounts_trials）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('member_trials_id_seq'::regclass) |  |  |
| member_id | bigint |  |  |  | members |  |
| kind | text |  |  |  |  |  |
| grade | smallint |  |  |  |  |  |
| tier | smallint |  |  | 0 |  | 体验的阶位：初阶 |
| starts_on | date |  |  |  |  |  |
| ends_on | date |  |  |  |  |  |
| inviter_id | bigint |  |  |  | members |  |
| benefit_use_id | bigint |  | 是 |  | benefit_uses | 赠送会籍：那次 QY-042 的使用登记（撤销时一并作废，次数腾出来） |
| business_date | date |  |  |  |  |  |
| staff_id | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| client_key | uuid |  |  |  |  | 页面的操作编号（没收到结果再提交返回原来那条；结果待确认时可以确认作废） |
| request_hash | text |  |  |  |  | 原请求的摘要（邀请人、类型、手机号、姓名、渠道）：同一编号重提按它核对，不看受邀人档案此刻的手机号（之后改了手机号，原样重提仍返回原来那条） |
| status | text |  |  | 'active'::text |  |  |
| ended_on | date |  | 是 |  |  |  |
| ended_by | bigint |  | 是 |  | staff |  |
| end_reason | text |  | 是 |  |  |  |

### members

浴族 yuzu 初始结构 约定：金额一律为整数「分」(bigint)；已入账的单据与流水只追加，不修改、不删除， 纠错通过新增撤销/冲正记录完成。 （建表：001_init）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('members_id_seq'::regclass) |  |  |
| member_no | text |  |  |  |  |  |
| name | text |  |  |  |  |  |
| phone | text |  | 是 |  |  |  |
| gender | text |  | 是 |  |  |  |
| birthday | date |  | 是 |  |  |  |
| note | text |  |  | ''::text |  |  |
| principal_balance | bigint |  |  | 0 |  |  |
| bonus_balance | bigint |  |  | 0 |  |  |
| status | text |  |  | 'active'::text |  |  |
| is_synthetic | boolean |  |  | false |  |  |
| created_by | bigint |  | 是 |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| custom_fields | jsonb |  |  | '{}'::jsonb |  |  |
| channel | text |  | 是 |  |  |  |
| grade | smallint |  |  | 0 |  |  |
| tier | smallint |  | 是 |  |  |  |
| cycle_start | date |  | 是 |  |  |  |
| cycle_end | date |  | 是 |  |  |  |
| grace_until | date |  | 是 |  |  |  |
| grade_version | integer |  |  | 0 |  |  |
| merged_into_id | bigint |  | 是 |  | members | 被并走的会员：停用，记下并到了谁（不能指向自己；被并走的不能再被当作目标，由应用核对） |
| card_type | text |  |  | 'ecard'::text |  |  |
| referrer_member_id | bigint |  | 是 |  | members |  |
| preferred_items | text[] |  |  | '{}'::text[] |  |  |
| client_key | uuid |  | 是 |  |  |  |
| request_hash | text |  | 是 |  |  |  |
| gift_batch_id | bigint |  | 是 |  | gift_card_batches |  |

### membership_job_runs

每天的自动任务：一个营业日一条，处理了多少人、各是什么结果、有没有出错（同一天多跑几次累加） （建表：040_membership_v2）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('membership_job_runs_id_seq'::regclass) |  |  |
| job | text |  |  |  |  |  |
| business_date | date |  |  |  |  |  |
| started_at | timestamp with time zone |  |  | now() |  |  |
| finished_at | timestamp with time zone |  | 是 |  |  |  |
| processed | integer |  |  | 0 |  |  |
| retained | integer |  |  | 0 |  |  |
| grace | integer |  |  | 0 |  |  |
| downgraded | integer |  |  | 0 |  |  |
| error | text |  | 是 |  |  |  |
| coupons | integer |  |  | 0 |  |  |
| catalog_stamp | bigint |  | 是 |  |  |  |

### op_fences

浴族 yuzu · G2 第 3 轮：作废登记绑定业务类型（增量迁移，只新增一张表） 「确认作废」改为写入 op_fences（操作编号 + 声明的业务类型 + 经办人），不再占用 idempotency_keys 的编号： · 原请求写入操作编号前，按编号取事务级咨询锁，再检查有没有「同一业务类型」的作废登记，有则整笔回滚； 作废登记同样先取这把锁，二者不会交错，原请求一旦写下编号，作废就只能查回结果； （建表：006_op_fences）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| key | uuid | PK |  |  |  |  |
| op_type | text | PK |  |  |  |  |
| staff_id | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### opening_balances

Batch 2.4d：旧系统（EBC）会员余额期初导入（店主 2026-10-27 #5 #6 #7） · 旧会员只做导入：按手机号匹配已有会员，没有的新建档案；本金、赠金分开迁入，金额与旧系统一致； · 每一批导入记下来源（例如 EBC）、文件名与文件摘要、经办人；每一行记下原始内容、旧卡号与是否新建会员； （建表：013_opening_balances）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('opening_balances_id_seq'::regclass) |  |  |
| import_id | bigint |  |  |  | opening_imports |  |
| member_id | bigint |  |  |  | members |  |
| doc_no | text |  |  |  |  |  |
| line_no | integer |  |  |  |  | 来源文件里的行号（含表头，从 1 开始）与原始内容 |
| source_row | jsonb |  |  |  |  |  |
| legacy_no | text |  |  | ''::text |  |  |
| principal | bigint |  |  |  |  |  |
| bonus | bigint |  |  |  |  |  |
| bonus_expires_at | timestamp with time zone |  | 是 |  |  |  |
| legacy_recharged | bigint |  |  | 0 |  | 旧系统的累计充值（用于 VIP 柜等级，口径待确认）；不计入充值实收 |
| member_created | boolean |  |  |  |  |  |
| status | text |  |  | 'active'::text |  |  |
| voided_at | timestamp with time zone |  | 是 |  |  |  |
| voided_by | bigint |  | 是 |  | staff |  |
| void_reason | text |  | 是 |  |  |  |
| void_business_date | date |  | 是 |  |  | 作废记入的营业日（日结按它汇总期初作废） |

### opening_imports

Batch 2.4d：旧系统（EBC）会员余额期初导入（店主 2026-10-27 #5 #6 #7） · 旧会员只做导入：按手机号匹配已有会员，没有的新建档案；本金、赠金分开迁入，金额与旧系统一致； · 每一批导入记下来源（例如 EBC）、文件名与文件摘要、经办人；每一行记下原始内容、旧卡号与是否新建会员； （建表：013_opening_balances）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('opening_imports_id_seq'::regclass) |  |  |
| import_no | text |  |  |  |  |  |
| client_key | uuid |  |  |  |  | 页面或命令行的操作编号：同一编号重提返回同一批，不会重复导入 |
| source | text |  |  |  |  |  |
| file_name | text |  |  | ''::text |  |  |
| file_sha256 | text |  |  |  |  |  |
| note | text |  |  | ''::text |  |  |
| row_count | integer |  |  |  |  |  |
| created_count | integer |  |  |  |  |  |
| principal_total | bigint |  |  |  |  |  |
| bonus_total | bigint |  |  |  |  |  |
| business_date | date |  |  |  |  |  |
| imported_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |

### opening_payables

应付：期初未付、付款、付款分配、应付流水 （建表：002_inventory）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('opening_payables_id_seq'::regclass) |  |  |
| doc_no | text |  |  |  |  |  |
| supplier_id | bigint |  |  |  | suppliers |  |
| amount_cents | bigint |  |  |  |  | 单位：分 |
| as_of_date | date |  |  |  |  |  |
| note | text |  |  | ''::text |  |  |
| status | text |  |  |  |  |  |
| client_key | uuid |  | 是 |  |  |  |
| is_synthetic | boolean |  |  | false |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| confirmed_by | bigint |  | 是 |  | staff |  |
| confirmed_at | timestamp with time zone |  | 是 |  |  |  |
| returned_reason | text |  | 是 |  |  |  |
| voided_by | bigint |  | 是 |  | staff |  |
| voided_at | timestamp with time zone |  | 是 |  |  |  |
| void_reason | text |  | 是 |  |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| import_id | bigint |  | 是 |  | erp_imports |  |

### org_departments

8.2.0 P04（回测 5-2，docs/YUZU_REQ_V820.md 第 5 节，RT9–RT12）：岗位职权数据重建。 （建表：201_position_catalog）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| key | text | PK |  |  |  |  |
| name | text |  |  |  |  |  |
| sort | integer |  |  |  |  |  |
| parent_key | text |  | 是 |  | org_departments |  |
| head_staff_id | bigint |  | 是 |  | staff |  |
| version | integer |  |  | 1 |  |  |

### ota_channels

8.0.21 OTA 渠道订单（docs/INTEGRATIONS_V8021.md 第 4 节，CW-I / CW9）：先做渠道后台导出的订单表导入成客房预约，直连是以后的事； 房量房价不自动推给渠道。 （建表：150_ota）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('ota_channels_id_seq'::regclass) |  |  |
| name | text |  |  |  |  |  |
| commission_bp | integer |  |  | 0 |  |  |
| room_map | jsonb |  |  | '{}'::jsonb |  | 渠道房型名 → 本店房型 id |
| column_map | jsonb |  |  | '{}'::jsonb |  | 导入用的列对照（字段 → 表头）；空的按同义词认 |
| active | boolean |  |  | true |  |  |
| version | integer |  |  | 1 |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### ota_imports

8.0.21 OTA 渠道订单（docs/INTEGRATIONS_V8021.md 第 4 节，CW-I / CW9）：先做渠道后台导出的订单表导入成客房预约，直连是以后的事； 房量房价不自动推给渠道。 （建表：150_ota）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('ota_imports_id_seq'::regclass) |  |  |
| channel_id | bigint |  |  |  | ota_channels |  |
| file_name | text |  |  |  |  |  |
| file_hash | text |  |  |  |  |  |
| rows | integer |  |  |  |  |  |
| client_key | uuid |  |  |  |  |  |
| request_hash | text |  |  |  |  |  |
| staff_id | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### ota_order_bookings

8.0.21 OTA 渠道订单（docs/INTEGRATIONS_V8021.md 第 4 节，CW-I / CW9）：先做渠道后台导出的订单表导入成客房预约，直连是以后的事； 房量房价不自动推给渠道。 （建表：150_ota）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| order_id | bigint | PK |  |  | ota_orders |  |
| booking_id | bigint | PK |  |  | bookings |  |

### ota_orders

8.0.21 OTA 渠道订单（docs/INTEGRATIONS_V8021.md 第 4 节，CW-I / CW9）：先做渠道后台导出的订单表导入成客房预约，直连是以后的事； 房量房价不自动推给渠道。 （建表：150_ota）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('ota_orders_id_seq'::regclass) |  |  |
| channel_id | bigint |  |  |  | ota_channels |  |
| order_no | text |  |  |  |  |  |
| guest_name | text |  |  | ''::text |  |  |
| guest_phone | text |  |  | ''::text |  |  |
| channel_room | text |  |  | ''::text |  |  |
| room_type_id | bigint |  | 是 |  | room_types |  |
| checkin_date | date |  |  |  |  |  |
| checkout_date | date |  |  |  |  |  |
| rooms | integer |  |  |  |  |  |
| amount_cents | bigint |  |  |  |  | 单位：分 |
| pay_mode | text |  |  |  |  |  |
| channel_status | text |  |  |  |  | 渠道那边的状态（这次导入时） |
| status | text |  |  | 'new'::text |  | 本店这边：new 刚导入、booked 建好预约、cancelled 取消了、failed 房型对照不上（补对照后重试）、skipped 入住日已经过了 |
| fail_reason | text |  | 是 |  |  |  |
| overbooked | boolean |  |  | false |  | 房量不够照样建了（超订提醒） |
| notice | text |  | 是 |  |  | 已经到店、渠道又改了或取消了：只提醒，不动预约 |
| raw | jsonb |  |  | '{}'::jsonb |  |  |
| last_import_id | bigint |  | 是 |  | ota_imports |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### patrol_checkin_repeats

8.0.9 巡场（Codex 审查 94f53d5）：同一个人 2 分钟内重复扫同一个码只记一次（XC5）；被当成「刚打过卡」的那一笔也记下 操作编号与它指向的那条打卡，回复丢了原样重提返回第一次的结果。之前不记：原来那条在重提之前被后台作废的话， 重提会再记一条新的有效打卡，等于撤销了作废。只追加，不能改、不能删。 （建表：112_patrol_repeats）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| client_key | uuid | PK |  |  |  |  |
| checkin_id | bigint |  |  |  | patrol_checkins | 当时算作「刚打过卡」的那一条（之后被作废也照样指着它） |
| employee_id | bigint |  |  |  | canteen_employees |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### patrol_checkins

巡场打卡：只追加，只能作废一次 （建表：111_patrol）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('patrol_checkins_id_seq'::regclass) |  |  |
| point_id | bigint |  |  |  | patrol_points |  |
| point_name | text |  |  |  |  | 当时的场所名称与员工的工号、姓名、部门（快照：之后改名单、改名称不改历史） |
| employee_id | bigint |  |  |  | canteen_employees |  |
| emp_no | text |  |  |  |  |  |
| employee_name | text |  |  |  |  |  |
| department_name | text |  |  | ''::text |  |  |
| business_date | date |  |  |  |  | 营业日（XC4）：按扫到的时间与营业日切换时间 |
| scanned_at | timestamp with time zone |  |  |  |  | 扫到的时间：断网补交时是手机记下的时间（按服务器时间差修正过，XC7） |
| recorded_at | timestamp with time zone |  |  | now() |  |  |
| via | text |  |  |  |  | 怎么扫的：工作台里扫码 / 用手机相机、微信直接扫开的 / 拍照识别 |
| client_key | uuid |  |  |  |  |  |
| voided_at | timestamp with time zone |  | 是 |  |  |  |
| void_reason | text |  | 是 |  |  |  |
| voided_by | bigint |  | 是 |  | staff |  |
| round_start | timestamp with time zone |  | 是 |  |  |  |
| round_minutes | integer |  | 是 |  |  |  |

### patrol_points

场所：一个场所一个码（印在二维码里：员工入口地址 + #patrol=码） （建表：111_patrol）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('patrol_points_id_seq'::regclass) |  |  |
| name | text |  |  |  |  |  |
| area | text |  |  | ''::text |  |  |
| token | text |  |  |  |  | 场所码：12 位大写字母与 2–7（base32），随机；换码时换成新的，旧码马上认不出（XC8） |
| active | boolean |  |  | true |  |  |
| sort_order | integer |  |  | 0 |  |  |
| version | integer |  |  | 1 |  |  |
| client_key | uuid |  |  |  |  | 新建时的操作编号（「结果待确认」查回、确认作废用）与原请求摘要 |
| request_hash | text |  |  |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_by | bigint |  | 是 |  | staff |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| token_changed_at | timestamp with time zone |  | 是 |  |  |  |

### pay_refunds

8.0.21 支付直连（docs/INTEGRATIONS_V8021.md 第 2 节，CW-G / CW7）：B 扫 C，收银员扫客人的付款码，到账自动记收款。 8.0.21 只有接口与模拟实现（CW22），正式实现等商户号联调；手选「微信 / 支付宝」、手输金额的做法照旧留着。 （建表：148_pay_terminal）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('pay_refunds_id_seq'::regclass) |  |  |
| tx_id | bigint |  |  |  | pay_transactions |  |
| out_refund_no | text |  |  |  |  |  |
| amount_cents | bigint |  |  |  |  | 单位：分 |
| reason | text |  |  |  |  |  |
| status | text |  |  | 'pending'::text |  |  |
| provider_refund_no | text |  | 是 |  |  |  |
| fail_reason | text |  | 是 |  |  |  |
| offline_note | text |  | 是 |  |  |  |
| refund_id | bigint |  | 是 |  | refunds | 退款单（v0.7.20）上的原路退回；没入账的整笔退回为空 |
| client_key | uuid |  | 是 |  |  |  |
| staff_id | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| done_at | timestamp with time zone |  | 是 |  |  |  |

### pay_transactions

8.0.21 支付直连（docs/INTEGRATIONS_V8021.md 第 2 节，CW-G / CW7）：B 扫 C，收银员扫客人的付款码，到账自动记收款。 8.0.21 只有接口与模拟实现（CW22），正式实现等商户号联调；手选「微信 / 支付宝」、手输金额的做法照旧留着。 （建表：148_pay_terminal）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('pay_transactions_id_seq'::regclass) |  |  |
| out_trade_no | text |  |  |  |  |  |
| provider | text |  |  |  |  |  |
| adapter | text |  |  |  |  |  |
| purpose | text |  |  |  |  |  |
| amount_cents | bigint |  |  |  |  | 单位：分 |
| status | text |  |  | 'paying'::text |  |  |
| provider_trade_no | text |  | 是 |  |  |  |
| paid_at | timestamp with time zone |  | 是 |  |  |  |
| fail_reason | text |  | 是 |  |  |  |
| refund_cents | bigint |  |  | 0 |  | 单位：分 |
| consumed_kind | text |  | 是 |  |  |  |
| consumed_id | bigint |  | 是 |  |  |  |
| client_key | uuid |  |  |  |  |  |
| request_hash | text |  |  |  |  |  |
| staff_id | bigint |  |  |  | staff |  |
| shift_id | bigint |  | 是 |  | shifts |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### pay_tx_events

用掉、解开的记录（只追加） （建表：148_pay_terminal）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('pay_tx_events_id_seq'::regclass) |  |  |
| tx_id | bigint |  |  |  | pay_transactions |  |
| action | text |  |  |  |  |  |
| kind | text |  |  |  |  |  |
| target_id | bigint |  |  |  |  |  |
| note | text |  |  | ''::text |  |  |
| staff_id | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### payment_allocations

付款核销到具体货款：某张收货单，或期初未付 （建表：002_inventory）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('payment_allocations_id_seq'::regclass) |  |  |
| payment_id | bigint |  |  |  | payments |  |
| receipt_doc_id | bigint |  | 是 |  | inv_docs |  |
| opening_payable_id | bigint |  | 是 |  | opening_payables |  |
| amount_cents | bigint |  |  |  |  | 单位：分 |

### payment_batch_items

8.0.21 供应商收款账户与批量付款文件（docs/FINANCE_V8021.md 第 5 节，CW-D / CW4 / CW18 / CW19）。 · suppliers 加收款账户：户名、开户行、账号（批量付款文件要用完整账号；页面列表里打码，维护照旧「维护物料、供应商、部门档案」）。 （建表：145_payment_batches）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | identity always |  |  |
| batch_id | bigint |  |  |  | payment_batches |  |
| line_no | integer |  |  |  |  |  |
| payment_request_id | bigint |  |  |  | payment_requests |  |
| amount_cents | bigint |  |  |  |  | 单位：分 |
| payee_name | text |  |  |  |  |  |
| payee_bank | text |  |  |  |  |  |
| payee_account | text |  |  |  |  |  |
| purpose | text |  |  |  |  |  |
| status | text |  |  | 'pending'::text |  |  |
| active | boolean |  |  | true |  | 还在一个没结束的批次里（pending 且批次没作废、没结束）：同一张申请同时只能有一行 active |
| pay_client_key | uuid |  |  |  |  | 记已付时调「按申请登记付款」用的操作编号（生成时就定下） |
| payment_kind | text |  | 是 |  |  | 记已付以后：供应商往来的付款（payments）或合同付款（contract_payouts） |
| payment_id | bigint |  | 是 |  |  |  |
| paid_on | date |  | 是 |  |  |  |
| bank_ref | text |  |  | ''::text |  |  |
| fail_reason | text |  | 是 |  |  |  |
| updated_by | bigint |  | 是 |  | staff |  |
| updated_at | timestamp with time zone |  | 是 |  |  |  |

### payment_batches

8.0.21 供应商收款账户与批量付款文件（docs/FINANCE_V8021.md 第 5 节，CW-D / CW4 / CW18 / CW19）。 · suppliers 加收款账户：户名、开户行、账号（批量付款文件要用完整账号；页面列表里打码，维护照旧「维护物料、供应商、部门档案」）。 （建表：145_payment_batches）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | identity always |  |  |
| batch_no | text |  |  |  |  |  |
| account_id | bigint |  |  |  | bank_accounts |  |
| template | text |  |  |  |  |  |
| status | text |  |  | 'draft'::text |  |  |
| total_cents | bigint |  |  |  |  | 单位：分 |
| item_count | integer |  |  |  |  |  |
| note | text |  |  | ''::text |  |  |
| version | integer |  |  | 1 |  |  |
| client_key | uuid |  |  |  |  |  |
| request_hash | text |  |  |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| exported_by | bigint |  | 是 |  | staff |  |
| exported_at | timestamp with time zone |  | 是 |  |  |  |
| voided_by | bigint |  | 是 |  | staff |  |
| voided_at | timestamp with time zone |  | 是 |  |  |  |
| void_reason | text |  | 是 |  |  |  |
| entity_id | bigint |  |  | yuzu_entity() | legal_entities |  |

### payment_request_targets

没挂合同的申请选的收货单、期初未付与各自金额（退回后改了再提交时整组换掉） （建表：080_payment_requests）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('payment_request_targets_id_seq'::regclass) |  |  |
| request_id | bigint |  |  |  | payment_requests |  |
| receipt_doc_id | bigint |  | 是 |  | inv_docs |  |
| opening_payable_id | bigint |  | 是 |  | opening_payables |  |
| amount_cents | bigint |  |  |  |  | 单位：分 |

### payment_requests

付款申请 （建表：080_payment_requests）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('payment_requests_id_seq'::regclass) |  |  |
| request_no | text |  |  |  |  |  |
| supplier_id | bigint |  | 是 |  | suppliers | 收款方：按应付付款（pay_mode = 'ap'）的要有供应商档案；服务、租赁、其他合同可以没有，收款方写合同的相对方 |
| payee | text |  |  |  |  |  |
| contract_id | bigint |  | 是 |  | contracts | 合同的哪一段（没挂合同的为空，选的收货单 / 期初未付在 payment_request_targets） |
| stage | text |  | 是 |  |  |  |
| pay_mode | text |  |  |  |  | ap：付款登记（进供应商往来，核销到收货单 / 期初未付或记预付款）；direct：在申请上登记合同付款（不进供应商往来） |
| amount_cents | bigint |  |  |  |  | 单位：分 |
| early | boolean |  |  | false |  | 提前付款（P6）：这一段还没到条件、或申请金额超过可付金额，单据类型「提前付款」、要写原因 |
| early_reason | text |  |  | ''::text |  |  |
| expected_date | date |  |  |  |  |  |
| purpose | text |  |  |  |  |  |
| department_id | bigint |  | 是 |  | departments | 审批规则按部门匹配：合同的部门（没挂合同的为空） |
| status | text |  |  | 'submitted'::text |  | submitted 审批中 / returned 已退回（含撤回，可以改了再提交）/ approved 待付款 / paid 已付 / ended 付了一部分、结束 / voided 已作废 |
| returned_reason | text |  | 是 |  |  |  |
| submitted_by | bigint |  |  |  | staff |  |
| submitted_at | timestamp with time zone |  |  | now() |  |  |
| approved_at | timestamp with time zone |  | 是 |  |  |  |
| closed_reason | text |  | 是 |  |  | 结束、作废 |
| closed_by | bigint |  | 是 |  | staff |  |
| closed_at | timestamp with time zone |  | 是 |  |  |  |
| version | integer |  |  | 1 |  | 改内容、改状态的乐观锁 |
| client_key | uuid |  |  |  |  |  |
| request_hash | text |  |  |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| entity_id | bigint |  |  | yuzu_entity() | legal_entities |  |

### payments

浴族 yuzu · 库存与采购（增量迁移，不改动会员与储值数据） 约定： · 数量一律为整数「千分之一库存单位」(*_milli，bigint)，金额一律为整数「分」，不使用浮点数； · 单据行保存当时的单位与换算快照，物料包装变更不会改写历史； （建表：002_inventory）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('payments_id_seq'::regclass) |  |  |
| doc_no | text |  |  |  |  |  |
| supplier_id | bigint |  |  |  | suppliers |  |
| pay_date | date |  |  |  |  |  |
| amount_cents | bigint |  |  |  |  | 单位：分 |
| method | text |  |  |  |  |  |
| evidence | text |  |  | ''::text |  |  |
| note | text |  |  | ''::text |  |  |
| status | text |  |  |  |  |  |
| client_key | uuid |  | 是 |  |  |  |
| is_synthetic | boolean |  |  | false |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| confirmed_by | bigint |  | 是 |  | staff |  |
| confirmed_at | timestamp with time zone |  | 是 |  |  |  |
| returned_reason | text |  | 是 |  |  |  |
| voided_by | bigint |  | 是 |  | staff |  |
| voided_at | timestamp with time zone |  | 是 |  |  |  |
| void_reason | text |  | 是 |  |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| payment_request_id | bigint |  | 是 |  | payment_requests | 付款登记挂申请（按申请登记的付款不再走付款的审批，P7） |
| entity_id | bigint |  |  | yuzu_entity() | legal_entities |  |

### petty_accounts

v0.7.29 ERP 采购五项③（主线）：部门备用金台账（E3，设计见 docs/ERP_PURCHASING.md 第 4 节）。 · 每个部门一行：保管人、定额（可空）、备注；改设置带版本号，两人同时改后保存的被拒； · 余额、在手、待补付、台账都按已有的打款、报销、退回补付算，不另记余额（这张表只放设置）。 （建表：071_petty_accounts）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| department_id | bigint | PK |  |  | departments |  |
| custodian_id | bigint |  | 是 |  | staff |  |
| limit_cents | bigint |  | 是 |  |  | 单位：分 |
| note | text |  |  | ''::text |  |  |
| version | integer |  |  | 1 |  |  |
| updated_by | bigint |  |  |  | staff |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### petty_advances

备用金打款（BY） （建表：026_expenses）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('petty_advances_id_seq'::regclass) |  |  |
| doc_no | text |  |  |  |  |  |
| department_id | bigint |  |  |  | departments |  |
| handler_id | bigint |  |  |  | staff | 经办人：拿这笔钱去采购的人（个人经手的金额按它查） |
| advance_date | date |  |  |  |  |  |
| amount_cents | bigint |  |  |  |  | 单位：分 |
| method | text |  |  |  |  |  |
| evidence | text |  |  |  |  |  |
| note | text |  |  | ''::text |  |  |
| status | text |  |  | 'active'::text |  |  |
| client_key | uuid |  | 是 |  |  |  |
| is_synthetic | boolean |  |  | false |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| voided_by | bigint |  | 是 |  | staff |  |
| voided_at | timestamp with time zone |  | 是 |  |  |  |
| void_reason | text |  | 是 |  |  |  |

### petty_merge_log

2. 并的记录（只追加） （建表：340_petty_merge）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| department_id | bigint | PK |  |  | departments |  |
| advance_id | bigint |  | 是 |  | petty_advances | 迁移给这个部门登记的「并入打款」；没有的为空（这个部门的零采报销改成了公司直付） |
| pool_total_cents | bigint |  |  | 0 |  | 零采备用金的总额（只记在归属部门那一行）与原来的设置；单位：分 |
| pool_settings | jsonb |  | 是 |  |  |  |
| confirmed_cents | bigint |  |  | 0 |  | 这个部门已确认的零采报销合计（并入打款里包含它）；单位：分 |
| petty_claim_ids | bigint[] |  |  | '{}'::bigint[] |  | 改成「备用金」的、改成「公司直付」的零采报销单 |
| company_claim_ids | bigint[] |  |  | '{}'::bigint[] |  |  |
| uses | integer |  |  | 0 |  | 记到这个部门的申用笔数、并之前的定额（回滚改回去） |
| limit_before_cents | bigint |  | 是 |  |  | 单位：分 |
| had_account | boolean |  |  | false |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### petty_settlements

退回（TH，经办人退给公司）/ 补付（BF，公司补给经办人） （建表：026_expenses）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('petty_settlements_id_seq'::regclass) |  |  |
| doc_no | text |  |  |  |  |  |
| advance_id | bigint |  |  |  | petty_advances |  |
| kind | text |  |  |  |  |  |
| settle_date | date |  |  |  |  |  |
| amount_cents | bigint |  |  |  |  | 单位：分 |
| method | text |  |  |  |  |  |
| evidence | text |  |  |  |  |  |
| note | text |  |  | ''::text |  |  |
| status | text |  |  | 'active'::text |  |  |
| client_key | uuid |  | 是 |  |  |  |
| is_synthetic | boolean |  |  | false |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| voided_by | bigint |  | 是 |  | staff |  |
| voided_at | timestamp with time zone |  | 是 |  |  |  |
| void_reason | text |  | 是 |  |  |  |

### petty_uses

8.1.9 零采备用金（docs/ERP_V819.md 第 2 节，PENDING_DECISIONS「8.1.9」BJ1–BJ8）。 （建表：182_petty_pool）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('petty_uses_id_seq'::regclass) |  |  |
| doc_no | text |  |  |  |  |  |
| use_date | date |  |  |  |  |  |
| applicant_id | bigint |  |  |  | staff |  |
| purpose | text |  |  |  |  | 用途说明、采购内容 |
| content | text |  |  |  |  |  |
| amount_cents | bigint |  |  |  |  | 单位：分 |
| note | text |  |  | ''::text |  |  |
| claim_state | text |  |  | 'open'::text |  | 报销：open 还没提交，submitted 供应链已提交、等财务登记报销单 |
| backfill | text |  | 是 |  |  | 补单：pending 未补单，done 已补单（要有采购单）；提交报销时必填，之后可以改 |
| purchase_order_id | bigint |  | 是 |  | purchase_orders |  |
| submit_note | text |  |  | ''::text |  |  |
| submitted_by | bigint |  | 是 |  | staff |  |
| submitted_at | timestamp with time zone |  | 是 |  |  |  |
| status | text |  |  | 'active'::text |  |  |
| voided_by | bigint |  | 是 |  | staff |  |
| voided_at | timestamp with time zone |  | 是 |  |  |  |
| void_reason | text |  | 是 |  |  |  |
| client_key | uuid |  |  |  |  |  |
| is_synthetic | boolean |  |  | false |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| version | integer |  |  | 1 |  |  |
| department_id | bigint |  |  |  | departments | 申用记在哪个部门的备用金上（下面按数据补上，之后不能为空） |

### platform_recon_issues

8.0.21 平台验券（docs/INTEGRATIONS_V8021.md 第 3 节，CW-H / CW8）：美团、抖音各一个适配器，验券即核销。 8.0.21 只有接口与模拟实现（CW22），正式实现等平台应用联调；平台不通时照旧手输（不验券）、补录照旧。 （建表：149_platform_verify）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('platform_recon_issues_id_seq'::regclass) |  |  |
| run_id | bigint |  |  |  | platform_recon_runs |  |
| platform | text |  |  |  |  |  |
| business_date | date |  |  |  |  |  |
| kind | text |  |  |  |  |  |
| code | text |  |  |  |  |  |
| deal_name | text |  |  | ''::text |  |  |
| platform_cents | bigint |  | 是 |  |  | 单位：分 |
| system_cents | bigint |  | 是 |  |  | 单位：分 |
| system_ref | text |  |  | ''::text |  |  |
| resolved_by | bigint |  | 是 |  | staff |  |
| resolved_at | timestamp with time zone |  | 是 |  |  |  |
| resolve_note | text |  | 是 |  |  |  |

### platform_recon_runs

每天对账 （建表：149_platform_verify）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('platform_recon_runs_id_seq'::regclass) |  |  |
| platform | text |  |  |  |  |  |
| business_date | date |  |  |  |  |  |
| adapter | text |  |  |  |  |  |
| ok | boolean |  |  |  |  |  |
| error | text |  | 是 |  |  |  |
| platform_lines | integer |  |  | 0 |  |  |
| system_lines | integer |  |  | 0 |  |  |
| issues | integer |  |  | 0 |  |  |
| staff_id | bigint |  | 是 |  | staff | 自动（每天）还是有人点了「重新对账」 |
| created_at | timestamp with time zone |  |  | now() |  |  |

### platform_redemptions

v0.7.28 ⑤（主线）：第三方平台核销补录（设计见 docs/SCHEDULE_FINISH.md 第 6 节，N6 待确认）。 · platform_redemptions：已在平台 App（美团、大众点评、抖音等）核销、没有经过前台结账的券，补登记一笔：券码、项目、面值、 平台应结给门店的金额、核销时刻； （建表：055_platform_redemptions）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('platform_redemptions_id_seq'::regclass) |  |  |
| redemption_no | text |  |  |  |  |  |
| platform | text |  |  |  |  |  |
| code | text |  |  |  |  |  |
| deal_name | text |  |  | ''::text |  |  |
| face_value | bigint |  |  |  |  | 面值（顾客在平台付的）与平台应结给门店的（扣佣金后；不知道时按面值） |
| settle_amount | bigint |  |  |  |  |  |
| guests | integer |  |  | 1 |  |  |
| redeemed_at | timestamp with time zone |  |  |  |  | 在平台 App 核销的时刻与它所在的营业日 |
| business_date | date |  |  |  |  |  |
| note | text |  |  | ''::text |  |  |
| status | text |  |  | 'active'::text |  |  |
| registered_by | bigint |  |  |  | staff |  |
| registered_at | timestamp with time zone |  |  | now() |  |  |
| client_key | uuid |  |  |  |  |  |
| request_hash | text |  |  |  |  |  |
| voided_by | bigint |  | 是 |  | staff |  |
| voided_at | timestamp with time zone |  | 是 |  |  |  |
| void_reason | text |  | 是 |  |  |  |

### platform_settlements

v0.7.28 ⑤（主线）：第三方平台核销补录（设计见 docs/SCHEDULE_FINISH.md 第 6 节，N6 待确认）。 · platform_redemptions：已在平台 App（美团、大众点评、抖音等）核销、没有经过前台结账的券，补登记一笔：券码、项目、面值、 平台应结给门店的金额、核销时刻； （建表：055_platform_redemptions）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('platform_settlements_id_seq'::regclass) |  |  |
| settlement_no | text |  |  |  |  |  |
| platform | text |  |  |  |  |  |
| period_from | date |  |  |  |  |  |
| period_to | date |  |  |  |  |  |
| amount | bigint |  |  |  |  |  |
| received_on | date |  |  |  |  |  |
| ref | text |  |  | ''::text |  |  |
| note | text |  |  | ''::text |  |  |
| status | text |  |  | 'active'::text |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| client_key | uuid |  |  |  |  |  |
| request_hash | text |  |  |  |  |  |
| voided_by | bigint |  | 是 |  | staff |  |
| voided_at | timestamp with time zone |  | 是 |  |  |  |
| void_reason | text |  | 是 |  |  |  |

### platform_verifications

8.0.21 平台验券（docs/INTEGRATIONS_V8021.md 第 3 节，CW-H / CW8）：美团、抖音各一个适配器，验券即核销。 8.0.21 只有接口与模拟实现（CW22），正式实现等平台应用联调；平台不通时照旧手输（不验券）、补录照旧。 （建表：149_platform_verify）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('platform_verifications_id_seq'::regclass) |  |  |
| platform | text |  |  |  |  |  |
| code | text |  |  |  |  |  |
| deal_name | text |  |  | ''::text |  |  |
| face_cents | bigint |  |  |  |  | 面值（这几份合计，结账抵扣的就是它）与平台应结给门店的；单位：分 |
| settle_cents | bigint |  |  |  |  | 单位：分 |
| quantity | integer |  |  | 1 |  |  |
| adapter | text |  |  |  |  |  |
| status | text |  |  | 'verifying'::text |  |  |
| verify_no | text |  | 是 |  |  |  |
| fail_reason | text |  | 是 |  |  |  |
| group_buy_coupon_id | bigint |  | 是 |  | group_buy_coupons |  |
| redemption_id | bigint |  | 是 |  | platform_redemptions |  |
| business_date | date |  |  |  |  |  |
| client_key | uuid |  |  |  |  |  |
| request_hash | text |  |  |  |  |  |
| staff_id | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| verified_at | timestamp with time zone |  | 是 |  |  |  |
| cancel_reason | text |  | 是 |  |  |  |
| cancelled_by | bigint |  | 是 |  | staff |  |
| cancelled_at | timestamp with time zone |  | 是 |  |  |  |

### po_match_releases

三单放行（只追加）：放行时的采购单金额、已收货（减退货）、已开票；三个金额都没变才算放行有效 （建表：081_three_way_match）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('po_match_releases_id_seq'::regclass) |  |  |
| purchase_order_id | bigint |  |  |  | purchase_orders |  |
| po_total_cents | bigint |  |  |  |  | 单位：分 |
| received_cents | bigint |  |  |  |  | 单位：分 |
| invoiced_cents | bigint |  |  |  |  | 单位：分 |
| reason | text |  |  |  |  |  |
| client_key | uuid |  |  |  |  |  |
| request_hash | text |  |  |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### po_supplier_confirmations

订单确认：一张采购单只认第一次确认（确认以后不再发确认链接；到货日有变的，供应商在发货预告里写预计到货日） （建表：147_supplier_links）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('po_supplier_confirmations_id_seq'::regclass) |  |  |
| purchase_order_id | bigint |  |  |  | purchase_orders |  |
| link_id | bigint |  |  |  | supplier_links |  |
| reply_id | bigint |  |  |  | supplier_link_replies |  |
| promised_date | date |  |  |  |  |  |
| reply_name | text |  |  |  |  |  |
| note | text |  |  | ''::text |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| po_revision | integer |  |  |  |  |  |

### position_catalog

8.2.0 P04（回测 5-2，docs/YUZU_REQ_V820.md 第 5 节，RT9–RT12）：岗位职权数据重建。 （建表：201_position_catalog）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| key | text | PK |  |  |  |  |
| department | text |  |  |  | org_departments |  |
| title | text |  |  |  |  |  |
| level | text |  |  |  |  |  |
| sort | integer |  |  |  |  |  |
| all_permissions | boolean |  |  | false |  | 总裁：固定拥有全部权限，没有建议权限这一说 |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| updated_by | bigint |  | 是 |  | staff |  |

### position_config_log

8.2.0 P04（回测 5-2，docs/YUZU_REQ_V820.md 第 5 节，RT9–RT12）：岗位职权数据重建。 （建表：201_position_catalog）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('position_config_log_id_seq'::regclass) |  |  |
| at | timestamp with time zone |  |  | now() |  |  |
| staff_id | bigint |  | 是 |  | staff |  |
| action | text |  |  |  |  |  |
| position_key | text |  | 是 |  | position_catalog |  |
| detail | jsonb |  |  | '{}'::jsonb |  |  |

### position_suggestions

8.2.0 P04（回测 5-2，docs/YUZU_REQ_V820.md 第 5 节，RT9–RT12）：岗位职权数据重建。 （建表：201_position_catalog）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| position_key | text | PK |  |  | position_catalog |  |
| permission | text | PK |  |  |  |  |

### purchase_order_line_images

飞书需求 RQ-005「采购与费用闭环」第二步（v0.7.8，见 docs/REQUISITIONS.md）： ① 部门采购需求单（XQ）：新职责「部门申购」，员工档案加所属部门；采购审核后转采购单，下单 / 到货 / 退货由采购单与收货单算出。 （建表：027_requisitions）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| po_line_id | bigint | PK |  |  | purchase_order_lines |  |
| sort_no | integer | PK |  |  |  |  |
| image_id | bigint |  |  |  | erp_images |  |

### purchase_order_line_requests

采购单的一行可以合并几行需求（几个部门要同一种物料）；一行需求最多对应一行有效的采购单行 （撤回的采购单不算；转采购单时锁需求单再核对，自检兜底） （建表：027_requisitions）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| po_line_id | bigint | PK |  |  | purchase_order_lines |  |
| request_line_id | bigint | PK |  |  | purchase_request_lines |  |

### purchase_order_lines

浴族 yuzu · 库存与采购（增量迁移，不改动会员与储值数据） 约定： · 数量一律为整数「千分之一库存单位」(*_milli，bigint)，金额一律为整数「分」，不使用浮点数； · 单据行保存当时的单位与换算快照，物料包装变更不会改写历史； （建表：002_inventory）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('purchase_order_lines_id_seq'::regclass) |  |  |
| po_id | bigint |  |  |  | purchase_orders |  |
| line_no | integer |  |  |  |  |  |
| material_id | bigint |  |  |  | materials |  |
| purchase_qty_milli | bigint |  |  |  |  |  |
| purchase_unit | text |  |  |  |  |  |
| inventory_unit | text |  |  |  |  |  |
| factor_milli | bigint |  |  |  |  |  |
| base_qty_milli | bigint |  |  |  |  |  |
| price_cents | bigint |  |  |  |  | 每采购单位；单位：分 |
| amount_cents | bigint |  |  |  |  | 单位：分 |
| note | text |  |  | ''::text |  |  |
| spec | text |  |  | ''::text |  | 采购单的行：规格、图片、来自哪几行需求 |

### purchase_order_revisions

采购单每次关键内容变更都保留上一版本 （建表：002_inventory）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('purchase_order_revisions_id_seq'::regclass) |  |  |
| po_id | bigint |  |  |  | purchase_orders |  |
| revision | integer |  |  |  |  |  |
| snapshot | jsonb |  |  |  |  |  |
| changed_by | bigint |  |  |  | staff |  |
| changed_at | timestamp with time zone |  |  | now() |  |  |

### purchase_orders

采购单 （建表：002_inventory）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('purchase_orders_id_seq'::regclass) |  |  |
| doc_no | text |  |  |  |  |  |
| supplier_id | bigint |  |  |  | suppliers |  |
| status | text |  |  |  |  |  |
| order_date | date |  |  |  |  |  |
| expected_date | date |  | 是 |  |  |  |
| note | text |  |  | ''::text |  |  |
| total_cents | bigint |  |  | 0 |  | 单位：分 |
| revision | integer |  |  | 1 |  |  |
| backfill | boolean |  |  | false |  | 先收货后补单：补单关联已有收货，不会再次入库或形成应付 |
| client_key | uuid |  | 是 |  |  |  |
| is_synthetic | boolean |  |  | false |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| submitted_by | bigint |  | 是 |  | staff |  |
| submitted_at | timestamp with time zone |  | 是 |  |  |  |
| approved_by | bigint |  | 是 |  | staff |  |
| approved_at | timestamp with time zone |  | 是 |  |  |  |
| returned_reason | text |  | 是 |  |  |  |
| closed_by | bigint |  | 是 |  | staff |  |
| closed_at | timestamp with time zone |  | 是 |  |  |  |
| close_reason | text |  | 是 |  |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| price_basis | text |  |  | ''::text |  | 价格口径随单据留存（例如「含税到货价」）：比价只比较同一口径 |
| backfill_receipt_id | bigint |  | 是 |  | inv_docs | 先收货后补单：补单采购单指向原收货单；确认后只关联，不再入库或形成应付 |
| channel | text |  | 是 |  |  |  |
| channel_label | text |  | 是 |  |  |  |
| channel_note | text |  |  | ''::text |  |  |
| sourcing_event_id | bigint |  | 是 |  | sourcing_events |  |
| contract_id | bigint |  | 是 |  | contracts |  |
| contract_note | text |  |  | ''::text |  |  |
| contract_added_by | bigint |  | 是 |  | staff |  |
| contract_added_at | timestamp with time zone |  | 是 |  |  |  |

### purchase_request_imports

集采导入（06）：一次导入一条；同一份文件（按内容摘要）只能导入一次 （建表：082_purchasing_flow）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('purchase_request_imports_id_seq'::regclass) |  |  |
| client_key | uuid |  |  |  |  |  |
| file_sha256 | text |  |  |  |  |  |
| file_name | text |  |  | ''::text |  |  |
| row_count | integer |  |  |  |  |  |
| request_count | integer |  |  |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| kind | text |  |  | 'bulk'::text |  |  |
| skipped_count | integer |  |  | 0 |  |  |

### purchase_request_line_images

飞书需求 RQ-005「采购与费用闭环」第二步（v0.7.8，见 docs/REQUISITIONS.md）： ① 部门采购需求单（XQ）：新职责「部门申购」，员工档案加所属部门；采购审核后转采购单，下单 / 到货 / 退货由采购单与收货单算出。 （建表：027_requisitions）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| request_line_id | bigint | PK |  |  | purchase_request_lines |  |
| sort_no | integer | PK |  |  |  |  |
| image_id | bigint |  |  |  | erp_images |  |

### purchase_request_lines

飞书需求 RQ-005「采购与费用闭环」第二步（v0.7.8，见 docs/REQUISITIONS.md）： ① 部门采购需求单（XQ）：新职责「部门申购」，员工档案加所属部门；采购审核后转采购单，下单 / 到货 / 退货由采购单与收货单算出。 （建表：027_requisitions）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('purchase_request_lines_id_seq'::regclass) |  |  |
| request_id | bigint |  |  |  | purchase_requests |  |
| line_no | integer |  |  |  |  |  |
| material_id | bigint |  | 是 |  | materials | 已有物料就选物料；新产品写名称（必须有参考链接和图片） |
| name | text |  |  |  |  |  |
| purpose | text |  |  |  |  |  |
| qty_milli | bigint |  |  |  |  |  |
| unit | text |  |  |  |  |  |
| link | text |  |  | ''::text |  |  |
| details | text |  |  | ''::text |  |  |
| ref_price_cents | bigint |  | 是 |  |  | 单位：分 |
| note | text |  |  | ''::text |  |  |
| applicant | text |  |  | ''::text |  |  |
| channel | text |  | 是 |  |  |  |
| supplier_id | bigint |  | 是 |  | suppliers |  |
| mall_sku_code | text |  |  | ''::text |  |  |
| price_version | text |  |  | ''::text |  |  |
| brand_model | text |  |  | ''::text |  |  |
| expected_category | text |  |  | ''::text |  |  |
| reason_text | text |  |  | ''::text |  |  |
| freight_cents | bigint |  | 是 |  |  | 单位：分 |
| tax_rate_bp | integer |  | 是 |  |  |  |
| custom_kind | text |  | 是 |  |  | 商城自主申请：standard 非定制（现成品）/ custom 定制；选品的行为空（8.1.51） |
| custom_spec | jsonb |  | 是 |  |  | 定制的结构化要求：size 尺寸规格、craft 材质工艺、scene 使用场景、sample 是否打样、budgetCents 预算（8.1.51） |

### purchase_request_progress_marks

进度变动记号（Codex 审查）：采购单改版时解开了与需求行的关联（purchase_order_line_requests 删行；询价的关联只追加，不会删）， 需求单本身不变，跟着关联算的「进度最后变动时刻」会往回走，增量同步（updatedSince）就漏了这张单。删关联时记一笔，只追加。 （建表：270_mall_integration）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('purchase_request_progress_marks_id_seq'::regclass) |  |  |
| request_id | bigint |  |  |  | purchase_requests |  |
| at | timestamp with time zone |  |  | clock_timestamp() |  |  |

### purchase_request_versions

商城需求单每次提交的完整版本快照（8.2.6）：V1、V2……只读可查

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| request_id | bigint | PK |  |  | purchase_requests |  |
| version_no | integer | PK |  |  |  |  |
| snapshot | jsonb |  |  |  |  |  |
| mode | text |  |  |  |  | submit 第一次提交；fix 只补必补项；rewrite 重新填写；baseline 升级前已提交的单第一次补资料时补记的原版本 |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### purchase_requests

部门采购需求单 （建表：027_requisitions）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('purchase_requests_id_seq'::regclass) |  |  |
| doc_no | text |  |  |  |  |  |
| department_id | bigint |  |  |  | departments |  |
| requester_id | bigint |  |  |  | staff |  |
| need_by | date |  | 是 |  |  |  |
| note | text |  |  | ''::text |  |  |
| status | text |  |  |  |  | submitted 待审核；returned 退回待修改；approved 已通过（可以转采购单）；rejected 不采购；cancelled 已撤回 |
| client_key | uuid |  | 是 |  |  |  |
| is_synthetic | boolean |  |  | false |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| reviewed_by | bigint |  | 是 |  | staff |  |
| reviewed_at | timestamp with time zone |  | 是 |  |  |  |
| reason | text |  | 是 |  |  | 退回、不采购、撤回的原因 |
| priority | text |  |  | 'normal'::text |  |  |
| submitted_at | timestamp with time zone |  |  | now() |  |  |
| approvable_on | date |  | 是 |  |  |  |
| source | text |  |  | 'form'::text |  |  |
| import_id | bigint |  | 是 |  | purchase_request_imports |  |
| dept_confirm | text |  |  | 'none'::text |  |  |
| dept_head_id | bigint |  | 是 |  | staff |  |
| dept_confirmed_by | bigint |  | 是 |  | staff |  |
| dept_confirmed_at | timestamp with time zone |  | 是 |  |  |  |
| stock_check | text |  |  | 'none'::text |  |  |
| stock_check_since | timestamp with time zone |  | 是 |  |  |  |
| stock_checked_by | bigint |  | 是 |  | staff |  |
| stock_checked_at | timestamp with time zone |  | 是 |  |  |  |
| external_no | text |  | 是 |  |  |  |
| contact_name | text |  |  | ''::text |  |  |
| store_id | bigint |  | 是 |  | stores |  |
| entity_id | bigint |  | 是 |  | legal_entities |  |
| budget_project | text |  |  | ''::text |  |  |
| delivery_address | text |  |  | ''::text |  |  |
| payment_intent | text |  | 是 |  |  |  |

### receipt_imports

8.1.9 库管入库（docs/ERP_V819.md 第 3 节，PENDING_DECISIONS「8.1.9」KR1–KR6）。 收货单加一个标记 direct：与按采购单收货一样（确认入库、成本、挂账供应商记应付、冲销、退供应商、补采购单），只是不选采购单。 （建表：183_direct_receipts）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('receipt_imports_id_seq'::regclass) |  |  |
| client_key | uuid |  |  |  |  |  |
| file_sha256 | text |  |  |  |  |  |
| file_name | text |  |  |  |  |  |
| row_count | integer |  |  |  |  |  |
| doc_count | integer |  |  |  |  |  |
| amount_cents | bigint |  |  |  |  | 单位：分 |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### recharge_plans

充值套餐与消费项目 （建表：001_init）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('recharge_plans_id_seq'::regclass) |  |  |
| name | text |  |  |  |  |  |
| pay_amount | bigint |  |  |  |  |  |
| bonus_amount | bigint |  |  | 0 |  |  |
| note | text |  |  | ''::text |  |  |
| active | boolean |  |  | true |  |  |
| sort_order | integer |  |  | 0 |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| bonus_valid_days | integer |  | 是 |  |  |  |

### recharges

充值单：收款确认后才会生成 （建表：001_init）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('recharges_id_seq'::regclass) |  |  |
| doc_no | text |  |  |  |  |  |
| member_id | bigint |  |  |  | members |  |
| plan_id | bigint |  | 是 |  | recharge_plans |  |
| plan_name | text |  | 是 |  |  |  |
| paid_amount | bigint |  |  |  |  | 实收金额，等额计入本金 |
| bonus_amount | bigint |  |  |  |  | 赠金 |
| payment_method | text |  |  |  |  |  |
| payment_ref | text |  |  | ''::text |  |  |
| note | text |  |  | ''::text |  |  |
| business_date | date |  |  |  |  |  |
| operator_id | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| over_limit_approved_by | bigint |  | 是 |  | staff |  |
| bonus_expires_at | timestamp with time zone |  | 是 |  |  | 充值时确定的赠金到期时间（到期那个营业日开始时作废）；没有赠金或不设有效期时为空 |
| shift_id | bigint |  | 是 |  | shifts | 充值单只追加：班次在入账时写入 |
| channel | text |  |  | 'counter'::text |  | ③ 线上收款入口（小程序第二期） 充值单的渠道：前台 counter、小程序 mp。小程序的不进任何班次，按微信交易单号（收款备注）去重 |
| pay_tx_id | bigint |  | 是 |  | pay_transactions |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |

### recon_links

8.0.7 供应链收尾 2.6（docs/ERP_V807.md）：供应商在线对账确认。 对账登记（月结或按批次）以后可以生成「对账确认链接」（有效 N 天，V10，默认 14 天）发给供应商； 供应商打开（不用登录）看这一期的对账单（生成链接时的快照），点「确认无误」或「有异议」（写原因、留姓名），只能回一次。 （建表：100_recon_links）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('recon_links_id_seq'::regclass) |  |  |
| reconciliation_id | bigint |  |  |  | supplier_reconciliations |  |
| token_hash | text |  |  |  |  |  |
| snapshot | jsonb |  |  |  |  |  |
| expires_at | timestamp with time zone |  |  |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| voided_by | bigint |  | 是 |  | staff |  |
| voided_at | timestamp with time zone |  | 是 |  |  |  |
| reply | text |  | 是 |  |  | 供应商的回复 |
| reply_name | text |  | 是 |  |  |  |
| reply_note | text |  |  | ''::text |  |  |
| replied_at | timestamp with time zone |  | 是 |  |  |  |
| reply_ip | text |  | 是 |  |  |  |

### refund_items

退的项目：结账单部门营业额快照里的一项（同名项目合并成一行），只追加 （建表：037_refunds_coupons）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| refund_id | bigint | PK |  |  | refunds |  |
| checkout_id | bigint |  |  |  | checkout_items |  |
| category | text | PK |  |  | checkout_items |  |
| name | text | PK |  |  | checkout_items |  |
| quantity | integer |  |  |  |  | 退的份数，可以是 0（只退钱、不退份数） |
| amount | bigint |  |  |  |  |  |

### refund_payments

退款方式：只退原单收过的现金类方式；扫码、银行卡登记商户后台的退款单号，「其他」写明怎么退的 （建表：037_refunds_coupons）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('refund_payments_id_seq'::regclass) |  |  |
| refund_id | bigint |  |  |  | refunds |  |
| method | text |  |  |  |  |  |
| amount | bigint |  |  |  |  |  |
| ref | text |  |  | ''::text |  |  |
| via_terminal | boolean |  |  | false |  | 退款单的一行是原路退回的 |

### refunds

① 退款单 （建表：037_refunds_coupons）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('refunds_id_seq'::regclass) |  |  |
| refund_no | text |  |  |  |  |  |
| checkout_id | bigint |  |  |  | checkouts |  |
| client_key | uuid |  |  |  |  |  |
| amount | bigint |  |  |  |  |  |
| reason | text |  |  |  |  |  |
| business_date | date |  |  |  |  |  |
| operator_id | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  |  |  |  |
| shift_id | bigint |  | 是 |  | shifts | 记到哪个班次：退现金时是所选钱箱当班的班次，否则是经办人当班的班次；没有开班（规则关闭时）为空 |
| status | text |  |  | 'completed'::text |  |  |
| voided_at | timestamp with time zone |  | 是 |  |  |  |
| voided_by | bigint |  | 是 |  | staff |  |
| void_reason | text |  | 是 |  |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |

### replenish_runs

8.0.20 自动补货（docs/ERP_V8020.md 第 3 节，JX-D / JX5 / JX10）：每天过了设定的时间，把「补货建议」里有供应商的行 按供应商各建一张采购单草稿（不提交）。这张表一天一行：当天跑没跑过、建了哪几张草稿、有几样缺供应商。 草稿算在途，第二天不会重复建议； （建表：129_replenish_runs）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| run_date | date | PK |  |  |  |  |
| status | text |  |  | 'running'::text |  |  |
| po_ids | bigint[] |  |  | '{}'::bigint[] |  |  |
| line_count | integer |  |  | 0 |  |  |
| skipped_no_supplier | integer |  |  | 0 |  | 建议里没有供应商（物料没设默认供应商、也没收过货）的行数：要人先选供应商 |
| error | text |  | 是 |  |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| finished_at | timestamp with time zone |  | 是 |  |  |  |

### request_fix_items

退回补资料的「本次必补」（8.2.6）：退回时逐项标出要补什么，补齐重提时记下补的内容；多轮退回各自一轮

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('request_fix_items_id_seq'::regclass) |  |  |
| request_id | bigint |  |  |  | purchase_requests |  |
| round | integer |  |  |  |  |  |
| request_line_id | bigint |  | 是 |  | purchase_request_lines |  |
| line_label | text |  |  | ''::text |  | 退回时那一行的名称（行删了也看得到是哪一行） |
| field_key | text |  |  |  |  | 要补的项（src/shared/mall-fix.ts 的 MALL_FIX_FIELDS） |
| original_value | text |  |  | ''::text |  | 退回时原来填的（补资料页灰字回显） |
| requirement | text |  |  |  |  |  |
| supplied_value | text |  | 是 |  |  |  |
| returned_by | bigint |  |  |  | staff |  |
| returned_at | timestamp with time zone |  |  | now() |  |  |
| resolved_at | timestamp with time zone |  | 是 |  |  |  |

### request_line_issues

物料发配记录（8.2.6）：需求行每一次给到部门的数量与领料单；stock 核库时领用，arrival 到货后补发

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('request_line_issues_id_seq'::regclass) |  |  |
| request_line_id | bigint |  |  |  | purchase_request_lines |  |
| request_id | bigint |  |  |  | purchase_requests |  |
| department_id | bigint |  |  |  | departments |  |
| inv_doc_id | bigint |  |  |  | inv_docs | 开的部门领料单（作废了的这一条不算已发配） |
| qty_milli | bigint |  |  |  |  | 这一次发配的数量（需求行的单位，千分之一） |
| kind | text |  |  |  |  | stock 核库时从库存发；arrival 采购到货后在物料发配记录里补发 |
| note | text |  |  | ''::text |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### request_line_stock

8.1.10 核库转领用（docs/ERP_V8110.md 第 2 节，PENDING_DECISIONS CK8–CK17） · 需求单的核库状态：none 不用核 / 还没到（等部门主管确认）；pending 待核库；confirming 待部门确认替代； done 核完； （建表：185_stock_check）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| request_line_id | bigint | PK |  |  | purchase_request_lines |  |
| request_id | bigint |  |  |  | purchase_requests |  |
| decision | text |  |  |  |  | issue 领用（可以只领一部分，剩下的转采购）；substitute 提议替代品（等部门确认）；purchase 转采购 |
| issued_qty_milli | bigint |  |  | 0 |  | 领用了多少（需求单这一行的单位，千分之一）：整行领用时等于申请数量；替代同意以后也记整行 |
| substitute_material_id | bigint |  | 是 |  | materials | 替代：库管提议的物料与数量（库存单位，千分之一） |
| substitute_qty_milli | bigint |  | 是 |  |  |  |
| substitute_state | text |  | 是 |  |  | 替代的答复：pending 等部门；accepted 同意（开了领料单）；declined 不用、照原来买；expired 超时没回；failed 同意时总仓不够了 |
| inv_doc_id | bigint |  | 是 |  | inv_docs | 开的部门领料单（领用的、替代同意了的） |
| decided_by | bigint |  |  |  | staff |  |
| decided_at | timestamp with time zone |  |  | now() |  |  |
| answered_by | bigint |  | 是 |  | staff |  |
| answered_at | timestamp with time zone |  | 是 |  |  |  |

### request_terminations

终止申购（8.2.6）：提单人申请、部门负责人或供应链 BP 确认；确认后需求单定为已撤回（显示「已终止」）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| request_id | bigint | PK |  |  | purchase_requests |  |
| reason | text |  |  |  |  |  |
| status | text |  |  |  |  |  |
| requested_by | bigint |  |  |  | staff |  |
| requested_at | timestamp with time zone |  |  | now() |  |  |
| decided_by | bigint |  | 是 |  | staff |  |
| decided_at | timestamp with time zone |  | 是 |  |  |  |
| decide_note | text |  |  | ''::text |  |  |

### reversals

撤销单：对原消费整单撤销，一张消费单最多一张撤销单 （建表：001_init）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('reversals_id_seq'::regclass) |  |  |
| doc_no | text |  |  |  |  |  |
| consumption_id | bigint |  |  |  | consumptions |  |
| member_id | bigint |  |  |  | members |  |
| principal_amount | bigint |  |  |  |  |  |
| bonus_amount | bigint |  |  |  |  |  |
| reason | text |  |  |  |  |  |
| business_date | date |  |  |  |  |  |
| operator_id | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |

### room_audits

夜审记录（只追加）：可以重复做，每次记一行 （建表：024_rooms）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('room_audits_id_seq'::regclass) |  |  |
| business_date | date |  |  |  |  |  |
| nights | integer |  |  |  |  |  |
| amount | integer |  |  |  |  |  |
| run_by | bigint |  |  |  | staff |  |
| run_at | timestamp with time zone |  |  | now() |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |

### room_categories

① 房型 （建表：190_room_center）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('room_categories_id_seq'::regclass) |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| name | text |  |  |  |  |  |
| source | text |  |  |  |  |  |
| business_types | text[] |  |  | '{}'::text[] |  | 管空间台账里的哪几种业态（spaces.business_type）；同一种业态同时只在一个在用的房型里（代码在锁里核对） |
| sort_order | integer |  |  | 0 |  |  |
| active | boolean |  |  | true |  |  |
| version | integer |  |  | 1 |  |  |
| created_by | bigint |  | 是 |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_by | bigint |  | 是 |  | staff |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### room_deposits

押金台账（只追加） 每种收款方式的余额 = 收 − 退，不能为负（服务端保证，自检核对）；退房、撤销入住之后为 0。 收、退都记经办人当班的班次（现金押金计入交班应有现金）。「其他」收的押金要写明收的是什么；退的写原因 （建表：024_rooms）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('room_deposits_id_seq'::regclass) |  |  |
| stay_id | bigint |  |  |  | room_stays |  |
| kind | text |  |  |  |  |  |
| method | text |  |  |  |  |  |
| amount | integer |  |  |  |  |  |
| ref | text |  |  | ''::text |  |  |
| reason | text |  | 是 |  |  |  |
| shift_id | bigint |  | 是 |  | shifts |  |
| business_date | date |  |  |  |  |  |
| operator_id | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### room_fee_charges

福田店整改后续（店主 2026-11-26 定：房费只在收银台收，docs/FUTIAN_1126.md）：房间按时间计费的房费在客人收银台结账时按时间算、挂到账单上， 这里记哪一张登记单的房费记在了哪一行明细上（一张登记单只收一次；那一行被作废了——反结账、退菜——下次结账再算）。只追加。 （建表：472_room_fee_charges）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('room_fee_charges_id_seq'::regclass) |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| registration_id | bigint |  |  |  | room_registrations |  |
| bill_line_id | bigint |  |  |  | bill_lines |  |
| amount | integer |  |  |  |  |  |
| starts_at | timestamp with time zone |  |  |  |  | 计费的时间段与分钟数（显示与对账用的快照） |
| ends_at | timestamp with time zone |  |  |  |  |  |
| charged_minutes | integer |  |  |  |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### room_housekeeping_events

8.0.8 前台整改 · 客房与派对房（docs/FRONTDESK_V808.md 第 3、4、6 节）： ① 预约到店入住（A04）：入住单记预约编号，一张预约只能有一张没撤销的入住单（部分唯一索引兜底）。 ② 房态记录（B04）：每次改房态记一条（手动改、撤回、入住退房换房撤销时自动改），只追加； （建表：108_rooms_v808）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('room_housekeeping_events_id_seq'::regclass) |  |  |
| room_id | bigint |  |  |  | rooms |  |
| from_state | text |  |  |  |  |  |
| to_state | text |  |  |  |  |  |
| note | text |  |  | ''::text |  |  |
| source | text |  |  |  |  | manual 手动改 / revert 撤回上一次手动修改 / auto 入住、退房、换房、撤销入住时自动改 |
| reverts_id | bigint |  | 是 |  | room_housekeeping_events |  |
| ref | text |  |  | ''::text |  | 自动改的那张入住单号 |
| staff_id | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### room_moves

换房记录（只追加）：账单跟着入住单走 （建表：024_rooms）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('room_moves_id_seq'::regclass) |  |  |
| stay_id | bigint |  |  |  | room_stays |  |
| from_room_id | bigint |  |  |  | rooms |  |
| to_room_id | bigint |  |  |  | rooms |  |
| reason | text |  |  |  |  |  |
| operator_id | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### room_order_lines

8.2.0 P07（回测 3-1，docs/YUZU_REQ_V820.md 第 8 节，RT15 起）：房态中心「在用」的房间直接点水吧、果吧。 下单照旧是挂账（来访 → 账单 → 沽清 → 出品单，frontdesk/bills.ts 的 postChargesTx），出品单上写送到哪间房； （建表：202_room_orders）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| room_order_id | bigint | PK |  |  | room_orders |  |
| bill_line_id | bigint | PK |  |  | bill_lines |  |

### room_order_outlets

8.2.0 P07（回测 3-1，docs/YUZU_REQ_V820.md 第 8 节，RT15 起）：房态中心「在用」的房间直接点水吧、果吧。 下单照旧是挂账（来访 → 账单 → 沽清 → 出品单，frontdesk/bills.ts 的 postChargesTx），出品单上写送到哪间房； （建表：202_room_orders）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| store_id | bigint | PK |  | yuzu_store() | stores |  |
| outlet | text | PK |  |  |  |  |
| categories | text[] |  | 是 |  |  | 能点的分类；空值为全部 |
| updated_by | bigint |  | 是 |  | staff |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### room_orders

8.2.0 P07（回测 3-1，docs/YUZU_REQ_V820.md 第 8 节，RT15 起）：房态中心「在用」的房间直接点水吧、果吧。 下单照旧是挂账（来访 → 账单 → 沽清 → 出品单，frontdesk/bills.ts 的 postChargesTx），出品单上写送到哪间房； （建表：202_room_orders）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('room_orders_id_seq'::regclass) |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| op_key | uuid |  |  |  |  |  |
| space_id | bigint |  | 是 |  | spaces | 房态中心的空间（技师房、派对房等），或客房的房间；二选一 |
| room_id | bigint |  | 是 |  | rooms |  |
| room_code | text |  |  |  |  |  |
| visit_id | bigint |  |  |  | visits |  |
| outlet | text |  |  |  |  |  |
| order_no | text |  | 是 |  |  |  |
| note | text |  |  | ''::text |  |  |
| total_cents | integer |  |  |  |  | 单位：分 |
| staff_id | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### room_registrations

③ 登记单 （建表：190_room_center）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('room_registrations_id_seq'::regclass) |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| space_id | bigint |  |  |  | spaces | 现在在哪间房（换房时改；从哪间换到哪间记在房间事件里） |
| visit_id | bigint |  |  |  | visits |  |
| session_id | bigint |  |  |  | technician_sessions | 登记时建的钟单；这位客人之后在这次登记里做的钟（续钟、转钟、再点一项）都是编号不小于它的钟单 |
| seller_no | text |  |  |  |  | 出单员：工号与姓名（登记时的快照） |
| seller_name | text |  |  |  |  |  |
| note | text |  |  | ''::text |  |  |
| status | text |  |  | 'open'::text |  |  |
| opened_at | timestamp with time zone |  |  |  |  |  |
| opened_by | bigint |  |  |  | staff |  |
| open_key | uuid |  |  |  |  | 登记这一笔挂账的操作编号（同一编号只登记一次） |
| closed_at | timestamp with time zone |  | 是 |  |  |  |
| closed_by | bigint |  | 是 |  | staff |  |
| close_kind | text |  | 是 |  |  | 怎么结束的：房态中心退房 / 客人结账离店 / 撤销来访 |
| unpaid_cents | integer |  | 是 |  |  | 退房时这位客人手牌账单上还没结的金额（退房前预览看到的；结账离店的为 0）；单位：分 |
| overnight | boolean |  |  | false |  |  |
| kind | text |  |  | 'normal'::text |  |  |

### room_stay_charges

房费：每一晚 / 每一段 / 超时半天对应一条账单明细（只追加） （建表：024_rooms）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('room_stay_charges_id_seq'::regclass) |  |  |
| stay_id | bigint |  |  |  | room_stays |  |
| kind | text |  |  |  |  |  |
| night_date | date |  | 是 |  |  | 全天房：哪一晚（营业日）；超时半天：退房的营业日 |
| block_no | integer |  | 是 |  |  | 钟点房：第几段 |
| line_id | bigint |  |  |  | bill_lines |  |
| amount | integer |  |  |  |  |  |
| source | text |  |  |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### room_stays

入住单 （建表：024_rooms）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('room_stays_id_seq'::regclass) |  |  |
| stay_no | text |  |  |  |  |  |
| room_id | bigint |  |  |  | rooms | 现在住的房间（换房时改）；房型与房价按入住时记下，之后改房型的价格不影响 |
| room_type_id | bigint |  |  |  | room_types |  |
| kind | text |  |  |  |  |  |
| rate | integer |  |  |  |  |  |
| block_minutes | integer |  | 是 |  |  |  |
| bill_id | bigint |  |  |  | bills | 在店的洗浴客人（来访）与房费挂的手牌账单（来访的账单） |
| visit_id | bigint |  |  |  | visits |  |
| guest_label | text |  |  | ''::text |  |  |
| guests | integer |  |  |  |  |  |
| expected_checkout_date | date |  | 是 |  |  | 预计离店的营业日（全天房只做提醒，房费按夜审与退房时间算） |
| status | text |  |  | 'open'::text |  | 在住 → 已退房（房费留在手牌账单上，随手牌结账）/ 已撤销 |
| business_date | date |  |  |  |  |  |
| checked_in_at | timestamp with time zone |  |  |  |  |  |
| checked_in_by | bigint |  |  |  | staff |  |
| open_key | uuid |  |  |  |  | 入住的操作编号（结果待确认时据此查回） |
| closed_at | timestamp with time zone |  | 是 |  |  |  |
| closed_by | bigint |  | 是 |  | staff |  |
| close_reason | text |  | 是 |  |  |  |
| booking_id | bigint |  | 是 |  | bookings |  |
| list_rate | integer |  | 是 |  |  |  |
| member_grade | smallint |  | 是 |  |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |

### room_type_member_prices

8.0.20 会员联动房价（docs/ERP_V8020.md 第 6 节，JX-G / JX8）。 · room_type_member_prices：房型按档级的会员价（某一档起；高档没单独设的用比它低的最近一档）。全天房是每晚、钟点房是每段。 （建表：139_room_member_prices）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| room_type_id | bigint | PK |  |  | room_types |  |
| grade | smallint | PK |  |  |  |  |
| price | integer |  |  |  |  |  |
| updated_by | bigint |  | 是 |  | staff |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### room_types

房型 （建表：024_rooms）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('room_types_id_seq'::regclass) |  |  |
| name | text |  |  |  |  |  |
| kind | text |  |  |  |  |  |
| price | integer |  |  |  |  | 分：全天房每晚、钟点房每段（房费是账单明细，单价要大于 0） |
| block_minutes | integer |  | 是 |  |  | 钟点房每段分钟；全天房为空 |
| sort_order | integer |  |  | 0 |  |  |
| active | boolean |  |  | true |  |  |
| created_by | bigint |  | 是 |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |

### rooms

房间 （建表：024_rooms）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('rooms_id_seq'::regclass) |  |  |
| room_no | text |  |  |  |  |  |
| floor | text |  |  | ''::text |  |  |
| room_type_id | bigint |  |  |  | room_types |  |
| housekeeping | text |  |  | 'clean'::text |  | 打扫状态：已打扫（没人住时就是空闲）、待打扫、维修（要写原因）；在住看有没有未退房的入住单 |
| maintenance_note | text |  | 是 |  |  |  |
| sort_order | integer |  |  | 0 |  |  |
| active | boolean |  |  | true |  |  |
| created_by | bigint |  | 是 |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| space_id | bigint |  | 是 |  | spaces | 客房房间挂接空间（RQ-003 剩余项）：一个空间最多挂一间房 |
| store_id | bigint |  |  | yuzu_store() | stores |  |

### schema_migrations

已执行的迁移（src/server/migrate.ts 记录；迁移只增不改）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| version | text | PK |  |  |  |  |
| applied_at | timestamp with time zone |  |  | now() |  |  |

### service_item_prices

Batch 2.3：消费项目多档价格与属性（店主 2026-10-27 #8） · 同一项目可设「标准 / 专业 / 优选」多档价格，某一档不提供时不设； · 项目属性：时长、仅限某一性别（如私汤木桶浴仅女宾）、力道、精油、热疗、「超人气」——不影响计价； （建表：009_price_tiers）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| item_id | bigint | PK |  |  | service_items |  |
| tier | text | PK |  |  |  |  |
| price | bigint |  |  |  |  |  |

### service_item_store_prices

8.0.22 价目按店覆盖（docs/MULTISTORE_V8022.md 第 10 节，MD4）：价目表全公司一套；第二家店可以对某个项目的某一档单独定价。 挂账、菜单取价时先看当前门店有没有单独的价，没有用全公司的；本店不用这张表（与以往完全一样）。 （建表：157_store_prices）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| store_id | bigint | PK |  |  | stores |  |
| item_id | bigint | PK |  |  | service_items |  |
| tier | text | PK |  |  |  |  |
| price | bigint |  |  |  |  |  |
| updated_by | bigint |  |  |  | staff |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### service_items

浴族 yuzu 初始结构 约定：金额一律为整数「分」(bigint)；已入账的单据与流水只追加，不修改、不删除， 纠错通过新增撤销/冲正记录完成。 （建表：001_init）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('service_items_id_seq'::regclass) |  |  |
| name | text |  |  |  |  |  |
| category | text |  |  | ''::text |  |  |
| price | bigint |  |  |  |  |  |
| active | boolean |  |  | true |  |  |
| sort_order | integer |  |  | 0 |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| duration_minutes | integer |  | 是 |  |  |  |
| gender | text |  | 是 |  |  |  |
| strength | text |  | 是 |  |  |  |
| essential_oil | boolean |  |  | false |  |  |
| heat_therapy | boolean |  |  | false |  |  |
| popular | boolean |  |  | false |  |  |
| note | text |  |  | ''::text |  |  |
| technician_required | boolean |  |  | false |  |  |
| station_id | bigint |  | 是 |  | kitchen_stations |  |
| zone_id | bigint |  | 是 |  | zones | 价目项目在哪个区消费（后台配；没配的项目不推导） |
| dining_outlet | text |  | 是 |  |  |  |
| dining_group | text |  |  | ''::text |  |  |
| dish_image_id | bigint |  | 是 |  | emenu_images | ④ 菜品自己的图片 菜品表、点单时的选项弹窗用；空着的带出电子菜单里那道菜的图（电子菜单的图仍在后台「电子菜单」里维护） |
| dish_sort | integer |  | 是 |  |  |  |
| dish_deleted_at | timestamp with time zone |  | 是 |  |  |  |
| dish_deleted_by | bigint |  | 是 |  | staff |  |
| catalog_key | text |  | 是 |  |  |  |
| catalog_managed | boolean |  |  | false |  |  |
| catalog_category_code | text |  | 是 |  |  |  |
| catalog_category_name | text |  | 是 |  |  |  |
| catalog_group | text |  | 是 |  |  |  |
| catalog_sort | integer |  | 是 |  |  |  |
| catalog_code | text |  | 是 |  |  |  |
| price_mode | text |  |  | 'fixed'::text |  |  |
| sale_windows | jsonb |  | 是 |  |  |  |
| station_pinned | boolean |  |  | false |  | 8.2.4：单独设了出品档口——true 时不跟菜单分组的默认档口，照自己的 station_id 出；false 时分组设了默认档口就按分组走（餐饮规则 groupStations） |

### sessions

浴族 yuzu 初始结构 约定：金额一律为整数「分」(bigint)；已入账的单据与流水只追加，不修改、不删除， 纠错通过新增撤销/冲正记录完成。 （建表：001_init）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| token_hash | text | PK |  |  |  |  |
| staff_id | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| last_seen_at | timestamp with time zone |  |  | now() |  |  |
| expires_at | timestamp with time zone |  |  |  |  |  |
| ip | text |  | 是 |  |  |  |
| user_agent | text |  | 是 |  |  |  |
| store_id | bigint |  | 是 |  | stores | 会话的当前门店（空 = 按员工挂的第一家，没挂的是本店） |

### settings

经营设置（键值） （建表：001_init）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| key | text | PK |  |  |  |  |
| value | jsonb |  |  |  |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| updated_by | bigint |  | 是 |  | staff |  |

### shift_members

v0.7.28 ⑨（主线）：按钱箱交班（N11，设计见 docs/SCHEDULE_FINISH.md 第 10 节）。 · 交班方式是经营规则（settings 表的 shift_mode：person 按人交班，默认、就是现在的做法； （建表：059_shift_drawers）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('shift_members_id_seq'::regclass) |  |  |
| shift_id | bigint |  |  |  | shifts |  |
| staff_id | bigint |  |  |  | staff |  |
| joined_at | timestamp with time zone |  |  |  |  |  |
| left_at | timestamp with time zone |  | 是 |  |  |  |
| left_by | bigint |  | 是 |  | staff | 谁让他离开的：本人离开钱箱，或交班的人（交班时所有人一起离开） |

### shifts

Batch 3 · S3.4：交班（店主 2026-10-27 #11：店员交班时需要做交班表或日结） · 当班员工开班时登记备用金；交班时系统按本班次（开班到交班）本人经办、仍有效的结账与充值汇总各收款方式， 算出应有现金 = 备用金 + 现金收款，员工实点现金后交班，差额（长款 / 短款）与汇总快照一起留存； （建表：015_shifts）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('shifts_id_seq'::regclass) |  |  |
| shift_no | text |  |  |  |  |  |
| staff_id | bigint |  |  |  | staff |  |
| status | text |  |  | 'open'::text |  |  |
| business_date | date |  |  |  |  |  |
| started_at | timestamp with time zone |  |  |  |  |  |
| opening_cash | bigint |  |  |  |  | 备用金（开班时抽屉里的现金，分） |
| ended_at | timestamp with time zone |  | 是 |  |  |  |
| expected_cash | bigint |  | 是 |  |  | 交班时系统算出的应有现金、员工实点的现金 |
| counted_cash | bigint |  | 是 |  |  |  |
| summary | jsonb |  | 是 |  |  | 交班时的汇总快照（各收款方式、单据数、反结账提醒等） |
| note | text |  |  | ''::text |  |  |
| handed_to | bigint |  | 是 |  | staff | 接班人（可不填） |
| closed_by | bigint |  | 是 |  | staff |  |
| legacy_window | boolean |  |  | false |  | 已有班次（含升级时仍未交班的）记为 true，之后开的班次默认 false；只加列、不改已有行（交班记录的保护触发器不受影响） |
| legacy_refund | boolean |  |  | false |  | ⑥ 反结账退款的交班口径（店主 2.5：现金退款扣减反结账人班次的应有现金，原单仍算在收款时的班次）只用于升级之后开的班次。 升级时已有的班次（含仍未交班的）里做的反结账仍按原口径：反结账人的班次只列提醒、不扣现金，原单也不计入收款时的班次。 同一张单在两个班次里按同一口径计算：升级前已交班的快照、升级时仍未交班的班次与之后开的班次合起来对得上。 |
| drawer | text |  | 是 |  |  |  |
| drawer_name | text |  | 是 |  |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |

### sms_outbox

8.0.4 会员体系整改（docs/MEMBERSHIP_V804.md）： · 第 9.1 节 买一赠一券：券模板加种类 bogo——买的项目 buy_item_id，赠的项目沿用 exchange_item_id； 可选的赠品出库设置（物料、每份出库数量、出哪个仓）； （建表：089_coupon_campaigns）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('sms_outbox_id_seq'::regclass) |  |  |
| member_id | bigint |  | 是 |  | members |  |
| phone | text |  |  |  |  |  |
| purpose | text |  |  |  |  |  |
| params | jsonb |  |  |  |  | 短信模板的变量（阿里云模板参数）与按变量拼好的全文（页面显示、导出手动发用） |
| content | text |  |  |  |  |  |
| campaign_id | bigint |  | 是 |  | coupon_campaigns |  |
| status | text |  |  | 'pending'::text |  |  |
| attempts | integer |  |  | 0 |  |  |
| last_error | text |  | 是 |  |  |  |
| provider | text |  | 是 |  |  |  |
| provider_ref | text |  | 是 |  |  |  |
| dedupe_key | text |  |  |  |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| sent_at | timestamp with time zone |  | 是 |  |  |  |
| claimed_until | timestamp with time zone |  | 是 |  |  | 8.0.4 短信待发箱的认领租约（Codex 自动审查 8603568，docs/MEMBERSHIP_V804.md 第 14 节）： 原来认领只在一个短事务里锁住、次数加一，事务提交以后这几条还是「待发」，前一批还没发完、下一分钟的一批（同一进程里也会叠在一起） 又能认领到同一条，一条短信会发两次。认领时写一个租约（到什么时候为止由这一批在发），租约内别的批次不认领； 发完（成功、失败）清掉； |

### sourcing_events

v0.7.29 ERP 采购五项⑤（主线）：询价比价与定标（E5–E8，设计见 docs/ERP_PURCHASING.md 第 6 节）。 · 询价单：标题、要货日期、物料与数量（采购单位，建好不改），状态 询价中 → 已定标（可撤销定标回到询价中）/ 已撤销； （建表：072_sourcing）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('sourcing_events_id_seq'::regclass) |  |  |
| doc_no | text |  |  |  |  |  |
| title | text |  |  |  |  |  |
| status | text |  |  | 'open'::text |  |  |
| need_by | date |  | 是 |  |  |  |
| note | text |  |  | ''::text |  |  |
| awarded_quote_id | bigint |  | 是 |  | sourcing_quotes |  |
| award_reason | text |  | 是 |  |  |  |
| single_source | boolean |  |  | false |  |  |
| awarded_by | bigint |  | 是 |  | staff |  |
| awarded_at | timestamp with time zone |  | 是 |  |  |  |
| cancel_reason | text |  | 是 |  |  |  |
| client_key | uuid |  |  |  |  | 页面带操作编号：同一编号、同样的内容重提返回原询价单，内容不同拒绝（只用自己的列，不动共用的幂等表） |
| request_hash | text |  |  |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| is_synthetic | boolean |  |  | false |  |  |

### sourcing_line_requests

v0.7.30（主线）：询价接上需求单与补货建议（v0.7.29 的已知问题，见 docs/HANDOFF_V0729.md 第 6 节）。 · 从需求单发起询价时，询价单的每一行记下来自哪几行需求（同一物料的几行需求可以并成询价单的一行）； （建表：074_sourcing_requests）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| sourcing_line_id | bigint | PK |  |  | sourcing_lines |  |
| request_line_id | bigint | PK |  |  | purchase_request_lines |  |

### sourcing_lines

v0.7.29 ERP 采购五项⑤（主线）：询价比价与定标（E5–E8，设计见 docs/ERP_PURCHASING.md 第 6 节）。 · 询价单：标题、要货日期、物料与数量（采购单位，建好不改），状态 询价中 → 已定标（可撤销定标回到询价中）/ 已撤销； （建表：072_sourcing）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('sourcing_lines_id_seq'::regclass) |  |  |
| event_id | bigint |  |  |  | sourcing_events |  |
| line_no | integer |  |  |  |  |  |
| material_id | bigint |  |  |  | materials |  |
| purchase_qty_milli | bigint |  |  |  |  |  |
| purchase_unit | text |  |  |  |  |  |
| factor_milli | bigint |  |  |  |  |  |
| base_qty_milli | bigint |  |  |  |  |  |
| spec | text |  |  | ''::text |  |  |

### sourcing_quote_lines

v0.7.29 ERP 采购五项⑤（主线）：询价比价与定标（E5–E8，设计见 docs/ERP_PURCHASING.md 第 6 节）。 · 询价单：标题、要货日期、物料与数量（采购单位，建好不改），状态 询价中 → 已定标（可撤销定标回到询价中）/ 已撤销； （建表：072_sourcing）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| quote_id | bigint | PK |  |  | sourcing_quotes |  |
| sourcing_line_id | bigint | PK |  |  | sourcing_lines |  |
| price_cents | bigint |  |  |  |  | 单位：分 |
| amount_cents | bigint |  |  |  |  | 单位：分 |

### sourcing_quotes

v0.7.29 ERP 采购五项⑤（主线）：询价比价与定标（E5–E8，设计见 docs/ERP_PURCHASING.md 第 6 节）。 · 询价单：标题、要货日期、物料与数量（采购单位，建好不改），状态 询价中 → 已定标（可撤销定标回到询价中）/ 已撤销； （建表：072_sourcing）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('sourcing_quotes_id_seq'::regclass) |  |  |
| event_id | bigint |  |  |  | sourcing_events |  |
| supplier_id | bigint |  |  |  | suppliers |  |
| status | text |  |  | 'active'::text |  |  |
| goods_cents | bigint |  |  |  |  | 单位：分 |
| freight_cents | bigint |  |  | 0 |  | 单位：分 |
| pay_terms | text |  |  |  |  |  |
| credit_days | integer |  |  | 0 |  |  |
| delivery_days | integer |  | 是 |  |  |  |
| valid_until | date |  | 是 |  |  |  |
| note | text |  |  | ''::text |  |  |
| withdraw_reason | text |  | 是 |  |  |  |
| withdrawn_by | bigint |  | 是 |  | staff |  |
| withdrawn_at | timestamp with time zone |  | 是 |  |  |  |
| client_key | uuid |  |  |  |  |  |
| request_hash | text |  |  |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| via_link_id | bigint |  | 是 |  | supplier_links | 报价从哪来：员工登记的为空；供应商在链接里报的记链接 |

### space_aliases

别名：品牌名、编码图原始标注、旧名；只追加，停用一次 （建表：032_spaces）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('space_aliases_id_seq'::regclass) |  |  |
| space_id | bigint |  |  |  | spaces |  |
| alias | text |  |  |  |  |  |
| kind | text |  |  |  |  |  |
| active | boolean |  |  | true |  |  |
| created_by | bigint |  | 是 |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| retired_by | bigint |  | 是 |  | staff |  |
| retired_at | timestamp with time zone |  | 是 |  |  |  |

### space_imports

导入记录（同一个文件只能写入一次） （建表：032_spaces）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('space_imports_id_seq'::regclass) |  |  |
| kind | text |  |  |  |  |  |
| file_name | text |  |  |  |  |  |
| file_sha256 | text |  |  |  |  |  |
| row_count | integer |  |  |  |  |  |
| created_count | integer |  |  |  |  |  |
| skipped_count | integer |  |  |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### space_room_events

④ 房间事件（只追加） （建表：190_room_center）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('space_room_events_id_seq'::regclass) |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| space_id | bigint |  |  |  | spaces |  |
| kind | text |  |  |  |  |  |
| registration_id | bigint |  | 是 |  | room_registrations |  |
| detail | jsonb |  |  | '{}'::jsonb |  | 手牌号、项目、技师、金额、原因、换到哪间……（显示用的快照） |
| staff_id | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### space_room_states

② 房态行 （建表：190_room_center）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| space_id | bigint | PK |  |  | spaces |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| cleaned_at | timestamp with time zone |  |  |  |  | 最近一次「清洁完成」的时刻；这以后用过（钟单做完、使用单结束、退房、手动标）就是待清 |
| dirty_at | timestamp with time zone |  | 是 |  |  | 手动标成待清、换房换出去的时刻与说明 |
| dirty_note | text |  |  | ''::text |  |  |
| maintenance | boolean |  |  | false |  |  |
| maintenance_reason | text |  | 是 |  |  |  |
| maintenance_until | timestamp with time zone |  | 是 |  |  | 预计完成时间 |
| maintenance_at | timestamp with time zone |  | 是 |  |  |  |
| maintenance_by | bigint |  | 是 |  | staff |  |
| merged_into | bigint |  | 是 |  | spaces | 并房：并到哪一间（主房）；主房自己这一项为空 |
| version | integer |  |  | 0 |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| updated_by | bigint |  | 是 |  | staff |  |

### space_usage_charges

v0.7.28 ②（主线）：派对房等「开单即占用」的计费（设计见 docs/SCHEDULE_FINISH.md 第 3 节，N2、N3）。 计费规则在设置 usage_rules.pricing 里（按业态：房费项目、起步时长、计费单位、开台费项目），没设的业态照旧不收费。 （建表：052_usage_charges）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| usage_id | bigint | PK |  |  | space_usages |  |
| kind | text | PK |  |  |  |  |
| line_id | bigint |  |  |  | bill_lines |  |
| minutes | integer |  |  |  |  | 实际用了多久、按多久计费（开台费这两项记 0） |
| charged_minutes | integer |  |  |  |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### space_usages

① 使用单 （建表：036_floorplan_finish）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('space_usages_id_seq'::regclass) |  |  |
| usage_no | text |  |  |  |  |  |
| space_id | bigint |  |  |  | spaces |  |
| visit_id | bigint |  |  |  | visits | 使用人：在店客人（手牌账单上记费用） |
| bill_id | bigint |  |  |  | bills |  |
| guests | integer |  |  | 1 |  |  |
| note | text |  |  | ''::text |  |  |
| status | text |  |  | 'open'::text |  |  |
| business_date | date |  |  |  |  |  |
| opened_at | timestamp with time zone |  |  |  |  |  |
| opened_by | bigint |  |  |  | staff |  |
| open_key | uuid |  |  |  |  |  |
| closed_at | timestamp with time zone |  | 是 |  |  |  |
| closed_by | bigint |  | 是 |  | staff |  |
| close_kind | text |  | 是 |  |  | 怎么结束的：手动结束 / 使用人结账 / 撤销来访 / 开错了撤单 |
| close_reason | text |  | 是 |  |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |

### spaces

空间（房间）：编码图的编码做主键（D6 方案 A），缺号不补 编码最多 8 位（与客房房号的长度一致：客房挂接后房号就是编码） （建表：032_spaces）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('spaces_id_seq'::regclass) |  |  |
| code | text |  |  |  |  |  |
| floor_id | bigint |  |  |  | floors |  |
| zone_id | bigint |  | 是 |  | zones |  |
| business_type | text |  |  |  |  |  |
| capacity | integer |  | 是 |  |  |  |
| area_centi_m2 | integer |  | 是 |  |  | 面积 × 100（㎡，两位小数） |
| display_name | text |  |  |  |  |  |
| name_en | text |  |  | ''::text |  |  |
| sellable | boolean |  |  | true |  |  |
| verify_status | text |  |  | 'confirmed'::text |  | 核对状态：已核对 / 推断（图上没直接写，按就近标签或品牌图推断）/ 待现场核对 |
| verified_by | bigint |  | 是 |  | staff |  |
| verified_at | timestamp with time zone |  | 是 |  |  |  |
| verify_note | text |  | 是 |  |  |  |
| source_label | text |  |  | ''::text |  | 编码图原始标注（如「足浴 C301 2人间」） |
| note | text |  |  | ''::text |  |  |
| active | boolean |  |  | true |  |  |
| import_id | bigint |  | 是 |  | space_imports |  |
| version | integer |  |  | 1 |  | 版本号：编辑、核对、设区域各加 1（别名、客房挂接不改这一行） |
| created_by | bigint |  | 是 |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| hall_zone_id | bigint |  | 是 |  | hall_zones |  |

### staff

员工与登录 （建表：001_init）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('staff_id_seq'::regclass) |  |  |
| username | text |  |  |  |  |  |
| display_name | text |  |  |  |  |  |
| role | text |  |  |  |  |  |
| password_hash | text |  |  |  |  |  |
| must_change_password | boolean |  |  | false |  |  |
| active | boolean |  |  | true |  |  |
| last_login_at | timestamp with time zone |  | 是 |  |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| duties | text[] |  |  | '{}'::text[] |  |  |
| department_id | bigint |  | 是 |  | departments |  |
| system | boolean |  |  | false |  | 系统账号：只做系统入账的经办人（线上充值记「小程序」），不能登录（停用、密码不可用），不出现在员工、排班、交班里。 第一次线上入账时才建（system.mp），新装的库、测试库里的员工不受影响 |
| position | text |  | 是 |  |  |  |
| permission_adjust | jsonb |  |  | '{}'::jsonb |  |  |
| needs_position | boolean |  |  | false |  |  |
| position_chosen_at | timestamp with time zone |  | 是 |  |  |  |

### staff_order_pins

② 点单密码 6 位数字一共只有一百万种，库泄露后怎么加密都能很快试出来，防护在线上（要先登录平板账号、输错限次、每次确认记审计）。 库里不存明文：pin_hash 是整个密码的 scrypt 摘要（与登录密码同一套）；slot 是密码的前三位，用来按密码找到人， 系统生成时保证不重复（唯一约束兜底）。 （建表：121_emenu）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| staff_id | bigint | PK |  |  | staff |  |
| slot | text |  |  |  |  |  |
| pin_hash | text |  |  |  |  |  |
| set_by | bigint |  |  |  | staff |  |
| set_at | timestamp with time zone |  |  | now() |  |  |

### staff_profiles

OA-01（店主 2026-11-22《企业 OA 审批 + 考勤打卡系统需求文档》，docs/OA.md 第 4 节，OA1–OA5）：组织架构与员工档案。 部门沿用 8.1.18 的 15 个部门（org_departments，OA1：不增删），补「上级部门」与「指定主管」； （建表：210_oa_org）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| staff_id | bigint | PK |  |  | staff |  |
| emp_no | text |  | 是 |  |  |  |
| phone | text |  | 是 |  |  |  |
| hire_date | date |  | 是 |  |  |  |
| leave_date | date |  | 是 |  |  |  |
| status | text |  |  | 'active'::text |  |  |
| version | integer |  |  | 1 |  | 乐观并发：后台改档案带着页面看到的版本，别人先改过就不能覆盖 |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| updated_by | bigint |  | 是 |  | staff |  |

### staff_stores

员工挂哪几家店；店主不用挂（所有门店都能进）；没挂任何门店的员工按本店算（以往直接建的账号照常能用） （建表：153_stores）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| staff_id | bigint | PK |  |  | staff |  |
| store_id | bigint | PK |  |  | stores |  |
| last_used_at | timestamp with time zone |  | 是 |  |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### stock_moves

库存流水：唯一的数量来源 （建表：002_inventory）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('stock_moves_id_seq'::regclass) |  |  |
| material_id | bigint |  |  |  | materials |  |
| move_type | text |  |  |  |  |  |
| doc_id | bigint |  |  |  | inv_docs |  |
| doc_line_id | bigint |  |  |  | inv_doc_lines |  |
| qty_delta_milli | bigint |  |  |  |  |  |
| qty_after_milli | bigint |  |  |  |  |  |
| doc_date | date |  |  |  |  |  |
| operator_id | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| warehouse_id | bigint |  |  |  | warehouses | 流水按仓：原有流水都在总仓 |
| unit_cost_e4 | bigint |  | 是 |  |  |  |
| cost_cents | bigint |  | 是 |  |  | 单位：分 |

### stock_transfer_lines

8.0.22 多店多仓与门店间调拨（docs/MULTISTORE_V8022.md 第 8 节，MD-B）。 · 仓库加门店：现有的总仓与部门小仓都归本店；第二家店有自己的主仓（kind = store_main，结存记在 warehouse_stock）； （建表：155_warehouses_transfers）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('stock_transfer_lines_id_seq'::regclass) |  |  |
| transfer_id | bigint |  |  |  | stock_transfers |  |
| material_id | bigint |  |  |  | materials |  |
| qty_milli | bigint |  |  |  |  |  |
| received_milli | bigint |  | 是 |  |  |  |
| variance_reason | text |  | 是 |  |  |  |

### stock_transfers

8.0.22 多店多仓与门店间调拨（docs/MULTISTORE_V8022.md 第 8 节，MD-B）。 · 仓库加门店：现有的总仓与部门小仓都归本店；第二家店有自己的主仓（kind = store_main，结存记在 warehouse_stock）； （建表：155_warehouses_transfers）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('stock_transfers_id_seq'::regclass) |  |  |
| transfer_no | text |  |  |  |  |  |
| from_warehouse_id | bigint |  |  |  | warehouses |  |
| to_warehouse_id | bigint |  |  |  | warehouses |  |
| status | text |  |  | 'in_transit'::text |  |  |
| note | text |  |  | ''::text |  |  |
| out_doc_id | bigint |  |  |  | inv_docs |  |
| in_doc_id | bigint |  | 是 |  | inv_docs |  |
| sent_by | bigint |  |  |  | staff |  |
| sent_at | timestamp with time zone |  |  | now() |  |  |
| received_by | bigint |  | 是 |  | staff |  |
| received_at | timestamp with time zone |  | 是 |  |  |  |
| cancelled_by | bigint |  | 是 |  | staff |  |
| cancelled_at | timestamp with time zone |  | 是 |  |  |  |
| cancel_reason | text |  | 是 |  |  |  |
| version | integer |  |  | 1 |  |  |

### stock_usage_batches

8.0.20 用料与配方、销售与出品扣库存（docs/ERP_V8020.md 第 2 节，JX-A / JX-B）。 · item_recipes / item_recipe_lines：价目项目的用料（零售品就是只有一行的配方），带版本——改用料 = 旧的停用、写一份新的。 （建表：128_stock_usage）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | identity always |  |  |
| kind | text |  |  |  |  |  |
| warehouse_id | bigint |  |  |  |  |  |
| client_key | uuid |  |  | gen_random_uuid() |  |  |
| status | text |  |  | 'posting'::text |  |  |
| inv_doc_id | bigint |  | 是 |  | inv_docs |  |
| doc_date | date |  |  |  |  |  |
| line_count | integer |  |  | 0 |  |  |
| error | text |  | 是 |  |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| finished_at | timestamp with time zone |  | 是 |  |  |  |

### stock_usage_events

8.0.20 用料与配方、销售与出品扣库存（docs/ERP_V8020.md 第 2 节，JX-A / JX-B）。 · item_recipes / item_recipe_lines：价目项目的用料（零售品就是只有一行的配方），带版本——改用料 = 旧的停用、写一份新的。 （建表：128_stock_usage）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | identity always |  |  |
| kind | text |  |  |  |  |  |
| sign | smallint |  |  |  |  |  |
| checkout_id | bigint |  | 是 |  | checkouts |  |
| kitchen_item_id | bigint |  | 是 |  | kitchen_items |  |
| bill_line_id | bigint |  | 是 |  |  |  |
| reverses_id | bigint |  | 是 |  | stock_usage_events |  |
| item_id | bigint |  |  |  |  |  |
| item_name | text |  |  |  |  |  |
| quantity | integer |  |  |  |  |  |
| recipe_id | bigint |  |  |  | item_recipes |  |
| material_id | bigint |  |  |  |  |  |
| warehouse_id | bigint |  |  |  |  |  |
| qty_milli | bigint |  |  |  |  |  |
| business_date | date |  |  |  |  |  |
| state | text |  |  | 'pending'::text |  | 处理状态（只有这几列会改）：pending 还没入账；batched 进了某一批；netted 与冲回轧平了、不用出库 |
| batch_id | bigint |  | 是 |  | stock_usage_batches |  |
| blocked_at | timestamp with time zone |  | 是 |  |  | 库存不够、这一轮没扣成的时间（待扣料里看） |
| reversed_at | timestamp with time zone |  | 是 |  |  | 被冲回的时间（只在 sign = 1 的行上） |
| created_at | timestamp with time zone |  |  | now() |  |  |
| kitchen_part_id | bigint |  | 是 |  | kitchen_item_parts | ③ 子项扣料 |

### store_settings

门店单独的设置（按店的那几项，docs/MULTISTORE_V8022.md 第 4 节）：本店照旧用 settings （建表：153_stores）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| store_id | bigint | PK |  |  | stores |  |
| key | text | PK |  |  |  |  |
| value | jsonb |  |  |  |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| updated_by | bigint |  | 是 |  | staff |  |

### stores

8.0.22 多门店：公司主体、门店、员工挂门店、门店设置、会话的当前门店（docs/MULTISTORE_V8022.md 第 1–4 节，MD-A / MD-C）。 只有一家店时与现在完全一样：现有数据都归「本店」（编号 1）与「本公司」（编号 1）；本店不设门店上下文。 （建表：153_stores）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('stores_id_seq'::regclass) |  |  |
| code | text |  |  |  |  |  |
| name | text |  |  |  |  |  |
| entity_id | bigint |  |  |  | legal_entities |  |
| address | text |  |  | ''::text |  |  |
| phone | text |  |  | ''::text |  |  |
| active | boolean |  |  | true |  |  |
| sort_order | integer |  |  | 0 |  |  |
| version | integer |  |  | 1 |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### studio_assets

④ 素材（只追加） （建表：164_studio）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | text | PK |  |  |  |  |
| mime | text |  |  |  |  |  |
| data | bytea |  |  |  |  |  |
| size_bytes | integer |  |  |  |  |  |
| width | integer |  | 是 |  |  |  |
| height | integer |  | 是 |  |  |  |
| name | text |  |  | ''::text |  |  |
| uploaded_by | bigint |  |  |  | staff |  |
| uploaded_at | timestamp with time zone |  |  | now() |  |  |

### studio_comments

166（8.1.2，迁移号在 docs/ROADMAP.md 第 7 节登记）：UI 工作台的定时发布与批注（docs/WORKBENCH_V811.md 第 11、13 节，GZ27、GZ28）。 ① 定时发布：发布时可以定一个以后的时间生效（effective_at；空 = 发布时就生效）。 （建表：166_studio_schedule_comments）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('studio_comments_id_seq'::regclass) |  |  |
| surface | text |  |  |  |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| screen | text |  |  |  |  | 哪一屏（改组件时是「@组件编号」）、画布上的位置（设计稿的像素），挂在哪一块上（可以不挂） |
| node_id | text |  | 是 |  |  |  |
| x | double precision |  |  |  |  |  |
| y | double precision |  |  |  |  |  |
| parent_id | bigint |  | 是 |  | studio_comments | 回复挂在第一条下面（只套一层） |
| body | text |  |  |  |  |  |
| client_key | uuid |  |  |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| resolved_at | timestamp with time zone |  | 是 |  |  |  |
| resolved_by | bigint |  | 是 |  | staff |  |

### studio_designs

② 草稿 （建表：164_studio）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('studio_designs_id_seq'::regclass) |  |  |
| surface | text |  |  |  |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| doc | jsonb |  |  |  |  |  |
| rev | integer |  |  | 1 |  |  |
| updated_by | bigint |  |  |  | staff |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### studio_preview_codes

⑤ 预览码 （建表：164_studio）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| code | text | PK |  |  |  |  |
| surface | text |  |  |  |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| doc | jsonb |  |  |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| expires_at | timestamp with time zone |  |  |  |  |  |

### studio_version_cancels

166（8.1.2，迁移号在 docs/ROADMAP.md 第 7 节登记）：UI 工作台的定时发布与批注（docs/WORKBENCH_V811.md 第 11、13 节，GZ27、GZ28）。 ① 定时发布：发布时可以定一个以后的时间生效（effective_at；空 = 发布时就生效）。 （建表：166_studio_schedule_comments）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| version_id | bigint | PK |  |  | studio_versions |  |
| cancelled_by | bigint |  |  |  | staff |  |
| cancelled_at | timestamp with time zone |  |  | now() |  |  |
| reason | text |  |  | ''::text |  |  |

### studio_versions

③ 已发布的版本（只追加） （建表：164_studio）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('studio_versions_id_seq'::regclass) |  |  |
| surface | text |  |  |  |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| version | integer |  |  |  |  |  |
| kind | text |  |  |  |  |  |
| rollback_of | integer |  | 是 |  |  | 回滚时是照哪一版重发的 |
| doc | jsonb |  |  |  |  |  |
| doc_hash | text |  |  |  |  |  |
| note | text |  |  | ''::text |  |  |
| screens_changed | text[] |  |  | '{}'::text[] |  | 改了哪几屏（theme、start、menu……） |
| client_key | uuid |  |  |  |  |  |
| request_hash | text |  |  |  |  |  |
| published_by | bigint |  |  |  | staff |  |
| published_at | timestamp with time zone |  |  | now() |  |  |
| effective_at | timestamp with time zone |  | 是 |  |  |  |

### supplier_contract_files

签约供应商的合同 PDF：可以传多份；撤下保留记录（只能补上撤下的人与时间一次，别的不能改、不能删） （建表：083_suppliers_contracts）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('supplier_contract_files_id_seq'::regclass) |  |  |
| supplier_id | bigint |  |  |  | suppliers |  |
| file_id | bigint |  |  |  | erp_files |  |
| name | text |  |  |  |  |  |
| uploaded_by | bigint |  |  |  | staff |  |
| uploaded_at | timestamp with time zone |  |  | now() |  |  |
| removed_by | bigint |  | 是 |  | staff |  |
| removed_at | timestamp with time zone |  | 是 |  |  |  |

### supplier_invoice_attachments

8.0.3 进项发票台账（docs/BUDGET_INVOICES.md 第 3 节，默认 BI07–BI12 待确认）：在 v0.7.32 的发票登记（supplier_invoices）上扩。 （建表：087_input_invoices）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('supplier_invoice_attachments_id_seq'::regclass) |  |  |
| invoice_id | bigint |  |  |  | supplier_invoices |  |
| image_id | bigint |  | 是 |  | erp_images |  |
| file_id | bigint |  | 是 |  | erp_files |  |
| name | text |  |  | ''::text |  |  |
| uploaded_by | bigint |  |  |  | staff |  |
| uploaded_at | timestamp with time zone |  |  | now() |  |  |

### supplier_invoice_lines

发票分到采购单的金额（只追加；发票作废以后这些行不再算） （建表：081_three_way_match）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('supplier_invoice_lines_id_seq'::regclass) |  |  |
| invoice_id | bigint |  |  |  | supplier_invoices |  |
| purchase_order_id | bigint |  |  |  | purchase_orders |  |
| amount_cents | bigint |  |  |  |  | 单位：分 |

### supplier_invoices

v0.7.32（主线）付款流 第二部分（docs/PAYMENTS.md 第 4 节，默认 P8 待确认）：三单匹配。 · 发票登记：供应商开来的发票（发票号码、开票日、价税合计、税额、税率），分到哪几张采购单、各分多少（合计等于价税合计）； 同一供应商同一发票号码只能有一张没作废的；登错了作废（写原因）。 （建表：081_three_way_match）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('supplier_invoices_id_seq'::regclass) |  |  |
| invoice_no | text |  |  |  |  |  |
| supplier_id | bigint |  | 是 |  | suppliers |  |
| invoice_date | date |  |  |  |  |  |
| total_cents | bigint |  |  |  |  | 价税合计、税额（整数分）、税率（万分比） |
| tax_cents | bigint |  |  |  |  | 单位：分 |
| tax_rate_bp | integer |  |  |  |  |  |
| note | text |  |  | ''::text |  |  |
| status | text |  |  | 'valid'::text |  |  |
| voided_by | bigint |  | 是 |  | staff |  |
| voided_at | timestamp with time zone |  | 是 |  |  |  |
| void_reason | text |  | 是 |  |  |  |
| client_key | uuid |  |  |  |  |  |
| request_hash | text |  |  |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| issuer_name | text |  |  | ''::text |  |  |
| kind | text |  |  | 'vat_special'::text |  |  |
| kind_label | text |  |  | '增值税专用发票'::text |  |  |
| source | text |  |  | 'three_way'::text |  |  |
| cert_status | text |  |  | 'pending'::text |  |  |
| cert_period | text |  | 是 |  |  |  |
| cert_by | bigint |  | 是 |  | staff |  |
| cert_at | timestamp with time zone |  | 是 |  |  |  |
| cert_note | text |  |  | ''::text |  |  |
| cert_version | integer |  |  | 1 |  |  |
| entry_method | text |  |  | 'manual'::text |  |  |
| entity_id | bigint |  |  | yuzu_entity() | legal_entities |  |

### supplier_licenses

8.0.7 供应链收尾 2.1（docs/ERP_V807.md）：供应商准入状态与证照；文件库（erp_files）加两种用途。 · 准入状态：待准入 / 已准入 / 暂停。已有的供应商都是「已准入」（升级后行为不变）；页面上新建的是「待准入」 （接口新建时写明，种子、导入等其他写入照旧按已准入）。 （建表：097_supplier_admission）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('supplier_licenses_id_seq'::regclass) |  |  |
| supplier_id | bigint |  |  |  | suppliers |  |
| kind | text |  |  |  |  |  |
| name | text |  |  | ''::text |  | 「其他」要写名称；另外三种可以不写 |
| license_no | text |  |  |  |  |  |
| valid_until | date |  | 是 |  |  | 有效期至：空 = 长期 |
| image_id | bigint |  | 是 |  | erp_images |  |
| file_id | bigint |  | 是 |  | erp_files |  |
| added_by | bigint |  |  |  | staff |  |
| added_at | timestamp with time zone |  |  | now() |  |  |
| removed_by | bigint |  | 是 |  | staff |  |
| removed_at | timestamp with time zone |  | 是 |  |  |  |
| remove_reason | text |  | 是 |  |  |  |

### supplier_link_replies

供应商每回复一次记一行：报价、订单确认、发货预告各自的内容；client_key 是供应商页面生成的，没收到结果再点一次照样只记一次 （建表：147_supplier_links）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('supplier_link_replies_id_seq'::regclass) |  |  |
| link_id | bigint |  |  |  | supplier_links |  |
| client_key | uuid |  |  |  |  |  |
| request_hash | text |  |  |  |  |  |
| reply_name | text |  |  |  |  |  |
| content | jsonb |  |  |  |  |  |
| quote_id | bigint |  | 是 |  | sourcing_quotes |  |
| ip | text |  | 是 |  |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### supplier_links

8.0.21 供应商门户（docs/FINANCE_V8021.md 第 7 节，CW-F / CW6）：在对账确认链接（迁移 100）的做法上扩成三种—— 报价（开着的询价单）、订单确认（已确认的采购单）、发货预告（供应商已确认的采购单）。 （建表：147_supplier_links）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('supplier_links_id_seq'::regclass) |  |  |
| kind | text |  |  |  |  |  |
| sourcing_event_id | bigint |  | 是 |  | sourcing_events |  |
| purchase_order_id | bigint |  | 是 |  | purchase_orders |  |
| supplier_id | bigint |  |  |  | suppliers |  |
| token_hash | text |  |  |  |  |  |
| snapshot | jsonb |  |  |  |  |  |
| expires_at | timestamp with time zone |  |  |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| voided_by | bigint |  | 是 |  | staff |  |
| voided_at | timestamp with time zone |  | 是 |  |  |  |

### supplier_reconciliation_docs

按批次登记包含的收货单与登记时的货款 （建表：031_stock_cycles）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| reconciliation_id | bigint | PK |  |  | supplier_reconciliations |  |
| doc_id | bigint | PK |  |  | inv_docs |  |
| amount_cents | bigint |  |  |  |  | 单位：分 |

### supplier_reconciliations

对账登记（#23）：只追加，撤销只能一次 （建表：031_stock_cycles）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('supplier_reconciliations_id_seq'::regclass) |  |  |
| supplier_id | bigint |  |  |  | suppliers |  |
| kind | text |  |  |  |  |  |
| period_month | date |  | 是 |  |  | 月结：对的是哪个月（那个月的 1 号） |
| begin_cents | bigint |  | 是 |  |  | 登记时的数字。月结：那个月对账单的期初余额、期初未付登记、收货、退货扣款、付款、供应商退款、期末余额； 按批次：只有合计（各张收货单的货款在明细表）；单位：分 |
| opening_cents | bigint |  | 是 |  |  | 单位：分 |
| received_cents | bigint |  | 是 |  |  | 单位：分 |
| return_credit_cents | bigint |  | 是 |  |  | 单位：分 |
| paid_cents | bigint |  | 是 |  |  | 单位：分 |
| refunded_cents | bigint |  | 是 |  |  | 单位：分 |
| end_cents | bigint |  | 是 |  |  | 单位：分 |
| total_cents | bigint |  |  |  |  | 单位：分 |
| note | text |  |  | ''::text |  |  |
| client_key | uuid |  | 是 |  |  |  |
| is_synthetic | boolean |  |  | false |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| voided_by | bigint |  | 是 |  | staff |  |
| voided_at | timestamp with time zone |  | 是 |  |  |  |
| void_reason | text |  | 是 |  |  |  |

### supplier_refunds

供应商退款（#25、#20） （建表：030_supplier_settlement）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('supplier_refunds_id_seq'::regclass) |  |  |
| doc_no | text |  |  |  |  |  |
| supplier_id | bigint |  |  |  | suppliers |  |
| refund_date | date |  |  |  |  |  |
| amount_cents | bigint |  |  |  |  | 单位：分 |
| method | text |  |  |  |  |  |
| evidence | text |  |  |  |  |  |
| note | text |  |  | ''::text |  |  |
| credit_payment_id | bigint |  | 是 |  | payments | 退的是哪一笔：预付款，或退货单（挂账的退货余额；现付供应商的退货） |
| credit_return_id | bigint |  | 是 |  | inv_docs |  |
| posts_ap | boolean |  |  |  |  | 挂账的记应付流水「供应商退款」；现付供应商的退货不记应付 |
| status | text |  |  |  |  |  |
| client_key | uuid |  | 是 |  |  |  |
| is_synthetic | boolean |  |  | false |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| voided_by | bigint |  | 是 |  | staff |  |
| voided_at | timestamp with time zone |  | 是 |  |  |  |
| void_reason | text |  | 是 |  |  |  |

### suppliers

浴族 yuzu · 库存与采购（增量迁移，不改动会员与储值数据） 约定： · 数量一律为整数「千分之一库存单位」(*_milli，bigint)，金额一律为整数「分」，不使用浮点数； · 单据行保存当时的单位与换算快照，物料包装变更不会改写历史； （建表：002_inventory）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('suppliers_id_seq'::regclass) |  |  |
| code | text |  |  |  |  |  |
| name | text |  |  |  |  |  |
| contact | text |  |  | ''::text |  |  |
| phone | text |  |  | ''::text |  |  |
| note | text |  |  | ''::text |  |  |
| active | boolean |  |  | true |  |  |
| is_synthetic | boolean |  |  | false |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| settlement | text |  |  | 'credit'::text |  | 供应商的结算方式；收货与退货记下确认时的结算方式 credit = 挂账（月结 / 按批次结算，收货记应付）；cash = 现付（下单时付清，收货不记应付，货款走费用报销） |
| import_id | bigint |  | 是 |  | erp_imports |  |
| reconcile_cycle | text |  |  | 'monthly'::text |  |  |
| reconcile_since | date |  | 是 |  |  |  |
| default_channel | text |  | 是 |  |  |  |
| contracted | boolean |  |  | false |  |  |
| admission | text |  |  | 'approved'::text |  |  |
| admission_note | text |  |  | ''::text |  |  |
| admission_by | bigint |  | 是 |  | staff |  |
| admission_at | timestamp with time zone |  | 是 |  |  |  |
| bank_payee | text |  |  | ''::text |  |  |
| bank_name | text |  |  | ''::text |  |  |
| bank_account | text |  |  | ''::text |  |  |
| bank_changed_by | bigint |  | 是 |  | staff |  |
| bank_changed_at | timestamp with time zone |  | 是 |  |  |  |
| bank_verified_by | bigint |  | 是 |  | staff |  |
| bank_verified_at | timestamp with time zone |  | 是 |  |  |  |

### table_events

桌台动作记录（只追加） （建表：188_dining_tables_v8115）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('table_events_id_seq'::regclass) |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| table_id | bigint |  |  |  | dining_tables |  |
| kind | text |  |  |  |  |  |
| session_id | bigint |  | 是 |  | table_sessions | 并台、拆台：这张桌上的开台、另一张桌与它的开台；这张桌是主台（main）还是附台（sub）。一次并台两张桌各记一条 |
| other_table_id | bigint |  | 是 |  | dining_tables |  |
| other_session_id | bigint |  | 是 |  | table_sessions |  |
| role | text |  | 是 |  |  |  |
| reason | text |  |  | ''::text |  | 维修的原因与预计恢复时间 |
| expected_back_at | timestamp with time zone |  | 是 |  |  |  |
| op_key | uuid |  |  |  |  |  |
| operator_id | bigint |  |  |  | staff |  |
| business_date | date |  |  |  |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### table_session_moves

转台记录（只追加）：账单跟着开台走，不跟着桌台走 （建表：023_dining_tables）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('table_session_moves_id_seq'::regclass) |  |  |
| session_id | bigint |  |  |  | table_sessions |  |
| from_table_id | bigint |  |  |  | dining_tables |  |
| to_table_id | bigint |  |  |  | dining_tables |  |
| reason | text |  |  |  |  |  |
| operator_id | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### table_session_returns

8.2.4 返台（只追加）：包房低消没够时，转挂账的单或已结账（还没清台）的单回到桌台继续点、补到低消。金额单位：分

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('table_session_returns_id_seq'::regclass) |  |  |
| store_id | bigint |  |  | yuzu_store() | stores | 门店 |
| session_id | bigint |  |  |  | table_sessions | 返台的开台 |
| table_id | bigint |  |  |  | dining_tables | 回到的桌台 |
| kind | text |  |  |  |  | parked 从转挂账回来 / settled 从已结账回来（同一事务里反结账那张结账单） |
| checkout_id | bigint |  | 是 |  | checkouts | 从已结账回来时反结账的结账单 |
| min_spend | bigint |  |  |  |  | 返台时这桌的低消（按房型、中消算好的） |
| subtotal | bigint |  |  |  |  | 返台时的菜钱（不算服务费、低消补足） |
| reason | text |  |  |  |  | 返台原因 |
| client_key | uuid |  |  |  |  | 操作编号：同一编号重提返回第一次的结果 |
| created_by | bigint |  |  |  | staff | 经办人 |
| created_at | timestamp with time zone |  |  |  |  | 返台时间 |

### table_sessions

开台：一桌一张账单 （建表：023_dining_tables）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('table_sessions_id_seq'::regclass) |  |  |
| session_no | text |  |  |  |  |  |
| bill_id | bigint |  |  |  | bills |  |
| table_id | bigint |  |  |  | dining_tables |  |
| guests | integer |  |  |  |  | 用餐人数（报表的结账客人按人数计） |
| guest_label | text |  |  | ''::text |  |  |
| member_id | bigint |  | 是 |  | members | 登记了会员的桌可以用这位会员的储值结账 |
| status | text |  |  | 'open'::text |  |  |
| business_date | date |  |  |  |  |  |
| opened_at | timestamp with time zone |  |  |  |  |  |
| opened_by | bigint |  |  |  | staff |  |
| open_key | uuid |  |  |  |  | 同一次开台的操作编号（结果待确认时据此查回） |
| closed_at | timestamp with time zone |  | 是 |  |  |  |
| closed_by | bigint |  | 是 |  | staff |  |
| close_reason | text |  | 是 |  |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| merged_into | bigint |  | 是 |  | table_sessions | 并台：附台的开台指向主台的开台 |
| parked_at | timestamp with time zone |  | 是 |  |  |  |
| parked_by | bigint |  | 是 |  | staff |  |
| park_reason | text |  | 是 |  |  |  |
| shared | boolean |  |  | false |  |  |

### tag_deposits

手牌押金（8.2.1）：客人外出留牌、去别的区域时收的押金；金额单位分。押金是负债，不算营业额；收、退都记经办人当班的班次（现金计入交班应有现金）。会员储值扣的记一张储值消费单，退的时候按原单撤销、退回原卡。只能从押着改成已退

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('tag_deposits_id_seq'::regclass) |  |  |
| store_id | bigint |  |  | yuzu_store() | stores | 门店 |
| deposit_no | text |  |  |  |  | 押金单号（YJ…） |
| visit_id | bigint |  |  |  | visits | 押在哪一次来访（手牌）上；换牌后跟着来访走 |
| method | text |  |  |  |  | 收的方式：cash 现金 / wechat 微信 / alipay 支付宝 / bank_card 银行卡 / wallet 会员储值 |
| amount | bigint |  |  |  |  | 押金金额（分） |
| member_id | bigint |  | 是 |  | members | 从哪位会员的储值扣的；不是储值的为空 |
| consumption_id | bigint |  | 是 |  | consumptions | 储值扣押金的那张消费单 |
| reason | text |  |  |  |  | 为什么收押金（外出留牌、去别的区域等） |
| ref | text |  |  | ''::text |  | 收款备注（例如微信单号后几位） |
| client_key | uuid |  |  |  |  | 收押金的操作编号 |
| shift_id | bigint |  | 是 |  | shifts | 收押金时经办人当班的班次 |
| business_date | date |  |  |  |  | 收押金的营业日 |
| staff_id | bigint |  |  |  | staff | 收押金的人 |
| created_at | timestamp with time zone |  |  | now() |  | 收押金的时间 |
| status | text |  |  | 'held'::text |  | held 押着 / refunded 已退 |
| refund_kind | text |  | 是 |  |  | 怎么退的：manual 一键退押金 / checkout 结账时退（抵扣）/ cancel 撤销来访时退 |
| refund_shift_id | bigint |  | 是 |  | shifts | 退押金时经办人当班的班次 |
| refund_business_date | date |  | 是 |  |  | 退押金的营业日 |
| refunded_by | bigint |  | 是 |  | staff | 退押金的人 |
| refunded_at | timestamp with time zone |  | 是 |  |  | 退押金的时间 |
| refund_reversal_id | bigint |  | 是 |  | reversals | 储值扣的押金退回原卡的那张撤销单 |
| checkout_id | bigint |  | 是 |  | checkouts | 结账时退的：那张结账单 |

### technician_announcer

主播报终端：一家店一行。client_id 是那个浏览器自己记的编号；空 = 现在没有终端负责播报 （建表：191_technician_admin）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| store_id | bigint | PK |  | yuzu_store() | stores |  |
| client_id | text |  | 是 |  |  |  |
| label | text |  |  | ''::text |  |  |
| claimed_by | bigint |  | 是 |  | staff |  |
| claimed_at | timestamp with time zone |  | 是 |  |  |  |
| seen_at | timestamp with time zone |  | 是 |  |  |  |

### technician_calls

叫号记录（只追加）：dispatch 派钟时自动叫、manual 手动叫号。text 是当时念的那一句（排位号、工号、花名、房间都按叫的那一刻） （建表：191_technician_admin）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('technician_calls_id_seq'::regclass) |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| technician_id | bigint |  |  |  | technicians |  |
| session_id | bigint |  | 是 |  | technician_sessions |  |
| kind | text |  |  |  |  |  |
| queue_position | integer |  | 是 |  |  |  |
| room | text |  |  | ''::text |  |  |
| text | text |  |  |  |  |  |
| business_date | date |  |  |  |  |  |
| staff_id | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### technician_events

v0.7.1 S6 技师第二步（ROADMAP 第 10 节）：钟房看板、轮钟排队、上下钟计时、提成。 · 钟单（technician_sessions）：一位技师给一位客人的一段连续服务（含加钟）。钱仍只在账单明细里，钟单只记钟数、时长与状态； 明细挂账时写上钟单编号（随明细只追加、不可改）。 （建表：021_clockroom）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('technician_events_id_seq'::regclass) |  |  |
| technician_id | bigint |  | 是 |  | technicians |  |
| session_id | bigint |  | 是 |  | technician_sessions |  |
| kind | text |  |  |  |  |  |
| detail | jsonb |  |  | '{}'::jsonb |  |  |
| business_date | date |  |  |  |  |  |
| staff_id | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### technician_groups

8.1.15 技师（docs/TECHNICIANS_V8115.md；《浴族系统需求汇总》技师 1–3）：技师管理（名册、组别、班次、休假）与排位播报。 ① 名册补四样：花名、类型（足浴 / 按摩 / SPA……清单在 settings 的 technician_kinds）、入职日期、离职日期； （建表：191_technician_admin）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('technician_groups_id_seq'::regclass) |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| name | text |  |  |  |  |  |
| leader_id | bigint |  | 是 |  | technicians | 组长是组里的一位技师（保存时核对）；没有组长为空 |
| sort_order | integer |  |  | 0 |  |  |
| active | boolean |  |  | true |  |  |
| note | text |  |  | ''::text |  |  |
| created_by | bigint |  | 是 |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### technician_leaves

休假单：pending 待审批 → approved 已批准 / rejected 已驳回；cancelled = 待审批时撤回，或批准以后销假。 client_key 是申请时的操作编号：同一个编号重提返回第一次建的那一张，不会建两张 （建表：191_technician_admin）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('technician_leaves_id_seq'::regclass) |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| technician_id | bigint |  |  |  | technicians |  |
| from_date | date |  |  |  |  |  |
| to_date | date |  |  |  |  |  |
| leave_type | text |  |  |  |  |  |
| reason | text |  |  |  |  |  |
| status | text |  |  | 'pending'::text |  |  |
| client_key | uuid |  |  |  |  |  |
| applied_by | bigint |  |  |  | staff |  |
| applied_at | timestamp with time zone |  |  | now() |  |  |
| decided_by | bigint |  | 是 |  | staff |  |
| decided_at | timestamp with time zone |  | 是 |  |  |  |
| decision_note | text |  |  | ''::text |  |  |
| cancelled_by | bigint |  | 是 |  | staff |  |
| cancelled_at | timestamp with time zone |  | 是 |  |  |  |
| cancel_reason | text |  |  | ''::text |  |  |
| auto_return | boolean |  |  | true |  | 休完自动上牌（8.2.2，默认是）：休完后的第一个营业日自动上牌、排到队尾 |
| returned_at | timestamp with time zone |  | 是 |  |  | 自动上牌处理过的时刻（上了牌，或那天已经有人手动改过状态、按手动的算）；没处理为空 |

### technician_photos

技师榜单第一批（docs/TECH_RANKING.md，店主 2026-11-24《技师榜单模块需求说明》）：名册上挂一张技师照片。 · 照片按门店存、按内容去重（同一家店同一张图只存一份），只追加；换照片只改技师上挂的是哪一张，旧图留着（审计里能对上）。 （建表：250_technician_ranking）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('technician_photos_id_seq'::regclass) |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| sha256 | text |  |  |  |  |  |
| mime | text |  |  |  |  |  |
| data | bytea |  |  |  |  |  |
| size_bytes | integer |  |  |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### technician_schedule

排班表：一位技师一天一格。shift_id 有值 = 上这个班；is_rest = 排休；两样都没有 = 没排（清掉的格子留着这一行，不删） （建表：191_technician_admin）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| technician_id | bigint | PK |  |  | technicians |  |
| work_date | date | PK |  |  |  |  |
| shift_id | bigint |  | 是 |  | technician_shifts |  |
| is_rest | boolean |  |  | false |  |  |
| updated_by | bigint |  | 是 |  | staff |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### technician_schedule_changes

排班的改动（只追加）：plan 排班、adjust 临时调班、swap 两人对调；临时调班、对调必须写原因 （建表：191_technician_admin）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('technician_schedule_changes_id_seq'::regclass) |  |  |
| technician_id | bigint |  |  |  | technicians |  |
| work_date | date |  |  |  |  |  |
| kind | text |  |  |  |  |  |
| from_shift_id | bigint |  | 是 |  | technician_shifts |  |
| from_rest | boolean |  |  | false |  |  |
| to_shift_id | bigint |  | 是 |  | technician_shifts |  |
| to_rest | boolean |  |  | false |  |  |
| swap_with | bigint |  | 是 |  | technicians |  |
| reason | text |  |  | ''::text |  |  |
| staff_id | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### technician_session_changes

换项目 / 换工种（8.2.2，只追加）：item 同一位技师换项目（钟单改项目、明细作废重挂），technician 换到原技师做不了的项目、换人做（原钟单收尾、原技师回原排位）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('technician_session_changes_id_seq'::regclass) |  |  |
| store_id | bigint |  |  | yuzu_store() | stores | 门店 |
| session_id | bigint |  |  |  | technician_sessions | 换之前的钟单 |
| new_session_id | bigint |  | 是 |  | technician_sessions | 换工种时新建的钟单（换给的技师）；同一位技师换项目为空 |
| kind | text |  |  |  |  | item 换项目（同一位技师）/ technician 换工种（换人） |
| from_item_id | bigint |  |  |  | service_items | 原来的项目 |
| to_item_id | bigint |  |  |  | service_items | 换成的项目 |
| reason | text |  |  |  |  | 原因（2–100 字） |
| created_by | bigint |  |  |  | staff | 经办人 |
| created_at | timestamp with time zone |  |  | now() |  | 换的时刻 |

### technician_sessions

v0.7.1 S6 技师第二步（ROADMAP 第 10 节）：钟房看板、轮钟排队、上下钟计时、提成。 · 钟单（technician_sessions）：一位技师给一位客人的一段连续服务（含加钟）。钱仍只在账单明细里，钟单只记钟数、时长与状态； 明细挂账时写上钟单编号（随明细只追加、不可改）。 （建表：021_clockroom）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('technician_sessions_id_seq'::regclass) |  |  |
| session_no | text |  |  |  |  |  |
| technician_id | bigint |  |  |  | technicians |  |
| visit_id | bigint |  |  |  | visits |  |
| item_id | bigint |  |  |  | service_items |  |
| call_type | text |  |  |  |  |  |
| clocks | integer |  |  |  |  | 钟数与计划时长（分钟），都含加钟 |
| minutes | integer |  |  |  |  |  |
| status | text |  |  | 'waiting'::text |  |  |
| business_date | date |  |  |  |  |  |
| queue_key_before | timestamp with time zone |  | 是 |  |  | 派钟前在轮钟队列里的位置：退钟、取消时按规则回到原位 |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| started_by | bigint |  | 是 |  | staff |  |
| started_at | timestamp with time zone |  | 是 |  |  |  |
| ended_by | bigint |  | 是 |  | staff |  |
| ended_at | timestamp with time zone |  | 是 |  |  |  |
| void_reason | text |  | 是 |  |  |  |
| space_id | bigint |  | 是 |  | spaces |  |
| space_version | integer |  |  | 0 |  | 房间的版本号：每换一次房间加 1。换房间的请求带上页面看到的版本号，对不上就拒绝——中间有过任何修改（哪怕又换回原来那间）， 超时后迟到的旧请求都不会盖掉后来的修改 |
| transferred_from | bigint |  | 是 |  | technician_sessions |  |
| booking_id | bigint |  | 是 |  | bookings |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| room_neutral | boolean |  |  | false |  |  |

### technician_shifts

班次：起止是当天的第几分钟（0–1439）；结束不晚于开始表示做到第二天 （建表：191_technician_admin）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('technician_shifts_id_seq'::regclass) |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| name | text |  |  |  |  |  |
| start_minute | integer |  |  |  |  |  |
| end_minute | integer |  |  |  |  |  |
| sort_order | integer |  |  | 0 |  |  |
| active | boolean |  |  | true |  |  |
| created_by | bigint |  | 是 |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### technician_status

v0.7.1 S6 技师第二步（ROADMAP 第 10 节）：钟房看板、轮钟排队、上下钟计时、提成。 · 钟单（technician_sessions）：一位技师给一位客人的一段连续服务（含加钟）。钱仍只在账单明细里，钟单只记钟数、时长与状态； 明细挂账时写上钟单编号（随明细只追加、不可改）。 （建表：021_clockroom）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| technician_id | bigint | PK |  |  | technicians |  |
| business_date | date |  |  |  |  | 状态只对这个营业日有效；换了营业日没有重新上牌的，按「未上牌」处理 |
| state | text |  |  |  |  |  |
| queue_key | timestamp with time zone |  |  |  |  |  |
| reject_streak | integer |  |  | 0 |  | 连续被退钟的次数（正常下钟后清零） |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| updated_by | bigint |  | 是 |  | staff |  |

### technician_targets

技师每月业绩任务（8.2.2）：按技师或按组设一个月的目标金额（分）与目标钟数；完成度按结账口径的技师业绩算。改目标是整月替换（审计里留改前改后）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('technician_targets_id_seq'::regclass) |  |  |
| store_id | bigint |  |  | yuzu_store() | stores | 门店 |
| month | date |  |  |  |  | 哪个月（当月 1 日） |
| technician_id | bigint |  | 是 |  | technicians | 按技师设的：技师；按组设的为空 |
| group_id | bigint |  | 是 |  | technician_groups | 按组设的：技师组；按技师设的为空 |
| amount_cents | bigint |  |  |  |  | 目标业绩金额（分） |
| clocks | integer |  | 是 |  |  | 目标钟数；不设为空 |
| updated_by | bigint |  |  |  | staff | 设目标的人 |
| updated_at | timestamp with time zone |  |  | now() |  | 设目标的时刻 |

### technicians

v0.7.0 S6 技师第一步（ROADMAP 第 10 节：先做技师名册和「挂技师项目时选技师」，钟房看板、轮钟排队、上下钟计时与提成在第二步） · 技师名册：工号、名字、性别、等级（对应价目表的「标准 / 专业 / 优选」价格档）、可做的项目分类；不删除，离职的停用； · 项目可标「需要技师」； （建表：020_technicians）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('technicians_id_seq'::regclass) |  |  |
| tech_no | text |  |  |  |  | 工号：1–6 位数字或字母，例如 08、A12；保存后不变 |
| name | text |  |  |  |  |  |
| gender | text |  |  |  |  |  |
| grade | text |  |  |  |  |  |
| skills | text[] |  |  | '{}'::text[] |  | 可做的项目分类（与项目的分类同名）；空为全部需要技师的项目 |
| active | boolean |  |  | true |  |  |
| sort_order | integer |  |  | 0 |  |  |
| note | text |  |  | ''::text |  |  |
| is_synthetic | boolean |  |  | false |  |  |
| created_by | bigint |  | 是 |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| suspended_at | timestamp with time zone |  | 是 |  |  |  |
| suspended_reason | text |  | 是 |  |  |  |
| suspended_by | bigint |  | 是 |  | staff |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| nickname | text |  |  | ''::text |  |  |
| kind | text |  |  | ''::text |  |  |
| hired_on | date |  | 是 |  |  |  |
| left_on | date |  | 是 |  |  |  |
| group_id | bigint |  | 是 |  | technician_groups |  |
| photo_id | bigint |  | 是 |  | technician_photos |  |
| photo_version | integer |  |  | 0 |  |  |
| phone | text |  |  | ''::text |  | 手机号（8.2.2，11 位；没留为空）；页面上打码显示 |
| height_cm | smallint |  | 是 |  |  | 身高（厘米，8.2.2）；没填为空 |
| weight_kg | smallint |  | 是 |  |  | 体重（公斤，8.2.2）；没填为空 |
| star | smallint |  | 是 |  |  | 星级（1–10，8.2.2）：提成可以按星级定；与价格档（等级）分开，价格档照旧决定价格 |

### ticket_types

① 票种（店主 #31 确认的票价；1 米以下儿童免票为 ❓3 的默认做法，待确认） （建表：014_checkout）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('ticket_types_id_seq'::regclass) |  |  |
| name | text |  |  |  |  |  |
| price_12h | bigint |  |  |  |  | 12 小时档 / 24 小时档的价格（分）；免票两档都为 0 |
| price_24h | bigint |  |  |  |  |  |
| note | text |  |  | ''::text |  |  |
| active | boolean |  |  | true |  |  |
| is_default | boolean |  |  | false |  | 接待时默认选中的票种（最多一个） |
| sort_order | integer |  |  | 0 |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| meals_12h | smallint |  |  | 0 |  | 8.2.8：12 小时档含几餐（餐厅入口登记时抵扣，0 = 不含餐） |
| meals_24h | smallint |  |  | 0 |  | 8.2.8：24 小时档（在店满 12 小时以后）含几餐 |

### visit_category_changes

发牌以后改客人类别的记录（8.2.3，只追加）：进这次来访的经办记录

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('visit_category_changes_id_seq'::regclass) |  |  |
| visit_id | bigint |  |  |  | visits | 哪一次来访 |
| from_category | text |  |  |  |  | 原来的类别（空 = 默认类别） |
| to_category | text |  |  |  |  | 改成的类别 |
| operator_id | bigint |  |  |  | staff | 经办人 |
| created_at | timestamp with time zone |  |  | now() |  | 改的时间 |

### visit_group_events

同行组进出记录 （建表：004_frontdesk）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('visit_group_events_id_seq'::regclass) |  |  |
| group_id | bigint |  |  |  | visit_groups |  |
| visit_id | bigint |  |  |  | visits |  |
| action | text |  |  |  |  |  |
| operator_id | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### visit_groups

同行组（联牌） （建表：004_frontdesk）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('visit_groups_id_seq'::regclass) |  |  |
| group_no | text |  |  |  |  |  |
| status | text |  |  | 'open'::text |  |  |
| business_date | date |  |  |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| closed_at | timestamp with time zone |  | 是 |  |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |

### visit_incident_events

待办的处理记录（只追加）：指派给谁、处理结果。一条待办只能写一次处理结果。 （建表：187_frontdesk_risk）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('visit_incident_events_id_seq'::regclass) |  |  |
| incident_id | bigint |  |  |  | visit_incidents |  |
| action | text |  |  |  |  |  |
| assignee_id | bigint |  | 是 |  | staff |  |
| note | text |  |  | ''::text |  |  |
| operator_id | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### visit_incidents

3. 来访异常 一行一件事，只追加：提醒、加收、上报、临时外出、返回、未结离店。上报、未结离店是「待办」，处理结果另记在 visit_incident_events。 （建表：187_frontdesk_risk）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('visit_incidents_id_seq'::regclass) |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| visit_id | bigint |  |  |  | visits |  |
| member_id | bigint |  | 是 |  | members | 当时这位客人是哪位会员（散客为空）：未结离店按它在下次发牌时拦下来授权 |
| kind | text |  |  |  |  |  |
| note | text |  |  | ''::text |  |  |
| amount_cents | bigint |  | 是 |  |  | 加收的金额、未结离店的应收（分） |
| bill_line_id | bigint |  | 是 |  | bill_lines | 加收挂到账单上的那条明细（手动金额的明细，走原来的挂账） |
| approved_by | bigint |  | 是 |  | staff | 加收由别人当场授权时的授权人（值班经理及以上自己加收的为空） |
| assignee_id | bigint |  | 是 |  | staff | 上报、未结离店登记时指给的责任人（之后改派记在处理记录里） |
| op_key | uuid |  |  |  |  | 这一次操作的编号：一个编号一条，原样重提返回第一次的结果 |
| business_date | date |  |  |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| overtime_hours | smallint |  | 是 |  |  | 2. 超时提醒（BW-1）：异常多一种，记着是哪一级 |

### visit_remark_removals

8.1.44（docs/V8144_CASHIER.md 第 1、2 条）：前台备注——记经办人与时间，分「同组备注」与「单人备注」，可带一个标签（客诉、特殊关照……）。 收银台的「备注」板块与发卡台客人卡上的备注是同一份数据，不另建两套。 · visit_remarks：一条备注（只追加）。 （建表：350_visit_remarks）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('visit_remark_removals_id_seq'::regclass) |  |  |
| remark_id | bigint |  |  |  | visit_remarks |  |
| reason | text |  |  |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### visit_remark_resolutions

客诉台账（8.2.3）：带「客诉」「特殊关照」等标签的前台备注标「已处理」（只追加，一条备注只能标一次）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('visit_remark_resolutions_id_seq'::regclass) |  |  |
| remark_id | bigint |  |  |  | visit_remarks | 哪一条前台备注 |
| note | text |  |  |  |  | 处理结果 |
| created_by | bigint |  |  |  | staff | 标已处理的人 |
| created_at | timestamp with time zone |  |  | now() |  | 标已处理的时间 |

### visit_remarks

8.1.44（docs/V8144_CASHIER.md 第 1、2 条）：前台备注——记经办人与时间，分「同组备注」与「单人备注」，可带一个标签（客诉、特殊关照……）。 收银台的「备注」板块与发卡台客人卡上的备注是同一份数据，不另建两套。 · visit_remarks：一条备注（只追加）。 （建表：350_visit_remarks）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('visit_remarks_id_seq'::regclass) |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| visit_id | bigint |  |  |  | visits |  |
| scope | text |  |  |  |  |  |
| group_id | bigint |  | 是 |  | visit_groups | 同组备注：写的时候这位客人所在的同行组；单人备注为空 |
| tag | text |  |  | ''::text |  |  |
| note | text |  |  |  |  |  |
| op_key | uuid |  |  |  |  | 这一次操作的编号：一个编号一条，原样重提返回第一次的结果 |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### visit_risk_alerts

高风险提示推送过的记录（8.2.3）：在店超过设定小时数、挂账超过设定金额时推给值班经理或店总（站内通知），每位客人每一样只推一次

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('visit_risk_alerts_id_seq'::regclass) |  |  |
| visit_id | bigint |  |  |  | visits | 哪一次来访 |
| reason | text |  |  |  |  | stay 在店时间长 / amount 挂账金额大 |
| threshold | bigint |  |  |  |  | 推的时候的阈值：stay 是小时数，amount 是金额（分） |
| observed | bigint |  |  |  |  | 推的时候的实际值：stay 是在店分钟数，amount 是挂账金额（分） |
| notify_level | text |  |  |  |  | 推给谁：duty_manager 值班经理及以上 / store_manager 店总及店主 |
| recipients | integer |  |  |  |  | 推给了几个人 |
| created_at | timestamp with time zone |  |  | now() |  | 推的时间 |

### visit_tag_changes

换牌记录：账单跟着来访走，不跟着手牌走 （建表：004_frontdesk）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('visit_tag_changes_id_seq'::regclass) |  |  |
| visit_id | bigint |  |  |  | visits |  |
| from_tag_id | bigint |  |  |  | hand_tags |  |
| to_tag_id | bigint |  |  |  | hand_tags |  |
| reason | text |  |  |  |  |  |
| old_tag_locked | boolean |  |  |  |  |  |
| operator_id | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| vip_override_by | bigint |  | 是 |  | staff |  |

### visit_tag_locks

8.2.7 锁牌外出：在店客人外出时锁住他的手牌（最多 4 小时），锁之前先收预售（一张手牌押金，结账时抵扣）；锁着期间不能挂账

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('visit_tag_locks_id_seq'::regclass) |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| visit_id | bigint |  |  |  | visits |  |
| tag_id | bigint |  |  |  | hand_tags |  |
| locked_at | timestamp with time zone |  |  |  |  |  |
| lock_until | timestamp with time zone |  |  |  |  | 到这个时刻自动解锁（不超过锁牌时刻 + 4 小时） |
| reason | text |  |  |  |  |  |
| tag_deposit_id | bigint |  |  |  | tag_deposits | 锁牌前收的预售（手牌押金，原因「锁牌外出预收」），结账时照押金抵扣 |
| client_key | uuid |  |  |  |  |  |
| locked_by | bigint |  |  |  | staff |  |
| released_at | timestamp with time zone |  | 是 |  |  |  |
| released_by | bigint |  | 是 |  | staff |  |
| release_kind | text |  | 是 |  |  | return 客人回来解锁、expired 到时间自动解锁、checkout 结账时解锁；空 = 还锁着 |

### visit_ticket_changes

Batch 3 · S3.1–S3.3：门票 12 小时跳档、结账收款、团购券、会员储值结账（增量迁移） · 店主 2026-10-27 #31：男女宾、普通柜与 VIP 柜统一一套门票，每 12 小时跳一档（12 小时档 / 24 小时档）； ❓3 儿童 1 米以下免票（做成可维护的票种）； （建表：014_checkout）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('visit_ticket_changes_id_seq'::regclass) |  |  |
| visit_id | bigint |  |  |  | visits |  |
| from_type_id | bigint |  | 是 |  | ticket_types |  |
| to_type_id | bigint |  |  |  | ticket_types |  |
| price_12h | bigint |  |  |  |  |  |
| price_24h | bigint |  |  |  |  |  |
| operator_id | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| approved_by | bigint |  | 是 |  | staff |  |
| reason | text |  | 是 |  |  |  |

### visits

来访：一人一牌，一次来访一张账单 （建表：004_frontdesk）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('visits_id_seq'::regclass) |  |  |
| visit_no | text |  |  |  |  |  |
| bill_id | bigint |  |  |  | bills |  |
| tag_id | bigint |  |  |  | hand_tags |  |
| zone | text |  |  |  |  |  |
| member_id | bigint |  | 是 |  | members |  |
| guest_label | text |  |  | ''::text |  |  |
| group_id | bigint |  | 是 |  | visit_groups |  |
| status | text |  |  | 'open'::text |  |  |
| business_date | date |  |  |  |  |  |
| checked_in_at | timestamp with time zone |  |  |  |  |  |
| checked_in_by | bigint |  |  |  | staff |  |
| checkin_key | uuid |  |  |  |  | 同一次接待（含同行多人）共用一个操作编号；重复提交时据此查回同一批来访 |
| closed_at | timestamp with time zone |  | 是 |  |  |  |
| closed_by | bigint |  | 是 |  | staff |  |
| close_reason | text |  | 是 |  |  |  |
| vip_override_by | bigint |  | 是 |  | staff | 开牌时的 VIP 授权人；换牌的授权记在换牌记录上 |
| ticket_type_id | bigint |  | 是 |  | ticket_types |  |
| ticket_price_12h | bigint |  | 是 |  |  |  |
| ticket_price_24h | bigint |  | 是 |  |  |  |
| ticket_end_at | timestamp with time zone |  | 是 |  |  | ④ 门票计到的时间：反结账时写入第一次结账的时刻（多次反结账仍是第一次），之后结账按它计价 |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| away_since | timestamp with time zone |  | 是 |  |  |  |
| away_by | bigint |  | 是 |  | staff |  |
| risk_approved_by | bigint |  | 是 |  | staff |  |
| risk_approved_at | timestamp with time zone |  | 是 |  |  |  |
| risk_reason | text |  | 是 |  |  |  |
| guest_category | text |  |  | ''::text |  | 客人类别（8.2.3）：发牌时选的（普通、港客、外宾、儿童……，后台「客人与提醒」的清单）；空 = 默认类别（升级前的来访） |

### warehouse_stock

部门小仓的结存（总仓的结存仍记在 materials.stock_milli / last_move_id） （建表：029_warehouses）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| warehouse_id | bigint | PK |  |  | warehouses |  |
| material_id | bigint | PK |  |  | materials |  |
| stock_milli | bigint |  |  | 0 |  |  |
| last_move_id | bigint |  | 是 |  |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### warehouses

仓库：一个总仓（id = 1）+ 每个部门一个小仓 （建表：029_warehouses）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('warehouses_id_seq'::regclass) |  |  |
| kind | text |  |  |  |  |  |
| department_id | bigint |  | 是 |  | departments |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| store_id | bigint |  |  | 1 | stores |  |
| name | text |  | 是 |  |  |  |

### web_push_keys

这个实例的网页推送钥匙（VAPID，P-256）：第一次用到时生成，只有一行（换了钥匙，员工手机上原来的订阅就都收不到了）。 私钥只在服务端发推送时用：不进设置、不给页面、不写日志 （建表：120_canteen_push）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | smallint | PK |  | 1 |  |  |
| public_key | text |  |  |  |  |  |
| private_key | text |  |  |  |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### wecom_pushes

8.0.7 A4 企业微信每周一推（docs/ERP_V807.md 第 4 节，V19、V20）：推送记录。 · 每周一 9:00（门店时区）以后，开关打开、服务器 .env 配了 ERP_WECOM_WEBHOOK 时，每分钟的自动任务把本周应付、待审批、 快到期的（质保金、合同、证照、批次）、逾期应收推到企业微信群机器人；同一周只推一次：period_key（那一周的周一）的部分唯一索引兜底， 几个进程同时跑也只有一个认领到。 （建表：104_wecom_pushes）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('wecom_pushes_id_seq'::regclass) |  |  |
| kind | text |  |  |  |  |  |
| period_key | date |  | 是 |  |  | weekly：那一周的周一（门店时区）；test 为空 |
| status | text |  |  |  |  |  |
| content | text |  |  | ''::text |  |  |
| error | text |  | 是 |  |  |  |
| attempts | integer |  |  | 1 |  |  |
| claimed_until | timestamp with time zone |  | 是 |  |  |  |
| created_by | bigint |  | 是 |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| finished_at | timestamp with time zone |  | 是 |  |  |  |

### wormhole_stays

福田店整改批次 4（2026-11-26《福田店餐饮与房态中心整改需求文档》，docs/FUTIAN_1126.md）： · 休息大厅分区（FT-15）：后台自定义分区（A 区、第一排……），床位（休息大厅一类的空间）归到分区里；开单选床位时按分区列； （建表：471_hall_wormhole）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('wormhole_stays_id_seq'::regclass) |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| space_id | bigint |  |  |  | spaces |  |
| visit_id | bigint |  |  |  | visits |  |
| gender | text |  |  |  |  |  |
| bill_line_id | bigint |  | 是 |  | bill_lines | 费用那一行（挂在手牌账单上；不收费的为空） |
| fee_cents | integer |  |  | 0 |  | 单位：分 |
| status | text |  |  | 'open'::text |  |  |
| open_key | uuid |  |  |  |  |  |
| opened_at | timestamp with time zone |  |  |  |  |  |
| opened_by | bigint |  |  |  | staff |  |
| closed_at | timestamp with time zone |  | 是 |  |  |  |
| closed_by | bigint |  | 是 |  | staff |  |

### zones

区域 （建表：032_spaces）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('zones_id_seq'::regclass) |  |  |
| floor_id | bigint |  |  |  | floors |  |
| name | text |  |  |  |  |  |
| name_en | text |  |  | ''::text |  |  |
| note | text |  |  | ''::text |  |  |
| sort_order | integer |  |  | 0 |  |  |
| active | boolean |  |  | true |  |  |
| import_id | bigint |  | 是 |  | space_imports |  |
| version | integer |  |  | 1 |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| guide_kind | text |  |  | 'public'::text |  | ② 对客导览 导览分类：动区（暖色）、静区（冷色）、公共（浅中性色）、后场（不显示）；颜色可单独指定 |
| guide_color | text |  | 是 |  |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |

## 业财法审批（gf_）

### gf_alloc_rule_versions

460 业财法 P07：人力资源付款批次与费用分摊引擎（docs/APPROVAL_V4.md 第 11 节）。 · gf_docs 的事项类型加 hr_batch（HR 付款批次）； · gf_hr_batches：批次（批次号唯一、类型、期间、原批次、人数、总额、凭证、账户摘要）； （建表：460_gf_hr）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| rule_id | bigint | PK |  |  | gf_alloc_rules |  |
| version | integer | PK |  |  |  |  |
| splits | jsonb |  |  |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### gf_alloc_rules

460 业财法 P07：人力资源付款批次与费用分摊引擎（docs/APPROVAL_V4.md 第 11 节）。 · gf_docs 的事项类型加 hr_batch（HR 付款批次）； · gf_hr_batches：批次（批次号唯一、类型、期间、原批次、人数、总额、凭证、账户摘要）； （建表：460_gf_hr）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('gf_alloc_rules_id_seq'::regclass) |  |  |
| name | text |  |  |  |  |  |
| version | integer |  |  | 1 |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### gf_alloc_runs

460 业财法 P07：人力资源付款批次与费用分摊引擎（docs/APPROVAL_V4.md 第 11 节）。 · gf_docs 的事项类型加 hr_batch（HR 付款批次）； · gf_hr_batches：批次（批次号唯一、类型、期间、原批次、人数、总额、凭证、账户摘要）； （建表：460_gf_hr）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('gf_alloc_runs_id_seq'::regclass) |  |  |
| rule_id | bigint |  |  |  | gf_alloc_rule_versions |  |
| rule_version | integer |  |  |  | gf_alloc_rule_versions |  |
| source_doc_id | bigint |  | 是 |  | gf_docs |  |
| kind | text |  |  |  |  |  |
| amount_cents | bigint |  |  |  |  | 单位：分 |
| lines | jsonb |  |  |  |  |  |
| reverses_run_id | bigint |  | 是 |  | gf_alloc_runs |  |
| reason | text |  |  | ''::text |  |  |
| client_key | uuid |  |  |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### gf_cc

400 业财法审批流 P01：审批引擎与角色底座（店主 2026-11-26，设计见 docs/APPROVAL_V4.md）。 · gf_role_members：角色映射（财务审核人、财总、CFO、法务、CEO、董事长……），店主配置；可按经营主体（法人）限定，撤销只记时间不删； （建表：400_govflow_core）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('gf_cc_id_seq'::regclass) |  |  |
| doc_id | bigint |  |  |  | gf_docs |  |
| staff_id | bigint |  |  |  | staff |  |
| role | text |  |  |  |  |  |
| urgent | boolean |  |  |  |  |  |
| reason | text |  |  | ''::text |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| notified_at | timestamp with time zone |  | 是 |  |  | 即时提醒的写入时就发；日报的发了日报再填 |
| read_at | timestamp with time zone |  | 是 |  |  |  |

### gf_contract_versions

430 业财法 P04：七类合同审批（docs/APPROVAL_V4.md 第 8 节）。 · gf_docs 的事项类型加 contract（合同；合同号、类型、金额口径、经济实质、明细都在 payload）； （建表：430_gf_contract）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('gf_contract_versions_id_seq'::regclass) |  |  |
| doc_id | bigint |  |  |  | gf_docs |  |
| version | integer |  |  |  |  |  |
| kind | text |  |  |  |  |  |
| approval_cents | bigint |  |  |  |  | 单位：分 |
| fields | text[] |  |  | '{}'::text[] |  |  |
| reason | text |  |  | ''::text |  |  |
| new_doc_id | bigint |  | 是 |  | gf_docs | 核心变更重新路由的新事项 |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### gf_dept_quotas

420 业财法 P03：零星采购与备用金额度（docs/APPROVAL_V4.md 第 7 节）。 · gf_settings：业财法的设置（哪个部门是采购部门）； · gf_dept_quotas：部门备用金额度（日 / 月），月度核定通过后从次月起生效，不自动升降；没有行的按默认日 1 万、月 5 万； （建表：420_gf_petty）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('gf_dept_quotas_id_seq'::regclass) |  |  |
| department_id | bigint |  |  |  | departments |  |
| effective_month | date |  |  |  |  | 从哪个月起生效（每月 1 日） |
| daily_cents | bigint |  |  |  |  | 单位：分 |
| monthly_cents | bigint |  |  |  |  | 单位：分 |
| doc_id | bigint |  |  |  | gf_docs |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### gf_docs

400 业财法审批流 P01：审批引擎与角色底座（店主 2026-11-26，设计见 docs/APPROVAL_V4.md）。 · gf_role_members：角色映射（财务审核人、财总、CFO、法务、CEO、董事长……），店主配置；可按经营主体（法人）限定，撤销只记时间不删； （建表：400_govflow_core）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('gf_docs_id_seq'::regclass) |  |  |
| biz_no | text |  |  |  |  |  |
| doc_type | text |  |  |  |  |  |
| title | text |  |  |  |  |  |
| note | text |  |  | ''::text |  |  |
| entity_id | bigint |  | 是 |  | legal_entities |  |
| department_id | bigint |  | 是 |  | departments |  |
| amount_cents | bigint |  | 是 |  |  | 审批口径的金额（不含税，分）；无金额的为空 |
| payload | jsonb |  |  | '{}'::jsonb |  |  |
| flags | text[] |  |  | '{}'::text[] |  |  |
| performer_id | bigint |  | 是 |  | staff |  |
| subject_staff_id | bigint |  | 是 |  | staff |  |
| related_doc_id | bigint |  | 是 |  | gf_docs |  |
| client_key | uuid |  |  |  |  |  |
| request_hash | text |  |  |  |  |  |
| version | integer |  |  | 1 |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| withdrawn_at | timestamp with time zone |  | 是 |  |  |  |
| withdrawn_by | bigint |  | 是 |  | staff |  |
| exec_started_at | timestamp with time zone |  | 是 |  |  |  |
| exec_started_by | bigint |  | 是 |  | staff |  |
| completed_at | timestamp with time zone |  | 是 |  |  |  |
| completed_by | bigint |  | 是 |  | staff |  |
| archived_at | timestamp with time zone |  | 是 |  |  |  |
| archived_by | bigint |  | 是 |  | staff |  |
| due_on | date |  | 是 |  |  | 执行 / 补登的期限（逾期按这个算） |
| backfill_open | boolean |  |  | false |  | 完成后还有没交的后补（发票、最终版……） |

### gf_files

400 业财法审批流 P01：审批引擎与角色底座（店主 2026-11-26，设计见 docs/APPROVAL_V4.md）。 · gf_role_members：角色映射（财务审核人、财总、CFO、法务、CEO、董事长……），店主配置；可按经营主体（法人）限定，撤销只记时间不删； （建表：400_govflow_core）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('gf_files_id_seq'::regclass) |  |  |
| owner_type | text |  |  |  |  |  |
| owner_id | bigint |  |  |  |  |  |
| purpose | text |  |  |  |  |  |
| file_name | text |  |  |  |  |  |
| mime | text |  |  |  |  |  |
| size_bytes | integer |  |  |  |  |  |
| sha256 | text |  |  |  |  |  |
| content | bytea |  |  |  |  |  |
| uploaded_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### gf_flow_actions

400 业财法审批流 P01：审批引擎与角色底座（店主 2026-11-26，设计见 docs/APPROVAL_V4.md）。 · gf_role_members：角色映射（财务审核人、财总、CFO、法务、CEO、董事长……），店主配置；可按经营主体（法人）限定，撤销只记时间不删； （建表：400_govflow_core）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('gf_flow_actions_id_seq'::regclass) |  |  |
| flow_id | bigint |  |  |  | gf_flows |  |
| level | integer |  |  |  |  |  |
| action | text |  |  |  |  |  |
| seat | text |  |  |  |  | 坐的哪一席：角色、dept_head、performer |
| actor_id | bigint |  |  |  | staff |  |
| comment | text |  |  | ''::text |  |  |
| client_key | uuid |  | 是 |  |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### gf_flows

400 业财法审批流 P01：审批引擎与角色底座（店主 2026-11-26，设计见 docs/APPROVAL_V4.md）。 · gf_role_members：角色映射（财务审核人、财总、CFO、法务、CEO、董事长……），店主配置；可按经营主体（法人）限定，撤销只记时间不删； （建表：400_govflow_core）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('gf_flows_id_seq'::regclass) |  |  |
| doc_id | bigint |  |  |  | gf_docs |  |
| round | integer |  |  |  |  |  |
| nodes | jsonb |  |  |  |  |  |
| notes | text[] |  |  | '{}'::text[] |  |  |
| current_level | integer |  |  | 1 |  |  |
| status | text |  |  | 'pending'::text |  |  |
| submitted_by | bigint |  |  |  | staff |  |
| submitted_at | timestamp with time zone |  |  | now() |  |  |
| level_started_at | timestamp with time zone |  |  | now() |  |  |
| finished_at | timestamp with time zone |  | 是 |  |  |  |
| finished_by | bigint |  | 是 |  | staff |  |

### gf_hr_batch_lines

460 业财法 P07：人力资源付款批次与费用分摊引擎（docs/APPROVAL_V4.md 第 11 节）。 · gf_docs 的事项类型加 hr_batch（HR 付款批次）； · gf_hr_batches：批次（批次号唯一、类型、期间、原批次、人数、总额、凭证、账户摘要）； （建表：460_gf_hr）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('gf_hr_batch_lines_id_seq'::regclass) |  |  |
| batch_id | bigint |  |  |  | gf_hr_batches |  |
| staff_id | bigint |  |  |  | staff |  |
| amount_cents | bigint |  |  |  |  | 单位：分 |
| account | text |  |  |  |  |  |
| cost_dept_id | bigint |  |  |  | departments |  |

### gf_hr_batches

460 业财法 P07：人力资源付款批次与费用分摊引擎（docs/APPROVAL_V4.md 第 11 节）。 · gf_docs 的事项类型加 hr_batch（HR 付款批次）； · gf_hr_batches：批次（批次号唯一、类型、期间、原批次、人数、总额、凭证、账户摘要）； （建表：460_gf_hr）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('gf_hr_batches_id_seq'::regclass) |  |  |
| doc_id | bigint |  |  |  | gf_docs |  |
| batch_no | text |  |  |  |  |  |
| kind | text |  |  |  |  |  |
| period | text |  |  |  |  |  |
| department_id | bigint |  |  |  | departments |  |
| original_batch_id | bigint |  | 是 |  | gf_hr_batches |  |
| headcount | integer |  |  |  |  |  |
| total_cents | bigint |  |  |  |  | 单位：分 |
| accounts_digest | text |  |  |  |  |  |
| evidence | jsonb |  |  |  |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### gf_hr_checks

460 业财法 P07：人力资源付款批次与费用分摊引擎（docs/APPROVAL_V4.md 第 11 节）。 · gf_docs 的事项类型加 hr_batch（HR 付款批次）； · gf_hr_batches：批次（批次号唯一、类型、期间、原批次、人数、总额、凭证、账户摘要）； （建表：460_gf_hr）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('gf_hr_checks_id_seq'::regclass) |  |  |
| batch_id | bigint |  |  |  | gf_hr_batches |  |
| ok | boolean |  |  |  |  |  |
| mismatches | text[] |  |  | '{}'::text[] |  |  |
| checked_by | bigint |  |  |  | staff |  |
| checked_at | timestamp with time zone |  |  | now() |  |  |

### gf_hr_payouts

460 业财法 P07：人力资源付款批次与费用分摊引擎（docs/APPROVAL_V4.md 第 11 节）。 · gf_docs 的事项类型加 hr_batch（HR 付款批次）； · gf_hr_batches：批次（批次号唯一、类型、期间、原批次、人数、总额、凭证、账户摘要）； （建表：460_gf_hr）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('gf_hr_payouts_id_seq'::regclass) |  |  |
| batch_id | bigint |  |  |  | gf_hr_batches |  |
| bank_ref | text |  |  |  |  |  |
| paid_by | bigint |  |  |  | staff |  |
| paid_at | timestamp with time zone |  |  | now() |  |  |

### gf_license_loans

450 业财法 P06：报销、出差、商务招待、用印证照（docs/APPROVAL_V4.md 第 10 节）。 · gf_docs 的事项类型加 expense（报销）、travel（出差申请）、entertain（商务招待）、seal_use（用印证照）； （建表：450_gf_expense）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('gf_license_loans_id_seq'::regclass) |  |  |
| license_id | bigint |  |  |  | gf_licenses |  |
| doc_id | bigint |  |  |  | gf_docs |  |
| borrower_id | bigint |  |  |  | staff |  |
| lent_by | bigint |  |  |  | staff |  |
| lent_at | timestamp with time zone |  |  | now() |  |  |
| due_on | date |  |  |  |  |  |
| returned_at | timestamp with time zone |  | 是 |  |  |  |
| returned_to | bigint |  | 是 |  | staff |  |

### gf_licenses

450 业财法 P06：报销、出差、商务招待、用印证照（docs/APPROVAL_V4.md 第 10 节）。 · gf_docs 的事项类型加 expense（报销）、travel（出差申请）、entertain（商务招待）、seal_use（用印证照）； （建表：450_gf_expense）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('gf_licenses_id_seq'::regclass) |  |  |
| name | text |  |  |  |  |  |
| kind | text |  |  |  |  |  |
| entity_id | bigint |  | 是 |  | legal_entities |  |
| active | boolean |  |  | true |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### gf_materials

410 业财法 P02：供应商与商品 SKU 两级库（docs/APPROVAL_V4.md 第 6 节）。 · gf_materials：集团物料（SKU 映射到它）； · gf_suppliers：一级供应商库，统一社会信用代码唯一；状态 待准入 / 审核中 / 已入库 / 停用 / 退出； （建表：410_gf_supply）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('gf_materials_id_seq'::regclass) |  |  |
| code | text |  |  |  |  |  |
| name | text |  |  |  |  |  |
| category | text |  |  |  |  |  |
| unit | text |  |  |  |  |  |
| core | boolean |  |  | false |  |  |
| active | boolean |  |  | true |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### gf_overdue_reviews

420 业财法 P03：零星采购与备用金额度（docs/APPROVAL_V4.md 第 7 节）。 · gf_settings：业财法的设置（哪个部门是采购部门）； · gf_dept_quotas：部门备用金额度（日 / 月），月度核定通过后从次月起生效，不自动升降；没有行的按默认日 1 万、月 5 万； （建表：420_gf_petty）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('gf_overdue_reviews_id_seq'::regclass) |  |  |
| staff_id | bigint |  |  |  | staff |  |
| reviewed_by | bigint |  |  |  | staff |  |
| note | text |  |  |  |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### gf_payouts

440 业财法 P05：付款与紧急特批（docs/APPROVAL_V4.md 第 9 节）。 · gf_docs 的事项类型加 payment（付款申请，含税金额；合同、付款节点、验收依据、发票、收款账户快照都在 payload）； （建表：440_gf_payment）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('gf_payouts_id_seq'::regclass) |  |  |
| doc_id | bigint |  |  |  | gf_docs |  |
| amount_cents | bigint |  |  |  |  | 单位：分 |
| payee_account | text |  |  |  |  |  |
| bank_ref | text |  |  |  |  |  |
| client_key | uuid |  |  |  |  |  |
| paid_by | bigint |  |  |  | staff |  |
| paid_at | timestamp with time zone |  |  | now() |  |  |

### gf_quota_ledger

420 业财法 P03：零星采购与备用金额度（docs/APPROVAL_V4.md 第 7 节）。 · gf_settings：业财法的设置（哪个部门是采购部门）； · gf_dept_quotas：部门备用金额度（日 / 月），月度核定通过后从次月起生效，不自动升降；没有行的按默认日 1 万、月 5 万； （建表：420_gf_petty）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('gf_quota_ledger_id_seq'::regclass) |  |  |
| department_id | bigint |  |  |  | departments |  |
| biz_date | date |  |  |  |  |  |
| kind | text |  |  |  |  | freeze 冻结、unfreeze 解冻（取消 / 驳回 / 验收时转出）、use 实际占用、reverse 冲正（追加负数，不删历史） |
| amount_cents | bigint |  |  |  |  | 单位：分 |
| doc_id | bigint |  |  |  | gf_docs |  |
| note | text |  |  | ''::text |  |  |
| op_key | text |  |  |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### gf_quota_specials

420 业财法 P03：零星采购与备用金额度（docs/APPROVAL_V4.md 第 7 节）。 · gf_settings：业财法的设置（哪个部门是采购部门）； · gf_dept_quotas：部门备用金额度（日 / 月），月度核定通过后从次月起生效，不自动升降；没有行的按默认日 1 万、月 5 万； （建表：420_gf_petty）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('gf_quota_specials_id_seq'::regclass) |  |  |
| special_no | text |  |  |  |  |  |
| doc_id | bigint |  |  |  | gf_docs |  |
| over_daily | boolean |  |  |  |  |  |
| over_monthly | boolean |  |  |  |  |  |
| purchase_dept | boolean |  |  | false |  |  |
| over_cents | bigint |  |  |  |  | 单位：分 |
| created_at | timestamp with time zone |  |  | now() |  |  |

### gf_role_members

400 业财法审批流 P01：审批引擎与角色底座（店主 2026-11-26，设计见 docs/APPROVAL_V4.md）。 · gf_role_members：角色映射（财务审核人、财总、CFO、法务、CEO、董事长……），店主配置；可按经营主体（法人）限定，撤销只记时间不删； （建表：400_govflow_core）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('gf_role_members_id_seq'::regclass) |  |  |
| role | text |  |  |  |  |  |
| staff_id | bigint |  |  |  | staff |  |
| entity_id | bigint |  | 是 |  | legal_entities | 空 = 所有经营主体 |
| note | text |  |  | ''::text |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| revoked_by | bigint |  | 是 |  | staff |  |
| revoked_at | timestamp with time zone |  | 是 |  |  |  |

### gf_settings

420 业财法 P03：零星采购与备用金额度（docs/APPROVAL_V4.md 第 7 节）。 · gf_settings：业财法的设置（哪个部门是采购部门）； · gf_dept_quotas：部门备用金额度（日 / 月），月度核定通过后从次月起生效，不自动升降；没有行的按默认日 1 万、月 5 万； （建表：420_gf_petty）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| key | text | PK |  |  |  |  |
| value | jsonb |  |  |  |  |  |
| updated_by | bigint |  |  |  | staff |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### gf_sku_prices

410 业财法 P02：供应商与商品 SKU 两级库（docs/APPROVAL_V4.md 第 6 节）。 · gf_materials：集团物料（SKU 映射到它）； · gf_suppliers：一级供应商库，统一社会信用代码唯一；状态 待准入 / 审核中 / 已入库 / 停用 / 退出； （建表：410_gf_supply）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('gf_sku_prices_id_seq'::regclass) |  |  |
| sku_id | bigint |  |  |  | gf_skus |  |
| version | integer |  |  |  |  |  |
| price_cents | bigint |  |  |  |  | 单位：分 |
| tax_rate_bp | integer |  |  |  |  |  |
| doc_id | bigint |  |  |  | gf_docs |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### gf_skus

410 业财法 P02：供应商与商品 SKU 两级库（docs/APPROVAL_V4.md 第 6 节）。 · gf_materials：集团物料（SKU 映射到它）； · gf_suppliers：一级供应商库，统一社会信用代码唯一；状态 待准入 / 审核中 / 已入库 / 停用 / 退出； （建表：410_gf_supply）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('gf_skus_id_seq'::regclass) |  |  |
| sku_code | text |  |  |  |  |  |
| supplier_id | bigint |  |  |  | gf_suppliers |  |
| material_id | bigint |  |  |  | gf_materials |  |
| name | text |  |  |  |  |  |
| spec | text |  |  | ''::text |  |  |
| unit | text |  |  |  |  |  |
| price_cents | bigint |  |  |  |  | 提报价 / 现行协议价（不含税，分）与税率（万分比） |
| price_version | integer |  |  | 0 |  |  |
| tax_rate_bp | integer |  |  | 0 |  |  |
| entity_ids | bigint[] |  |  | '{}'::bigint[] |  |  |
| formats | text[] |  |  | '{}'::text[] |  |  |
| status | text |  |  | 'reviewing'::text |  |  |
| doc_id | bigint |  | 是 |  | gf_docs |  |
| pending_change_doc_id | bigint |  | 是 |  | gf_docs |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### gf_specials

400 业财法审批流 P01：审批引擎与角色底座（店主 2026-11-26，设计见 docs/APPROVAL_V4.md）。 · gf_role_members：角色映射（财务审核人、财总、CFO、法务、CEO、董事长……），店主配置；可按经营主体（法人）限定，撤销只记时间不删； （建表：400_govflow_core）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('gf_specials_id_seq'::regclass) |  |  |
| special_no | text |  |  |  |  |  |
| doc_id | bigint |  | 是 |  | gf_docs |  |
| title | text |  |  |  |  |  |
| amount_cents | bigint |  |  |  |  | 单位：分 |
| reason | text |  |  |  |  |  |
| confirmer_ids | bigint[] |  |  |  |  |  |
| confirmed_at | timestamp with time zone |  |  |  |  |  |
| due_on | date |  |  |  |  |  |
| registered_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| client_key | uuid |  |  |  |  |  |
| request_hash | text |  |  |  |  |  |
| backfilled_at | timestamp with time zone |  | 是 |  |  |  |
| backfilled_by | bigint |  | 是 |  | staff |  |
| backfill_note | text |  |  | ''::text |  |  |
| payee_account | text |  | 是 |  |  |  |

### gf_supplier_versions

410 业财法 P02：供应商与商品 SKU 两级库（docs/APPROVAL_V4.md 第 6 节）。 · gf_materials：集团物料（SKU 映射到它）； · gf_suppliers：一级供应商库，统一社会信用代码唯一；状态 待准入 / 审核中 / 已入库 / 停用 / 退出； （建表：410_gf_supply）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('gf_supplier_versions_id_seq'::regclass) |  |  |
| supplier_id | bigint |  |  |  | gf_suppliers |  |
| version | integer |  |  |  |  |  |
| snapshot | jsonb |  |  |  |  |  |
| doc_id | bigint |  | 是 |  | gf_docs |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### gf_suppliers

410 业财法 P02：供应商与商品 SKU 两级库（docs/APPROVAL_V4.md 第 6 节）。 · gf_materials：集团物料（SKU 映射到它）； · gf_suppliers：一级供应商库，统一社会信用代码唯一；状态 待准入 / 审核中 / 已入库 / 停用 / 退出； （建表：410_gf_supply）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('gf_suppliers_id_seq'::regclass) |  |  |
| supplier_no | text |  |  |  |  |  |
| name | text |  |  |  |  |  |
| credit_code | text |  |  |  |  |  |
| categories | text[] |  |  | '{general}'::text[] |  |  |
| contact | text |  |  | ''::text |  |  |
| phone | text |  |  | ''::text |  |  |
| address | text |  |  | ''::text |  |  |
| bank_name | text |  |  | ''::text |  |  |
| bank_account | text |  |  | ''::text |  |  |
| account_name | text |  |  | ''::text |  |  |
| qualifications | jsonb |  |  | '[]'::jsonb |  |  |
| note | text |  |  | ''::text |  |  |
| status | text |  |  | 'pending'::text |  |  |
| legacy | boolean |  |  | false |  |  |
| version | integer |  |  | 1 |  |  |
| admission_doc_id | bigint |  | 是 |  | gf_docs |  |
| pending_change_doc_id | bigint |  | 是 |  | gf_docs |  |
| client_key | uuid |  | 是 |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### gf_travel_budgets

450 业财法 P06：报销、出差、商务招待、用印证照（docs/APPROVAL_V4.md 第 10 节）。 · gf_docs 的事项类型加 expense（报销）、travel（出差申请）、entertain（商务招待）、seal_use（用印证照）； （建表：450_gf_expense）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| department_id | bigint | PK |  |  | departments |  |
| month | date | PK |  |  |  |  |
| budget_cents | bigint |  |  |  |  | 单位：分 |
| updated_by | bigint |  |  |  | staff |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### gf_travel_ledger

450 业财法 P06：报销、出差、商务招待、用印证照（docs/APPROVAL_V4.md 第 10 节）。 · gf_docs 的事项类型加 expense（报销）、travel（出差申请）、entertain（商务招待）、seal_use（用印证照）； （建表：450_gf_expense）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('gf_travel_ledger_id_seq'::regclass) |  |  |
| department_id | bigint |  |  |  | departments |  |
| month | date |  |  |  |  |  |
| kind | text |  |  |  |  |  |
| amount_cents | bigint |  |  |  |  | 单位：分 |
| doc_id | bigint |  |  |  | gf_docs |  |
| op_key | text |  |  |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

## 办公 OA（oa_）

### oa_announcement_reads

员工办公 v1.1 第 5 批（docs/OA_MOBILE.md 第 5 节）： · oa_announcements：公司 / 部门公告（置顶、全员或指定部门、正文、附件、发布 / 撤回与乐观锁版本号）； · oa_announcement_reads：员工已读记录（每人每条公告一行）； （建表：294_oa_announcements_and_kb_search）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| announcement_id | bigint | PK |  |  | oa_announcements |  |
| staff_id | bigint | PK |  |  | staff |  |
| read_at | timestamp with time zone |  |  | now() |  |  |

### oa_announcements

员工办公 v1.1 第 5 批（docs/OA_MOBILE.md 第 5 节）： · oa_announcements：公司 / 部门公告（置顶、全员或指定部门、正文、附件、发布 / 撤回与乐观锁版本号）； · oa_announcement_reads：员工已读记录（每人每条公告一行）； （建表：294_oa_announcements_and_kb_search）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('oa_announcements_id_seq'::regclass) |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| title | text |  |  |  |  |  |
| body | text |  |  |  |  |  |
| scope | text |  |  |  |  |  |
| target_depts | text[] |  |  | '{}'::text[] |  |  |
| pinned | boolean |  |  | false |  |  |
| status | text |  |  | 'published'::text |  |  |
| published_by | bigint |  |  |  | staff |  |
| published_at | timestamp with time zone |  |  | now() |  |  |
| recalled_by | bigint |  | 是 |  | staff |  |
| recalled_at | timestamp with time zone |  | 是 |  |  |  |
| recall_reason | text |  |  | ''::text |  |  |
| version | integer |  |  | 1 |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### oa_approval_cc

OA-10 办公审批引擎（docs/OA.md 第 13 节；需求文档五（一））。另建，不动审批中心。 · oa_approval_templates：模板 = 元数据。 （建表：219_oa_approvals）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| approval_id | bigint | PK |  |  | oa_approvals |  |
| staff_id | bigint | PK |  |  | staff |  |
| read_at | timestamp with time zone |  | 是 |  |  |  |

### oa_approval_events

OA-10 办公审批引擎（docs/OA.md 第 13 节；需求文档五（一））。另建，不动审批中心。 · oa_approval_templates：模板 = 元数据。 （建表：219_oa_approvals）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('oa_approval_events_id_seq'::regclass) |  |  |
| approval_id | bigint |  |  |  | oa_approvals |  |
| actor_id | bigint |  |  |  | staff |  |
| kind | text |  |  |  |  |  |
| step_id | bigint |  | 是 |  | oa_approval_steps |  |
| to_staff_id | bigint |  | 是 |  | staff |  |
| comment | text |  |  | ''::text |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### oa_approval_steps

OA-10 办公审批引擎（docs/OA.md 第 13 节；需求文档五（一））。另建，不动审批中心。 · oa_approval_templates：模板 = 元数据。 （建表：219_oa_approvals）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('oa_approval_steps_id_seq'::regclass) |  |  |
| approval_id | bigint |  |  |  | oa_approvals |  |
| seq | integer |  |  |  |  |  |
| label | text |  |  |  |  |  |
| approver_id | bigint |  |  |  | staff |  |
| original_approver_id | bigint |  | 是 |  | staff |  |
| status | text |  |  |  |  |  |
| transferred_to | bigint |  | 是 |  | oa_approval_steps |  |
| comment | text |  |  | ''::text |  |  |
| acted_at | timestamp with time zone |  | 是 |  |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### oa_approval_templates

OA-10 办公审批引擎（docs/OA.md 第 13 节；需求文档五（一））。另建，不动审批中心。 · oa_approval_templates：模板 = 元数据。 （建表：219_oa_approvals）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('oa_approval_templates_id_seq'::regclass) |  |  |
| code | text |  |  |  |  |  |
| name | text |  |  |  |  |  |
| description | text |  |  | ''::text |  |  |
| fields | jsonb |  |  |  |  |  |
| levels | jsonb |  |  |  |  |  |
| conditions | jsonb |  |  | '{}'::jsonb |  |  |
| cc | jsonb |  |  | '[]'::jsonb |  |  |
| active | boolean |  |  | true |  |  |
| sort | integer |  |  | 0 |  |  |
| version | integer |  |  | 1 |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### oa_approvals

OA-10 办公审批引擎（docs/OA.md 第 13 节；需求文档五（一））。另建，不动审批中心。 · oa_approval_templates：模板 = 元数据。 （建表：219_oa_approvals）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('oa_approvals_id_seq'::regclass) |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| template_id | bigint |  |  |  | oa_approval_templates |  |
| template_code | text |  |  |  |  |  |
| template_name | text |  |  |  |  |  |
| fields | jsonb |  |  |  |  |  |
| applicant_id | bigint |  |  |  | staff |  |
| title | text |  |  |  |  |  |
| form | jsonb |  |  |  |  |  |
| status | text |  |  | 'pending'::text |  |  |
| revision | integer |  |  | 1 |  |  |
| previous_id | bigint |  | 是 |  | oa_approvals |  |
| submitted_at | timestamp with time zone |  |  | now() |  |  |
| finished_at | timestamp with time zone |  | 是 |  |  |  |
| last_urged_at | timestamp with time zone |  | 是 |  |  |  |
| version | integer |  |  | 1 |  |  |

### oa_attachments

OA-03 站内通知与附件（docs/OA.md 第 6 节）。只加新表，不改已有的表与数据。 · oa_notifications：每位员工的站内通知（哪一类、标题、内容、点开去哪一页、关联的单据）。只追加：已读只记时间； （建表：212_oa_notifications_attachments）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('oa_attachments_id_seq'::regclass) |  |  |
| client_key | uuid |  |  |  |  | 操作编号：上传没收到结果时原样重提，返回原来那一个，不再存一份 |
| uploaded_by | bigint |  |  |  | staff |  |
| file_name | text |  |  |  |  |  |
| mime | text |  |  |  |  |  |
| size_bytes | integer |  |  |  |  |  |
| sha256 | text |  |  |  |  |  |
| data | bytea |  |  |  |  |  |
| thumb | bytea |  | 是 |  |  |  |
| ref_type | text |  | 是 |  |  |  |
| ref_id | bigint |  | 是 |  |  |  |
| bound_at | timestamp with time zone |  | 是 |  |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### oa_attendance_covers

OA-13 考勤与审批联动（docs/OA.md 第 16 节；需求文档四（五）表 4-1、待确认第 7 条）。 · oa_attendance_covers：审批通过以后对考勤的覆盖（请假、出差），每张单每天一行。part = full 整天 / am 上午 / pm 下午； （建表：222_oa_attendance_link）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('oa_attendance_covers_id_seq'::regclass) |  |  |
| staff_id | bigint |  |  |  | staff |  |
| work_date | date |  |  |  |  |  |
| kind | text |  |  |  |  |  |
| part | text |  |  |  |  |  |
| halves | integer |  |  | 0 |  |  |
| leave_type_id | bigint |  | 是 |  | oa_leave_types |  |
| approval_id | bigint |  |  |  | oa_approvals |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### oa_attendance_daily

OA-08 考勤结算（docs/OA.md 第 11 节；需求文档四（五））。 · oa_attendance_daily：每条排班（员工 + 业务日期 + 班次）结算成一条。下班窗口结束以后才结算； （建表：217_oa_attendance_daily）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('oa_attendance_daily_id_seq'::regclass) |  |  |
| store_id | bigint |  |  |  | stores |  |
| staff_id | bigint |  |  |  | staff |  |
| business_date | date |  |  |  |  |  |
| shift_id | bigint |  |  |  | oa_shifts |  |
| status | text |  |  |  |  |  |
| late_minutes | integer |  |  | 0 |  |  |
| early_minutes | integer |  |  | 0 |  |  |
| missing_in | boolean |  |  | false |  |  |
| missing_out | boolean |  |  | false |  |  |
| in_punch_id | bigint |  | 是 |  | oa_punches |  |
| out_punch_id | bigint |  | 是 |  | oa_punches |  |
| outwork | boolean |  |  | false |  |  |
| outwork_counted | boolean |  |  | true |  |  |
| outwork_by | bigint |  | 是 |  | staff |  |
| outwork_at | timestamp with time zone |  | 是 |  |  |  |
| face_pending | boolean |  |  | false |  |  |
| notified | boolean |  |  | false |  |  |
| settled_at | timestamp with time zone |  |  | now() |  |  |
| cover | text |  | 是 |  |  |  |
| cover_approval_id | bigint |  | 是 |  | oa_approvals |  |

### oa_attendance_groups

OA-04 考勤组、班次、打卡点（docs/OA.md 第 7 节；需求文档四（一）、四（二））。 · oa_shifts：班次（上下班时间按「当天第几分钟」存，下班不晚于上班 = 跨天班）与打卡窗口的几个时长（默认值 OA9）； · oa_locations：打卡点（经纬度、有效半径）； （建表：213_oa_attendance_setup）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('oa_attendance_groups_id_seq'::regclass) |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| name | text |  |  |  |  |  |
| gps_required | boolean |  |  | true |  |  |
| face_required | boolean |  |  | false |  |  |
| active | boolean |  |  | true |  |  |
| version | integer |  |  | 1 |  |  |
| created_by | bigint |  | 是 |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_by | bigint |  | 是 |  | staff |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### oa_face_enrollments

OA-07 人脸录入与审核（docs/OA.md 第 10 节；需求文档四（四）第 3 条）。 · oa_face_enrollments：员工每提交一次一行（3 张照片挂在 oa_attachments 上，ref_type = 'oa_face'）。 （建表：216_oa_face）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('oa_face_enrollments_id_seq'::regclass) |  |  |
| staff_id | bigint |  |  |  | staff |  |
| status | text |  |  | 'pending'::text |  |  |
| submitted_at | timestamp with time zone |  |  | now() |  |  |
| reviewed_by | bigint |  | 是 |  | staff |  |
| reviewed_at | timestamp with time zone |  | 是 |  |  |  |
| review_note | text |  | 是 |  |  |  |

### oa_group_locations

OA-04 考勤组、班次、打卡点（docs/OA.md 第 7 节；需求文档四（一）、四（二））。 · oa_shifts：班次（上下班时间按「当天第几分钟」存，下班不晚于上班 = 跨天班）与打卡窗口的几个时长（默认值 OA9）； · oa_locations：打卡点（经纬度、有效半径）； （建表：213_oa_attendance_setup）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| group_id | bigint | PK |  |  | oa_attendance_groups |  |
| location_id | bigint | PK |  |  | oa_locations |  |

### oa_group_members

一位员工只在一个考勤组里（主键是员工） （建表：213_oa_attendance_setup）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| staff_id | bigint | PK |  |  | staff |  |
| group_id | bigint |  |  |  | oa_attendance_groups |  |
| joined_at | timestamp with time zone |  |  | now() |  |  |

### oa_holiday_years

OA-13 考勤与审批联动（docs/OA.md 第 16 节；需求文档四（五）表 4-1、待确认第 7 条）。 · oa_attendance_covers：审批通过以后对考勤的覆盖（请假、出差），每张单每天一行。part = full 整天 / am 上午 / pm 下午； （建表：222_oa_attendance_link）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| year | integer | PK |  |  |  |  |
| version | integer |  |  | 1 |  |  |
| updated_by | bigint |  | 是 |  | staff |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### oa_holidays

OA-13 考勤与审批联动（docs/OA.md 第 16 节；需求文档四（五）表 4-1、待确认第 7 条）。 · oa_attendance_covers：审批通过以后对考勤的覆盖（请假、出差），每张单每天一行。part = full 整天 / am 上午 / pm 下午； （建表：222_oa_attendance_link）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| day | date | PK |  |  |  |  |
| kind | text |  |  |  |  |  |
| name | text |  |  |  |  |  |

### oa_im_conversations

OA-14 即时通讯：会话与消息（docs/OA.md 第 17 节；需求文档六（一）、九（二）第 6 条）。 · oa_im_conversations：kind = direct 单聊 / group 群聊。单聊的 direct_key = 两人编号小的在前（「3:8」），同两个人只有一个单聊； 群聊有群名与群主。 （建表：223_oa_im）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('oa_im_conversations_id_seq'::regclass) |  |  |
| kind | text |  |  |  |  |  |
| name | text |  | 是 |  |  |  |
| direct_key | text |  | 是 |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| last_message_id | bigint |  | 是 |  | oa_im_messages |  |
| last_message_at | timestamp with time zone |  |  | now() |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| dept_key | text |  | 是 |  | org_departments |  |
| notice | text |  | 是 |  |  |  |
| notice_by | bigint |  | 是 |  | staff |  |
| notice_at | timestamp with time zone |  | 是 |  |  |  |
| dissolved_at | timestamp with time zone |  | 是 |  |  |  |

### oa_im_members

OA-14 即时通讯：会话与消息（docs/OA.md 第 17 节；需求文档六（一）、九（二）第 6 条）。 · oa_im_conversations：kind = direct 单聊 / group 群聊。单聊的 direct_key = 两人编号小的在前（「3:8」），同两个人只有一个单聊； 群聊有群名与群主。 （建表：223_oa_im）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| conversation_id | bigint | PK |  |  | oa_im_conversations |  |
| staff_id | bigint | PK |  |  | staff |  |
| role | text |  |  | 'member'::text |  |  |
| last_read_message_id | bigint |  |  | 0 |  |  |
| joined_at | timestamp with time zone |  |  | now() |  |  |
| left_at | timestamp with time zone |  | 是 |  |  |  |
| source | text |  |  | 'manual'::text |  |  |

### oa_im_messages

OA-14 即时通讯：会话与消息（docs/OA.md 第 17 节；需求文档六（一）、九（二）第 6 条）。 · oa_im_conversations：kind = direct 单聊 / group 群聊。单聊的 direct_key = 两人编号小的在前（「3:8」），同两个人只有一个单聊； 群聊有群名与群主。 （建表：223_oa_im）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('oa_im_messages_id_seq'::regclass) |  |  |
| conversation_id | bigint |  |  |  | oa_im_conversations |  |
| sender_id | bigint |  |  |  | staff |  |
| kind | text |  |  |  |  |  |
| body | text |  |  | ''::text |  |  |
| attachment_id | bigint |  | 是 |  | oa_attachments |  |
| mentions | bigint[] |  |  | '{}'::bigint[] |  |  |
| mention_all | boolean |  |  | false |  |  |
| client_key | uuid |  | 是 |  |  |  |
| request_hash | text |  | 是 |  |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| revoked_at | timestamp with time zone |  | 是 |  |  |  |

### oa_leave_balances

OA-09 假期余额（docs/OA.md 第 12 节；需求文档四（五））。考勤月报按 oa_attendance_daily 现算，不另建表。 · oa_leave_types：假种（全公司一份）。 （建表：218_oa_leave）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| staff_id | bigint | PK |  |  | staff |  |
| leave_type_id | bigint | PK |  |  | oa_leave_types |  |
| year | integer | PK |  |  |  |  |
| granted_halves | integer |  |  | 0 |  |  |
| used_halves | integer |  |  | 0 |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### oa_leave_entries

OA-09 假期余额（docs/OA.md 第 12 节；需求文档四（五））。考勤月报按 oa_attendance_daily 现算，不另建表。 · oa_leave_types：假种（全公司一份）。 （建表：218_oa_leave）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('oa_leave_entries_id_seq'::regclass) |  |  |
| staff_id | bigint |  |  |  | oa_leave_balances, staff |  |
| leave_type_id | bigint |  |  |  | oa_leave_balances, oa_leave_types |  |
| year | integer |  |  |  | oa_leave_balances |  |
| kind | text |  |  |  |  |  |
| halves | integer |  |  |  |  |  |
| reason | text |  |  | ''::text |  |  |
| ref_type | text |  | 是 |  |  |  |
| ref_id | bigint |  | 是 |  |  |  |
| created_by | bigint |  | 是 |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### oa_leave_types

OA-09 假期余额（docs/OA.md 第 12 节；需求文档四（五））。考勤月报按 oa_attendance_daily 现算，不另建表。 · oa_leave_types：假种（全公司一份）。 （建表：218_oa_leave）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('oa_leave_types_id_seq'::regclass) |  |  |
| name | text |  |  |  |  |  |
| paid | boolean |  |  |  |  |  |
| proof_required | boolean |  |  | false |  |  |
| has_balance | boolean |  |  | false |  |  |
| annual_tiers | jsonb |  | 是 |  |  |  |
| active | boolean |  |  | true |  |  |
| sort | integer |  |  | 0 |  |  |
| version | integer |  |  | 1 |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### oa_locations

OA-04 考勤组、班次、打卡点（docs/OA.md 第 7 节；需求文档四（一）、四（二））。 · oa_shifts：班次（上下班时间按「当天第几分钟」存，下班不晚于上班 = 跨天班）与打卡窗口的几个时长（默认值 OA9）； · oa_locations：打卡点（经纬度、有效半径）； （建表：213_oa_attendance_setup）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('oa_locations_id_seq'::regclass) |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| name | text |  |  |  |  |  |
| address | text |  |  | ''::text |  |  |
| lat | numeric(9,6) |  |  |  |  | 经纬度（WGS-84，小数点后 6 位，约 0.1 米） |
| lng | numeric(9,6) |  |  |  |  |  |
| radius_m | integer |  |  | 300 |  |  |
| active | boolean |  |  | true |  |  |
| version | integer |  |  | 1 |  |  |
| created_by | bigint |  | 是 |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_by | bigint |  | 是 |  | staff |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### oa_notifications

OA-03 站内通知与附件（docs/OA.md 第 6 节）。只加新表，不改已有的表与数据。 · oa_notifications：每位员工的站内通知（哪一类、标题、内容、点开去哪一页、关联的单据）。只追加：已读只记时间； （建表：212_oa_notifications_attachments）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('oa_notifications_id_seq'::regclass) |  |  |
| staff_id | bigint |  |  |  | staff |  |
| kind | text |  |  |  |  |  |
| title | text |  |  |  |  |  |
| body | text |  |  | ''::text |  |  |
| link | text |  | 是 |  |  |  |
| ref_type | text |  | 是 |  |  |  |
| ref_id | bigint |  | 是 |  |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| refreshed_at | timestamp with time zone |  |  | now() |  |  |
| read_at | timestamp with time zone |  | 是 |  |  |  |

### oa_payroll_audit

OA-17 工资条模板与制表（docs/OA.md 第 20 节；需求文档七（一）、七（三））。 · oa_payslip_templates：工资条模板（字段：名称、类型 money 金额 / number 数字 / text 文字、哪一项是「实发」），HR 在后台维护；停用不删。 （建表：225_oa_payroll）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('oa_payroll_audit_id_seq'::regclass) |  |  |
| staff_id | bigint |  | 是 |  | staff |  |
| action | text |  |  |  |  |  |
| batch_id | bigint |  | 是 |  | oa_payroll_batches |  |
| target_id | bigint |  | 是 |  | staff |  |
| file_id | bigint |  | 是 |  | oa_payroll_files |  |
| ip | text |  | 是 |  |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### oa_payroll_batches

OA-17 工资条模板与制表（docs/OA.md 第 20 节；需求文档七（一）、七（三））。 · oa_payslip_templates：工资条模板（字段：名称、类型 money 金额 / number 数字 / text 文字、哪一项是「实发」），HR 在后台维护；停用不删。 （建表：225_oa_payroll）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('oa_payroll_batches_id_seq'::regclass) |  |  |
| month | text |  |  |  |  |  |
| title | text |  |  |  |  |  |
| template_id | bigint |  |  |  | oa_payslip_templates |  |
| fields | jsonb |  |  |  |  |  |
| status | text |  |  | 'draft'::text |  |  |
| store_ids | bigint[] |  | 是 |  |  | 门店范围：建表人能管的门店（排好序）；空 = 全部门店（总裁建的）。名单按它取，别的门店的 HR 看不到（Codex 安全审查 f6c14e7） |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_by | bigint |  | 是 |  | staff |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| voided_by | bigint |  | 是 |  | staff |  |
| voided_at | timestamp with time zone |  | 是 |  |  |  |
| published_at | timestamp with time zone |  | 是 |  |  |  |
| published_by | bigint |  | 是 |  | staff |  |
| reminded_at | timestamp with time zone |  | 是 |  |  |  |

### oa_payroll_files

OA-17 工资条模板与制表（docs/OA.md 第 20 节；需求文档七（一）、七（三））。 · oa_payslip_templates：工资条模板（字段：名称、类型 money 金额 / number 数字 / text 文字、哪一项是「实发」），HR 在后台维护；停用不删。 （建表：225_oa_payroll）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('oa_payroll_files_id_seq'::regclass) |  |  |
| batch_id | bigint |  |  |  | oa_payroll_batches |  |
| file_name | text |  |  |  |  |  |
| size | integer |  |  |  |  |  |
| sha256 | text |  |  |  |  |  |
| iv | bytea |  |  |  |  | AES-256-GCM：iv 12 字节、tag 16 字节；key_id = 密钥指纹（sha256 的前 16 位十六进制），换了密钥能认出来 |
| tag | bytea |  |  |  |  |  |
| ciphertext | bytea |  |  |  |  |  |
| key_id | text |  |  |  |  |  |
| row_count | integer |  |  |  |  |  |
| uploaded_by | bigint |  |  |  | staff |  |
| uploaded_at | timestamp with time zone |  |  | now() |  |  |

### oa_payslip_templates

OA-17 工资条模板与制表（docs/OA.md 第 20 节；需求文档七（一）、七（三））。 · oa_payslip_templates：工资条模板（字段：名称、类型 money 金额 / number 数字 / text 文字、哪一项是「实发」），HR 在后台维护；停用不删。 （建表：225_oa_payroll）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('oa_payslip_templates_id_seq'::regclass) |  |  |
| name | text |  |  |  |  |  |
| fields | jsonb |  |  |  |  |  |
| active | boolean |  |  | true |  |  |
| version | integer |  |  | 1 |  |  |
| created_by | bigint |  | 是 |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_by | bigint |  | 是 |  | staff |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### oa_payslips

OA-17 工资条模板与制表（docs/OA.md 第 20 节；需求文档七（一）、七（三））。 · oa_payslip_templates：工资条模板（字段：名称、类型 money 金额 / number 数字 / text 文字、哪一项是「实发」），HR 在后台维护；停用不删。 （建表：225_oa_payroll）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('oa_payslips_id_seq'::regclass) |  |  |
| batch_id | bigint |  |  |  | oa_payroll_batches |  |
| staff_id | bigint |  |  |  | staff |  |
| values | jsonb |  |  | '{}'::jsonb |  |  |
| updated_by | bigint |  | 是 |  | staff |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| signed_at | timestamp with time zone |  | 是 |  |  |  |
| viewed_at | timestamp with time zone |  | 是 |  |  |  |

### oa_punches

OA-06 打卡（docs/OA.md 第 9 节；需求文档四（四）、第十三节第 1、2 条）。 · oa_punches：打卡明细，只追加（不改不删）。 （建表：215_oa_punches）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('oa_punches_id_seq'::regclass) |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| staff_id | bigint |  |  |  | staff |  |
| punched_at | timestamp with time zone |  |  |  |  |  |
| kind | text |  |  |  |  |  |
| business_date | date |  |  |  |  |  |
| shift_id | bigint |  | 是 |  | oa_shifts |  |
| late_minutes | integer |  |  | 0 |  |  |
| early_minutes | integer |  |  | 0 |  |  |
| group_id | bigint |  | 是 |  | oa_attendance_groups |  |
| lat | numeric(9,6) |  | 是 |  |  |  |
| lng | numeric(9,6) |  | 是 |  |  |  |
| accuracy_m | integer |  | 是 |  |  |  |
| location_id | bigint |  | 是 |  | oa_locations |  |
| distance_m | integer |  | 是 |  |  |  |
| location_ok | boolean |  |  |  |  |  |
| outwork | boolean |  |  | false |  |  |
| outwork_reason | text |  | 是 |  |  |  |
| shared_location | boolean |  |  | false |  |  |
| device_info | text |  |  | ''::text |  |  |
| ip | text |  |  | ''::text |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| face_result | text |  | 是 |  |  |  |
| makeup_approval_id | bigint |  | 是 |  | oa_approvals |  |

### oa_schedule_grants

员工办公 v1.1 第 2 批（docs/OA_MOBILE.md 第 3、5 节；需求文档 5.2）：排班授权。 · oa_schedule_grants：人事（hr.attendance）或部门经理把本范围的排班权限授给下属（主管 / 部长 / 指定员工）。 （建表：292_oa_schedule_grants）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('oa_schedule_grants_id_seq'::regclass) |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| grantor_staff_id | bigint |  |  |  | staff |  |
| grantee_staff_id | bigint |  |  |  | staff |  |
| permissions | text[] |  |  |  |  |  |
| scope_type | text |  |  |  |  |  |
| scope_group_id | bigint |  | 是 |  | oa_attendance_groups |  |
| scope_dept_key | text |  | 是 |  | org_departments |  |
| scope_staff_ids | bigint[] |  | 是 |  |  |  |
| scope_cap_depts | text[] |  | 是 |  |  |  |
| valid_from | date |  |  |  |  |  |
| valid_to | date |  |  |  |  |  |
| grantee_position | text |  |  |  |  |  |
| note | text |  |  | ''::text |  |  |
| client_key | uuid |  |  |  |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| revoked_at | timestamp with time zone |  | 是 |  |  |  |
| revoked_by | bigint |  | 是 |  | staff |  |
| revoke_reason | text |  | 是 |  |  |  |

### oa_schedule_publishes

员工办公 v1.1 第 2 批（docs/OA_MOBILE.md 第 3、5 节；EO5）：排班「发布」才生效、才通知。 · oa_schedule_publishes：每次发布排班留一条记录（门店、考勤组、起止日期、涉及员工数与格子数、发布人、操作编号，只追加）。 （建表：291_oa_schedule_publish）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('oa_schedule_publishes_id_seq'::regclass) |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| group_id | bigint |  |  |  | oa_attendance_groups |  |
| from_date | date |  |  |  |  |  |
| to_date | date |  |  |  |  |  |
| staff_count | integer |  |  |  |  |  |
| cell_count | integer |  |  |  |  |  |
| published_by | bigint |  |  |  | staff |  |
| client_key | uuid |  |  |  |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### oa_schedules

OA-05 排班（docs/OA.md 第 8 节；需求文档四（三））。 · oa_schedules：某位员工某个业务日期上某个班次（业务日期 = 班次开始那天，跨天班的下班卡也记在这一天）。 同一人同一天可以有几个班次（连班），唯一键 员工 + 日期 + 班次；没排的日子按休息算（不存行）。 （建表：214_oa_schedules）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('oa_schedules_id_seq'::regclass) |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| staff_id | bigint |  |  |  | staff |  |
| work_date | date |  |  |  |  |  |
| shift_id | bigint |  |  |  | oa_shifts |  |
| consecutive | boolean |  |  | false |  |  |
| created_by | bigint |  | 是 |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_by | bigint |  | 是 |  | staff |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| status | text |  |  | 'published'::text |  |  |
| pending_delete | boolean |  |  | false |  |  |
| draft_consecutive | boolean |  | 是 |  |  |  |
| published_at | timestamp with time zone |  | 是 |  |  |  |
| published_by | bigint |  | 是 |  | staff |  |
| publish_id | bigint |  | 是 |  | oa_schedule_publishes |  |

### oa_shifts

OA-04 考勤组、班次、打卡点（docs/OA.md 第 7 节；需求文档四（一）、四（二））。 · oa_shifts：班次（上下班时间按「当天第几分钟」存，下班不晚于上班 = 跨天班）与打卡窗口的几个时长（默认值 OA9）； · oa_locations：打卡点（经纬度、有效半径）； （建表：213_oa_attendance_setup）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('oa_shifts_id_seq'::regclass) |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| name | text |  |  |  |  |  |
| start_minute | integer |  |  |  |  |  |
| end_minute | integer |  |  |  |  |  |
| rest_start_minute | integer |  | 是 |  |  | 休息段（可不填）：两个都有或都没有 |
| rest_end_minute | integer |  | 是 |  |  |  |
| in_advance_minutes | integer |  |  | 120 |  | 打卡窗口（分钟）：上班卡可提前、迟到弹性、上班窗口在上班后再开多久、下班窗口在下班前多久开始、下班卡可延后 |
| late_grace_minutes | integer |  |  | 0 |  |  |
| in_after_minutes | integer |  |  | 60 |  |  |
| out_before_minutes | integer |  |  | 60 |  |  |
| out_delay_minutes | integer |  |  | 120 |  |  |
| active | boolean |  |  | true |  |  |
| version | integer |  |  | 1 |  |  |
| created_by | bigint |  | 是 |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_by | bigint |  | 是 |  | staff |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### oa_staff_imports

OA-02 账号与批量开通（docs/OA.md 第 5 节）：后台「组织架构 → 批量开通」按表格一次建一批员工账号与员工档案。 · oa_staff_imports：一次开通一行——操作编号（同一编号只开一次）、文件名与摘要、开了哪些账号、经办人与时间。只追加； （建表：211_oa_staff_import）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('oa_staff_imports_id_seq'::regclass) |  |  |
| client_key | uuid |  |  |  |  |  |
| file_name | text |  |  |  |  |  |
| file_sha256 | text |  |  |  |  |  |
| staff_ids | bigint[] |  |  |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

## 小程序（mp_，小程序线）

### mp_banners

043 微信小程序第一期（小程序线，docs/MINIPROGRAM.md 第 12 节）： ① 小程序用的图片：门店、首页轮播、项目介绍（与采购单图片一样存在库里、随备份走，同一张图只存一份） ② 绑定记录：微信 openid ↔ 会员（只追加； （建表：043_miniprogram）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('mp_banners_id_seq'::regclass) |  |  |
| title | text |  |  |  |  |  |
| image_id | bigint |  |  |  | mp_images |  |
| link | text |  |  | 'none'::text |  | 点了去哪：不跳转、价目表、楼层导览、门店信息 |
| starts_on | date |  | 是 |  |  | 显示的营业日（含首尾；空 = 不限） |
| ends_on | date |  | 是 |  |  |  |
| sort_order | integer |  |  | 0 |  |  |
| active | boolean |  |  | true |  |  |
| client_key | uuid |  | 是 |  |  |  |
| version | integer |  |  | 1 |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_by | bigint |  | 是 |  | staff |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### mp_bindings

043 微信小程序第一期（小程序线，docs/MINIPROGRAM.md 第 12 节）： ① 小程序用的图片：门店、首页轮播、项目介绍（与采购单图片一样存在库里、随备份走，同一张图只存一份） ② 绑定记录：微信 openid ↔ 会员（只追加； （建表：043_miniprogram）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('mp_bindings_id_seq'::regclass) |  |  |
| openid | text |  | 是 |  |  | 小程序用户（网关用 wx.login 的 code 换来的 openid） |
| member_id | bigint |  |  |  | members |  |
| phone | text |  | 是 |  |  | 绑定时微信验证过的手机号（当时等于会员档案上的手机号） |
| mock | boolean |  |  | false |  | 模拟微信绑定的（只在 development 实例允许） |
| client_key | uuid |  |  |  |  | 网关带的操作编号：同一编号重提返回原来那次的结果 |
| bound_at | timestamp with time zone |  |  | now() |  |  |
| unbound_at | timestamp with time zone |  | 是 |  |  | 解绑：前台员工在会员详情里做，写原因、记经办人 |
| unbound_by | bigint |  | 是 |  | staff |  |
| unbind_reason | text |  | 是 |  |  |  |
| unbind_client_key | uuid |  | 是 |  |  |  |
| purged_at | timestamp with time zone |  | 是 |  |  | ③ 解绑满 3 年清除（MP16，docs/MP_PRIVACY.md：绑定期间保存，解绑后再保存 3 年，期满删除）： 绑定记录解绑满 3 年，去掉手机号与微信标识（openid），解绑原因换成固定的一句（原因是员工写的，可能写了手机号），记下清除时间； 同一条绑定下的线上充值单、领券记录、到期提醒的同意，去掉 openid（单子与记录照留：会员档案与储值是门店的账目，按账目的规定保存）； |

### mp_booking_ops

小程序第三期 3d：预约技师与派对房（小程序线，docs/MP_PHASE3.md 第 4 节；MP34–MP37；接主线 v0.7.28 的 bookings，迁移 053）。 ① mp_booking_ops：小程序的每一次预约、取消——操作编号、哪条绑定、哪位会员、哪张预约单。 （建表：063_mp_bookings）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('mp_booking_ops_id_seq'::regclass) |  |  |
| client_key | uuid |  |  |  |  |  |
| action | text |  |  |  |  | create 小程序预约、cancel 小程序取消 |
| binding_id | bigint |  |  |  | mp_bindings |  |
| member_id | bigint |  |  |  |  |  |
| booking_id | bigint |  |  |  | bookings |  |
| request_hash | text |  |  |  |  | 这次请求的摘要（项目或房间、时段、技师、人数、备注；取消是哪一张）：同一个编号重提时核对内容一样，不一样的拒绝 |
| created_at | timestamp with time zone |  |  | now() |  |  |

### mp_coupon_claims

小程序第二期 2c 线上领券（docs/MP_COUPONS.md；MP22、MP27）与 2d 原路退回（docs/MP_RECHARGE.md 第 9 节；MP21），小程序线。 （建表：048_mp_coupons_refunds）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('mp_coupon_claims_id_seq'::regclass) |  |  |
| client_key | uuid |  |  |  |  |  |
| template_id | bigint |  |  |  | coupon_templates |  |
| member_id | bigint |  |  |  | members |  |
| binding_id | bigint |  |  |  | mp_bindings |  |
| openid | text |  | 是 |  |  |  |
| seq | integer |  |  |  |  | 这位会员这张券模板领的第几张（从 1 起） |
| issue_id | bigint |  |  |  | coupon_issues |  |
| coupon_id | bigint |  |  |  | coupons |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### mp_food_orders

小程序第三期 3c：扫码点餐（小程序线，docs/MP_PHASE3.md 第 3 节；MP32、MP33）。 ① mp_food_orders：小程序下的每一单——哪条绑定、哪位会员、挂在哪次来访（手牌）、出品单号、送到哪张桌、合计， 以及下单那一刻点了什么（名称、份数、金额、口味备注； （建表：062_mp_food）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('mp_food_orders_id_seq'::regclass) |  |  |
| client_key | uuid |  |  |  |  |  |
| binding_id | bigint |  |  |  | mp_bindings |  |
| member_id | bigint |  |  |  |  |  |
| visit_id | bigint |  |  |  | visits |  |
| tag_code | text |  |  |  |  |  |
| order_no | text |  | 是 |  |  | 厨房出品单号（主线的出品单；没有进厨房的菜时为空，小程序只能点进厨房的菜，正常不会为空） |
| deliver_to | text |  |  | ''::text |  | 扫了桌码的：送到哪张桌（下单那一刻桌台的名字）；没扫的为空，服务员按手牌送 |
| total | bigint |  |  |  |  |  |
| lines | jsonb |  |  |  |  | [{ name, quantity, amount, note }] |
| created_at | timestamp with time zone |  |  | now() |  |  |

### mp_images

043 微信小程序第一期（小程序线，docs/MINIPROGRAM.md 第 12 节）： ① 小程序用的图片：门店、首页轮播、项目介绍（与采购单图片一样存在库里、随备份走，同一张图只存一份） ② 绑定记录：微信 openid ↔ 会员（只追加； （建表：043_miniprogram）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('mp_images_id_seq'::regclass) |  |  |
| sha256 | text |  |  |  |  | 内容摘要：同一张图只存一份 |
| mime | text |  |  |  |  |  |
| data | bytea |  |  |  |  |  |
| size_bytes | integer |  |  |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### mp_invites

小程序第三期 3b：邀请好友（小程序线，docs/MP_PHASE3.md 第 2 节；MP30、MP31）。 ① mp_invites：邀请码——哪位会员（哪条绑定）发的、码、7 天内有效（MP30）、状态（待领取、已领取、已收回；过了有效期的按时间算过期）； （建表：061_mp_invites）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('mp_invites_id_seq'::regclass) |  |  |
| code | text |  |  |  |  | 分享卡片带的邀请码（不含容易看错的 0、1、I、O） |
| client_key | uuid |  |  |  |  | 发起的操作编号：同一个编号重提返回同一个码 |
| inviter_member_id | bigint |  |  |  | members |  |
| inviter_binding_id | bigint |  |  |  | mp_bindings |  |
| label | text |  |  |  |  | 发起时好友能体验的档阶（显示用；领取时以主线那时的规则为准） |
| created_at | timestamp with time zone |  |  | now() |  |  |
| expires_at | timestamp with time zone |  |  |  |  |  |
| status | text |  |  | 'open'::text |  |  |
| claim_client_key | uuid |  | 是 |  |  | 好友领取：领取的操作编号、好友的会员、好友这个微信的绑定（这位会员已经绑了别的微信时为空）、主线的临时身份 |
| invitee_member_id | bigint |  | 是 |  | members |  |
| invitee_binding_id | bigint |  | 是 |  | mp_bindings |  |
| trial_id | bigint |  | 是 |  | member_trials |  |
| used_at | timestamp with time zone |  | 是 |  |  |  |
| revoked_at | timestamp with time zone |  | 是 |  |  |  |

### mp_item_intros

043 微信小程序第一期（小程序线，docs/MINIPROGRAM.md 第 12 节）： ① 小程序用的图片：门店、首页轮播、项目介绍（与采购单图片一样存在库里、随备份走，同一张图只存一份） ② 绑定记录：微信 openid ↔ 会员（只追加； （建表：043_miniprogram）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| item_id | bigint | PK |  |  | service_items |  |
| intro | text |  |  | ''::text |  |  |
| image_id | bigint |  | 是 |  | mp_images |  |
| version | integer |  |  | 1 |  |  |
| updated_by | bigint |  | 是 |  | staff |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### mp_op_fences

浴族 yuzu · 小程序线（docs/MINIPROGRAM.md 第 12 节）：「结果待确认」的作废登记（Codex 审查 PR #42 的两个 P1） 小程序绑定会员、后台新建首页轮播都带操作编号（client_key）。 （建表：044_miniprogram_fences）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| key | uuid | PK |  |  |  |  |
| op_type | text | PK |  |  |  |  |
| openid | text |  | 是 |  |  | 绑定：哪个微信作废的；新建轮播：哪位员工作废的 |
| staff_id | bigint |  | 是 |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### mp_recharge_events

046 微信小程序第二期 2a（小程序线，docs/MP_RECHARGE.md）：线上充值单 ① mp_recharge_orders：线上充值单，一单一行。单号、会员、微信、套餐、金额、预估建单后不能改； （建表：046_mp_recharge）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('mp_recharge_events_id_seq'::regclass) |  |  |
| order_id | bigint |  | 是 |  | mp_recharge_orders | 找不到单子的到账通知（例如门店系统从备份恢复过）为空，后台单列给店主看 |
| kind | text |  |  |  |  |  |
| ok | boolean |  |  |  |  |  |
| code | text |  | 是 |  |  | 拒绝、出错、对不上的代码 |
| detail | jsonb |  |  | '{}'::jsonb |  |  |
| staff_id | bigint |  | 是 |  | staff | 店主处理时的经办人 |
| created_at | timestamp with time zone |  |  | now() |  |  |

### mp_recharge_orders

046 微信小程序第二期 2a（小程序线，docs/MP_RECHARGE.md）：线上充值单 ① mp_recharge_orders：线上充值单，一单一行。单号、会员、微信、套餐、金额、预估建单后不能改； （建表：046_mp_recharge）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('mp_recharge_orders_id_seq'::regclass) |  |  |
| order_no | text |  |  |  |  | 商户单号（微信支付的 out_trade_no）：MPR + 下单的营业日 + 10 位随机 |
| client_key | uuid |  |  |  |  | 小程序的操作编号：同一个编号重提返回这张单 |
| openid | text |  | 是 |  |  | 付款的微信（到账通知里的付款人要是它）与下单时的绑定记录 |
| binding_id | bigint |  |  |  | mp_bindings |  |
| member_id | bigint |  |  |  | members |  |
| plan_id | bigint |  | 是 |  | recharge_plans | 选的充值套餐与下单时的名称；自定义金额两样都空 |
| plan_name | text |  | 是 |  |  |  |
| amount | bigint |  |  |  |  | 实付（分） |
| est_bonus | bigint |  |  |  |  | 下单时的预估（以到账时为准）：赠金（分）与充完的档阶 |
| est_label | text |  |  | ''::text |  |  |
| business_date | date |  |  |  |  | 下单的营业日（每人每天的笔数按它算） |
| expires_at | timestamp with time zone |  |  |  |  | 微信支付的 time_expire（下单后 15 分钟） |
| mock | boolean |  |  | false |  | 模拟微信支付的单子（只在 development、test 实例） |
| status | text |  |  | 'pending'::text |  |  |
| prepay_id | text |  | 是 |  |  | 微信支付下单拿到的 prepay_id（拿到一次就不变；没拿到的继续支付时再下单） |
| transaction_id | text |  | 是 |  |  | 微信支付核实的付款：交易单号与付款时间 |
| paid_at | timestamp with time zone |  | 是 |  |  |  |
| recharge_id | bigint |  | 是 |  | recharges | 入账：钱包的充值单、实际入账的会员（来源会员合并了时是合并进去的那位） |
| credited_member_id | bigint |  | 是 |  | members |  |
| booked_at | timestamp with time zone |  | 是 |  |  |  |
| booked_label | text |  | 是 |  |  | 入账后的档阶（入账那一刻，给顾客看「充完是哪一档」） |
| flags | text[] |  |  | '{}'::text[] |  | 入账时标出来给店主看的（入账照常）：到账时已停用、记到合并进去的会员、关单之后才付的 |
| closed_at | timestamp with time zone |  | 是 |  |  | 关单：到期、顾客取消、微信那边关了、微信下单失败 |
| close_reason | text |  | 是 |  |  |  |
| hold_code | text |  | 是 |  |  | 已付款待处理：入账被拒（拒绝码与说明）或通知与单子对不上（MISMATCH） |
| hold_message | text |  | 是 |  |  |  |
| held_at | timestamp with time zone |  | 是 |  |  |  |
| resolution | text |  | 是 |  |  | 店主处理已付款待处理的：重新入账、按金额入账（不发套餐券）、已另行处理；写原因、记经办人 |
| resolution_note | text |  | 是 |  |  |  |
| resolved_by | bigint |  | 是 |  | staff |  |
| resolved_at | timestamp with time zone |  | 是 |  |  |  |
| resolve_client_key | uuid |  | 是 |  |  |  |
| queried_at | timestamp with time zone |  | 是 |  |  | 上次去微信查单的时刻（顾客等结果时同一张单 3 秒一次、每分钟补查时 1 分钟一次） |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### mp_recharge_recons

2b 对账：每天下前一天的微信支付交易账单，与线上充值单逐笔核对的结论（只追加：重新核对再记一条，不改旧的） （建表：046_mp_recharge）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('mp_recharge_recons_id_seq'::regclass) |  |  |
| bill_date | date |  |  |  |  | 账单日（北京时间的自然日） |
| ok | boolean |  |  |  |  | 都对上了；没对上的写在 issues 里（标红给店主看） |
| wx_count | integer |  |  |  |  | 微信账单里这一天的成功交易：笔数、金额（分） |
| wx_amount | bigint |  |  |  |  |  |
| store_count | integer |  |  |  |  | 门店系统里这一天付款的单子（已入账、已付款待处理、已处理）：笔数、金额（分） |
| store_amount | bigint |  |  |  |  |  |
| issues | jsonb |  |  | '[]'::jsonb |  | 没对上的（种类、商户单号、交易单号、两边的金额、说明）与账单里的退款 |
| refunds | jsonb |  |  | '[]'::jsonb |  |  |
| source | text |  |  |  |  | auto 每天自动；manual 店主在后台点「重新核对」（记经办人） |
| staff_id | bigint |  | 是 |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### mp_refund_events

④ 原路退回单的记录（只追加） （建表：048_mp_coupons_refunds）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('mp_refund_events_id_seq'::regclass) |  |  |
| order_id | bigint |  | 是 |  | mp_refund_orders | 找不到原路退回单的退款通知（例如商户平台上手动退的、配到了这个地址）为空 |
| kind | text |  |  |  |  |  |
| ok | boolean |  |  |  |  |  |
| code | text |  | 是 |  |  |  |
| detail | jsonb |  |  | '{}'::jsonb |  |  |
| staff_id | bigint |  | 是 |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### mp_refund_orders

③ 原路退回单（2d） （建表：048_mp_coupons_refunds）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('mp_refund_orders_id_seq'::regclass) |  |  |
| line_id | bigint |  |  |  | member_refund_lines | 主线退储值单的那一行（route = mp_auto）：按行号唯一，重复取到也只建一张 |
| member_refund_id | bigint |  |  |  | member_refunds |  |
| member_id | bigint |  |  |  | members |  |
| recharge_id | bigint |  |  |  | recharges |  |
| recharge_order_id | bigint |  | 是 |  | mp_recharge_orders | 原来那笔线上充值单（按充值单找；找不到的记「没能退」给店主看） |
| out_trade_no | text |  | 是 |  |  |  |
| transaction_id | text |  |  |  |  | 原来那笔的微信支付交易单号 |
| out_refund_no | text |  |  |  |  | 商户退款单号：建单时定下；店主重试关闭了的退款时换一个新的（旧的记在记录里） |
| amount | bigint |  |  |  |  |  |
| total | bigint |  | 是 |  |  | 原订单金额（微信要求带上） |
| mock | boolean |  |  |  |  |  |
| status | text |  |  | 'new'::text |  | new 待申请、processing 微信处理中、success 已退到、abnormal 退款异常（顾客的卡注销等，要到商户平台处理）、 closed 退款关闭、failed 没能退（申请被拒、找不到原单）、handled 店主已另行处理 |
| wx_refund_id | text |  | 是 |  |  |  |
| received_account | text |  | 是 |  |  |  |
| succeeded_at | timestamp with time zone |  | 是 |  |  |  |
| fail_code | text |  | 是 |  |  |  |
| fail_message | text |  | 是 |  |  |  |
| attempts | integer |  |  | 0 |  | 申请失败（连不上、微信出错）重试的次数与下一次的时间 |
| next_try_at | timestamp with time zone |  | 是 |  |  |  |
| queried_at | timestamp with time zone |  | 是 |  |  |  |
| handled_note | text |  | 是 |  |  |  |
| handled_by | bigint |  | 是 |  | staff |  |
| handled_at | timestamp with time zone |  | 是 |  |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### mp_reminder_consents

小程序第三期 3a：到期提醒（订阅消息；小程序线，docs/MP_PHASE3.md 第 1 节；MP28、MP29）；解绑满 3 年清除（MP16，docs/MP_PRIVACY.md）。 （建表：050_mp_reminders_retention）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('mp_reminder_consents_id_seq'::regclass) |  |  |
| client_key | uuid |  |  |  |  |  |
| openid | text |  | 是 |  |  |  |
| binding_id | bigint |  |  |  | mp_bindings |  |
| member_id | bigint |  |  |  | members |  |
| kind | text |  |  |  |  | coupon 券快到期、membership 会籍快到期、grace 进补充期当天、bonus 赠金快到期 |
| coupon_id | bigint |  | 是 |  | coupons | 提醒哪一张券（只有 coupon） |
| target_date | date |  |  |  |  | 到期的那一天：券的有效期到、会籍周期的最后一天（补充期也记这一天）、赠金作废的那一天 |
| template_id | text |  |  |  |  | 顾客同意的是哪个模板（微信按模板记次数） |
| due_date | date |  |  |  |  | 哪天发（营业日）：到期前几天（MP28），同意时已经过了就是当天 |
| seq | integer |  |  | 1 |  | 同一样东西的同一种提醒第几次同意（之前那条没发出、不用发了、模板换过的，再同意记下一次） |
| created_at | timestamp with time zone |  |  | now() |  |  |
| booking_id | bigint |  | 是 |  | bookings | 到期提醒加一种「预约到店」：提醒哪一张预约单（只有 booking）；到期的那一天记预约单的营业日，当天 10:00–20:00 发 |

### mp_reminder_messages

小程序第三期 3a：到期提醒（订阅消息；小程序线，docs/MP_PHASE3.md 第 1 节；MP28、MP29）；解绑满 3 年清除（MP16，docs/MP_PRIVACY.md）。 （建表：050_mp_reminders_retention）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('mp_reminder_messages_id_seq'::regclass) |  |  |
| consent_id | bigint |  |  |  | mp_reminder_consents |  |
| status | text |  |  |  |  | queued 排队、leased 网关取走了、sent 发出、failed 没发出、unknown 结果不明、skipped 不发 |
| reason | text |  | 是 |  |  | 不发的原因、没发出的原因（顾客看不到，后台看） |
| page | text |  | 是 |  |  | 点开消息进的页面与模板的各个字段（{"thing1": {"value": "…"}}）；不发的没有 |
| data | jsonb |  | 是 |  |  |  |
| valid_until | date |  | 是 |  |  | 过了这一天（营业日）就不用发了：券的有效期到、会籍周期的最后一天、补充期的最后一天、赠金最后能用的一天 |
| lease_token | uuid |  | 是 |  |  | 网关这一次取走用的凭据与期限：过了期限没回报的记「结果不明」；同一批用同一个批次号（网关没收到回答时按批次号再要一次） |
| lease_batch | uuid |  | 是 |  |  |  |
| leased_until | timestamp with time zone |  | 是 |  |  |  |
| retry_after | timestamp with time zone |  | 是 |  |  | 要再试的：这个时间以后再给网关 |
| attempts | integer |  |  | 0 |  |  |
| errcode | integer |  | 是 |  |  | 微信回的错误码（没发出、要再试的） |
| created_at | timestamp with time zone |  |  | now() |  |  |
| finished_at | timestamp with time zone |  | 是 |  |  |  |

### mp_stores

043 微信小程序第一期（小程序线，docs/MINIPROGRAM.md 第 12 节）： ① 小程序用的图片：门店、首页轮播、项目介绍（与采购单图片一样存在库里、随备份走，同一张图只存一份） ② 绑定记录：微信 openid ↔ 会员（只追加； （建表：043_miniprogram）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('mp_stores_id_seq'::regclass) |  |  |
| code | text |  |  |  |  |  |
| name | text |  |  |  |  |  |
| is_home | boolean |  |  | false |  | 本系统所在的门店（会员、余额、券只来自这一家，MP5） |
| hours | text |  |  | ''::text |  |  |
| address | text |  |  | ''::text |  |  |
| phone | text |  |  | ''::text |  |  |
| latitude | numeric(9,6) |  | 是 |  |  | 导航用的坐标（微信地图，GCJ-02） |
| longitude | numeric(9,6) |  | 是 |  |  |  |
| notice | text |  |  | ''::text |  |  |
| image_id | bigint |  | 是 |  | mp_images |  |
| sort_order | integer |  |  | 0 |  |  |
| visible | boolean |  |  | true |  |  |
| version | integer |  |  | 1 |  |  |
| updated_by | bigint |  | 是 |  | staff |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

## 员工食堂（canteen_）

### canteen_checkins

打卡：只追加；撤销只做标记（原因与经办人）。同一人同一天同一餐只能有一条没撤销的 （建表：090_canteen）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('canteen_checkins_id_seq'::regclass) |  |  |
| employee_id | bigint |  |  |  | canteen_employees |  |
| emp_no | text |  |  |  |  | 当时的工号、姓名、部门（快照：之后改名单不改历史） |
| employee_name | text |  |  |  |  |  |
| department_name | text |  |  | ''::text |  |  |
| meal_date | date |  |  |  |  |  |
| meal | text |  |  |  |  |  |
| method | text |  |  |  |  |  |
| note | text |  |  | ''::text |  |  |
| scanned_at | timestamp with time zone |  |  |  |  | 扫到（或手动点下）的时间：断网补登时是手机记下的时间 |
| recorded_at | timestamp with time zone |  |  | now() |  |  |
| recorder_id | bigint |  |  |  | canteen_employees |  |
| recorder_name | text |  |  |  |  |  |
| client_key | uuid |  |  |  |  |  |
| voided_at | timestamp with time zone |  | 是 |  |  |  |
| void_reason | text |  | 是 |  |  |  |
| voided_by_employee | bigint |  | 是 |  | canteen_employees | 撤销的人：负责人（员工端）或管理员（系统账号），二选一 |
| voided_by_staff | bigint |  | 是 |  | staff |  |

### canteen_employees

员工名单：只由管理员在 yuzu 后台维护 （建表：090_canteen）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('canteen_employees_id_seq'::regclass) |  |  |
| emp_no | text |  |  |  |  | 工号：大写字母、数字与短横线，1–16 位（保存时转大写） |
| name | text |  |  |  |  |  |
| department_id | bigint |  | 是 |  | departments | 部门（普通员工可以不填；厨师、负责人必须是设置里的食堂部门，由服务端核对） |
| role | text |  |  | 'staff'::text |  |  |
| avatar | text |  |  |  |  |  |
| active | boolean |  |  | true |  |  |
| password_hash | text |  | 是 |  |  | 员工自己设的密码（开通之前为空；重新开通时清空） |
| activation_code | text |  | 是 |  |  | 开通码：打印在开通卡片上，员工用它设密码；用过、重新开通、停用时清掉 |
| activation_expires_at | timestamp with time zone |  | 是 |  |  |  |
| activation_key | uuid |  | 是 |  |  | 生成这张开通码的操作编号：同一编号重提返回同一张，不会换码 |
| activated_at | timestamp with time zone |  | 是 |  |  |  |
| code_epoch | integer |  |  | 1 |  | 码钥匙的版本：停用、重新开通时加一，旧手机上的码钥匙与登录随之失效 |
| failed_logins | integer |  |  | 0 |  |  |
| locked_until | timestamp with time zone |  | 是 |  |  |  |
| last_seen_at | timestamp with time zone |  | 是 |  |  |  |
| version | integer |  |  | 1 |  |  |
| is_synthetic | boolean |  |  | false |  |  |
| created_by | bigint |  | 是 |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| username | text |  | 是 |  |  |  |
| phone | text |  | 是 |  |  |  |
| source | text |  |  | 'admin'::text |  |  |

### canteen_feedback

跟柚子说：员工想让柚子做的事（心愿）和碎碎念；管理员在后台看、回一句话。内容发出后不能改、不能删 （建表：091_canteen_join）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('canteen_feedback_id_seq'::regclass) |  |  |
| employee_id | bigint |  |  |  | canteen_employees |  |
| employee_name | text |  |  |  |  | 当时的名字（快照：之后改名单不改历史） |
| kind | text |  |  |  |  |  |
| content | text |  |  |  |  |  |
| client_key | uuid |  |  |  |  | 操作编号：回复没收到时原样重发，返回同一条 |
| created_at | timestamp with time zone |  |  | now() |  |  |
| read_at | timestamp with time zone |  | 是 |  |  | 管理员看过（回信时也算看过） |
| read_by | bigint |  | 是 |  | staff |  |
| reply | text |  | 是 |  |  |  |
| replied_at | timestamp with time zone |  | 是 |  |  |  |
| replied_by | bigint |  | 是 |  | staff |  |
| read_by_employee | bigint |  | 是 |  | canteen_employees |  |
| replied_by_employee | bigint |  | 是 |  | canteen_employees |  |

### canteen_feedback_reply_ops

员工食堂：柚子信箱交给食堂负责人在手机上看、回信（店主 2026-11-10，docs/CANTEEN.md 第 18 节，K20）。 只改员工食堂自己的表： · canteen_feedback 加「哪位食堂负责人看过、回信」两列（引用 canteen_employees）。 （建表：096_canteen_mailbox_mobile）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| client_key | uuid | PK |  |  |  |  |
| feedback_id | bigint |  |  |  | canteen_feedback |  |
| employee_id | bigint |  |  |  | canteen_employees | 回信的负责人 |
| request_hash | text |  |  |  |  | 原请求摘要（那一条 + 回信的内容）：同一个编号换了内容拒绝 |
| created_at | timestamp with time zone |  |  | now() |  |  |

### canteen_likes

点赞：谁给哪份菜单的哪道菜点了赞（主键去重；取消就删掉这一条） （建表：090_canteen）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| menu_id | bigint | PK |  |  | canteen_menus |  |
| dish_id | text | PK |  |  |  |  |
| employee_id | bigint | PK |  |  | canteen_employees |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### canteen_menus

某天某餐的菜单：厨师、负责人在手机上编辑、发布；带版本号，两个人同时改不会互相覆盖 （建表：090_canteen）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('canteen_menus_id_seq'::regclass) |  |  |
| menu_date | date |  |  |  |  |  |
| meal | text |  |  |  |  |  |
| dishes | jsonb |  |  | '[]'::jsonb |  | [{ id, name, emoji, tags }]，最多 30 道 |
| note | text |  |  | ''::text |  |  |
| published | boolean |  |  | false |  |  |
| published_at | timestamp with time zone |  | 是 |  |  |  |
| version | integer |  |  | 1 |  |  |
| last_client_key | uuid |  | 是 |  |  | 最后一次保存的操作编号：回复没收到时原样重提，返回同一个结果 |
| updated_by | bigint |  |  |  | canteen_employees |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### canteen_push_prefs

员工自己关掉的餐次（柚子饭堂「我的 → 饭点提醒」）：没有这一行 = 后台开着的几顿都提醒 （建表：120_canteen_push）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| employee_id | bigint | PK |  |  | canteen_employees |  |
| muted_meals | text[] |  |  | '{}'::text[] |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### canteen_push_subscriptions

员工手机上的订阅：一台手机（一个浏览器、或桌面上的柚子饭堂）一条，推送地址唯一；同一台手机换人登录后再打开提醒，改到新的人名下。 停用以后不再发，记录留着：off 员工自己关掉、logout 退出登录、gone 推送服务说这个订阅没了（404 / 410） （建表：120_canteen_push）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('canteen_push_subscriptions_id_seq'::regclass) |  |  |
| employee_id | bigint |  |  |  | canteen_employees |  |
| endpoint | text |  |  |  |  |  |
| p256dh | text |  |  |  |  |  |
| auth | text |  |  |  |  |  |
| platform | text |  |  | 'other'::text |  |  |
| origin | text |  | 是 |  |  | 员工打开柚子饭堂的 https 地址（例如 https://staff.example.com）：发推送时告诉推送服务这是谁家的（VAPID 的联系方式） |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| last_success_at | timestamp with time zone |  | 是 |  |  |  |
| last_failure_at | timestamp with time zone |  | 是 |  |  |  |
| failures | integer |  |  | 0 |  |  |
| last_error | text |  | 是 |  |  |  |
| disabled_at | timestamp with time zone |  | 是 |  |  |  |
| disabled_reason | text |  | 是 |  |  |  |

### canteen_reminder_deliveries

每台手机的发送记录：同一次提醒同一台手机只发一次（先记一行再发；中断后接着发的跳过记过的，结果不明的也不重发） （建表：120_canteen_push）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| run_id | bigint | PK |  |  | canteen_reminder_runs |  |
| subscription_id | bigint | PK |  |  | canteen_push_subscriptions |  |
| employee_id | bigint |  |  |  | canteen_employees |  |
| status | text |  |  | 'sending'::text |  |  |
| error | text |  | 是 |  |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| finished_at | timestamp with time zone |  | 是 |  |  |  |

### canteen_reminder_runs

每天每顿的饭点提醒：先认领（同一天同一顿只有一行，几个进程同时跑也只有一个认领到），写租约，事务外发送，最后记结果。 进程在发送中断了的，租约过期以后、还在到点后 30 分钟之内，由下一分钟接着发没发过的手机 （建表：120_canteen_push）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('canteen_reminder_runs_id_seq'::regclass) |  |  |
| meal_date | date |  |  |  |  |  |
| meal | text |  |  |  |  |  |
| due_at | timestamp with time zone |  |  |  |  |  |
| title | text |  |  |  |  |  |
| line | text |  |  |  |  | 这一天轮到的那一句（{名字} 发的时候按人换）与 {菜单} 换成的菜 |
| menu_text | text |  |  | ''::text |  |  |
| open_page | text |  |  |  |  |  |
| status | text |  |  | 'sending'::text |  |  |
| lease_until | timestamp with time zone |  | 是 |  |  |  |
| started_at | timestamp with time zone |  |  | now() |  |  |
| finished_at | timestamp with time zone |  | 是 |  |  |  |
| sent | integer |  |  | 0 |  |  |
| failed | integer |  |  | 0 |  |  |
| skipped_checked_in | integer |  |  | 0 |  |  |

### canteen_sessions

员工端会话（只存令牌摘要；30 天，用着就顺延）。停用、重新开通时整批删掉 （建表：090_canteen）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| token_hash | text | PK |  |  |  |  |
| employee_id | bigint |  |  |  | canteen_employees |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| last_seen_at | timestamp with time zone |  |  | now() |  |  |
| expires_at | timestamp with time zone |  |  |  |  |  |
| ip | text |  | 是 |  |  |  |
| user_agent | text |  | 是 |  |  |  |

## 客户关系（concierge_）

### concierge_balance_evidence

8.0.12 管家部：只新增业务数据，不自动纳入旧站或原生会员，不写钱包。 （建表：135_concierge）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('concierge_balance_evidence_id_seq'::regclass) |  |  |
| balance_id | uuid |  |  |  | concierge_records |  |
| upload_id | uuid |  | 是 |  | concierge_uploads |  |
| receipt_id | uuid |  | 是 |  | concierge_records |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | clock_timestamp() |  |  |

### concierge_members

8.0.12 管家部：只新增业务数据，不自动纳入旧站或原生会员，不写钱包。 （建表：135_concierge）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | uuid | PK |  |  |  |  |
| code | integer |  |  | identity always |  |  |
| native_member_id | bigint |  | 是 |  | members |  |
| data | jsonb |  |  |  |  |  |
| version | integer |  |  | 1 |  |  |
| created_by | bigint |  |  |  | staff |  |
| updated_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | clock_timestamp() |  |  |
| updated_at | timestamp with time zone |  |  | clock_timestamp() |  |  |

### concierge_operations

8.0.12 管家部：只新增业务数据，不自动纳入旧站或原生会员，不写钱包。 （建表：135_concierge）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| actor_id | bigint | PK |  |  | staff |  |
| request_id | text | PK |  |  |  |  |
| request_hash | text |  |  |  |  |  |
| response | jsonb |  | 是 |  |  |  |
| abandoned | boolean |  |  | false |  |  |
| created_at | timestamp with time zone |  |  | clock_timestamp() |  |  |

### concierge_praise

管家好评独立保存；旧消费凭证、钱包和135/136保持不动。 （建表：137_concierge_praise）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | uuid | PK |  |  |  |  |
| staff_id | bigint |  |  |  | staff |  |
| staff_name_snapshot | text |  |  |  |  |  |
| occurred_on | date |  |  |  |  |  |
| source | text |  |  |  |  |  |
| content | text |  |  |  |  |  |
| guest_name | text |  |  |  |  |  |
| member_id | uuid |  | 是 |  | concierge_members |  |
| status | text |  |  | 'active'::text |  |  |
| version | integer |  |  | 1 |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | clock_timestamp() |  |  |
| voided_by | bigint |  | 是 |  | staff |  |
| voided_at | timestamp with time zone |  | 是 |  |  |  |
| void_reason | text |  |  | ''::text |  |  |

### concierge_praise_evidence

管家好评独立保存；旧消费凭证、钱包和135/136保持不动。 （建表：137_concierge_praise）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| praise_id | uuid | PK |  |  | concierge_praise |  |
| upload_id | uuid | PK |  |  | concierge_uploads |  |
| position | smallint |  |  |  |  |  |

### concierge_records

8.0.12 管家部：只新增业务数据，不自动纳入旧站或原生会员，不写钱包。 （建表：135_concierge）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | uuid | PK |  |  |  |  |
| ordinal | bigint |  |  | identity always |  |  |
| kind | text |  |  |  |  |  |
| member_id | uuid |  | 是 |  | concierge_members |  |
| native_booking_id | bigint |  | 是 |  | bookings |  |
| native_checkout_id | bigint |  | 是 |  | checkouts |  |
| data | jsonb |  |  |  |  |  |
| version | integer |  |  | 1 |  |  |
| created_by | bigint |  |  |  | staff |  |
| updated_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | clock_timestamp() |  |  |
| updated_at | timestamp with time zone |  |  | clock_timestamp() |  |  |
| native_space_id | bigint |  | 是 |  | spaces |  |
| native_table_id | bigint |  | 是 |  | dining_tables |  |
| native_room_id | bigint |  | 是 |  | rooms |  |

### concierge_revisions

8.0.12 管家部：只新增业务数据，不自动纳入旧站或原生会员，不写钱包。 （建表：135_concierge）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('concierge_revisions_id_seq'::regclass) |  |  |
| object_type | text |  |  |  |  |  |
| object_id | uuid |  |  |  |  |  |
| version | integer |  |  |  |  |  |
| snapshot | jsonb |  |  |  |  |  |
| actor_id | bigint |  |  |  | staff |  |
| reason | text |  |  | ''::text |  |  |
| created_at | timestamp with time zone |  |  | clock_timestamp() |  |  |

### concierge_sync

同步版本号：管家部每次写入在模块锁里加一，页面每 3 秒只比这个数。 原来比的是全店 audit_logs 的最大编号：别的模块每记一条审计，所有开着管家部的页面都要重新取一遍整个工作区。 （建表：135_concierge）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| only_row | boolean | PK |  | true |  |  |
| revision | bigint |  |  | 0 |  |  |

### concierge_uploads

8.0.12 管家部：只新增业务数据，不自动纳入旧站或原生会员，不写钱包。 （建表：135_concierge）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | uuid | PK |  |  |  |  |
| member_id | uuid |  | 是 |  | concierge_members |  |
| image_id | bigint |  |  |  | erp_images |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | clock_timestamp() |  |  |

## 价目表（price_catalog_）

### price_catalog_changes

价目表录入 第三批 编辑与校验（docs/PRICE_CATALOG.md 第 5 节，PENDING_DECISIONS「价目表录入」PC9 起）： · 条目加版本号：页面改价、停用带着读到的版本，别人先改了就拒绝（不悄悄覆盖）； （建表：231_price_catalog_edits）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('price_catalog_changes_id_seq'::regclass) |  |  |
| set_id | bigint |  |  |  | price_catalog_sets |  |
| entry_id | bigint |  |  |  | price_catalog_entries |  |
| action | text |  |  |  |  |  |
| entry_name | text |  |  |  |  | 改后的名称（列表不用再连条目表） |
| before | jsonb |  | 是 |  |  | 改前与改后的整项（新增没有改前） |
| after | jsonb |  |  |  |  |  |
| price_changed | boolean |  |  | false |  | 价格（形态、两个价、比例、加钟 / 超时、封顶、分档价）有没有变：「只看改价」用 |
| reason | text |  |  | ''::text |  |  |
| staff_id | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| op_key | uuid |  | 是 |  |  |  |

### price_catalog_entries

价目表录入 第一批（店主 2026-11-22《汤崎宝安全品类价目表录入系统需求说明》，docs/PRICE_CATALOG.md，PC1 起）： 把《汤崎宝安全品类价目表 1119》六张表录成一份「价目表数据集」。 （建表：230_price_catalog）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('price_catalog_entries_id_seq'::regclass) |  |  |
| set_id | bigint |  |  |  | price_catalog_sets |  |
| sheet | text |  |  |  |  | 六张表：门店价格、娱乐价格、房间价格、零点菜品价格、按摩及助浴价格（储值政策本次不录入） |
| kind | text |  |  |  |  |  |
| section | text |  |  | ''::text |  | 板块（康疗、SPA……）/ 餐段（2 楼零点、早餐、午餐、晚餐）/ 门店价格的「类型」 |
| category | text |  |  | ''::text |  | 菜品分类（中式零点、生滚粥……） |
| code | text |  |  | ''::text |  | 表格里的原始编号（按摩及助浴 1–76，编号 43 空缺） |
| name | text |  |  |  |  |  |
| price_mode | text |  |  |  |  |  |
| price_cents | bigint |  | 是 |  |  | 单位：分 |
| price2_cents | bigint |  | 是 |  |  | 单位：分 |
| rate_bp | integer |  | 是 |  |  |  |
| unit | text |  |  | ''::text |  | 计价单位（位、份、只、次、晚……） |
| duration_minutes | integer |  | 是 |  |  | 服务时长（按摩）、门票时长（12H / 24H）、基础价含的时长（娱乐、房间 2H 起开），一律分钟 |
| extra_price_cents | bigint |  | 是 |  |  | 加钟价（娱乐）/ 超时单价（房间），以及多少分钟算一次 |
| extra_minutes | integer |  | 是 |  |  |  |
| cap_cents | bigint |  | 是 |  |  | 封顶价（房间过夜封顶）；单位：分 |
| units_count | integer |  | 是 |  |  | 台位数（PS5 17 台……）/ 房型的总间数 |
| room_numbers | text[] |  |  | '{}'::text[] |  | 房号清单（S301、S302……） |
| window_start | integer |  | 是 |  |  | 供应 / 使用时段（餐票的早餐 7:30–10:00、夜间票 21:00–次日 11:00），时刻按 0–1439 分钟存，跨零点的结束小于开始 |
| window_end | integer |  | 是 |  |  |  |
| includes_meal | boolean |  | 是 |  |  | 是否含餐（门票） |
| venues | text[] |  |  | '{}'::text[] |  | 适用房型（房间 / 大堂 / 浴区，可以几种）与适用性别（助浴表「资深价」一列写的其实是性别） |
| gender | text |  | 是 |  |  |  |
| audience | text |  |  | ''::text |  |  |
| content | text |  |  | ''::text |  |  |
| highlight | text |  |  | ''::text |  |  |
| note | text |  |  | ''::text |  |  |
| variants | jsonb |  |  | '[]'::jsonb |  | 一项里还分几档、几种位价的（轰趴房按面积分档、客房大小房、餐饮包房的位价与低消、棋牌房 8H 价），结构见 src/shared/price-catalog.ts |
| orderable | boolean |  |  | true |  | 能不能下单：2 楼零点暂无售价的菜「待定价、不可下单」，补价后启用 |
| active | boolean |  |  | true |  |  |
| source_row | integer |  | 是 |  |  | 表格里第几行（报错、核对用）与排序 |
| sort_order | integer |  |  | 0 |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| version | integer |  |  | 1 |  |  |

### price_catalog_import_ops

价目表录入：导入草稿带操作编号（Codex 审查 PR #160 P1；docs/PRICE_CATALOG.md 第 3 节）。 导入已经提交、响应却丢了（断网、超时）时，页面原样重提：同一个编号直接返回第一次导入的那份草稿，不再删掉草稿重新导； （建表：232_price_catalog_import_ops）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| op_key | text | PK |  |  |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| set_id | bigint |  | 是 |  | price_catalog_sets | 导入出来的那份草稿；草稿被替换或放弃后为空 |
| file_sha256 | text |  |  |  |  | 文件内容的摘要：同一个编号换了文件的拒绝 |
| staff_id | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### price_catalog_link_ops

价目表录入 第四批：对接收银项目（docs/PRICE_CATALOG.md 第 6 节，PC17、PC18）。 价目表的一项（同一张表、同一个板块 / 餐段、同一个分类里的名称，不分大小写、不管空格：priceNameKey）对上一个收银项目（service_items）。 （建表：237_price_catalog_links）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| op_key | uuid | PK |  |  |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| action | text |  |  |  |  |  |
| result | jsonb |  |  |  |  |  |
| staff_id | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### price_catalog_links

价目表录入 第四批：对接收银项目（docs/PRICE_CATALOG.md 第 6 节，PC17、PC18）。 价目表的一项（同一张表、同一个板块 / 餐段、同一个分类里的名称，不分大小写、不管空格：priceNameKey）对上一个收银项目（service_items）。 （建表：237_price_catalog_links）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| store_id | bigint | PK |  | yuzu_store() | stores |  |
| entry_key | text | PK |  |  |  |  |
| item_id | bigint |  |  |  | service_items |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### price_catalog_set_ops

价目表录入：整体回滚带操作编号（Codex 审查 PR #160 P1；docs/PRICE_CATALOG.md 第 5 节）。 第一次回滚 B→A 已经提交、响应却丢了，之后别人又回滚 A→B：原样重提第一次的请求（生效的还是 B）不能再把它切回 A。 同一个编号直接返回现在的样子、什么都不改。只追加。 （建表：233_price_catalog_set_ops）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| op_key | text | PK |  |  |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| action | text |  |  |  |  |  |
| from_set_id | bigint |  | 是 |  |  | 换下来的那份与恢复生效的那份（之后被放弃的草稿不会是这两份：只有停用 / 生效的才参与回滚） |
| to_set_id | bigint |  | 是 |  |  |  |
| staff_id | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### price_catalog_sets

价目表录入 第一批（店主 2026-11-22《汤崎宝安全品类价目表录入系统需求说明》，docs/PRICE_CATALOG.md，PC1 起）： 把《汤崎宝安全品类价目表 1119》六张表录成一份「价目表数据集」。 （建表：230_price_catalog）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('price_catalog_sets_id_seq'::regclass) |  |  |
| store_id | bigint |  |  | yuzu_store() | stores |  |
| status | text |  |  |  |  |  |
| title | text |  |  |  |  |  |
| file_name | text |  | 是 |  |  | 导入的文件（手工维护的为空）：文件名与内容摘要，同一份文件导两次能认出来 |
| file_sha256 | text |  | 是 |  |  |  |
| notes | jsonb |  |  | '{}'::jsonb |  | 表里不录入、只记下来的内容（储值政策那一句等） |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| activated_by | bigint |  | 是 |  | staff |  |
| activated_at | timestamp with time zone |  | 是 |  |  |  |
| retired_at | timestamp with time zone |  | 是 |  |  |  |

## 员工培训（training_）

### training_blob_chunks

员工培训第一期（店主 2026-11-25，docs/TRAINING.md、PENDING_DECISIONS PC37）： · 文件夹：「培训资料」（公共）+ 现有 15 个部门各一个，后台可新建部门文件夹、改名、排序、停用（不动 org_departments）； （建表：280_training）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| sha256 | text | PK |  |  | training_blobs |  |
| seq | integer | PK |  |  |  |  |
| data | bytea |  |  |  |  |  |

### training_blobs

员工培训第一期（店主 2026-11-25，docs/TRAINING.md、PENDING_DECISIONS PC37）： · 文件夹：「培训资料」（公共）+ 现有 15 个部门各一个，后台可新建部门文件夹、改名、排序、停用（不动 org_departments）； （建表：280_training）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| sha256 | text | PK |  |  |  |  |
| size_bytes | bigint |  |  |  |  |  |
| chunk_count | integer |  |  |  |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### training_file_versions

员工培训第一期（店主 2026-11-25，docs/TRAINING.md、PENDING_DECISIONS PC37）： · 文件夹：「培训资料」（公共）+ 现有 15 个部门各一个，后台可新建部门文件夹、改名、排序、停用（不动 org_departments）； （建表：280_training）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('training_file_versions_id_seq'::regclass) |  |  |
| file_id | bigint |  |  |  | training_files |  |
| version_no | integer |  |  |  |  |  |
| file_name | text |  |  |  |  |  |
| mime | text |  |  |  |  |  |
| sha256 | text |  |  |  | training_blobs |  |
| size_bytes | bigint |  |  |  |  |  |
| note | text |  |  | ''::text |  |  |
| uploaded_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### training_files

员工培训第一期（店主 2026-11-25，docs/TRAINING.md、PENDING_DECISIONS PC37）： · 文件夹：「培训资料」（公共）+ 现有 15 个部门各一个，后台可新建部门文件夹、改名、排序、停用（不动 org_departments）； （建表：280_training）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('training_files_id_seq'::regclass) |  |  |
| folder_id | bigint |  |  |  | training_folders |  |
| title | text |  |  |  |  |  |
| description | text |  |  | ''::text |  |  |
| active | boolean |  |  | true |  |  |
| sort | integer |  |  | 100 |  |  |
| current_version_id | bigint |  | 是 |  | training_file_versions |  |
| version | integer |  |  | 1 |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### training_folders

员工培训第一期（店主 2026-11-25，docs/TRAINING.md、PENDING_DECISIONS PC37）： · 文件夹：「培训资料」（公共）+ 现有 15 个部门各一个，后台可新建部门文件夹、改名、排序、停用（不动 org_departments）； （建表：280_training）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('training_folders_id_seq'::regclass) |  |  |
| name | text |  |  |  |  |  |
| kind | text |  |  |  |  |  |
| department_key | text |  | 是 |  | org_departments |  |
| sort | integer |  |  | 100 |  |  |
| active | boolean |  |  | true |  |  |
| version | integer |  |  | 1 |  |  |
| created_by | bigint |  | 是 |  | staff |  |
| client_key | uuid |  | 是 |  |  | 新建时页面带的操作编号：没收到结果原样重提返回原来那个文件夹，不报重名（Codex 审查 a3f5310） |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |

### training_upload_chunks

传到一半的块先放这里，完成时搬进 training_blob_chunks（同一个文件已经有了就不再搬） （建表：280_training）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| upload_id | bigint | PK |  |  | training_uploads |  |
| seq | integer | PK |  |  |  |  |
| data | bytea |  |  |  |  |  |

### training_uploads

分块上传：开始时登记要传的文件（名称、类型、大小、块数），一块块传完再「完成」：服务端按块算摘要（内网 HTTP 下浏览器没有 crypto.subtle）， 同样的内容已经有了就不再存一份，登记成文件或新版本。 操作编号：完成没收到结果时原样重提，返回第一次登记的那份（不再建一份） （建表：280_training）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('training_uploads_id_seq'::regclass) |  |  |
| client_key | uuid |  |  |  |  |  |
| size_bytes | bigint |  |  |  |  |  |
| chunk_count | integer |  |  |  |  |  |
| file_name | text |  |  |  |  |  |
| mime | text |  |  |  |  |  |
| request_hash | text |  |  |  |  |  |
| status | text |  |  | 'open'::text |  | cancelled = 管理员确认不传了（服务端作废登记，与「完成」互斥；之后同一个编号不能再传、不能再完成） |
| result_file_id | bigint |  | 是 |  | training_files |  |
| result_version_id | bigint |  | 是 |  | training_file_versions |  |
| created_by | bigint |  |  |  | staff |  |
| claim_token | uuid |  | 是 |  |  | 「完成」的认领：同一次上传只有认领到的那个请求去读块、算摘要；10 分钟没登记完（进程退出）可以重新认领（Codex 安全审查 f2dbf5a） |
| claimed_at | timestamp with time zone |  | 是 |  |  |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| finished_at | timestamp with time zone |  | 是 |  |  |  |

### training_views

员工培训第一期（店主 2026-11-25，docs/TRAINING.md、PENDING_DECISIONS PC37）： · 文件夹：「培训资料」（公共）+ 现有 15 个部门各一个，后台可新建部门文件夹、改名、排序、停用（不动 org_departments）； （建表：280_training）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| file_id | bigint | PK |  |  | training_files |  |
| staff_id | bigint | PK |  |  | staff |  |
| first_viewed_at | timestamp with time zone |  |  | now() |  |  |
| last_viewed_at | timestamp with time zone |  |  | now() |  |  |
| view_count | integer |  |  | 1 |  |  |
| last_version_id | bigint |  | 是 |  | training_file_versions |  |

## 采购商城（mall_）

### mall_request_quotes

商城需求的成交方案（8.1.51）：供应链 BP 记下的供应商、含税单价、运费、交期与报价截图；部门确认或 BP 记已在微信确认后为 selected，转采购单时带上

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('mall_request_quotes_id_seq'::regclass) |  |  |
| request_id | bigint |  |  |  | purchase_requests |  |
| line_id | bigint |  |  |  | purchase_request_lines |  |
| client_key | uuid |  |  |  |  |  |
| supplier_id | bigint |  | 是 |  | suppliers |  |
| supplier_name | text |  |  |  |  |  |
| unit_price_cents | integer |  |  |  |  | 含税单价（分，每个需求单位）；部门看不到 |
| tax_rate_bp | integer |  |  |  |  |  |
| freight_cents | integer |  |  | 0 |  |  |
| lead_days | integer |  |  |  |  |  |
| valid_until | date |  | 是 |  |  |  |
| plan_note | text |  |  | ''::text |  | 给部门看的方案说明（规格、材质、样品情况等） |
| internal_note | text |  |  | ''::text |  | 只给采购看的备注（谈价过程等） |
| image_ids | bigint[] |  |  | '{}'::bigint[] |  | 报价截图、样品照片（erp_images；只给采购看） |
| recommended | boolean |  |  | false |  |  |
| status | text |  |  | 'proposed'::text |  |  |
| selected_mode | text |  | 是 |  |  | dept 部门在系统里确认；wechat BP 记已在微信上确认 |
| selected_by | bigint |  | 是 |  | staff |  |
| selected_at | timestamp with time zone |  | 是 |  |  |  |
| selected_note | text |  |  | ''::text |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |

### mall_request_sourcing

商城需求池接单（8.1.51）：哪位供应链 BP 在跟这张需求单；放回需求池时删掉这一行

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| request_id | bigint | PK |  |  | purchase_requests | 需求单（商城来源） |
| owner_id | bigint |  |  |  | staff | 接单跟进的供应链 BP |
| claimed_at | timestamp with time zone |  |  | now() |  | 接单时间 |

### mall_sku_changes

核心信息的改动（改价、改税率、起订量、运费、有效期、适用门店）：只追加；同一条 SKU 同时最多一张待审的 （建表：271_mall_skus）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('mall_sku_changes_id_seq'::regclass) |  |  |
| sku_id | bigint |  |  |  | mall_skus |  |
| status | text |  |  | 'pending'::text |  |  |
| before | jsonb |  |  |  |  |  |
| after | jsonb |  |  |  |  |  |
| reason | text |  |  |  |  |  |
| requested_by | bigint |  |  |  | staff |  |
| requested_at | timestamp with time zone |  |  | now() |  |  |
| decided_by | bigint |  | 是 |  | staff |  |
| decided_at | timestamp with time zone |  | 是 |  |  |  |
| decision_note | text |  |  | ''::text |  |  |

### mall_skus

采购商城并进柚子（8.1.32，店主 2026-11-24，docs/MALL_V8132.md）：供应商 SKU——同一个物料可以挂几家供应商的报价， 部门在商城里比选、加清单、提需求单（提交仍是 270 的采购需求单）。 （建表：271_mall_skus）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('mall_skus_id_seq'::regclass) |  |  |
| material_id | bigint |  |  |  | materials |  |
| supplier_id | bigint |  |  |  | suppliers |  |
| sku_code | text |  |  |  |  |  |
| price_cents | bigint |  |  |  |  | 单位：分 |
| tax_rate_bp | integer |  |  |  |  |  |
| moq_milli | bigint |  |  |  |  |  |
| lead_days | integer |  |  |  |  |  |
| freight_cents | bigint |  |  | 0 |  | 单位：分 |
| valid_until | date |  |  |  |  |  |
| store_ids | bigint[] |  |  | '{}'::bigint[] |  | 适用门店（业态）：空数组 = 全部门店 |
| unit | text |  |  |  |  | 报价按的采购单位与换算（上架审核时照物料抄下来，Codex 审查）：物料的采购单位、换算之后改了，这条 SKU 暂停采购， 停用后重新上架审核（价格版本加一）——免得清单里「2 箱」的价格被当成「2 个」提交 |
| unit_factor_milli | bigint |  |  |  |  |  |
| price_version | integer |  |  | 1 |  |  |
| status | text |  |  | 'draft'::text |  |  |
| core_pending | boolean |  |  | false |  |  |
| note | text |  |  | ''::text |  |  |
| submitted_by | bigint |  | 是 |  | staff |  |
| submitted_at | timestamp with time zone |  | 是 |  |  |  |
| approved_by | bigint |  | 是 |  | staff |  |
| approved_at | timestamp with time zone |  | 是 |  |  |  |
| created_by | bigint |  |  |  | staff |  |
| created_at | timestamp with time zone |  |  | now() |  |  |
| updated_at | timestamp with time zone |  |  | now() |  |  |
| version | integer |  |  | 1 |  |  |

## 旧系统导入（legacy_）

### legacy_brand_requests

品牌新增寻款采购清单 （建表：028_legacy_ledger）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| import_id | bigint | PK |  |  | legacy_imports |  |
| row_no | integer | PK |  |  |  |  |
| seq | text |  |  | ''::text |  |  |
| ordered | boolean |  |  | false |  |  |
| received | boolean |  |  | false |  |  |
| returned | boolean |  |  | false |  |  |
| product | text |  |  | ''::text |  |  |
| purpose | text |  |  | ''::text |  |  |
| qty_text | text |  |  | ''::text |  |  |
| qty_milli | bigint |  | 是 |  |  |  |
| note | text |  |  | ''::text |  |  |
| details | text |  |  | ''::text |  |  |
| link_text | text |  |  | ''::text |  |  |
| link_url | text |  |  | ''::text |  |  |
| raw | jsonb |  |  |  |  |  |

### legacy_images

已下单物料的 WPS 单元格图（原图，随备份走） （建表：028_legacy_ledger）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('legacy_images_id_seq'::regclass) |  |  |
| import_id | bigint |  |  |  | legacy_imports |  |
| image_key | text |  |  |  |  |  |
| mime | text |  |  |  |  |  |
| data | bytea |  |  |  |  |  |
| size_bytes | integer |  |  |  |  |  |

### legacy_imports

8–10 月旧账只读对照（v0.7.10，飞书需求 RQ-005 收尾，见 docs/LEGACY_LEDGER.md） 四份原始 Excel（采购台账、采购物资明细表、已下单物料、品牌新增寻款采购清单）按原样导入只读表： 不进正式账，任何正式的报表、台账、平账、账目自检、check 都不读这些表。 （建表：028_legacy_ledger）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  | nextval('legacy_imports_id_seq'::regclass) |  |  |
| source | text |  |  |  |  |  |
| file_name | text |  |  |  |  |  |
| sha256 | text |  |  |  |  | 文件内容摘要：同一份文件重复导入返回原来那次 |
| file_bytes | integer |  |  |  |  |  |
| sheets | jsonb |  |  |  |  | 每张表：名称、表格里写出来的行数（含空行）、表头所在行、导入的行数 |
| file_totals | jsonb |  |  | '{}'::jsonb |  | 表里自带的合计行（付款台账的「合计」）：列名 → 分 |
| warnings | jsonb |  |  | '[]'::jsonb |  |  |
| status | text |  |  | 'active'::text |  |  |
| imported_by | bigint |  |  |  | staff |  |
| imported_at | timestamp with time zone |  |  | now() |  |  |
| voided_by | bigint |  | 是 |  | staff |  |
| voided_at | timestamp with time zone |  | 是 |  |  |  |
| void_reason | text |  | 是 |  |  |  |

### legacy_ledger_lines

采购台账第 1 张「费用报销明细表」 （建表：028_legacy_ledger）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| import_id | bigint | PK |  |  | legacy_imports |  |
| row_no | integer | PK |  |  |  |  |
| seq | text |  |  | ''::text |  |  |
| entry_date | date |  | 是 |  |  |  |
| date_text | text |  |  | ''::text |  |  |
| item | text |  |  | ''::text |  |  |
| qty_text | text |  |  | ''::text |  |  |
| amount_cents | bigint |  | 是 |  |  | 单位：分 |
| amount_formula | text |  | 是 |  |  |  |
| merchant | text |  |  | ''::text |  |  |
| purpose | text |  |  | ''::text |  |  |
| invoice | text |  |  | ''::text |  |  |
| note | text |  |  | ''::text |  |  |
| merged_into | integer |  | 是 |  |  | 金额格与上面第几行合并（金额算在那一行） |
| pre_header | boolean |  |  | false |  | 表头下面、序号 1 之前的行：单列，不计入合计 |
| raw | jsonb |  |  |  |  |  |

### legacy_material_lines

采购物资明细表（每月一张表） （建表：028_legacy_ledger）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| import_id | bigint | PK |  |  | legacy_imports |  |
| sheet | text | PK |  |  |  |  |
| row_no | integer | PK |  |  |  |  |
| seq | text |  |  | ''::text |  |  |
| buy_date | date |  | 是 |  |  |  |
| date_text | text |  |  | ''::text |  |  |
| item | text |  |  | ''::text |  |  |
| purpose | text |  |  | ''::text |  |  |
| amount_cents | bigint |  | 是 |  |  | 单位：分 |
| amount_formula | text |  | 是 |  |  |  |
| bought_text | text |  |  | ''::text |  |  |
| bought_milli | bigint |  | 是 |  |  |  |
| received_text | text |  |  | ''::text |  |  |
| received_milli | bigint |  | 是 |  |  |  |
| department | text |  |  | ''::text |  |  |
| invoice | text |  |  | ''::text |  |  |
| tax_text | text |  |  | ''::text |  |  |
| tax_rate_bp | integer |  | 是 |  |  |  |
| category | text |  |  | ''::text |  |  |
| merged_into | integer |  | 是 |  |  |  |
| raw | jsonb |  |  |  |  |  |

### legacy_ordered_lines

已下单物料 （建表：028_legacy_ledger）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| import_id | bigint | PK |  |  | legacy_imports |  |
| sheet | text | PK |  |  |  |  |
| row_no | integer | PK |  |  |  |  |
| order_date | date |  | 是 |  |  |  |
| date_text | text |  |  | ''::text |  |  |
| product | text |  |  | ''::text |  |  |
| image_id | bigint |  | 是 |  | legacy_images |  |
| image_shared | boolean |  |  | false |  |  |
| variant | text |  |  | ''::text |  |  |
| department | text |  |  | ''::text |  |  |
| orderer | text |  |  | ''::text |  |  |
| qty_text | text |  |  | ''::text |  |  |
| qty_milli | bigint |  | 是 |  |  |  |
| amount_cents | bigint |  | 是 |  |  | 单位：分 |
| amount_formula | text |  | 是 |  |  |  |
| note | text |  |  | ''::text |  |  |
| merged_into | integer |  | 是 |  |  |  |
| raw | jsonb |  |  |  |  |  |

### legacy_payment_days

采购台账第 2 张「付款台账」 （建表：028_legacy_ledger）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| import_id | bigint | PK |  |  | legacy_imports |  |
| row_no | integer | PK |  |  |  |  |
| pay_date | date |  | 是 |  |  |  |
| date_text | text |  |  | ''::text |  |  |
| advance_cents | bigint |  | 是 |  |  | 单位：分 |
| advance_formula | text |  | 是 |  |  |  |
| should_return_cents | bigint |  | 是 |  |  | 单位：分 |
| should_return_formula | text |  | 是 |  |  |  |
| returned_cents | bigint |  | 是 |  |  | 单位：分 |
| returned_formula | text |  | 是 |  |  |  |
| note | text |  |  | ''::text |  |  |
| raw | jsonb |  |  |  |  |  |

## 归档（archived_）

### archived_integration_calls

对外调用记录的归档：超过保留天数的，由归档任务从 integration_calls 挪来（只追加；建表：483_archive_tables）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  |  |  |  |
| kind | text |  |  |  |  |  |
| provider | text |  |  |  |  |  |
| action | text |  |  |  |  |  |
| mode | text |  |  |  |  |  |
| ref_type | text |  | 是 |  |  |  |
| ref_id | bigint |  | 是 |  |  |  |
| request_summary | jsonb |  |  |  |  |  |
| ok | boolean |  |  |  |  |  |
| result_summary | jsonb |  |  |  |  |  |
| error | text |  | 是 |  |  |  |
| duration_ms | integer |  |  |  |  |  |
| staff_id | bigint |  | 是 |  |  |  |
| created_at | timestamp with time zone |  |  |  |  |  |
| archived_at | timestamp with time zone |  |  | now() |  | 挪进归档的时刻 |

### archived_location_events

位置事件的归档：超过保留天数、已没有轨迹段与当前位置引用的事件，由归档任务从 location_events 挪来（只追加；建表：483_archive_tables）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  |  |  |  |
| visit_id | bigint |  | 是 |  |  | 谁：在店客人（来访）或技师 |
| technician_id | bigint |  | 是 |  |  |  |
| tag_code | text |  | 是 |  |  | 当时的手牌号（客人换牌后，旧事件里仍是当时那张） |
| kind | text |  |  |  |  | 在某处 / 离开某处、去向不明（退房、没设休息区时下钟）/ 离店（客人结账、撤销来访；技师下牌） |
| floor_id | bigint |  | 是 |  |  |  |
| zone_id | bigint |  | 是 |  |  |  |
| space_id | bigint |  | 是 |  |  |  |
| source | text |  |  |  |  | 怎么知道的：刷卡、定位上报（第二级预留）、发牌、消费、开房、换房、退房、上钟、换服务的房间、下钟、技师上牌 / 下牌、结账、撤销来访 |
| ref_type | text |  | 是 |  |  | 哪条业务单据：来访、账单明细、入住单、钟单、结账单 |
| ref_id | bigint |  | 是 |  |  |  |
| reader_id | bigint |  | 是 |  |  |  |
| at | timestamp with time zone |  |  |  |  | 发生时刻（刷卡时刻、业务时刻）与写入时刻 |
| recorded_at | timestamp with time zone |  |  |  |  |  |
| applied | boolean |  |  |  |  | 生效：比这个人最近一次位置还早的（迟到的刷卡）只记事件、不改当前位置与轨迹 |
| op_key | uuid |  | 是 |  |  | 上报的操作编号与内容摘要：同一个编号原样重发返回原结果、不重复记（业务动作推导的为空） |
| op_hash | text |  | 是 |  |  |  |
| x_mm | integer |  | 是 |  |  | 第二级精确定位预留（UWB、蓝牙信标）：底图坐标（毫米）、精度（毫米）、设备编号；第一级为空 |
| y_mm | integer |  | 是 |  |  |  |
| accuracy_mm | integer |  | 是 |  |  |  |
| device_id | text |  | 是 |  |  |  |
| staff_id | bigint |  | 是 |  |  | 经办人：业务动作的操作员、模拟刷卡的人或设备桥的账号 |
| archived_at | timestamp with time zone |  |  | now() |  | 挪进归档的时刻 |

### archived_location_tracks

位置轨迹段的归档：结束超过保留天数、不是谁的当前段的，由归档任务从 location_tracks 挪来（只追加；建表：483_archive_tables）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  |  |  |  |
| visit_id | bigint |  | 是 |  |  |  |
| technician_id | bigint |  | 是 |  |  |  |
| floor_id | bigint |  |  |  |  |  |
| zone_id | bigint |  | 是 |  |  |  |
| space_id | bigint |  | 是 |  |  |  |
| entered_at | timestamp with time zone |  |  |  |  | 进入：这一段的第一条事件 |
| first_event_id | bigint |  |  |  |  |  |
| last_at | timestamp with time zone |  |  |  |  | 这一段最近的一条事件与事件数（第二级来了事件更密，段还是按进入—离开） |
| last_event_id | bigint |  |  |  |  |  |
| event_count | integer |  |  |  |  |  |
| left_at | timestamp with time zone |  | 是 |  |  | 离开：换到别处、离开、离店的那一条事件；还在这里为空 |
| end_event_id | bigint |  | 是 |  |  |  |
| archived_at | timestamp with time zone |  |  | now() |  | 挪进归档的时刻 |

### archived_wecom_pushes

企业微信推送记录的归档：已发完或已失败、超过保留天数的，由归档任务从 wecom_pushes 挪来（只追加；建表：483_archive_tables）

| 列 | 类型 | 键 | 可空 | 默认 | 引用 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| id | bigint | PK |  |  |  |  |
| kind | text |  |  |  |  |  |
| period_key | date |  | 是 |  |  | weekly：那一周的周一（门店时区）；test 为空 |
| status | text |  |  |  |  |  |
| content | text |  |  |  |  |  |
| error | text |  | 是 |  |  |  |
| attempts | integer |  |  |  |  |  |
| claimed_until | timestamp with time zone |  | 是 |  |  |  |
| created_by | bigint |  | 是 |  |  |  |
| created_at | timestamp with time zone |  |  |  |  |  |
| finished_at | timestamp with time zone |  | 是 |  |  |  |
| archived_at | timestamp with time zone |  |  | now() |  | 挪进归档的时刻 |
