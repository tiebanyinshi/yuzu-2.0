import { defineConfig } from 'vitest/config';

// 员工小程序的单元测试：只测不依赖微信界面的部分（接口层与登录、此刻卡、日期与文字、入口清单、页面完整性），wx 在测试里换成假的
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
