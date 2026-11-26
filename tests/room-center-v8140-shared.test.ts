// 8.1.40（B，docs/V8140_B.md 第 1、2 节）房态中心的排序与过夜筛选：只在页面上排、筛。不要数据库。

import { describe, expect, it } from 'vitest';
import { arrangeRooms, isOvernightRoom } from '../src/shared/room-center';

const room = (code: string, overnight: boolean[] = []) => ({ code, guests: overnight.map((o) => ({ overnight: o })) });

describe('房态中心排序与过夜筛选', () => {
  const rooms = [room('A99'), room('A102', [false, true]), room('B1', [false]), room('A100'), room('8')];

  it('从小到大照原来的顺序（接口给的楼层、房号）；从大到小按房号倒排，数字按数值比', () => {
    expect(arrangeRooms(rooms, { order: 'asc', overnightOnly: false }).map((r) => r.code)).toEqual(['A99', 'A102', 'B1', 'A100', '8']);
    expect(arrangeRooms(rooms, { order: 'desc', overnightOnly: false }).map((r) => r.code)).toEqual(['B1', 'A102', 'A100', 'A99', '8']);
    // 不改传进来的数组
    expect(rooms.map((r) => r.code)).toEqual(['A99', 'A102', 'B1', 'A100', '8']);
  });

  it('只看过夜：有一位客人过夜就算；与排序一起用', () => {
    expect(isOvernightRoom(room('A1', [false, true]))).toBe(true);
    expect(isOvernightRoom(room('A1', [false]))).toBe(false);
    const more = [...rooms, room('A120', [true])];
    expect(arrangeRooms(more, { order: 'asc', overnightOnly: true }).map((r) => r.code)).toEqual(['A102', 'A120']);
    expect(arrangeRooms(more, { order: 'desc', overnightOnly: true }).map((r) => r.code)).toEqual(['A120', 'A102']);
  });
});
