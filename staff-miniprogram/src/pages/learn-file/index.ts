// 一份培训资料（docs/STAFF_MP.md 第 2.3 节）：标题、说明、哪一版；按格式打开——
//   · 文档（PDF、Word、Excel、PPT）：带令牌下载到手机，用微信自带的文档预览打开（显示下载进度）；
//   · 图片：下载后放大看；视频、音频：用短时地址在页里播；
//   · 小程序里打不开的格式写明「请在电脑上的 WCP 里看」；
//   · 打开成功（文档打开了、图片看了、视频音频开始播了）记「看过」——记的是真正打开、正在放的那一版；
//   · 管理员刚换了新版本的，门店系统会说换了：重新取这份资料（新的一版）、旧的播放器关掉；
//   · 视频放不出来自动重连一次（短时地址过期多半是这个），还不行就停下给「重新加载视频」，不一直重试。

import type { TrainingFile } from '../../../../src/shared/training';
import { isApiError, messageOf } from '../../utils/api';
import { shortTime } from '../../utils/format';
import { requireMe, toLogin } from '../../utils/guard';
import { largeTextOn } from '../../utils/prefs';
import { downloadFile, extOf, isNew, loadFiles, markViewed, mediaUrl, noteOpened, openModeOf } from '../../utils/training';

let file: TrainingFile | null = null;
let audio: WechatMiniprogram.InnerAudioContext | null = null;
/** 短时地址是哪一版的（正在放的那一版；记「看过」按它记） */
let mediaFile: TrainingFile | null = null;
/** 视频放不出来时自动重连了几次（放出来了归零） */
let autoRetries = 0;
/** 第几次取这份资料：旧的那次（包括已经关掉的上一页）回来就不用了 */
let gen = 0;
/** 放到哪了（秒）：断了重新连上从这里接着放 */
let videoPos = 0;
let audioPos = 0;

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
    mediaFailed: false,
    resumeAt: 0,
    autoplay: false,
    playing: false,
    openError: '',
  },

  onLoad(q: Record<string, string | undefined>) {
    // 新开的一页：上一页留下的都不用
    file = null;
    mediaFile = null;
    autoRetries = 0;
    videoPos = 0;
    audioPos = 0;
    this.setData({ large: largeTextOn(), folderId: Number(q.folder) || 0, id: Number(q.id) || 0 });
  },

  async onShow() {
    if (!(await requireMe())) return;
    if (this.data.state === 'loading') this.load();
  },

  onUnload() {
    this.resetAudio();
    file = null;
    mediaFile = null;
    gen += 1;
  },

  /** 关掉音频播放器（换了一版、出错了、离开页面） */
  resetAudio() {
    audio?.destroy();
    audio = null;
    this.setData({ playing: false });
  },

  async load() {
    const my = ++gen;
    this.resetAudio();
    mediaFile = null;
    this.setData({ state: 'loading', error: '' });
    try {
      // 员工端没有单个文件的接口：取这个文件夹的资料，找出这一份
      const list = await loadFiles(this.data.folderId);
      if (my !== gen) return;
      const found = list.find((f) => f.id === this.data.id);
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
        mediaFailed: false,
        // 断了重新连上的：从放到的地方接着放
        resumeAt: Math.floor(videoPos),
        autoplay: videoPos > 0,
      });
      if (mode === 'video' || mode === 'audio') this.prepareMedia();
    } catch (e) {
      if (my !== gen) return;
      if (isApiError(e) && e.status === 401) return toLogin();
      this.setData({ state: isApiError(e) && e.code === 'NETWORK' ? 'offline' : 'error', error: messageOf(e) });
    }
  },

  onRetry() {
    autoRetries = 0;
    this.load();
  },

  /** 视频、音频：要一个短时地址（10 分钟有效；过期了再点一次就重新要） */
  async prepareMedia() {
    const f = file;
    if (!f) return;
    const my = gen;
    this.setData({ mediaFailed: false });
    try {
      const url = await mediaUrl(f);
      if (my !== gen) return;
      mediaFile = f;
      this.setData({ mediaSrc: url, openError: '' });
    } catch (e) {
      if (my !== gen) return;
      // 地址没要到（连不上、门店出错）：给「重新加载」，不留一个一直转的占位
      this.setData({ openError: messageOf(e), mediaFailed: true });
    }
  },

  /** 手动重新加载：重新取这份资料（可能换了新版本）再要地址 */
  onMediaRetry() {
    autoRetries = 0;
    this.load();
  },

  /** 记「看过」：f 是真正打开、正在放的那一版 */
  async viewed(f: TrainingFile | null) {
    if (!f) return;
    try {
      await markViewed(f);
      if (file && f.current.id === file.current.id) this.setData({ fresh: false, viewed: '刚刚看过' });
    } catch (e) {
      // 管理员刚换了新版本：重新取这份资料（看的是旧版本，不记看过）
      if (isApiError(e) && e.code === 'TRAINING_VERSION_CHANGED') {
        autoRetries = 0;
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
        noteOpened(f.id);
        this.viewed(f);
      } else {
        await new Promise<void>((resolve, reject) =>
          wx.openDocument({ filePath: path, fileType: extOf(f.current.fileName) as 'pdf', showMenu: false, success: () => resolve(), fail: () => reject(new Error('open')) }),
        );
        noteOpened(f.id);
        this.viewed(f);
      }
    } catch (e) {
      if (isApiError(e) && e.status === 401) return toLogin();
      this.setData({ openError: isApiError(e) ? e.message : '这份资料没有打开，请再试一次；还不行请在电脑上的 WCP 里看' });
      // 管理员刚换了新版本：重新取这份资料
      if (isApiError(e) && e.code === 'VERSION_CHANGED') this.load();
    } finally {
      this.setData({ busy: false });
    }
  },

  onVideoTime(e: WechatMiniprogram.CustomEvent<{ currentTime: number }>) {
    videoPos = e.detail.currentTime || 0;
  },

  onVideoPlay() {
    autoRetries = 0;
    if (mediaFile) noteOpened(mediaFile.id);
    if (this.data.fresh) this.viewed(mediaFile);
  },

  onVideoError() {
    // 短时地址过期（停在这一页超过 10 分钟）、刚换了新版本：自动重新取一次（连资料一起，换了版本就是新的一版）
    if (autoRetries < 1) {
      autoRetries += 1;
      this.setData({ openError: '视频没有放出来，正在重新连接…' });
      this.load();
      return;
    }
    // 还是不行：停下，给「重新加载视频」
    this.setData({ mediaSrc: '', mediaFailed: true, openError: '视频没有放出来：点「重新加载视频」再试；还不行请在电脑上的 WCP 里看' });
  },

  onAudio() {
    if (!this.data.mediaSrc) {
      this.prepareMedia();
      return;
    }
    if (!audio) {
      // 这个播放器放的是哪一版：记「看过」按它记
      const playing = mediaFile;
      audio = wx.createInnerAudioContext({ useWebAudioImplement: false });
      audio.src = this.data.mediaSrc;
      // 断了重新连上的：从放到的地方接着放
      if (audioPos > 0) audio.startTime = audioPos;
      const ctx = audio;
      audio.onTimeUpdate(() => {
        audioPos = ctx.currentTime || audioPos;
      });
      audio.onEnded(() => this.setData({ playing: false }));
      // 真的放出来了才记「看过」（地址过期、放不了的不记）
      audio.onPlay(() => {
        if (playing) noteOpened(playing.id);
        if (this.data.fresh) this.viewed(playing);
      });
      audio.onError(() => {
        // 地址过期、刚换了新版本：关掉这个播放器，重新取这份资料与地址；要员工再点一次播放（不自动重试）
        this.resetAudio();
        this.setData({ openError: '音频没有放出来，请再点一次播放' });
        this.load();
      });
    }
    if (this.data.playing) {
      audio.pause();
      this.setData({ playing: false });
    } else {
      audio.play();
      this.setData({ playing: true });
    }
  },
});
