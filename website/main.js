/*
 * 柚子官网的动效（docs/WEBSITE.md）：
 *   · 首屏的柚子池是 three.js 的 3D（hero3d.js，8.2.0）；起不来时换回 2D 的 pool.js；
 *   · Lenis 平滑滚动，GSAP + ScrollTrigger 驱动滚动动画；
 *   · 首屏「柚子」两个字从水里浮上来；「店里的一天」宽屏时钉住、横着走过五个钟点；
 *   · 「纯天然 AI 制作，零人工代码添加」逐字被照亮；四扇门跟着指针微微倾斜；主按钮有一点磁性；收尾的字条一直往左走。
 * 脚本或库没加载到时，页面照常显示（藏起来的东西只在 html.js 下才藏，见 styles.css）。
 * 减少动效时：不钉住、不倾斜、不跑字条，水面只画一帧。
 */
(function () {
  'use strict';

  var root = document.documentElement;
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var hasGsap = typeof window.gsap !== 'undefined' && typeof window.ScrollTrigger !== 'undefined';

  // 把标题拆成一个个字（分行的标题按 .line 一行行拆，保留换行）。标题本身留给读屏（用 aria-label 读整句），
  // 只把拆出来的字藏起来：没有 .line 的标题先包一层再藏这一层，不藏标题本身（Codex 审查 1b3667e）
  function splitChars(el) {
    if (!el || el.dataset.splitDone) return [];
    if (!el.getAttribute('aria-label')) el.setAttribute('aria-label', el.textContent);
    var lines = el.querySelectorAll('.line');
    if (!lines.length) {
      var wrap = document.createElement('span');
      wrap.className = 'line-inline';
      wrap.textContent = el.textContent;
      el.textContent = '';
      el.appendChild(wrap);
    }
    var targets = lines.length ? Array.from(lines) : [el.firstChild];
    var out = [];
    targets.forEach(function (target) {
      var text = target.textContent;
      target.textContent = '';
      target.setAttribute('aria-hidden', 'true');
      Array.from(text).forEach(function (ch) {
        var span = document.createElement('span');
        span.className = 'char';
        span.textContent = ch;
        target.appendChild(span);
        out.push(span);
      });
    });
    el.dataset.splitDone = '1';
    return out;
  }

  // ── 水面 ──
  // 8.2.0 起首屏是 three.js 的 3D 柚子池（hero3d.js，模块脚本，在这之后跑）；它起不来时（不支持 WebGL2、3D 库没加载到、
  // 着色器编不过、老浏览器不认模块脚本）调这里，换回原来的 2D 柚子池（pool.js）
  var hero = document.querySelector('.hero-pool');
  var poolCanvas = document.querySelector('[data-pool]');
  var fellBack = false;
  window.YuzuHeroFallback = function () {
    if (fellBack) return;
    fellBack = true;
    if (!poolCanvas || !window.YuzuPool) return;
    poolCanvas.hidden = false;
    var pool = window.YuzuPool.mount(poolCanvas, {
      mode: 'pool',
      onTouch: function () {
        if (hero) hero.dataset.touched = 'true';
      },
    });
    if (!pool && hero) hero.dataset.touched = 'true';
    if (pool) {
      window.YuzuHero = pool;
      if (window.YuzuHeroPendingSuspend && pool.suspend) pool.suspend();
    }
  };
  if (!('noModule' in HTMLScriptElement.prototype)) window.YuzuHeroFallback();
  // 首屏视频要停水面时，水面可能还没起来（3D 库还在下载）：先记下，起来以后自己停
  var heroCtl = {
    suspend: function () {
      window.YuzuHeroPendingSuspend = true;
      if (window.YuzuHero && window.YuzuHero.suspend) window.YuzuHero.suspend();
    },
    resume: function () {
      window.YuzuHeroPendingSuspend = false;
      if (window.YuzuHero && window.YuzuHero.resume) window.YuzuHero.resume();
    },
  };
  // ── 首屏视频（8.1.46，docs/BOARDS.md 第 5 节）：系统素材库里设了「官网 · 首屏视频」就换上，柚子池停掉；
  // 没设（404）、正式服取不到、浏览器不让自动播、减少动效、省流量时什么都不做，照原来的柚子池
  var heroVideo = document.querySelector('[data-hero-video]');
  var saveData = navigator.connection && navigator.connection.saveData;
  if (heroVideo && hero && !reduce && !saveData && heroVideo.dataset.src) {
    var poolLabel = hero.getAttribute('aria-label');
    // 放不了（没设、取不到、不让自动播）或者放到一半出错（后面某一段取不到、内容坏了）：拿掉视频、柚子池接着动（Codex 审查）
    var dropVideo = function () {
      if (heroVideo.parentNode) heroVideo.parentNode.removeChild(heroVideo);
      if (hero.dataset.video === 'on') {
        delete hero.dataset.video;
        if (poolLabel) hero.setAttribute('aria-label', poolLabel);
        heroCtl.resume();
      }
    };
    heroVideo.addEventListener('error', dropVideo);
    heroVideo.addEventListener(
      'playing',
      function () {
        hero.dataset.video = 'on';
        hero.setAttribute('aria-label', '柚子的首屏视频');
        heroCtl.suspend();
      },
      { once: true },
    );
    heroVideo.src = heroVideo.dataset.src;
    var started = heroVideo.play();
    if (started && started.catch) started.catch(dropVideo);
  }

  var rippleCanvas = document.querySelector('[data-ripple]');
  if (rippleCanvas && window.YuzuPool) window.YuzuPool.mount(rippleCanvas, { mode: 'ledger' });

  // ── 导航：滚过首屏一点就加底色 ──
  var nav = document.querySelector('[data-nav]');
  function onScroll() {
    if (nav) nav.dataset.scrolled = window.scrollY > 24 ? 'true' : 'false';
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // ── 平滑滚动 ──
  var lenis = null;
  if (!reduce && typeof window.Lenis !== 'undefined') {
    lenis = new window.Lenis({ duration: 1.1, smoothWheel: true });
    if (hasGsap) {
      lenis.on('scroll', window.ScrollTrigger.update);
      window.gsap.ticker.add(function (time) {
        lenis.raf(time * 1000);
      });
      window.gsap.ticker.lagSmoothing(0);
    } else {
      var raf = function (time) {
        lenis.raf(time);
        requestAnimationFrame(raf);
      };
      requestAnimationFrame(raf);
    }
    // 页内锚点也走平滑滚动
    document.querySelectorAll('a[href^="#"]').forEach(function (a) {
      a.addEventListener('click', function (ev) {
        var id = a.getAttribute('href');
        var target = id && id.length > 1 ? document.querySelector(id) : null;
        if (!target && id !== '#top') return;
        ev.preventDefault();
        lenis.scrollTo(target || 0, { offset: -72 });
      });
    });
  }

  // 进场的字与按钮
  root.classList.add('ready');

  if (!hasGsap) return;
  var gsap = window.gsap;
  gsap.registerPlugin(window.ScrollTrigger);

  // ── 首屏「柚子」从水里浮上来 ──
  var heroChars = splitChars(document.querySelector('[data-split]'));
  if (!reduce && heroChars.length) {
    gsap.from(heroChars, {
      yPercent: 110,
      rotate: function (i) {
        return i % 2 ? 9 : -7;
      },
      opacity: 0,
      duration: 1.3,
      ease: 'expo.out',
      stagger: 0.12,
      delay: 0.1,
    });
    // 之后轻轻地浮
    heroChars.forEach(function (ch, i) {
      gsap.to(ch, { y: i % 2 ? -6 : 6, rotate: i % 2 ? 1.5 : -1.5, duration: 2.8 + i * 0.4, ease: 'sine.inOut', yoyo: true, repeat: -1, delay: 1.4 });
    });
  }

  var mm = gsap.matchMedia();

  // ── 店里的一天：宽屏钉住横走 ──
  var day = document.querySelector('.day');
  var track = document.querySelector('[data-day-track]');
  var meter = document.querySelector('[data-day-meter]');
  // 一天的天色：前 60% 是白天，之后慢慢入夜；柚子太阳沿一道弧从左走到右，入夜变月亮
  var sun = document.querySelector('[data-day-sun]');
  var dayColors = {
    bg: gsap.utils.interpolate('rgb(240, 234, 222)', 'rgb(24, 40, 54)'),
    ink: gsap.utils.interpolate('rgb(22, 37, 52)', 'rgb(244, 239, 228)'),
    ink2: gsap.utils.interpolate('rgb(52, 70, 86)', 'rgb(206, 214, 216)'),
    time: gsap.utils.interpolate('rgb(76, 111, 140)', 'rgb(233, 199, 94)'),
    rule: gsap.utils.interpolate('rgb(222, 213, 198)', 'rgb(58, 76, 92)'),
    sun: gsap.utils.interpolate('rgb(233, 199, 94)', 'rgb(236, 232, 214)'),
  };
  function paintDay(p) {
    if (meter) meter.style.transform = 'scaleX(' + p.toFixed(4) + ')';
    var night = gsap.utils.clamp(0, 1, (p - 0.55) / 0.4);
    day.style.setProperty('--day-bg', dayColors.bg(night));
    day.style.setProperty('--day-ink', dayColors.ink(night));
    day.style.setProperty('--day-ink-2', dayColors.ink2(night));
    day.style.setProperty('--day-time', dayColors.time(night));
    day.style.setProperty('--day-rule', dayColors.rule(night));
    if (sun) {
      var w = day.clientWidth;
      var x = 0.08 * w + p * 0.84 * w - 36;
      var y = 150 - Math.sin(p * Math.PI) * 110;
      sun.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px)';
      sun.style.background = dayColors.sun(night);
    }
  }
  mm.add('(min-width: 900px) and (prefers-reduced-motion: no-preference)', function () {
    if (!day || !track) return;
    day.dataset.pinned = 'true';
    window.ScrollTrigger.refresh();
    var distance = function () {
      return Math.max(0, track.scrollWidth - window.innerWidth + parseFloat(getComputedStyle(track).paddingLeft) * 2);
    };
    var tween = gsap.to(track, {
      x: function () {
        return -distance();
      },
      ease: 'none',
      scrollTrigger: {
        trigger: day,
        start: 'top top',
        end: function () {
          return '+=' + distance();
        },
        pin: true,
        scrub: 0.6,
        invalidateOnRefresh: true,
        onUpdate: function (self) {
          paintDay(self.progress);
        },
      },
    });
    // 每个钟点进到中间时，数字亮起来
    gsap.utils.toArray('.hour').forEach(function (hour) {
      gsap.from(hour.querySelector('.hour-time'), {
        opacity: 0.25,
        scrollTrigger: { trigger: hour, containerAnimation: tween, start: 'left 75%', end: 'left 35%', scrub: true },
      });
    });
    paintDay(0);
    return function () {
      day.dataset.pinned = 'false';
      gsap.set(track, { clearProps: 'transform' });
      ['--day-bg', '--day-ink', '--day-ink-2', '--day-time', '--day-rule'].forEach(function (k) {
        day.style.removeProperty(k);
      });
    };
  });
  // 窄屏：一个个从下面滑上来
  mm.add('(max-width: 899px) and (prefers-reduced-motion: no-preference)', function () {
    gsap.utils.toArray('.hour').forEach(function (hour) {
      gsap.from(hour, { y: 40, opacity: 0, duration: 0.9, ease: 'expo.out', scrollTrigger: { trigger: hour, start: 'top 85%' } });
    });
  });

  mm.add('(prefers-reduced-motion: no-preference)', function () {
    // ── 四扇门依次推开 ──
    gsap.from('.door', {
      y: 60,
      opacity: 0,
      duration: 1.1,
      ease: 'expo.out',
      stagger: 0.1,
      scrollTrigger: { trigger: '.doors-grid', start: 'top 80%' },
    });

    // ── 纯天然 AI 制作，零人工代码添加：逐字被照亮（8.1.43 以前是「钱按分记」） ──
    var fillChars = splitChars(document.querySelector('[data-fill]'));
    if (fillChars.length) {
      gsap.fromTo(
        fillChars,
        { opacity: 0.18 },
        {
          opacity: 1,
          stagger: 0.08,
          ease: 'none',
          scrollTrigger: { trigger: '.ledger', start: 'top 70%', end: 'center 45%', scrub: true },
        },
      );
    }
    gsap.from('.ledger-eyebrow, .ledger-lines li', {
      y: 30,
      opacity: 0,
      duration: 1,
      ease: 'expo.out',
      stagger: 0.15,
      scrollTrigger: { trigger: '.ledger-notes', start: 'top 85%' },
    });

    // ── 员工那三行 ──
    gsap.from('.staff-list li', {
      x: 40,
      opacity: 0,
      duration: 0.9,
      ease: 'expo.out',
      stagger: 0.1,
      scrollTrigger: { trigger: '.staff-list', start: 'top 85%' },
    });

    // ── 收尾：大字落下来，字条一直往左走 ──
    gsap.from('.close-title', {
      yPercent: 40,
      opacity: 0,
      duration: 1.2,
      ease: 'expo.out',
      scrollTrigger: { trigger: '.close', start: 'top 75%' },
    });
    var row = document.querySelector('[data-marquee]');
    if (row) {
      row.innerHTML += row.innerHTML;
      gsap.to(row, { xPercent: -50, duration: 28, ease: 'none', repeat: -1 });
    }
  });

  // ── 指针：门微微倾斜、主按钮有点磁性（只在有鼠标的设备上） ──
  mm.add('(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)', function () {
    var cleanups = [];
    document.querySelectorAll('[data-tilt]').forEach(function (el) {
      var rx = gsap.quickTo(el, 'rotationX', { duration: 0.6, ease: 'power3.out' });
      var ry = gsap.quickTo(el, 'rotationY', { duration: 0.6, ease: 'power3.out' });
      gsap.set(el, { transformPerspective: 900 });
      var move = function (ev) {
        var r = el.getBoundingClientRect();
        var px = (ev.clientX - r.left) / r.width - 0.5;
        var py = (ev.clientY - r.top) / r.height - 0.5;
        rx(-py * 6);
        ry(px * 8);
      };
      var leave = function () {
        rx(0);
        ry(0);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerleave', leave);
      cleanups.push(function () {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerleave', leave);
      });
    });
    document.querySelectorAll('[data-magnetic]').forEach(function (el) {
      var mx = gsap.quickTo(el, 'x', { duration: 0.5, ease: 'power3.out' });
      var my = gsap.quickTo(el, 'y', { duration: 0.5, ease: 'power3.out' });
      var move = function (ev) {
        var r = el.getBoundingClientRect();
        mx((ev.clientX - (r.left + r.width / 2)) * 0.25);
        my((ev.clientY - (r.top + r.height / 2)) * 0.35);
      };
      var leave = function () {
        mx(0);
        my(0);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerleave', leave);
      cleanups.push(function () {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerleave', leave);
      });
    });
    return function () {
      cleanups.forEach(function (fn) {
        fn();
      });
    };
  });

  window.addEventListener('load', function () {
    window.ScrollTrigger.refresh();
  });
})();
