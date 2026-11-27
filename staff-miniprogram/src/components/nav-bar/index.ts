// 自己画的导航栏（docs/STAFF_MP.md 第 4 节）：
//   · Tab 页（large）：胶囊那一行左边写「汤崎 WCP」与实例标识（测试服、演示库常显，正式服不显示），下面一行是英文小标题与大标题，
//     右边的按钮（slot actions）在大标题这一行——胶囊下面，不和胶囊挤在一起；
//   · 子页面：左上角返回（页面栈只有一页时是「首页」）、居中的小标题；
//   · 高度按胶囊的位置算，这一行的内容不伸进胶囊。

import { instanceTag } from '../../utils/instance';
import { goHome, isFirstPage, navMetrics } from '../../utils/nav';
import { currentMe, watchMe } from '../../utils/session';

/** 每个导航栏各自的「我是谁」监听（卸下时取消） */
const unwatchers = new WeakMap<object, () => void>();

Component({
  options: { multipleSlots: true },
  properties: {
    title: { type: String, value: '' },
    eyebrow: { type: String, value: '' },
    large: { type: Boolean, value: false },
  },
  data: {
    statusBar: 20,
    bar: 44,
    capsuleRight: 97,
    capsuleHeight: 32,
    first: false,
    tag: '',
  },
  lifetimes: {
    attached() {
      const m = navMetrics();
      const me = currentMe();
      this.setData({
        statusBar: m.statusBar,
        bar: m.bar,
        capsuleRight: m.capsuleRight,
        capsuleHeight: m.capsuleHeight,
        first: isFirstPage(),
        tag: me ? instanceTag(me.build.instance) : '',
      });
      // 冷启动时先画页面、后登录：登录上了（或换了人、退出了）再更新实例标识，测试服、演示库的标识不会缺
      unwatchers.set(
        this,
        watchMe((m) => this.setData({ tag: m ? instanceTag(m.build.instance) : '' })),
      );
    },
    detached() {
      const off = unwatchers.get(this);
      if (off) off();
      unwatchers.delete(this);
    },
  },
  methods: {
    onBack() {
      if (this.data.first) goHome();
      else wx.navigateBack({ fail: () => goHome() });
    },
  },
});
