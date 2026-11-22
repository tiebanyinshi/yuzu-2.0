// OA-01 后台「组织架构」（docs/OA.md 第 4 节）：部门上级与主管、员工档案（工号、手机号、入职 / 离职）、办理离职与复职。
// 部门沿用 8.1.18 的 15 个部门（OA1：不在这里增删）；部门主管没指定时按负责人岗位自动取（OA3）。

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Search } from 'lucide-react';
import { EMPLOYMENT_STATUS_LABELS, type EmployeeProfile, type OrgDepartmentNode, type OrgOverview } from '@shared/oa';
import { ORG_DEPARTMENTS, positionLabel } from '@shared/positions';
import { api, ApiError, errorMessage, UncertainError } from '../../lib/api';
import { DataTable, type DataColumn } from '../../components/DataTable';
import { LoadFailed } from '../../components/LoadFailed';
import { Dialog } from '../../components/Overlay';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, Field, Input, Segmented, Select, Skeleton } from '../../components/ui';
import { AdminPage } from '../admin/AdminShell';

const ORG_KEY = ['oa', 'org'] as const;
const deptName = (key: string | null) => ORG_DEPARTMENTS.find((d) => d.key === key)?.name ?? '未分部门';
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** 部门按上下级排成一棵树：先根（公司），再按原来的顺序深度优先 */
function treeOrder(depts: readonly OrgDepartmentNode[]): { node: OrgDepartmentNode; depth: number }[] {
  const out: { node: OrgDepartmentNode; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const d of depts) {
      if (d.parentKey !== parent || seen.has(d.key)) continue;
      seen.add(d.key);
      out.push({ node: d, depth });
      walk(d.key, depth + 1);
    }
  };
  walk(null, 0);
  // 万一有挂不上的（上级被删、数据不全），放在最后，不丢
  for (const d of depts) if (!seen.has(d.key)) out.push({ node: d, depth: 0 });
  return out;
}

export function OrgSection() {
  const q = useQuery({ queryKey: ORG_KEY, queryFn: () => api.get<OrgOverview>('/api/oa/org') });
  return (
    <AdminPage section="org" wide description="部门的上下级与主管、员工档案（工号、手机号、入职与离职）。部门清单随岗位体系，不在这里增删；办理离职会停用账号，考勤、审批等历史都保留。">
      {q.isPending ? (
        <Skeleton className="h-64" />
      ) : q.isError && !q.data ? (
        <LoadFailed title="组织架构没有取回来" onRetry={() => q.refetch()} retrying={q.isFetching} />
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-5 xl:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
          <DepartmentTree org={q.data} />
          <EmployeeTable org={q.data} />
        </div>
      )}
    </AdminPage>
  );
}

function DepartmentTree({ org }: { org: OrgOverview }) {
  const [editing, setEditing] = useState<OrgDepartmentNode | null>(null);
  const rows = useMemo(() => treeOrder(org.departments), [org.departments]);
  return (
    <Card className="p-4" data-testid="org-tree">
      <h2 className="mb-3 flex items-center gap-2 text-[15px] font-semibold text-ink">
        <Building2 className="size-4 text-ink-3" />
        部门
      </h2>
      <ul className="space-y-1">
        {rows.map(({ node, depth }) => (
          <li key={node.key} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-paper" style={{ paddingLeft: 8 + depth * 18 }} data-testid={`org-dept-${node.key}`}>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14px] font-medium text-ink">{node.name}</div>
              <div className="text-[12px] text-ink-3">
                主管：{node.head ? node.head.name : '未设'}
                {node.head && !node.head.designated && <span>（按负责人岗位）</span>} · 在职 {node.memberCount} 人
              </div>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setEditing(node)} data-testid={`org-dept-edit-${node.key}`}>
              编辑
            </Button>
          </li>
        ))}
      </ul>
      {editing && <DepartmentDialog dept={editing} org={org} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function DepartmentDialog({ dept, org, onClose }: { dept: OrgDepartmentNode; org: OrgOverview; onClose: () => void }) {
  const [parentKey, setParentKey] = useState<string>(dept.parentKey ?? '');
  const [headId, setHeadId] = useState<string>(dept.headStaffId ? String(dept.headStaffId) : '');
  const { saving, run } = useOrgWrite(onClose);
  const candidates = org.employees.filter((e) => e.active && e.status === 'active');
  const save = () =>
    run(
      () => api.put<OrgOverview>(`/api/oa/org/departments/${dept.key}`, { parentKey: parentKey || null, headStaffId: headId ? Number(headId) : null, version: dept.version }),
      `已保存「${dept.name}」`,
    );
  return (
    <Dialog
      open
      onClose={onClose}
      title={`编辑部门：${dept.name}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={saving} onClick={save} data-testid="org-dept-save">
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="上级部门" htmlFor="org-parent" hint={dept.key === 'company' ? '公司在最上面，没有上级' : '不能选自己或自己下面的部门'}>
          <Select id="org-parent" value={parentKey} disabled={dept.key === 'company'} onChange={(e) => setParentKey(e.target.value)} data-testid="org-dept-parent">
            {dept.key === 'company' && <option value="">（无）</option>}
            {org.departments
              .filter((d) => d.key !== dept.key)
              .map((d) => (
                <option key={d.key} value={d.key}>
                  {d.name}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="指定主管" htmlFor="org-head" hint="不指定时按本部门在职的负责人岗位自动取；审批的「本部门主管」从这里取">
          <Select id="org-head" value={headId} onChange={(e) => setHeadId(e.target.value)} data-testid="org-dept-head">
            <option value="">按负责人岗位自动取</option>
            {candidates.map((e) => (
              <option key={e.staffId} value={e.staffId}>
                {e.name}（{positionLabel(e.position) || '未定岗位'}）
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Dialog>
  );
}

type StatusFilter = 'active' | 'left' | 'all';

function EmployeeTable({ org }: { org: OrgOverview }) {
  const [status, setStatus] = useState<StatusFilter>('active');
  const [dept, setDept] = useState<string>('');
  const [keyword, setKeyword] = useState('');
  const [editing, setEditing] = useState<EmployeeProfile | null>(null);
  const [leaving, setLeaving] = useState<EmployeeProfile | null>(null);
  const [rehiring, setRehiring] = useState<EmployeeProfile | null>(null);
  const kw = keyword.trim().toLowerCase();
  const rows = org.employees.filter(
    (e) =>
      (status === 'all' || e.status === status) &&
      (!dept || e.department === dept) &&
      (!kw || e.name.toLowerCase().includes(kw) || e.username.includes(kw) || (e.empNo ?? '').toLowerCase().includes(kw) || (e.phone ?? '').includes(kw)),
  );
  const columns: DataColumn<EmployeeProfile>[] = [
    {
      key: 'name',
      header: '姓名',
      cell: (e) => (
        <div>
          <div className="font-medium text-ink">{e.name}</div>
          <div className="text-[12px] text-ink-3">{e.username}</div>
        </div>
      ),
    },
    { key: 'dept', header: '部门 / 岗位', cell: (e) => <span>{e.position ? positionLabel(e.position) : deptName(e.department)}</span> },
    { key: 'empNo', header: '工号', cell: (e) => e.empNo ?? '—' },
    { key: 'phone', header: '手机号', cell: (e) => e.phone ?? '—' },
    { key: 'hire', header: '入职日期', cell: (e) => e.hireDate ?? '—' },
    {
      key: 'status',
      header: '状态',
      cell: (e) => (
        <div className="flex flex-wrap gap-1">
          <Badge tone={e.status === 'active' ? 'pine' : 'ember'}>{EMPLOYMENT_STATUS_LABELS[e.status]}</Badge>
          {e.status === 'left' && e.leaveDate && <span className="text-[12px] text-ink-3">{e.leaveDate}</span>}
          {e.status === 'active' && !e.active && <Badge tone="neutral">账号停用</Badge>}
        </div>
      ),
    },
    {
      key: 'ops',
      header: '',
      align: 'right',
      cell: (e) => (
        <div className="flex justify-end gap-1">
          <Button size="sm" variant="secondary" onClick={() => setEditing(e)} data-testid={`org-emp-edit-${e.username}`}>
            编辑档案
          </Button>
          {e.status === 'active' ? (
            <Button size="sm" variant="ghost" onClick={() => setLeaving(e)} data-testid={`org-emp-leave-${e.username}`}>
              办理离职
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setRehiring(e)} data-testid={`org-emp-rehire-${e.username}`}>
              办理复职
            </Button>
          )}
        </div>
      ),
    },
  ];
  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-[15px] font-semibold text-ink">员工档案</h2>
        <Segmented<StatusFilter>
          value={status}
          onChange={setStatus}
          size="sm"
          ariaLabel="在职状态"
          options={[
            { value: 'active', label: '在职' },
            { value: 'left', label: '离职' },
            { value: 'all', label: '全部' },
          ]}
        />
        <Select value={dept} onChange={(e) => setDept(e.target.value)} fullWidth={false} aria-label="部门" data-testid="org-emp-dept">
          <option value="">全部部门</option>
          {ORG_DEPARTMENTS.map((d) => (
            <option key={d.key} value={d.key}>
              {d.name}
            </option>
          ))}
        </Select>
        <div className="relative w-full sm:w-56">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
          <Input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="姓名、工号、手机号" className="pl-9" aria-label="搜索员工" data-testid="org-emp-search" />
        </div>
      </div>
      <DataTable columns={columns} rows={rows} rowKey={(e) => e.staffId} variant="plain" empty="没有符合条件的员工" testId="org-employees" />
      {editing && <ProfileDialog emp={editing} onClose={() => setEditing(null)} />}
      {leaving && <LeaveDialog emp={leaving} onClose={() => setLeaving(null)} />}
      {rehiring && <RehireDialog emp={rehiring} onClose={() => setRehiring(null)} />}
    </Card>
  );
}

/**
 * 改部门、改档案、办离职、办复职共用：带着版本提交，成功后用返回的整份组织架构刷新。
 * 这几样都是改已有的记录、带版本（与巡场场所、券、设备的编辑同一个做法）：
 *   · 结果不明（超时、断网、服务器出错，可能已经改上了）：不当失败处理——关掉对话框、重新载入，提示核对后再改；
 *     原样再提交也不会改两遍（版本已经变了会被拒），所以不需要另记操作编号；
 *   · 别人先改过（版本对不上）：同样关掉、载入最新的；
 *   · 其余被明确拒绝的（工号重复等）：对话框留着，改了再提交。
 */
function useOrgWrite(onDone: () => void) {
  const qc = useQueryClient();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const run = async (send: () => Promise<OrgOverview>, ok: string) => {
    setSaving(true);
    try {
      qc.setQueryData(ORG_KEY, await send());
      toast({ tone: 'success', title: ok });
      onDone();
    } catch (err) {
      if (err instanceof UncertainError) {
        toast({ tone: 'info', title: `${err.message}，不确定有没有保存上`, body: '已重新载入，请核对这一行是不是已经改好，没改上再重新办理' });
        onDone();
      } else if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') {
        toast({ tone: 'info', title: errorMessage(err), body: '已载入最新内容，请核对后再改' });
        onDone();
      } else toast({ tone: 'error', title: errorMessage(err) });
      void qc.invalidateQueries({ queryKey: ORG_KEY });
    } finally {
      setSaving(false);
    }
  };
  return { saving, run };
}

function ProfileDialog({ emp, onClose }: { emp: EmployeeProfile; onClose: () => void }) {
  const [empNo, setEmpNo] = useState(emp.empNo ?? '');
  const [phone, setPhone] = useState(emp.phone ?? '');
  const [hireDate, setHireDate] = useState(emp.hireDate ?? '');
  const { saving, run } = useOrgWrite(onClose);
  const save = () =>
    run(
      () => api.put<OrgOverview>(`/api/oa/employees/${emp.staffId}/profile`, { empNo: empNo.trim() || null, phone: phone.trim() || null, hireDate: hireDate || null, version: emp.version }),
      `已保存 ${emp.name} 的档案`,
    );
  return (
    <Dialog
      open
      onClose={onClose}
      title={`员工档案：${emp.name}`}
      description="部门与岗位在「员工账号」里改。"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={saving} onClick={save} data-testid="org-profile-save">
            保存
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="工号" htmlFor="org-empno" hint="字母、数字、- 或 _，全店不重复">
          <Input id="org-empno" value={empNo} onChange={(e) => setEmpNo(e.target.value)} maxLength={20} data-testid="org-profile-empno" />
        </Field>
        <Field label="手机号" htmlFor="org-phone" hint="11 位">
          <Input id="org-phone" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="numeric" maxLength={11} data-testid="org-profile-phone" />
        </Field>
        <Field label="入职日期" htmlFor="org-hire">
          <Input id="org-hire" type="date" value={hireDate} onChange={(e) => setHireDate(e.target.value)} data-testid="org-profile-hire" />
        </Field>
      </div>
    </Dialog>
  );
}

function LeaveDialog({ emp, onClose }: { emp: EmployeeProfile; onClose: () => void }) {
  const [leaveDate, setLeaveDate] = useState(localToday());
  const { saving, run } = useOrgWrite(onClose);
  const save = () => run(() => api.post<OrgOverview>(`/api/oa/employees/${emp.staffId}/leave`, { leaveDate, version: emp.version }), `已为 ${emp.name} 办理离职`);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`办理离职：${emp.name}`}
      description="账号会立即停用并退出登录；考勤、审批、工资条等历史都保留，可以随时办理复职。"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button variant="danger" loading={saving} onClick={save} data-testid="org-leave-confirm">
            确认离职
          </Button>
        </>
      }
    >
      <Field label="离职日期" htmlFor="org-leave-date">
        <Input id="org-leave-date" type="date" value={leaveDate} onChange={(e) => setLeaveDate(e.target.value)} data-testid="org-leave-date" />
      </Field>
    </Dialog>
  );
}

function RehireDialog({ emp, onClose }: { emp: EmployeeProfile; onClose: () => void }) {
  const { saving, run } = useOrgWrite(onClose);
  const save = () => run(() => api.post<OrgOverview>(`/api/oa/employees/${emp.staffId}/rehire`, { version: emp.version }), `已为 ${emp.name} 办理复职`);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`办理复职：${emp.name}`}
      description="档案改回在职、清掉离职日期、账号重新启用（密码不变；忘了的在「员工账号」里重置）。"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={saving} onClick={save} data-testid="org-rehire-confirm">
            确认复职
          </Button>
        </>
      }
    >
      <p className="text-[14px] text-ink-2">离职日期：{emp.leaveDate ?? '—'}</p>
    </Dialog>
  );
}
