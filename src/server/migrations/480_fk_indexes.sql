-- 数据库评估（8.1.47，docs/DB_REVIEW_V8147.md 第 3、4 节）：索引补齐。
-- ① 外键补索引：外键列没有以它打头的索引时，删父表的行（或改父表主键）要整表扫子表找引用、并锁住扫到的行；按父找子的查询（这张单的明细、这位会员的流水）也走不了索引。
--    规则（tests/schema-health.test.ts 核对，以后的新外键照这个来）：每个外键都要有以它打头的索引；只有指向员工 staff、门店 stores 的外键例外
--    （这两张是主数据，代码里从不删、主键不改，按员工、按门店找的查询各模块已有自己的复合索引）。
--    可以为空的外键列建部分索引（WHERE 列 IS NOT NULL）：大多为空的列（审批人、合并到谁）索引小得多，外键检查的 col = $1 照样用得上。
-- ② 慢查询：位置读卡器列表每个读卡器取「最后一次刷卡」（location_events 按 reader_id 取 max(at)），位置事件只增不减，原来每个读卡器整表扫一遍。
-- ③ 重复索引：wecom_pushes_recent_idx (id DESC) 与主键同列（B 树正反向都能扫），删掉。
-- 迁移是在一个事务里跑的（src/server/migrate.ts），不能用 CREATE INDEX CONCURRENTLY；建索引时这张表的写入要等索引建完（读不受影响）。
-- 门店的库是单店规模（最大的表几十万行），整份迁移秒级到十几秒，在发版重启时执行。表很大的环境先在影子库量一下时长。
-- 风险已知：只新建索引、删一个与主键重复的索引，不动数据；回滚见 docs/rollback/480_fk_indexes.down.sql。

-- ① 外键补索引（272 个；行尾注释是它指向的表；多列外键建同样几列的复合索引）
CREATE INDEX contract_reviews_approval_request_id_fk_idx ON contract_reviews (approval_request_id);  -- → approval_requests
CREATE INDEX contract_revisions_approval_request_id_fk_idx ON contract_revisions (approval_request_id) WHERE approval_request_id IS NOT NULL;  -- → approval_requests
CREATE INDEX approval_requests_rule_id_fk_idx ON approval_requests (rule_id) WHERE rule_id IS NOT NULL;  -- → approval_rules
CREATE INDEX checkout_payments_ar_account_id_fk_idx ON checkout_payments (ar_account_id) WHERE ar_account_id IS NOT NULL;  -- → ar_accounts
CREATE INDEX asset_stocktake_scans_asset_id_fk_idx ON asset_stocktake_scans (asset_id) WHERE asset_id IS NOT NULL;  -- → asset_cards
CREATE INDEX payment_batches_account_id_fk_idx ON payment_batches (account_id);  -- → bank_accounts
CREATE INDEX bank_statement_lines_import_id_fk_idx ON bank_statement_lines (import_id);  -- → bank_imports
CREATE INDEX benefit_grants_benefit_id_fk_idx ON benefit_grants (benefit_id);  -- → benefits
CREATE INDEX benefit_uses_benefit_id_fk_idx ON benefit_uses (benefit_id);  -- → benefits
CREATE INDEX checkout_bills_ticket_extension_benefit_id_fk_idx ON checkout_bills (ticket_extension_benefit_id) WHERE ticket_extension_benefit_id IS NOT NULL;  -- → benefits
CREATE INDEX checkout_payments_benefit_id_fk_idx ON checkout_payments (benefit_id) WHERE benefit_id IS NOT NULL;  -- → benefits
CREATE INDEX visit_incidents_bill_line_id_fk_idx ON visit_incidents (bill_line_id) WHERE bill_line_id IS NOT NULL;  -- → bill_lines
CREATE INDEX wormhole_stays_bill_line_id_fk_idx ON wormhole_stays (bill_line_id) WHERE bill_line_id IS NOT NULL;  -- → bill_lines
CREATE INDEX room_stays_bill_id_fk_idx ON room_stays (bill_id);  -- → bills
CREATE INDEX space_usages_bill_id_fk_idx ON space_usages (bill_id);  -- → bills
CREATE INDEX bonus_lot_moves_expiry_id_fk_idx ON bonus_lot_moves (expiry_id) WHERE expiry_id IS NOT NULL;  -- → bonus_expiries
CREATE INDEX bonus_lots_origin_lot_id_fk_idx ON bonus_lots (origin_lot_id) WHERE origin_lot_id IS NOT NULL;  -- → bonus_lots
CREATE INDEX concierge_records_native_booking_id_fk_idx ON concierge_records (native_booking_id) WHERE native_booking_id IS NOT NULL;  -- → bookings
CREATE INDEX canteen_checkins_recorder_id_fk_idx ON canteen_checkins (recorder_id);  -- → canteen_employees
CREATE INDEX canteen_checkins_voided_by_employee_fk_idx ON canteen_checkins (voided_by_employee) WHERE voided_by_employee IS NOT NULL;  -- → canteen_employees
CREATE INDEX canteen_feedback_read_by_employee_fk_idx ON canteen_feedback (read_by_employee) WHERE read_by_employee IS NOT NULL;  -- → canteen_employees
CREATE INDEX canteen_feedback_replied_by_employee_fk_idx ON canteen_feedback (replied_by_employee) WHERE replied_by_employee IS NOT NULL;  -- → canteen_employees
CREATE INDEX canteen_feedback_reply_ops_employee_id_fk_idx ON canteen_feedback_reply_ops (employee_id);  -- → canteen_employees
CREATE INDEX canteen_menus_updated_by_fk_idx ON canteen_menus (updated_by);  -- → canteen_employees
CREATE INDEX canteen_reminder_deliveries_employee_id_fk_idx ON canteen_reminder_deliveries (employee_id);  -- → canteen_employees
CREATE INDEX patrol_checkin_repeats_employee_id_fk_idx ON patrol_checkin_repeats (employee_id);  -- → canteen_employees
CREATE INDEX refund_items_checkout_item_fk_idx ON refund_items (checkout_id, category, name);  -- → checkout_items（三列外键）
CREATE INDEX concierge_records_native_checkout_id_fk_idx ON concierge_records (native_checkout_id) WHERE native_checkout_id IS NOT NULL;  -- → checkouts
CREATE INDEX coupon_events_checkout_id_fk_idx ON coupon_events (checkout_id) WHERE checkout_id IS NOT NULL;  -- → checkouts
CREATE INDEX group_buy_coupons_checkout_id_fk_idx ON group_buy_coupons (checkout_id);  -- → checkouts
CREATE INDEX concierge_praise_member_id_fk_idx ON concierge_praise (member_id) WHERE member_id IS NOT NULL;  -- → concierge_members
CREATE INDEX concierge_uploads_member_id_fk_idx ON concierge_uploads (member_id) WHERE member_id IS NOT NULL;  -- → concierge_members
CREATE INDEX concierge_balance_evidence_receipt_id_fk_idx ON concierge_balance_evidence (receipt_id) WHERE receipt_id IS NOT NULL;  -- → concierge_records
CREATE INDEX concierge_balance_evidence_upload_id_fk_idx ON concierge_balance_evidence (upload_id) WHERE upload_id IS NOT NULL;  -- → concierge_uploads
CREATE INDEX concierge_praise_evidence_upload_id_fk_idx ON concierge_praise_evidence (upload_id);  -- → concierge_uploads
CREATE INDEX member_grade_events_consumption_id_fk_idx ON member_grade_events (consumption_id) WHERE consumption_id IS NOT NULL;  -- → consumptions
CREATE INDEX contract_versions_change_id_fk_idx ON contract_versions (change_id) WHERE change_id IS NOT NULL;  -- → contract_changes
CREATE INDEX contracts_current_revision_id_fk_idx ON contracts (current_revision_id) WHERE current_revision_id IS NOT NULL;  -- → contract_revisions
CREATE INDEX count_card_moves_refund_id_fk_idx ON count_card_moves (refund_id) WHERE refund_id IS NOT NULL;  -- → count_card_refunds
CREATE INDEX count_cards_type_id_fk_idx ON count_cards (type_id) WHERE type_id IS NOT NULL;  -- → count_card_types
CREATE INDEX member_notices_campaign_id_fk_idx ON member_notices (campaign_id) WHERE campaign_id IS NOT NULL;  -- → coupon_campaigns
CREATE INDEX coupon_campaign_members_issue_id_fk_idx ON coupon_campaign_members (issue_id) WHERE issue_id IS NOT NULL;  -- → coupon_issues
CREATE INDEX member_notices_issue_id_fk_idx ON member_notices (issue_id) WHERE issue_id IS NOT NULL;  -- → coupon_issues
CREATE INDEX coupon_issues_rule_id_fk_idx ON coupon_issues (rule_id) WHERE rule_id IS NOT NULL;  -- → coupon_rules
CREATE INDEX benefits_template_id_fk_idx ON benefits (template_id) WHERE template_id IS NOT NULL;  -- → coupon_templates
CREATE INDEX coupon_campaigns_template_id_fk_idx ON coupon_campaigns (template_id);  -- → coupon_templates
CREATE INDEX coupon_gift_outs_template_id_fk_idx ON coupon_gift_outs (template_id);  -- → coupon_templates
CREATE INDEX coupon_issues_template_id_fk_idx ON coupon_issues (template_id);  -- → coupon_templates
CREATE INDEX coupon_rules_template_id_fk_idx ON coupon_rules (template_id);  -- → coupon_templates
CREATE INDEX mp_reminder_consents_coupon_id_fk_idx ON mp_reminder_consents (coupon_id) WHERE coupon_id IS NOT NULL;  -- → coupons
CREATE INDEX approval_requests_department_id_fk_idx ON approval_requests (department_id) WHERE department_id IS NOT NULL;  -- → departments
CREATE INDEX approval_rules_department_id_fk_idx ON approval_rules (department_id) WHERE department_id IS NOT NULL;  -- → departments
CREATE INDEX asset_stocktakes_department_id_fk_idx ON asset_stocktakes (department_id) WHERE department_id IS NOT NULL;  -- → departments
CREATE INDEX contracts_department_id_fk_idx ON contracts (department_id) WHERE department_id IS NOT NULL;  -- → departments
CREATE INDEX gf_docs_department_id_fk_idx ON gf_docs (department_id) WHERE department_id IS NOT NULL;  -- → departments
CREATE INDEX gf_hr_batch_lines_cost_dept_id_fk_idx ON gf_hr_batch_lines (cost_dept_id);  -- → departments
CREATE INDEX gf_hr_batches_department_id_fk_idx ON gf_hr_batches (department_id);  -- → departments
CREATE INDEX inv_docs_department_id_fk_idx ON inv_docs (department_id) WHERE department_id IS NOT NULL;  -- → departments
CREATE INDEX payment_requests_department_id_fk_idx ON payment_requests (department_id) WHERE department_id IS NOT NULL;  -- → departments
CREATE INDEX staff_department_id_fk_idx ON staff (department_id) WHERE department_id IS NOT NULL;  -- → departments
CREATE INDEX table_events_other_table_id_fk_idx ON table_events (other_table_id) WHERE other_table_id IS NOT NULL;  -- → dining_tables
CREATE INDEX table_session_moves_from_table_id_fk_idx ON table_session_moves (from_table_id);  -- → dining_tables
CREATE INDEX table_session_moves_to_table_id_fk_idx ON table_session_moves (to_table_id);  -- → dining_tables
CREATE INDEX dish_methods_group_fk_idx ON dish_methods (item_id, group_name) WHERE group_name IS NOT NULL;  -- → dish_method_groups（两列外键）
CREATE INDEX emenu_dishes_detail_image_id_fk_idx ON emenu_dishes (detail_image_id) WHERE detail_image_id IS NOT NULL;  -- → emenu_images
CREATE INDEX emenu_dishes_image_id_fk_idx ON emenu_dishes (image_id) WHERE image_id IS NOT NULL;  -- → emenu_images
CREATE INDEX service_items_dish_image_id_fk_idx ON service_items (dish_image_id) WHERE dish_image_id IS NOT NULL;  -- → emenu_images
CREATE INDEX contract_files_file_id_fk_idx ON contract_files (file_id) WHERE file_id IS NOT NULL;  -- → erp_files
CREATE INDEX inv_doc_attachments_file_id_fk_idx ON inv_doc_attachments (file_id) WHERE file_id IS NOT NULL;  -- → erp_files
CREATE INDEX invoice_requests_file_id_fk_idx ON invoice_requests (file_id) WHERE file_id IS NOT NULL;  -- → erp_files
CREATE INDEX supplier_contract_files_file_id_fk_idx ON supplier_contract_files (file_id);  -- → erp_files
CREATE INDEX supplier_invoice_attachments_file_id_fk_idx ON supplier_invoice_attachments (file_id) WHERE file_id IS NOT NULL;  -- → erp_files
CREATE INDEX supplier_licenses_file_id_fk_idx ON supplier_licenses (file_id) WHERE file_id IS NOT NULL;  -- → erp_files
CREATE INDEX concierge_uploads_image_id_fk_idx ON concierge_uploads (image_id);  -- → erp_images
CREATE INDEX contract_files_image_id_fk_idx ON contract_files (image_id) WHERE image_id IS NOT NULL;  -- → erp_images
CREATE INDEX inv_doc_attachments_image_id_fk_idx ON inv_doc_attachments (image_id) WHERE image_id IS NOT NULL;  -- → erp_images
CREATE INDEX purchase_order_line_images_image_id_fk_idx ON purchase_order_line_images (image_id);  -- → erp_images
CREATE INDEX purchase_request_line_images_image_id_fk_idx ON purchase_request_line_images (image_id);  -- → erp_images
CREATE INDEX supplier_invoice_attachments_image_id_fk_idx ON supplier_invoice_attachments (image_id) WHERE image_id IS NOT NULL;  -- → erp_images
CREATE INDEX supplier_licenses_image_id_fk_idx ON supplier_licenses (image_id) WHERE image_id IS NOT NULL;  -- → erp_images
CREATE INDEX opening_payables_import_id_fk_idx ON opening_payables (import_id) WHERE import_id IS NOT NULL;  -- → erp_imports
CREATE INDEX suppliers_import_id_fk_idx ON suppliers (import_id) WHERE import_id IS NOT NULL;  -- → erp_imports
CREATE INDEX floorplan_room_outlines_room_fk_idx ON floorplan_room_outlines (batch_id, floor_code, code);  -- → floorplan_rooms（三列外键）
CREATE INDEX gf_alloc_runs_rule_version_fk_idx ON gf_alloc_runs (rule_id, rule_version);  -- → gf_alloc_rule_versions（两列外键）
CREATE INDEX gf_alloc_runs_source_doc_id_fk_idx ON gf_alloc_runs (source_doc_id) WHERE source_doc_id IS NOT NULL;  -- → gf_docs
CREATE INDEX gf_contract_versions_new_doc_id_fk_idx ON gf_contract_versions (new_doc_id) WHERE new_doc_id IS NOT NULL;  -- → gf_docs
CREATE INDEX gf_dept_quotas_doc_id_fk_idx ON gf_dept_quotas (doc_id);  -- → gf_docs
CREATE INDEX gf_docs_related_doc_id_fk_idx ON gf_docs (related_doc_id) WHERE related_doc_id IS NOT NULL;  -- → gf_docs
CREATE INDEX gf_sku_prices_doc_id_fk_idx ON gf_sku_prices (doc_id);  -- → gf_docs
CREATE INDEX gf_skus_doc_id_fk_idx ON gf_skus (doc_id) WHERE doc_id IS NOT NULL;  -- → gf_docs
CREATE INDEX gf_skus_pending_change_doc_id_fk_idx ON gf_skus (pending_change_doc_id) WHERE pending_change_doc_id IS NOT NULL;  -- → gf_docs
CREATE INDEX gf_specials_doc_id_fk_idx ON gf_specials (doc_id) WHERE doc_id IS NOT NULL;  -- → gf_docs
CREATE INDEX gf_supplier_versions_doc_id_fk_idx ON gf_supplier_versions (doc_id) WHERE doc_id IS NOT NULL;  -- → gf_docs
CREATE INDEX gf_suppliers_admission_doc_id_fk_idx ON gf_suppliers (admission_doc_id) WHERE admission_doc_id IS NOT NULL;  -- → gf_docs
CREATE INDEX gf_suppliers_pending_change_doc_id_fk_idx ON gf_suppliers (pending_change_doc_id) WHERE pending_change_doc_id IS NOT NULL;  -- → gf_docs
CREATE INDEX gf_travel_ledger_doc_id_fk_idx ON gf_travel_ledger (doc_id);  -- → gf_docs
CREATE INDEX gf_hr_batches_original_batch_id_fk_idx ON gf_hr_batches (original_batch_id) WHERE original_batch_id IS NOT NULL;  -- → gf_hr_batches
CREATE INDEX gf_hr_checks_batch_id_fk_idx ON gf_hr_checks (batch_id);  -- → gf_hr_batches
CREATE INDEX visit_tag_changes_from_tag_id_fk_idx ON visit_tag_changes (from_tag_id);  -- → hand_tags
CREATE INDEX visit_tag_changes_to_tag_id_fk_idx ON visit_tag_changes (to_tag_id);  -- → hand_tags
CREATE INDEX stock_moves_doc_line_id_fk_idx ON stock_moves (doc_line_id);  -- → inv_doc_lines
CREATE INDEX coupon_gift_outs_inv_doc_id_fk_idx ON coupon_gift_outs (inv_doc_id) WHERE inv_doc_id IS NOT NULL;  -- → inv_docs
CREATE INDEX gift_receipts_receipt_doc_id_fk_idx ON gift_receipts (receipt_doc_id) WHERE receipt_doc_id IS NOT NULL;  -- → inv_docs
CREATE INDEX stock_transfers_in_doc_id_fk_idx ON stock_transfers (in_doc_id) WHERE in_doc_id IS NOT NULL;  -- → inv_docs
CREATE INDEX stock_transfers_out_doc_id_fk_idx ON stock_transfers (out_doc_id);  -- → inv_docs
CREATE INDEX stock_usage_batches_inv_doc_id_fk_idx ON stock_usage_batches (inv_doc_id) WHERE inv_doc_id IS NOT NULL;  -- → inv_docs
CREATE INDEX stock_usage_events_recipe_id_fk_idx ON stock_usage_events (recipe_id);  -- → item_recipes
CREATE INDEX service_items_station_id_fk_idx ON service_items (station_id) WHERE station_id IS NOT NULL;  -- → kitchen_stations
CREATE INDEX legacy_ordered_lines_image_id_fk_idx ON legacy_ordered_lines (image_id) WHERE image_id IS NOT NULL;  -- → legacy_images
CREATE INDEX gf_docs_entity_id_fk_idx ON gf_docs (entity_id) WHERE entity_id IS NOT NULL;  -- → legal_entities
CREATE INDEX gf_licenses_entity_id_fk_idx ON gf_licenses (entity_id) WHERE entity_id IS NOT NULL;  -- → legal_entities
CREATE INDEX gf_role_members_entity_id_fk_idx ON gf_role_members (entity_id) WHERE entity_id IS NOT NULL;  -- → legal_entities
CREATE INDEX purchase_requests_entity_id_fk_idx ON purchase_requests (entity_id) WHERE entity_id IS NOT NULL;  -- → legal_entities
CREATE INDEX stores_entity_id_fk_idx ON stores (entity_id);  -- → legal_entities
CREATE INDEX linen_doc_lines_item_id_fk_idx ON linen_doc_lines (item_id);  -- → linen_items
CREATE INDEX current_locations_last_event_id_fk_idx ON current_locations (last_event_id) WHERE last_event_id IS NOT NULL;  -- → location_events
CREATE INDEX location_tracks_end_event_id_fk_idx ON location_tracks (end_event_id) WHERE end_event_id IS NOT NULL;  -- → location_events
CREATE INDEX location_tracks_first_event_id_fk_idx ON location_tracks (first_event_id);  -- → location_events
CREATE INDEX location_tracks_last_event_id_fk_idx ON location_tracks (last_event_id);  -- → location_events
CREATE INDEX current_locations_track_id_fk_idx ON current_locations (track_id) WHERE track_id IS NOT NULL;  -- → location_tracks
CREATE INDEX asset_cards_material_id_fk_idx ON asset_cards (material_id) WHERE material_id IS NOT NULL;  -- → materials
CREATE INDEX coupon_gift_outs_material_id_fk_idx ON coupon_gift_outs (material_id);  -- → materials
CREATE INDEX coupon_templates_gift_material_id_fk_idx ON coupon_templates (gift_material_id) WHERE gift_material_id IS NOT NULL;  -- → materials
CREATE INDEX expense_claim_lines_material_id_fk_idx ON expense_claim_lines (material_id) WHERE material_id IS NOT NULL;  -- → materials
CREATE INDEX gift_receipts_material_id_fk_idx ON gift_receipts (material_id) WHERE material_id IS NOT NULL;  -- → materials
CREATE INDEX item_recipe_lines_material_id_fk_idx ON item_recipe_lines (material_id);  -- → materials
CREATE INDEX request_line_stock_substitute_material_id_fk_idx ON request_line_stock (substitute_material_id) WHERE substitute_material_id IS NOT NULL;  -- → materials
CREATE INDEX sourcing_lines_material_id_fk_idx ON sourcing_lines (material_id);  -- → materials
CREATE INDEX stock_transfer_lines_material_id_fk_idx ON stock_transfer_lines (material_id);  -- → materials
CREATE INDEX member_card_returns_deposit_id_fk_idx ON member_card_returns (deposit_id) WHERE deposit_id IS NOT NULL;  -- → member_card_deposits
CREATE INDEX member_card_deposits_card_id_fk_idx ON member_card_deposits (card_id) WHERE card_id IS NOT NULL;  -- → member_cards
CREATE INDEX member_card_returns_card_id_fk_idx ON member_card_returns (card_id) WHERE card_id IS NOT NULL;  -- → member_cards
CREATE INDEX member_cards_replaces_id_fk_idx ON member_cards (replaces_id) WHERE replaces_id IS NOT NULL;  -- → member_cards
CREATE INDEX bonus_lot_moves_member_merge_id_fk_idx ON bonus_lot_moves (member_merge_id) WHERE member_merge_id IS NOT NULL;  -- → member_merges
CREATE INDEX bonus_lots_member_merge_id_fk_idx ON bonus_lots (member_merge_id) WHERE member_merge_id IS NOT NULL;  -- → member_merges
CREATE INDEX member_grade_events_member_merge_id_fk_idx ON member_grade_events (member_merge_id) WHERE member_merge_id IS NOT NULL;  -- → member_merges
CREATE INDEX member_refund_lines_member_merge_id_fk_idx ON member_refund_lines (member_merge_id) WHERE member_merge_id IS NOT NULL;  -- → member_merges
CREATE INDEX member_status_events_member_merge_id_fk_idx ON member_status_events (member_merge_id) WHERE member_merge_id IS NOT NULL;  -- → member_merges
CREATE INDEX bonus_lot_moves_member_refund_id_fk_idx ON bonus_lot_moves (member_refund_id) WHERE member_refund_id IS NOT NULL;  -- → member_refunds
CREATE INDEX member_grade_events_member_refund_id_fk_idx ON member_grade_events (member_refund_id) WHERE member_refund_id IS NOT NULL;  -- → member_refunds
CREATE INDEX mp_refund_orders_member_refund_id_fk_idx ON mp_refund_orders (member_refund_id);  -- → member_refunds
CREATE INDEX checkout_payments_member_id_fk_idx ON checkout_payments (member_id) WHERE member_id IS NOT NULL;  -- → members
CREATE INDEX coupon_campaign_members_member_id_fk_idx ON coupon_campaign_members (member_id);  -- → members
CREATE INDEX customer_recharge_credits_canonical_member_id_fk_idx ON customer_recharge_credits (canonical_member_id);  -- → members
CREATE INDEX customer_recharge_credits_member_id_fk_idx ON customer_recharge_credits (member_id);  -- → members
CREATE INDEX mp_invites_invitee_member_id_fk_idx ON mp_invites (invitee_member_id) WHERE invitee_member_id IS NOT NULL;  -- → members
CREATE INDEX mp_recharge_orders_credited_member_id_fk_idx ON mp_recharge_orders (credited_member_id) WHERE credited_member_id IS NOT NULL;  -- → members
CREATE INDEX reversals_member_id_fk_idx ON reversals (member_id);  -- → members
CREATE INDEX sms_outbox_member_id_fk_idx ON sms_outbox (member_id) WHERE member_id IS NOT NULL;  -- → members
CREATE INDEX mp_booking_ops_binding_id_fk_idx ON mp_booking_ops (binding_id);  -- → mp_bindings
CREATE INDEX mp_coupon_claims_binding_id_fk_idx ON mp_coupon_claims (binding_id);  -- → mp_bindings
CREATE INDEX mp_food_orders_binding_id_fk_idx ON mp_food_orders (binding_id);  -- → mp_bindings
CREATE INDEX mp_invites_invitee_binding_id_fk_idx ON mp_invites (invitee_binding_id) WHERE invitee_binding_id IS NOT NULL;  -- → mp_bindings
CREATE INDEX mp_invites_inviter_binding_id_fk_idx ON mp_invites (inviter_binding_id);  -- → mp_bindings
CREATE INDEX mp_recharge_orders_binding_id_fk_idx ON mp_recharge_orders (binding_id);  -- → mp_bindings
CREATE INDEX mp_banners_image_id_fk_idx ON mp_banners (image_id);  -- → mp_images
CREATE INDEX mp_item_intros_image_id_fk_idx ON mp_item_intros (image_id) WHERE image_id IS NOT NULL;  -- → mp_images
CREATE INDEX mp_stores_image_id_fk_idx ON mp_stores (image_id) WHERE image_id IS NOT NULL;  -- → mp_images
CREATE INDEX mp_refund_orders_recharge_order_id_fk_idx ON mp_refund_orders (recharge_order_id) WHERE recharge_order_id IS NOT NULL;  -- → mp_recharge_orders
CREATE INDEX oa_approval_events_step_id_fk_idx ON oa_approval_events (step_id) WHERE step_id IS NOT NULL;  -- → oa_approval_steps
CREATE INDEX oa_approval_steps_transferred_to_fk_idx ON oa_approval_steps (transferred_to) WHERE transferred_to IS NOT NULL;  -- → oa_approval_steps
CREATE INDEX oa_approvals_template_id_fk_idx ON oa_approvals (template_id);  -- → oa_approval_templates
CREATE INDEX oa_attendance_daily_cover_approval_id_fk_idx ON oa_attendance_daily (cover_approval_id) WHERE cover_approval_id IS NOT NULL;  -- → oa_approvals
CREATE INDEX oa_im_messages_attachment_id_fk_idx ON oa_im_messages (attachment_id) WHERE attachment_id IS NOT NULL;  -- → oa_attachments
CREATE INDEX oa_punches_group_id_fk_idx ON oa_punches (group_id) WHERE group_id IS NOT NULL;  -- → oa_attendance_groups
CREATE INDEX oa_schedule_grants_scope_group_id_fk_idx ON oa_schedule_grants (scope_group_id) WHERE scope_group_id IS NOT NULL;  -- → oa_attendance_groups
CREATE INDEX oa_schedule_publishes_group_id_fk_idx ON oa_schedule_publishes (group_id);  -- → oa_attendance_groups
CREATE INDEX oa_im_conversations_last_message_id_fk_idx ON oa_im_conversations (last_message_id) WHERE last_message_id IS NOT NULL;  -- → oa_im_messages
CREATE INDEX oa_attendance_covers_leave_type_id_fk_idx ON oa_attendance_covers (leave_type_id) WHERE leave_type_id IS NOT NULL;  -- → oa_leave_types
CREATE INDEX oa_leave_balances_leave_type_id_fk_idx ON oa_leave_balances (leave_type_id);  -- → oa_leave_types
CREATE INDEX oa_leave_entries_leave_type_id_fk_idx ON oa_leave_entries (leave_type_id);  -- → oa_leave_types
CREATE INDEX oa_group_locations_location_id_fk_idx ON oa_group_locations (location_id);  -- → oa_locations
CREATE INDEX oa_punches_location_id_fk_idx ON oa_punches (location_id) WHERE location_id IS NOT NULL;  -- → oa_locations
CREATE INDEX oa_payroll_audit_file_id_fk_idx ON oa_payroll_audit (file_id) WHERE file_id IS NOT NULL;  -- → oa_payroll_files
CREATE INDEX oa_payroll_batches_template_id_fk_idx ON oa_payroll_batches (template_id);  -- → oa_payslip_templates
CREATE INDEX oa_attendance_daily_in_punch_id_fk_idx ON oa_attendance_daily (in_punch_id) WHERE in_punch_id IS NOT NULL;  -- → oa_punches
CREATE INDEX oa_attendance_daily_out_punch_id_fk_idx ON oa_attendance_daily (out_punch_id) WHERE out_punch_id IS NOT NULL;  -- → oa_punches
CREATE INDEX oa_schedules_publish_id_fk_idx ON oa_schedules (publish_id) WHERE publish_id IS NOT NULL;  -- → oa_schedule_publishes
CREATE INDEX oa_attendance_daily_shift_id_fk_idx ON oa_attendance_daily (shift_id);  -- → oa_shifts
CREATE INDEX oa_punches_shift_id_fk_idx ON oa_punches (shift_id) WHERE shift_id IS NOT NULL;  -- → oa_shifts
CREATE INDEX oa_schedules_shift_id_fk_idx ON oa_schedules (shift_id);  -- → oa_shifts
CREATE INDEX bonus_lot_moves_opening_id_fk_idx ON bonus_lot_moves (opening_id) WHERE opening_id IS NOT NULL;  -- → opening_balances
CREATE INDEX member_refund_lines_opening_id_fk_idx ON member_refund_lines (opening_id) WHERE opening_id IS NOT NULL;  -- → opening_balances
CREATE INDEX ap_entries_opening_payable_id_fk_idx ON ap_entries (opening_payable_id) WHERE opening_payable_id IS NOT NULL;  -- → opening_payables
CREATE INDEX payment_request_targets_opening_payable_id_fk_idx ON payment_request_targets (opening_payable_id) WHERE opening_payable_id IS NOT NULL;  -- → opening_payables
CREATE INDEX oa_schedule_grants_scope_dept_key_fk_idx ON oa_schedule_grants (scope_dept_key) WHERE scope_dept_key IS NOT NULL;  -- → org_departments
CREATE INDEX org_departments_parent_key_fk_idx ON org_departments (parent_key) WHERE parent_key IS NOT NULL;  -- → org_departments
CREATE INDEX position_catalog_department_fk_idx ON position_catalog (department);  -- → org_departments
CREATE INDEX ota_orders_last_import_id_fk_idx ON ota_orders (last_import_id) WHERE last_import_id IS NOT NULL;  -- → ota_imports
CREATE INDEX patrol_checkin_repeats_checkin_id_fk_idx ON patrol_checkin_repeats (checkin_id);  -- → patrol_checkins
CREATE INDEX checkout_payments_pay_tx_id_fk_idx ON checkout_payments (pay_tx_id) WHERE pay_tx_id IS NOT NULL;  -- → pay_transactions
CREATE INDEX recharges_pay_tx_id_fk_idx ON recharges (pay_tx_id) WHERE pay_tx_id IS NOT NULL;  -- → pay_transactions
CREATE INDEX petty_merge_log_advance_id_fk_idx ON petty_merge_log (advance_id) WHERE advance_id IS NOT NULL;  -- → petty_advances
CREATE INDEX platform_recon_issues_run_id_fk_idx ON platform_recon_issues (run_id);  -- → platform_recon_runs
CREATE INDEX platform_verifications_redemption_id_fk_idx ON platform_verifications (redemption_id) WHERE redemption_id IS NOT NULL;  -- → platform_redemptions
CREATE INDEX group_buy_coupons_verification_id_fk_idx ON group_buy_coupons (verification_id) WHERE verification_id IS NOT NULL;  -- → platform_verifications
CREATE INDEX position_config_log_position_key_fk_idx ON position_config_log (position_key) WHERE position_key IS NOT NULL;  -- → position_catalog
CREATE INDEX price_catalog_import_ops_set_id_fk_idx ON price_catalog_import_ops (set_id) WHERE set_id IS NOT NULL;  -- → price_catalog_sets
CREATE INDEX coupon_rules_plan_id_fk_idx ON coupon_rules (plan_id) WHERE plan_id IS NOT NULL;  -- → recharge_plans
CREATE INDEX mp_recharge_orders_plan_id_fk_idx ON mp_recharge_orders (plan_id) WHERE plan_id IS NOT NULL;  -- → recharge_plans
CREATE INDEX recharges_plan_id_fk_idx ON recharges (plan_id) WHERE plan_id IS NOT NULL;  -- → recharge_plans
CREATE INDEX coupon_issues_recharge_id_fk_idx ON coupon_issues (recharge_id) WHERE recharge_id IS NOT NULL;  -- → recharges
CREATE INDEX member_grade_events_recharge_id_fk_idx ON member_grade_events (recharge_id) WHERE recharge_id IS NOT NULL;  -- → recharges
CREATE INDEX mp_refund_orders_recharge_id_fk_idx ON mp_refund_orders (recharge_id);  -- → recharges
CREATE INDEX pay_refunds_refund_id_fk_idx ON pay_refunds (refund_id) WHERE refund_id IS NOT NULL;  -- → refunds
CREATE INDEX bonus_expiries_reversal_id_fk_idx ON bonus_expiries (reversal_id) WHERE reversal_id IS NOT NULL;  -- → reversals
CREATE INDEX bonus_lot_moves_reversal_id_fk_idx ON bonus_lot_moves (reversal_id) WHERE reversal_id IS NOT NULL;  -- → reversals
CREATE INDEX space_room_events_registration_id_fk_idx ON space_room_events (registration_id) WHERE registration_id IS NOT NULL;  -- → room_registrations
CREATE INDEX ota_orders_room_type_id_fk_idx ON ota_orders (room_type_id) WHERE room_type_id IS NOT NULL;  -- → room_types
CREATE INDEX room_stays_room_type_id_fk_idx ON room_stays (room_type_id);  -- → room_types
CREATE INDEX rooms_room_type_id_fk_idx ON rooms (room_type_id);  -- → room_types
CREATE INDEX room_moves_from_room_id_fk_idx ON room_moves (from_room_id);  -- → rooms
CREATE INDEX room_moves_to_room_id_fk_idx ON room_moves (to_room_id);  -- → rooms
CREATE INDEX bill_lines_item_id_fk_idx ON bill_lines (item_id) WHERE item_id IS NOT NULL;  -- → service_items
CREATE INDEX bookings_item_id_fk_idx ON bookings (item_id) WHERE item_id IS NOT NULL;  -- → service_items
CREATE INDEX consumption_lines_item_id_fk_idx ON consumption_lines (item_id) WHERE item_id IS NOT NULL;  -- → service_items
CREATE INDEX coupon_gift_outs_item_id_fk_idx ON coupon_gift_outs (item_id) WHERE item_id IS NOT NULL;  -- → service_items
CREATE INDEX coupon_templates_buy_item_id_fk_idx ON coupon_templates (buy_item_id) WHERE buy_item_id IS NOT NULL;  -- → service_items
CREATE INDEX coupon_templates_exchange_item_id_fk_idx ON coupon_templates (exchange_item_id) WHERE exchange_item_id IS NOT NULL;  -- → service_items
CREATE INDEX dish_ops_item_id_fk_idx ON dish_ops (item_id) WHERE item_id IS NOT NULL;  -- → service_items
CREATE INDEX kitchen_item_parts_item_id_fk_idx ON kitchen_item_parts (item_id);  -- → service_items
CREATE INDEX kitchen_items_item_id_fk_idx ON kitchen_items (item_id);  -- → service_items
CREATE INDEX service_item_store_prices_item_id_fk_idx ON service_item_store_prices (item_id);  -- → service_items
CREATE INDEX technician_sessions_item_id_fk_idx ON technician_sessions (item_id);  -- → service_items
CREATE INDEX sourcing_quote_lines_sourcing_line_id_fk_idx ON sourcing_quote_lines (sourcing_line_id);  -- → sourcing_lines
CREATE INDEX sourcing_events_awarded_quote_id_fk_idx ON sourcing_events (awarded_quote_id) WHERE awarded_quote_id IS NOT NULL;  -- → sourcing_quotes
CREATE INDEX supplier_link_replies_quote_id_fk_idx ON supplier_link_replies (quote_id) WHERE quote_id IS NOT NULL;  -- → sourcing_quotes
CREATE INDEX spaces_import_id_fk_idx ON spaces (import_id) WHERE import_id IS NOT NULL;  -- → space_imports
CREATE INDEX zones_import_id_fk_idx ON zones (import_id) WHERE import_id IS NOT NULL;  -- → space_imports
CREATE INDEX location_readers_space_id_fk_idx ON location_readers (space_id) WHERE space_id IS NOT NULL;  -- → spaces
CREATE INDEX po_supplier_confirmations_link_id_fk_idx ON po_supplier_confirmations (link_id);  -- → supplier_links
CREATE INDEX sourcing_quotes_via_link_id_fk_idx ON sourcing_quotes (via_link_id) WHERE via_link_id IS NOT NULL;  -- → supplier_links
CREATE INDEX inv_docs_supplier_id_fk_idx ON inv_docs (supplier_id) WHERE supplier_id IS NOT NULL;  -- → suppliers
CREATE INDEX materials_default_supplier_id_fk_idx ON materials (default_supplier_id) WHERE default_supplier_id IS NOT NULL;  -- → suppliers
CREATE INDEX opening_payables_supplier_id_fk_idx ON opening_payables (supplier_id);  -- → suppliers
CREATE INDEX purchase_request_lines_supplier_id_fk_idx ON purchase_request_lines (supplier_id) WHERE supplier_id IS NOT NULL;  -- → suppliers
CREATE INDEX sourcing_quotes_supplier_id_fk_idx ON sourcing_quotes (supplier_id);  -- → suppliers
CREATE INDEX supplier_links_supplier_id_fk_idx ON supplier_links (supplier_id);  -- → suppliers
CREATE INDEX table_events_other_session_id_fk_idx ON table_events (other_session_id) WHERE other_session_id IS NOT NULL;  -- → table_sessions
CREATE INDEX table_events_session_id_fk_idx ON table_events (session_id) WHERE session_id IS NOT NULL;  -- → table_sessions
CREATE INDEX technicians_photo_id_fk_idx ON technicians (photo_id) WHERE photo_id IS NOT NULL;  -- → technician_photos
CREATE INDEX room_registrations_session_id_fk_idx ON room_registrations (session_id);  -- → technician_sessions
CREATE INDEX technician_calls_session_id_fk_idx ON technician_calls (session_id) WHERE session_id IS NOT NULL;  -- → technician_sessions
CREATE INDEX technician_events_session_id_fk_idx ON technician_events (session_id) WHERE session_id IS NOT NULL;  -- → technician_sessions
CREATE INDEX technician_schedule_shift_id_fk_idx ON technician_schedule (shift_id) WHERE shift_id IS NOT NULL;  -- → technician_shifts
CREATE INDEX technician_schedule_changes_from_shift_id_fk_idx ON technician_schedule_changes (from_shift_id) WHERE from_shift_id IS NOT NULL;  -- → technician_shifts
CREATE INDEX technician_schedule_changes_to_shift_id_fk_idx ON technician_schedule_changes (to_shift_id) WHERE to_shift_id IS NOT NULL;  -- → technician_shifts
CREATE INDEX technician_calls_technician_id_fk_idx ON technician_calls (technician_id);  -- → technicians
CREATE INDEX technician_events_technician_id_fk_idx ON technician_events (technician_id) WHERE technician_id IS NOT NULL;  -- → technicians
CREATE INDEX technician_groups_leader_id_fk_idx ON technician_groups (leader_id) WHERE leader_id IS NOT NULL;  -- → technicians
CREATE INDEX technician_schedule_changes_swap_with_fk_idx ON technician_schedule_changes (swap_with) WHERE swap_with IS NOT NULL;  -- → technicians
CREATE INDEX technician_schedule_changes_technician_id_fk_idx ON technician_schedule_changes (technician_id);  -- → technicians
CREATE INDEX bill_lines_ticket_type_id_fk_idx ON bill_lines (ticket_type_id) WHERE ticket_type_id IS NOT NULL;  -- → ticket_types
CREATE INDEX checkout_bills_ticket_type_id_fk_idx ON checkout_bills (ticket_type_id) WHERE ticket_type_id IS NOT NULL;  -- → ticket_types
CREATE INDEX coupon_templates_exchange_ticket_type_id_fk_idx ON coupon_templates (exchange_ticket_type_id) WHERE exchange_ticket_type_id IS NOT NULL;  -- → ticket_types
CREATE INDEX visit_ticket_changes_from_type_id_fk_idx ON visit_ticket_changes (from_type_id) WHERE from_type_id IS NOT NULL;  -- → ticket_types
CREATE INDEX visit_ticket_changes_to_type_id_fk_idx ON visit_ticket_changes (to_type_id);  -- → ticket_types
CREATE INDEX visits_ticket_type_id_fk_idx ON visits (ticket_type_id) WHERE ticket_type_id IS NOT NULL;  -- → ticket_types
CREATE INDEX training_file_versions_sha256_fk_idx ON training_file_versions (sha256);  -- → training_blobs
CREATE INDEX training_files_current_version_id_fk_idx ON training_files (current_version_id) WHERE current_version_id IS NOT NULL;  -- → training_file_versions
CREATE INDEX training_uploads_result_version_id_fk_idx ON training_uploads (result_version_id) WHERE result_version_id IS NOT NULL;  -- → training_file_versions
CREATE INDEX training_views_last_version_id_fk_idx ON training_views (last_version_id) WHERE last_version_id IS NOT NULL;  -- → training_file_versions
CREATE INDEX training_uploads_result_file_id_fk_idx ON training_uploads (result_file_id) WHERE result_file_id IS NOT NULL;  -- → training_files
CREATE INDEX bookings_arrival_visit_id_fk_idx ON bookings (arrival_visit_id) WHERE arrival_visit_id IS NOT NULL;  -- → visits
CREATE INDEX checkout_bills_visit_id_fk_idx ON checkout_bills (visit_id) WHERE visit_id IS NOT NULL;  -- → visits
CREATE INDEX mp_food_orders_visit_id_fk_idx ON mp_food_orders (visit_id);  -- → visits
CREATE INDEX coupon_gift_outs_warehouse_id_fk_idx ON coupon_gift_outs (warehouse_id);  -- → warehouses
CREATE INDEX coupon_templates_gift_warehouse_id_fk_idx ON coupon_templates (gift_warehouse_id) WHERE gift_warehouse_id IS NOT NULL;  -- → warehouses
CREATE INDEX item_recipes_warehouse_id_fk_idx ON item_recipes (warehouse_id) WHERE warehouse_id IS NOT NULL;  -- → warehouses
CREATE INDEX stock_transfers_from_warehouse_id_fk_idx ON stock_transfers (from_warehouse_id);  -- → warehouses
CREATE INDEX location_readers_zone_id_fk_idx ON location_readers (zone_id) WHERE zone_id IS NOT NULL;  -- → zones
CREATE INDEX service_items_zone_id_fk_idx ON service_items (zone_id) WHERE zone_id IS NOT NULL;  -- → zones

-- ② 读卡器「最后一次刷卡」
CREATE INDEX location_events_reader_idx ON location_events (reader_id, at DESC) WHERE reader_id IS NOT NULL;

-- ③ 与主键重复的索引
-- 风险已知：只删索引不删数据；最近记录按主键倒序扫，计划不变；回滚重建。
DROP INDEX wecom_pushes_recent_idx;
