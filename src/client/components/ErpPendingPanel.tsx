// ERP 单据「结果待确认」的提醒（v0.7.8）：费用报销、备用金打款与退回补付、部门需求单；v0.7.12 起还有核销、供应商退款、批量导入；
// v0.7.13 起还有对账登记；后台的空间台账导入（v0.7.14）、模拟刷卡（v0.7.17）也用它；v0.7.22 起还有供应商付款与期初未付登记。
// 进入页面时按原编号只读查回：已登记或已作废的直接移除；查不到的保留，由员工选择
// 「按原内容重新提交」（同一编号，不会重复登记）或「确认作废」（服务端登记作废，原请求晚到也不会登记）。

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CloudOff, RotateCw, Search, Trash2 } from 'lucide-react';
import { ERP_OP_LABELS, type ErpOpLookup, type ErpOpType } from '@shared/erp';
import { ApiError, errorMessage, UncertainError } from '../lib/api';
import { abandonErpOp, lookupErpOp, removeErpPending, sendErpOp, useErpPending, type ErpPendingOp } from '../lib/erpPending';
import { formatDateTime } from '../lib/utils';
import { useToast } from './Toast';
import { Button, Notice } from './ui';
import { useReconnectTick } from '../lib/connection';

export interface ErpOpRef {
  refId: number;
  advanceId?: number;
  /** 按原内容重新提交成功时接口的原样回答（查回、作废时没有）：有的回答只在第一次登记时带（OA-02 批量开通的临时密码），页面要拿去显示 */
  response?: unknown;
}

/** 重新提交成功时，从各接口的返回里取出单据编号 */
/** 返回里这个字段是那张单据（对象），refId 取它的 id */
const REF_OBJECT: Partial<Record<ErpOpType, string>> = {
  expense_claim: 'claim',
  purchase_request: 'request',
  // 核库、答复替代（8.1.10）：返回那张需求单
  request_stock: 'request',
  ap_offset: 'offset',
  supplier_refund: 'refund',
  erp_import: 'import',
  space_import: 'import',
  // 集采导入（8.0.1）：返回那次导入；库管入库台账导入（8.1.9）同样
  request_import: 'import',
  receipt_import: 'import',
  ledger_import: 'import',
  // OA-02 批量开通：返回那次开通
  oa_staff_import: 'import',
  // OA-04 考勤设置：新建的那一行
  oa_attendance_setup: 'created',
  // OA-05 排班保存：那个考勤组
  oa_schedule_save: 'saved',
  // OA-06 打卡：那一条打卡
  oa_punch: 'punch',
  // OA-07 提交人脸录入：那一份录入
  oa_face_enroll: 'enrollment',
  // OA-07 人脸审核：那一份录入
  oa_face_review: 'enrollment',
  // OA-10 办公审批的提交与处理：那一张审批单
  oa_approval_submit: 'approval',
  oa_approval_act: 'approval',
  // 员工办公 v1.1 第 5 批：公司公告（发布、修改、撤回均返回 { announcement, replayed }）
  oa_announcement: 'announcement',
  // 赠品登记（8.0.1）：返回那条登记
  gift_receipt: 'gift',
  // 回款登记（8.0.7）：返回那笔回款；资产建卡：返回建的第一张卡
  ar_collection: 'collection',
  asset_card: 'card',
  // 新建巡场场所（8.0.9）：返回那个场所
  patrol_point: 'point',
  // 布草单据（8.0.20）：返回那张单
  linen_doc: 'doc',
  // 开票申请（8.0.21）：返回那张申请
  invoice_request: 'request',
  // 网银流水导入（8.0.21）：返回那次导入
  bank_import: 'import',
  // 批量付款（8.0.21）：返回那一批
  payment_batch: 'batch',
  supplier_recon: 'reconciliation',
  supplier_recon_void: 'reconciliation',
  // 供应商付款、期初未付登记（v0.7.22）
  payment: 'payment',
  opening_payable: 'opening',
  // 登记会员权益使用（v0.7.24）：返回那条登记；备用金申用（8.1.42）：返回那笔申用
  benefit_use: 'use',
  petty_use: 'use',
  // 邀请体验、赠送会籍（v0.7.25）：返回那条临时身份
  member_trial: 'trial',
  // 会员实体卡（v0.7.28）：发卡、补卡返回那张卡
  member_card: 'card',
  // 会员体系收尾（v0.7.26）：退储值返回那张退储值单，停用 / 启用返回那位会员，合并返回那张合并单
  member_refund: 'refund',
  member_merge: 'merge',
  // 生成礼品卡（8.1.40）：返回那一批
  gift_card_batch: 'batch',
  // 次卡（v0.7.28）：售卡、退卡都返回那张卡
  count_card_sale: 'card',
  count_card_refund: 'card',
  // 平台核销补录（v0.7.28）
  platform_redemption: 'redemption',
  platform_settlement: 'settlement',
  // 合同与法务审查（v0.7.31）：新建合同返回那份合同，变更单、用印申请返回那一条
  contract_create: 'contract',
  contract_change: 'change',
  contract_seal: 'seal',
  // 付款流（v0.7.32）：付款申请返回那张申请，合同付款返回那一笔，验收、质量问题登记返回那一条（id），发票返回那张发票
  payment_request: 'request',
  supplier_invoice: 'invoice',
};
/** 返回里这个字段就是 refId（数字） */
const REF_NUMBER: Partial<Record<ErpOpType, string>> = {
  // 手牌批量添加：返回那一次生成的编号（重提成功也要刷新手牌池）
  hand_tag_generate: 'opId',
  // OA-14 建群：返回那个会话的编号
  oa_im_group: 'id',
  customer_note: 'id',
  customer_binding_request: 'id',
  customer_binding_review: 'id',
  customer_credit_claim: 'id',
  customer_credit_review: 'id',
  customer_target: 'id',
  // OA-09 新建假种：返回那个假种；调整假期余额：返回那条明细
  oa_leave_type: 'id',
  oa_leave_adjust: 'entryId',
  // 门店间调拨（8.0.22）：返回那张调拨单
  stock_transfer: 'id',
  // 工作台发布、回滚（8.1.1）：返回那一版
  studio_publish: 'id',
  // 开始扫码盘点（8.0.7）：返回那次盘点本身
  asset_stocktake: 'id',
  // 渠道订单导入（8.0.21）：返回那次导入
  ota_import: 'importId',
  location_report: 'eventId',
  // 券与会员权益（v0.7.20）：模板、无记名券返回自己（id），规则返回 ruleId，发券返回 issueId
  coupon_template: 'id',
  coupon_batch: 'id',
  coupon_campaign: 'id',
  // 新建签赠券类型（8.1.9）：返回那个类型（券模板）
  gift_type: 'id',
  coupon_rule: 'ruleId',
  // 硬件连接（v0.7.21）：登记设备返回那台设备，打印任务返回那个任务
  device_create: 'id',
  device_job: 'id',
  doc_print: 'id',
  coupon_issue: 'issueId',
  // 签赠发放（8.1.9）：返回那条发券记录
  gift_issue: 'issueId',
  // 手动调整会员档阶（v0.7.23）：返回那位会员的等级卡
  grade_adjust: 'memberId',
  member_status: 'memberId',
  // 审批中心（v0.7.30）：新建审批规则、设代理人都返回那一条（id）
  approval_rule: 'id',
  approval_delegation: 'id',
  contract_payout: 'payoutId',
  contract_acceptance: 'id',
  contract_quality: 'id',
  // 员工食堂第二期：柚子信箱的回信返回那一条（id）
  canteen_reply: 'id',
  // 会员建档（8.1.15）：返回那位会员
  member_create: 'id',
  // 退卡退押金（8.1.15）：返回那位会员
  member_card_return: 'memberId',
  // 采购商城 V1.1 主数据维护（供应商编辑/启停、物料编辑/启停、批量改分类）：返回受影响的主键 id
  shop_master: 'id',
};

function refOfResponse(type: ErpOpType, data: unknown): ErpOpRef | null {
  const d = data as Record<string, { id: number } | number | undefined>;
  const field = REF_OBJECT[type];
  if (field) {
    const v = d[field];
    return v && typeof v === 'object' ? { refId: v.id } : null;
  }
  const key = REF_NUMBER[type];
  if (key) {
    const v = d[key];
    return typeof v === 'number' ? { refId: v } : null;
  }
  switch (type) {
    case 'petty_advance':
      return d.advance && typeof d.advance === 'object' ? { refId: d.advance.id, advanceId: d.advance.id } : null;
    case 'petty_settlement':
      return d.advance && typeof d.advance === 'object' && typeof d.settlementId === 'number' ? { refId: d.settlementId, advanceId: d.advance.id } : null;
  }
  return null;
}

const refOfLookup = (r: ErpOpLookup): ErpOpRef | null => (r.found && r.refId ? { refId: r.refId, advanceId: r.advanceId } : null);

export function ErpPendingPanel({
  types,
  onFound,
  className,
  filter,
}: {
  types: readonly ErpOpType[];
  onFound?: (op: ErpPendingOp, ref: ErpOpRef) => void;
  className?: string;
  /** 只列其中一部分（例如会员详情只列发给这位会员的券） */
  filter?: (op: ErpPendingOp) => boolean;
}) {
  const all = useErpPending(types);
  const ops = filter ? all.filter(filter) : all;
  const qc = useQueryClient();
  const toast = useToast();
  const checked = useRef(new Set<string>());
  const onFoundRef = useRef(onFound);
  onFoundRef.current = onFound;

  // 进入页面先查回一次：已登记、已作废的不用员工再处理。
  // 按「有哪些编号」触发，不按数组本身（v0.7.22）：传了 filter 时每次渲染都是新数组，原来每次重新渲染都会把查回失败的再查一次——
  // 断网时页面一刷新数据就再发一遍查回；网络一恢复，又会抢在员工点「按原内容重新提交」之前把这一行处理掉。
  // 没传 filter 的页面本来就只在列表变了时查。查不回的由员工点「查回」或重新提交、作废。
  const opKeys = ops.map((op) => op.key).join('\n');
  // 网络恢复（8.1.3）：上次没查成的（查回失败时从 checked 里拿掉了）再查一次；查到「没有」的不重查，不抢员工正在处理的
  const reconnects = useReconnectTick();
  useEffect(() => {
    for (const op of ops) {
      if (checked.current.has(op.key)) continue;
      checked.current.add(op.key);
      lookupErpOp(op)
        .then((r) => {
          if (!r.found && !r.abandoned) return;
          removeErpPending(op.key);
          void qc.invalidateQueries({ queryKey: ['inv'] });
          if (r.found) {
            toast({ tone: 'success', title: `已查回：${ERP_OP_LABELS[op.type]}已登记`, body: `${op.summary}。只登记了一次，不用重新填写。` });
            const ref = refOfLookup(r);
            if (ref) onFoundRef.current?.(op, ref);
          }
        })
        .catch(() => checked.current.delete(op.key));
    }
    // ops 只在 opKeys 变了时读：同一组编号的新数组不再触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opKeys, qc, toast, reconnects]);

  if (ops.length === 0) return null;
  return (
    <div className={className ?? 'space-y-2'} data-testid="erp-pending">
      {ops.map((op) => (
        <PendingRow key={op.key} op={op} onFound={onFound} />
      ))}
    </div>
  );
}

function PendingRow({ op, onFound }: { op: ErpPendingOp; onFound?: (op: ErpPendingOp, ref: ErpOpRef) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<null | 'check' | 'resend' | 'abandon'>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const label = ERP_OP_LABELS[op.type];

  const settle = (r: ErpOpLookup | null, ref: ErpOpRef | null) => {
    removeErpPending(op.key);
    void qc.invalidateQueries({ queryKey: ['inv'] });
    if (ref) {
      toast({ tone: 'success', title: `${label}已登记`, body: `${op.summary}。只登记了一次。` });
      onFound?.(op, ref);
    } else if (r?.abandoned) {
      toast({ tone: 'info', title: `${label}已作废`, body: '这笔没有登记；如仍需办理，请重新填写。' });
    }
  };

  const check = async () => {
    setBusy('check');
    setMessage(null);
    try {
      const r = await lookupErpOp(op);
      if (r.found || r.abandoned) settle(r, refOfLookup(r));
      else setMessage('服务器上暂时查不到这笔。查不到不能断定没有登记（原请求可能还在路上），请按原内容重新提交，或确认作废后再重新填写。');
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const resend = async () => {
    setBusy('resend');
    setMessage(null);
    try {
      const data = await sendErpOp<unknown>(op);
      const ref = refOfResponse(op.type, data);
      settle(null, ref ? { ...ref, response: data } : null);
    } catch (e) {
      if (e instanceof UncertainError) {
        setMessage(e.reason === 'server' ? '服务器还是出错，结果待确认。稍后再查回或重新提交（同一编号只登记一次）。' : '仍然连不上服务器，结果待确认。稍后再查回或重新提交。');
      } else if (e instanceof ApiError && e.code === 'OP_ABANDONED') settle({ found: false, abandoned: true }, null);
      else setMessage(`${errorMessage(e)}（之前那次提交可能仍会登记：请先查回，确认没有登记时再确认作废）`);
    } finally {
      setBusy(null);
    }
  };

  const abandon = async () => {
    setBusy('abandon');
    setMessage(null);
    try {
      const r = await abandonErpOp(op);
      settle(r, refOfLookup(r));
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setBusy(null);
      setConfirming(false);
    }
  };

  return (
    <Notice
      tone="warning"
      icon={<CloudOff className="size-5" />}
      title={`${label}结果待确认`}
      action={
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="primary" icon={<Search className="size-4" />} loading={busy === 'check'} disabled={!!busy} onClick={() => void check()} data-testid="erp-pending-check">
            查回结果
          </Button>
          <Button size="sm" variant="secondary" icon={<RotateCw className="size-4" />} loading={busy === 'resend'} disabled={!!busy} onClick={() => void resend()} data-testid="erp-pending-resend">
            按原内容重新提交
          </Button>
          {confirming ? (
            <Button
              size="sm"
              variant="danger"
              icon={<Trash2 className="size-4" />}
              loading={busy === 'abandon'}
              disabled={!!busy && busy !== 'abandon'}
              onClick={() => void abandon()}
              data-testid="erp-pending-abandon-confirm"
            >
              确认作废这笔
            </Button>
          ) : (
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => setConfirming(true)} data-testid="erp-pending-abandon">
              作废这笔
            </Button>
          )}
        </div>
      }
    >
      <span className="block">
        {op.summary} · {op.staffName} · {formatDateTime(op.createdAt)}
      </span>
      <span className="block text-[12.5px]">上次提交时网络中断，可能已经登记，也可能没有。重新提交用同一操作编号，不会重复登记；作废后原请求即使晚到也不会登记。</span>
      {confirming && <span className="block text-[12.5px] font-semibold">确认作废：服务器先登记作废，如果这笔其实已经登记，会直接显示原单据，不会作废。</span>}
      {message && <span className="block text-[12.5px] font-semibold text-clay">{message}</span>}
    </Notice>
  );
}
