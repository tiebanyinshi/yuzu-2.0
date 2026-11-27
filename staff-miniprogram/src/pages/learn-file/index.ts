// 一份培训资料（docs/STAFF_MP.md 第 2.3 节）：标题、说明、哪一版；按格式打开——
//   · 文档（PDF、Word、Excel、PPT）：带令牌下载到手机，用微信自带的文档预览打开（显示下载进度）；
//   · 图片：下载后放大看；视频、音频：用短时地址在页里播；
//   · 小程序里打不开的格式写明「请在电脑上的 WCP 里看」；
//   · 打开成功（文档打开了、图片看了、视频音频开始播了）记「看过」；管理员刚换了新版本的，门店系统会说换了，重新打开。

import type { TrainingFile } from '../../../../src/shared/training';
import { isApiError, messageOf } from '../../utils/api';
import { shortTime } from '../../utils/format';
import { requireMe, toLogin } from '../../utils/guard';
import { largeTextOn } from '../../utils/prefs';
import { downloadFile, extOf, isNew, loadFiles, markViewed, mediaUrl, openModeOf } from '../../utils/training';

let file: TrainingFile | null = null;
let audio: WechatMiniprogram.InnerAudioContext | null = null;

Page({
  data: {
    large: false,
    folderId: 0,
    id: 0,
    state: 'loading',
    error: '',
    title: '',
    description: '',
    meta: '',
    mode: 'document',
    note: '',
    viewed: '',
    fresh: false,
    busy: false,
    progress: 0,
    mediaSrc: '',
    playing: false,
    openError: '',
  },

  onLoad(q: Record<string, string | undefined>) {
    this.setData({ large: largeTextOn(), folderId: Number(q.folder) || 0, id: Number(q.id) || 0 });
  },

  async onShow() {
    if (!(await requireMe())) return;
    if (this.data.state === 'loading') this.load();
  },

  onUnload() {
    audio?.destroy();
    audio = null;
    file = null;
  },

  async load() {
    this.setData({ state: 'loading', error: '' });
    try {
      // 员工端没有单个文件的接口：取这个文件夹的资料，找出这一份
      const found = (await loadFiles(this.data.folderId)).find((f) => f.id === this.data.id);
      if (!found) return this.setData({ state: 'empty', error: '' });
      file = found;
      let platform = '';
      try {
        platform = wx.getDeviceInfo().platform;
      } catch {
        platform = '';
      }
      const { mode, note } = openModeOf(found.current.mime, found.current.fileName, platform);
      this.setData({
        state: 'ready',
        title: found.title,
        description: found.description,
        meta: `${extOf(found.current.fileName).toUpperCase() || '文件'} · 第 ${found.current.versionNo} 版 · ${shortTime(found.current.createdAt)} 更新`,
        mode,
        note,
        fresh: isNew(found),
        viewed: found.myLastViewedAt ? `上次看过：${shortTime(found.myLastViewedAt)}` : '',
        mediaSrc: '',
      });
      if (mode === 'video' || mode === 'audio') this.prepareMedia();
    } catch (e) {
      if (isApiError(e) && e.status === 401) return toLogin();
      this.setData({ state: isApiError(e) && e.code === 'NETWORK' ? 'offline' : 'error', error: messageOf(e) });
    }
  },

  onRetry() {
    this.load();
  },

  /** 视频、音频：要一个短时地址（10 分钟有效；过期了再点一次就重新要） */
  async prepareMedia() {
    if (!file) return;
    try {
      this.setData({ mediaSrc: await mediaUrl(file), openError: '' });
    } catch (e) {
      this.setData({ openError: messageOf(e) });
    }
  },

  async viewed() {
    if (!file) return;
    try {
      await markViewed(file);
      this.setData({ fresh: false, viewed: '刚刚看过' });
    } catch (e) {
      // 管理员刚换了新版本：重新打开这一页（看的是旧版本，不记看过）
      if (isApiError(e) && e.code === 'TRAINING_VERSION_CHANGED') {
        this.setData({ openError: '这份资料刚换了新版本，已经重新打开' });
        this.load();
      }
    }
  },

  async onOpen() {
    if (!file || this.data.busy) return;
    const f = file;
    this.setData({ busy: true, progress: 0, openError: '' });
    try {
      const path = await downloadFile(f, (p) => this.setData({ progress: p }));
      if (this.data.mode === 'image') {
        wx.previewImage({ urls: [path], current: path });
        this.viewed();
      } else {
        await new Promise<void>((resolve, reject) =>
          wx.openDocument({ filePath: path, fileType: extOf(f.current.fileName) as 'pdf', showMenu: false, success: () => resolve(), fail: () => reject(new Error('open')) }),
        );
        this.viewed();
      }
    } catch (e) {
      if (isApiError(e) && e.status === 401) return toLogin();
      this.setData({ openError: isApiError(e) ? e.message : '这份资料没有打开，请再试一次；还不行请在电脑上的 WCP 里看' });
    } finally {
      this.setData({ busy: false });
    }
  },

  onVideoPlay() {
    if (this.data.fresh) this.viewed();
  },

  onVideoError() {
    // 短时地址过期（停在这一页超过 10 分钟）或格式放不了：重新要一个地址
    this.setData({ openError: '视频没有放出来，正在重新连接；还不行请在电脑上的 WCP 里看' });
    this.prepareMedia();
  },

  onAudio() {
    if (!this.data.mediaSrc) {
      this.prepareMedia();
      return;
    }
    if (!audio) {
      audio = wx.createInnerAudioContext({ useWebAudioImplement: false });
      audio.src = this.data.mediaSrc;
      audio.onEnded(() => this.setData({ playing: false }));
      audio.onError(() => {
        this.setData({ playing: false, openError: '音频没有放出来，请再点一次' });
        audio?.destroy();
        audio = null;
        this.prepareMedia();
      });
    }
    if (this.data.playing) {
      audio.pause();
      this.setData({ playing: false });
    } else {
      audio.play();
      this.setData({ playing: true });
      if (this.data.fresh) this.viewed();
    }
  },
});
