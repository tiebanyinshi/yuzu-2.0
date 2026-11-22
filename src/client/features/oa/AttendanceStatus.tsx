// 一条考勤结果的徽标与异常短语（后台「考勤结果」与员工「我的考勤」共用）：结果、OA-13 的请假 / 出差覆盖、迟到早退缺卡。

import { attendanceIssues, attendanceTone, ATTENDANCE_COVER_LABELS, ATTENDANCE_STATUS_LABELS, type AttendanceDailyRow } from '@shared/oa';
import { Badge } from '../../components/ui';

export function AttendanceStatus({ row }: { row: AttendanceDailyRow }) {
  // 整天请假、出差的徽标就是覆盖本身；半天请假另外标一个
  const half = row.cover === 'leave_am' || row.cover === 'leave_pm';
  return (
    <>
      <Badge tone={attendanceTone(row.status)}>{ATTENDANCE_STATUS_LABELS[row.status]}</Badge>
      {half && <Badge tone="lake">{ATTENDANCE_COVER_LABELS[row.cover!]}</Badge>}
      {attendanceIssues(row)
        .filter((t) => t !== '旷工')
        .map((t) => (
          <span key={t} className="text-[13px] text-ember">
            {t}
          </span>
        ))}
    </>
  );
}
