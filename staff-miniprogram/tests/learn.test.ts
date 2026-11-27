// 学习的纯函数（src/utils/training.ts）：怎么打开、什么算「新」、列表里一行写什么、文件夹的先后、最近搜过的。

import { describe, expect, it } from 'vitest';
import { fileRow, folderRows, isNew, openModeOf, pushRecent } from '../src/utils/training';

const file = (over: Record<string, unknown> = {}) =>
  ({
    id: 3,
    folderId: 1,
    title: '泡汤健康与安全禁忌',
    description: '',
    active: true,
    sort: 0,
    version: 1,
    current: { id: 9, versionNo: 2, fileName: '禁忌.pdf', mime: 'application/pdf', sizeBytes: 1258291, note: '', uploadedByName: '人事', createdAt: '2026-11-20T02:00:00Z' },
    viewKind: 'pdf',
    myLastViewedAt: null,
    updatedAt: '2026-11-20T02:00:00Z',
    ...over,
  }) as never;

describe('怎么打开', () => {
  it('文档、图片、视频、音频；打不开的写明去电脑看', () => {
    expect(openModeOf('application/pdf', 'a.pdf').mode).toBe('document');
    expect(openModeOf('application/vnd.openxmlformats-officedocument.presentationml.presentation', '课件.PPTX').mode).toBe('document');
    expect(openModeOf('image/png', 'a.png').mode).toBe('image');
    expect(openModeOf('video/mp4', 'a.mp4').mode).toBe('video');
    expect(openModeOf('audio/mpeg', 'a.mp3').mode).toBe('audio');
    expect(openModeOf('application/zip', 'a.zip')).toMatchObject({ mode: 'unsupported', note: expect.stringContaining('电脑') });
  });

  it('webm 在 iPhone 上放不了，安卓照放', () => {
    expect(openModeOf('video/webm', 'a.webm', 'ios')).toMatchObject({ mode: 'unsupported', note: expect.stringContaining('iPhone') });
    expect(openModeOf('video/webm', 'a.webm', 'android').mode).toBe('video');
  });
});

describe('新不新', () => {
  it('没看过、或看过以后换了新版本的算新', () => {
    expect(isNew(file())).toBe(true);
    expect(isNew(file({ myLastViewedAt: '2026-11-21T00:00:00Z' }))).toBe(false);
    expect(isNew(file({ myLastViewedAt: '2026-11-19T00:00:00Z' }))).toBe(true);
  });

  it('列表一行：格式、大小、更新时间', () => {
    const row = fileRow(file(), '培训资料');
    expect(row).toMatchObject({ id: 3, folderId: 1, icon: 'doc', isNew: true });
    expect(row.meta).toMatch(/^培训资料 · PDF · 1\.2 MB · \d\d-\d\d \d\d:\d\d 更新$/);
  });
});

describe('文件夹', () => {
  it('培训资料在前、本部门其次；停用的、空的不列', () => {
    const f = (id: number, kind: string, departmentKey: string | null, fileCount = 2, active = true) => ({ id, name: `夹${id}`, kind, departmentKey, sort: id, active, version: 1, fileCount });
    const rows = folderRows({ folders: [f(5, 'department', 'spa'), f(4, 'department', 'front'), f(1, 'public', null), f(6, 'department', 'x', 0), f(7, 'department', 'y', 3, false)], myDepartment: 'front', canManage: false } as never);
    expect(rows.map((r) => r.id)).toEqual([1, 4, 5]);
    expect(rows.find((r) => r.id === 4)!.mine).toBe(true);
    expect(rows[0]!.meta).toBe('2 份资料');
  });
});

describe('最近搜过', () => {
  it('新的放前面、去重、最多 5 条、空的不记', () => {
    expect(pushRecent(['a', 'b'], 'b')).toEqual(['b', 'a']);
    expect(pushRecent(['1', '2', '3', '4', '5'], '6')).toEqual(['6', '1', '2', '3', '4']);
    expect(pushRecent(['a'], '  ')).toEqual(['a']);
  });
});
