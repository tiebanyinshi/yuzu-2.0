import type { Db } from '../db';
import { currentRequestId, currentStoreId, DEFAULT_STORE_ID } from './store-context';

export type AuditAction =
  | 'customer_record'
  | 'concierge_record'
  | 'concierge_upload'
  | 'login'
  | 'login_failed'
  | 'auth_granted'
  | 'auth_failed'
  | 'logout'
  | 'password_changed'
  | 'staff_created'
  | 'staff_updated'
  | 'staff_password_reset'
  // OA-01 组织架构与员工档案（docs/OA.md 第 4 节）
  | 'org_department_updated'
  | 'employee_profile_updated'
  | 'employee_left'
  | 'employee_rehired'
  // OA-04 考勤组、班次、打卡点（docs/OA.md 第 7 节）
  | 'oa_shift_saved'
  | 'oa_location_saved'
  | 'oa_group_saved'
  // OA-05 排班
  | 'oa_schedule_saved'
  | 'oa_face_reviewed'
  | 'oa_attendance_settled'
  | 'oa_attendance_outwork'
  | 'oa_leave_type_saved'
  | 'oa_leave_adjusted'
  | 'oa_leave_granted'
  | 'oa_approval_template_saved'
  | 'oa_holidays_saved'
  | 'oa_staff_imported'
  // OA-16 通讯录与群管理
  | 'oa_im_dept_group_created'
  | 'oa_im_group_dissolved'
  | 'oa_directory_settings_saved'
  | 'oa_payslip_template_saved'
  | 'oa_payroll_batch_created'
  | 'oa_payroll_imported'
  | 'oa_payroll_edited'
  | 'oa_payroll_batch_voided'
  | 'oa_payroll_published'
  // 员工培训（2026-11-25）：文件夹的新建与修改；培训文件的上传、换版本、改标题、移动、上下架
  | 'training_folder_saved'
  | 'training_file_saved'
  // 业财法审批流（2026-11-26，docs/APPROVAL_V4.md）：角色映射、事项（新建 / 提交 / 撤回 / 执行）、审批动作、微信特批
  | 'gf_role'
  | 'gf_doc'
  | 'gf_act'
  | 'gf_special'
  | 'gf_supply'
  | 'gf_petty'
  | 'gf_contract'
  | 'gf_payment'
  | 'gf_expense'
  | 'gf_hr'
  | 'oa_payroll_reminded'
  | 'position_chosen'
  | 'member_created'
  | 'member_updated'
  | 'recharge_created'
  | 'consumption_created'
  | 'consumption_reversed'
  | 'consume_rejected'
  | 'duplicate_blocked'
  | 'operation_abandoned'
  | 'settlement_closed'
  | 'settings_updated'
  | 'store_saved'
  | 'entity_saved'
  | 'staff_stores_saved'
  | 'store_switched'
  | 'plan_saved'
  | 'item_saved'
  | 'price_list_imported'
  | 'bonus_expired'
  | 'opening_imported'
  | 'opening_voided'
  | 'member_history_imported'
  | 'member_history_voided'
  | 'export'
  | 'inventory_master_saved'
  | 'inventory_doc'
  | 'purchase_order'
  | 'payable_doc'
  | 'erp_import'
  | 'expense_doc'
  | 'petty_doc'
  | 'petty_account'
  | 'sourcing_doc'
  | 'approval_rule'
  | 'approval_delegation'
  | 'approval_batch'
  | 'contract_doc'
  | 'payment_doc'
  | 'purchase_request'
  | 'erp_image'
  | 'erp_op_abandoned'
  | 'inventory_settings_updated'
  | 'frontdesk_checkin'
  | 'frontdesk_swap'
  | 'frontdesk_group'
  // 8.1.44：买单时把会员记到手牌上（现场建档或查到的老会员）
  | 'frontdesk_bind_member'
  | 'frontdesk_cancel'
  | 'frontdesk_post'
  | 'frontdesk_void'
  | 'clock_assign'
  | 'clock_transfer'
  | 'clock_session_room'
  | 'frontdesk_move'
  // 8.2.1：单项打折、撤下折扣；手牌押金的收、退
  | 'frontdesk_line_discount'
  | 'frontdesk_line_discount_revoke'
  | 'tag_deposit_received'
  | 'tag_deposit_refunded'
  | 'frontdesk_abandon'
  | 'frontdesk_ticket'
  | 'frontdesk_checkout'
  | 'frontdesk_checkout_void'
  | 'ticket_type_saved'
  | 'shift_started'
  | 'shift_closed'
  | 'shift_joined'
  | 'shift_left'
  | 'hand_tags_created'
  | 'hand_tags_imported'
  | 'hand_tag_locked'
  | 'locker_opened'
  | 'hand_tag_unlocked'
  | 'hand_tag_updated'
  | 'technician_saved'
  // 8.1.35 福田迁移：技师名册导入
  | 'technicians_imported'
  | 'items_technician_updated'
  // 餐饮（S5 第一步）：出品档口、菜品的出品档口、沽清
  | 'kitchen_station_saved'
  | 'items_station_updated'
  // 8.1.7：菜品的点单分类（餐厅 / 水吧 / 果吧）
  | 'items_slot_updated'
  | 'dish_limit_set'
  | 'dining_table_saved'
  | 'table_open'
  | 'table_update'
  | 'table_move'
  | 'table_cancel'
  | 'table_post'
  | 'table_void'
  // 点餐系统 · 平板电子菜单（8.0.10，docs/EMENU.md）：平板下单、电子菜单的保存与生成初稿、点单密码
  | 'emenu_order'
  | 'emenu_saved'
  | 'emenu_draft'
  | 'order_pin_set'
  | 'order_pin_cleared'
  | 'order_pin_failed'
  // 客房（S7，v0.7.4）
  | 'room_type_saved'
  | 'room_saved'
  | 'room_checkin'
  | 'room_extend'
  | 'room_update'
  | 'room_move'
  | 'room_cancel'
  | 'room_deposit'
  | 'room_close'
  | 'room_housekeeping'
  | 'room_audit'
  // 8–10 月旧账只读对照（v0.7.10）
  | 'legacy_imported'
  | 'legacy_import_voided'
  // 空间台账（RQ-004 第一段，v0.7.14）：空间（含别名、核对、批量设区域）、楼层与区域、导入
  | 'space_saved'
  | 'space_zone_saved'
  | 'space_import'
  // 底图转换（RQ-004 第二段，v0.7.15）：上传图纸、启用一批底图
  | 'floorplan_upload'
  | 'floorplan_activate'
  // 第一级实时位置（RQ-004，v0.7.17）：刷卡点、项目所在区域
  | 'location_reader_saved'
  | 'items_zone_updated'
  // 平面图收尾（v0.7.19）：派对房等的使用单；换回旧底图、补画轮廓；对客导览的图标
  | 'usage_open'
  | 'usage_end'
  | 'usage_cancel'
  | 'booking_create'
  | 'booking_confirm'
  | 'booking_reschedule'
  | 'booking_cancel'
  | 'booking_no_show'
  | 'booking_arrive'
  // 次卡（v0.7.28 ④）
  | 'count_card_type_saved'
  | 'count_card_sale'
  | 'count_card_refund'
  | 'count_card_expire'
  | 'count_card_opening'
  // 平台核销补录（v0.7.28 ⑤）
  | 'platform_redemption'
  | 'platform_redemption_void'
  | 'platform_settlement'
  | 'platform_settlement_void'
  | 'floorplan_restore'
  | 'floorplan_outline'
  | 'guide_marker_saved'
  | 'guide_markers_detected'
  // 收银完善（RQ-006，v0.7.20）：退款单与作废；券模板、发券规则、发券、无记名券、作废券
  | 'checkout_refund'
  | 'checkout_refund_void'
  | 'coupon_template_saved'
  // 8.1.44：发过券的模板改使用条件（改前、改后、已发几张）
  | 'coupon_terms_changed'
  | 'coupon_rule_saved'
  | 'coupon_issued'
  | 'coupon_batch_created'
  | 'coupon_batch_exported'
  // 8.0.4 会员体系整改（docs/MEMBERSHIP_V804.md）
  | 'member_tag_saved'
  | 'member_tags_exported'
  | 'member_records_exported'
  | 'coupon_campaign_created'
  | 'coupon_campaign_finished'
  | 'coupon_usage_exported'
  | 'sms_outbox_exported'
  | 'sms_sent'
  | 'gift_out_done'
  | 'gift_out_failed'
  | 'gift_out_retried'
  | 'marketing_cost_param_saved'
  | 'marketing_cost_exported'
  | 'coupon_voided'
  // 硬件连接（RQ-001，v0.7.21）：设备登记、启用停用、按采购清单导入、打印任务
  | 'device_created'
  | 'device_updated'
  | 'device_enabled'
  | 'devices_imported'
  | 'device_job_created'
  // 取消排队、等打印机恢复的打印任务（v0.7.28）
  | 'device_job_canceled'
  // 会员实体卡（v0.7.28）：发卡、补卡；挂失
  | 'member_card_issued'
  | 'member_card_lost'
  // 会员体系 v2（v0.7.23）：已有会员上线定档、手动调整档阶、他店查询
  | 'membership_live'
  | 'member_grade_adjusted'
  // 会员权益（v0.7.24）：导入清单、修改、发布 / 暂缓、自动发放、登记使用、作废登记
  | 'benefits_imported'
  | 'benefit_saved'
  | 'benefit_status'
  | 'benefit_granted'
  | 'benefit_used'
  | 'benefit_use_voided'
  | 'member_lookup'
  // 会员体系 v2 第三期（v0.7.25）：邀请体验、赠送会籍的发起与撤销
  | 'member_trial_created'
  | 'member_trial_cancelled'
  // 会员体系收尾（v0.7.26）：退储值、小程序线上充值入账、停用 / 启用、改手机号、合并
  | 'member_refund'
  | 'recharge_online'
  | 'member_status_changed'
  | 'member_phone_changed'
  | 'member_merged'
  // 微信小程序（小程序线）：解绑会员的微信、维护小程序内容、作废结果不确定的操作
  | 'mp_unbind'
  | 'mp_content_saved'
  | 'mp_op_abandoned'
  // 小程序线第二期：店主处理「已付款待处理」的线上充值单
  | 'mp_recharge_resolved'
  // 小程序线第二期 2d：原路退回没退成的，店主重试、已另行处理
  | 'mp_refund_retried'
  | 'mp_refund_handled'
  // 员工食堂 · 柚子饭堂（docs/CANTEEN.md）：员工名单的新建、修改、停用、重新开通、员工自己登记；跟柚子说的回信
  | 'canteen_employee'
  | 'canteen_feedback'
  // 8.0.1 采购组整改：签约供应商的合同 PDF（08）、收货附件（11）、集采导入（06）、赠品台账（09）
  | 'supplier_contract_file'
  | 'supplier_contract_file_removed'
  | 'receipt_attachment'
  | 'request_import'
  | 'gift_receipt'
  | 'stock_transfer'
  // 8.0.3 费用预算与进项发票台账：改预算额度；台账里的发票（登记、认证状态、照片、作废）
  | 'expense_budget'
  | 'input_invoice'
  // 8.0.7 供应链收尾与 ERP P2（docs/ERP_V807.md）：证照与准入、验收标准模板、对账确认链接与供应商的回复、
  // 协议单位与回款、资产卡片与扫码盘点、企业微信推送
  | 'supplier_license'
  | 'supplier_admission'
  | 'acceptance_template'
  | 'recon_link'
  | 'recon_reply'
  | 'ar_unit'
  | 'ar_collection'
  | 'asset_card'
  | 'asset_stocktake'
  | 'wecom_push'
  // 8.0.9 安保巡场（docs/PATROL_V809.md）：场所的新建、修改、换码、停用 / 启用；作废打卡记录
  | 'patrol_point'
  | 'patrol_checkin_void'
  // 8.0.20 用料与扣料（docs/ERP_V8020.md）：改项目的用料
  | 'item_recipe'
  // 8.0.20 布草洗涤：品类的新建与修改、开单、作废
  | 'linen_item'
  | 'linen_doc'
  | 'linen_doc_void'
  // 8.0.21 自定义字段（docs/FINANCE_V8021.md 第 1 节）
  | 'custom_field_def'
  | 'custom_field_value'
  // 8.0.21 开票申请（docs/FINANCE_V8021.md 第 3 节）：申请、登记已开、交给服务商开、驳回、作废
  | 'invoice_request'
  // 8.0.21 银行账户与网银流水（docs/FINANCE_V8021.md 第 4 节）：账户、导入、勾对
  | 'bank_account'
  | 'bank_import'
  | 'bank_match'
  // 8.0.21 批量付款（同上第 5 节）：生成、导出、下载、作废、记已付 / 失败
  | 'payment_batch'
  // 8.0.21 合同模板（同上第 6 节）：新建、改版、停用、导出 Word
  | 'contract_template'
  // 8.0.21 供应商门户（同上第 7 节）：发链接、作废，供应商在链接里报价、确认、发货预告
  | 'supplier_link'
  | 'supplier_reply'
  // 8.0.21 扫码收款（docs/INTEGRATIONS_V8021.md 第 2 节）：开始收款、原路退回、重试、线下已退
  | 'pay_terminal'
  // 8.0.21 平台验券（同上第 3 节）：验券、撤销核销、转补录
  | 'platform_verify'
  // 8.0.21 OTA 渠道订单（同上第 4 节）：渠道的新建与修改、导入、订单建 / 改 / 取消预约
  | 'ota_channel'
  | 'ota_import'
  | 'ota_order'
  // 8.0.21 供应商收款账户（Codex 安全审查后补，迁移 151）：应付岗改账户、另一人复核
  | 'supplier_bank'
  // 8.1.1 UI 工作台：发布、回滚（谁、什么时候、改了哪几屏，GZ3）；8.1.2 撤销定时发布、导入设计包
  | 'studio_publish'
  | 'studio_rollback'
  | 'studio_cancel'
  | 'studio_pack_import'
  // 采购商城（8.1.32）：SKU 的新建、修改、提交、审核、停用、改动（detail.action 写是哪一样）
  | 'mall_sku'
  // Design 素材库（店主 2026-11-24，docs/BOARDS.md 第 4 节）
  | 'design_asset_upload'
  | 'design_asset_edit'
  | 'material_images'
  | 'material_images_imported'
  | 'design_asset_archive'
  | 'design_slot_assign'
  // 备用金申用（8.1.42；8.1.42 以前的记录是 pool_use）：申用、提交 / 撤回报销、更新补单、作废（detail.action 写是哪一样）
  | 'petty_use'
  // 8.1.9 库管入库台账导入
  | 'receipt_import'
  // 8.1.20 出入库台账导入
  | 'ledger_import'
  // 价目表录入（docs/PRICE_CATALOG.md）：导入草稿、切换生效、回滚、改价、停用（detail.action 写是哪一样）
  | 'price_catalog'
  // 8.1.9 签赠：新建、修改签赠券类型（知识库），签赠发放；作废签赠券记 coupon_voided（与券一样）
  | 'gift_type'
  | 'gift_issue'
  // 8.1.10 急采后补合同；核库转领用（库管核库、部门答复替代，detail 写领用、替代、转采购）
  | 'po_contract_added'
  | 'request_stock'
  // 8.1.15 前台（块 A，docs/FRONTDESK_RISK_V8115.md）：手牌绑 / 解绑芯片号、黑名单的登记与解除、发牌被黑名单拦下、
  // 发牌后的异常处置（提醒、加收、上报、外出、返回、未结离店）与待办的指派、处理结果
  | 'hand_tag_card'
  | 'blacklist_added'
  | 'blacklist_lifted'
  | 'checkin_blocked'
  | 'visit_incident'
  | 'incident_assigned'
  | 'incident_resolved'
  // 8.1.15 块 B1（docs/DINING_V8115.md）：桌台动作——清台、维修、恢复、并台、拆台
  | 'table_clear'
  | 'table_maintenance'
  | 'table_restore'
  | 'table_merge'
  | 'table_split'
  // 8.1.15 菜品管理（docs/DISHES_V8115.md）：新增 / 编辑、上下架、改价、导入
  | 'dish_saved'
  | 'dish_active_set'
  | 'dish_price_changed'
  | 'dishes_imported'
  // 8.1.39：菜品的计价方式（按价目 / 时价、杂项 / 称重）；包房转挂账
  | 'dish_price_mode'
  | 'table_park'
  // 8.1.40：导出券的发放台账；生成一批礼品卡
  | 'coupon_ledger_export'
  | 'gift_card_batch'
  // 8.1.15 房态中心：服务房间的登记、续钟、换房、退房、并房 / 拆并，改房态（待清、清洁完成、维修、恢复），后台的房型
  | 'room_center_register'
  | 'room_center_extend'
  | 'room_center_move'
  | 'room_center_checkout'
  | 'room_center_merge'
  | 'room_center_revoke'
  | 'room_center_backfill'
  | 'room_center_overnight_photo'
  | 'room_center_add_item'
  | 'room_center_goods'
  | 'room_center_wormhole'
  | 'hall_zone_saved'
  | 'room_center_state'
  | 'room_category'
  // 8.1.15 技师管理（docs/TECHNICIANS_V8115.md）：组别、班次、排班与临时调班、休假单（detail.action：申请、批准、驳回、撤回、销假）、主播报终端的接管与放下
  | 'technician_group'
  | 'technician_shift'
  | 'technician_schedule'
  | 'technician_leave'
  | 'clock_announcer'
  // 8.1.15 会员卡押金（收、退，detail.kind 写是哪一样）、退卡
  | 'member_card_deposit'
  | 'member_card_returned'
  // 8.1.17 第二家店改本店价（docs/FRONTDESK_V8117.md 第 6 节，BW-11）：改前改后、那时的全公司价、原因；菜品的另记进改价记录
  | 'store_price_changed'
  // 8.1.17 菜品（docs/DISHES_V8117.md 第 6 节）：排序、批量上下架、删除（下架并隐藏）、恢复
  | 'dishes_sorted'
  | 'dishes_active_bulk'
  | 'dish_deleted'
  | 'dish_restored'
  // 8.1.16 菜品维护的「结果待确认」：确认作废一个操作编号（Codex 审查 d12390f 的 P1，docs/DISHES_V8115.md 第 9 节）
  | 'dish_op_abandoned'
  // 8.1.44 前台备注（docs/V8144_CASHIER.md）：写一条、撤下一条
  | 'visit_remark'
  | 'visit_remark_removed'
  // 8.2.3 前台（docs/V8223_FRONTDESK.md）：改客人类别、改客人偏好、客诉标已处理
  | 'visit_category'
  | 'guest_preferences'
  | 'complaint_resolved'
  // 员工办公 v1.1 第 2 批（docs/OA_MOBILE.md）：排班发布、排班授权与撤销
  | 'oa_schedule_published'
  | 'oa_schedule_grant_created'
  | 'oa_schedule_grant_revoked'
  // 员工办公 v1.1 第 5 批（docs/OA_MOBILE.md）：公司公告发布、编辑与撤回
  | 'oa_announcement_published'
  | 'oa_announcement_updated'
  | 'oa_announcement_recalled';

export interface AuditEntry {
  staffId: number | null;
  action: AuditAction;
  targetType?: string;
  targetId?: string | number;
  detail?: Record<string, unknown>;
  ip?: string;
  businessDate?: string;
}

/** 审计记在当前门店（8.0.22）：不在事务里写的也记对（门店显式传，不靠事务开头的设置） */
export async function writeAudit(db: Db, entry: AuditEntry & { storeId?: number }): Promise<void> {
  const storeId = entry.storeId ?? currentStoreId();
  // 本店照旧不写这一列（默认值就是本店，只有一家店时与以往完全一样）
  const storeCol = storeId === DEFAULT_STORE_ID ? db`` : db`, store_id`;
  const storeVal = storeId === DEFAULT_STORE_ID ? db`` : db`, ${storeId}`;
  // 请求编号（8.1.48，迁移 490）：请求里写的记上，日志与审计能对上；自动任务里没有
  await db`
    INSERT INTO audit_logs (staff_id, action, target_type, target_id, detail, ip, business_date, request_id ${storeCol})
    VALUES (${entry.staffId}, ${entry.action}, ${entry.targetType ?? null},
            ${entry.targetId == null ? null : String(entry.targetId)},
            ${db.json((entry.detail ?? {}) as never)}, ${entry.ip ?? null}, ${entry.businessDate ?? null}, ${currentRequestId() ?? null} ${storeVal})`;
}
