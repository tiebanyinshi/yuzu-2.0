/*
 * 一池柚子汤（柚子官网首屏，docs/WEBSITE.md）：一个全屏片元着色器画水面的焦散光纹，几颗柚子浮在上面。
 * 柚子会躲开指针、互相碰一碰；点一下水面起一圈涟漪，附近的柚子被推开。
 * mode "pool" 是首屏（亮水、有柚子），mode "ledger" 是深色小节的底（只有暗一点的光纹，没有柚子）。
 * 不支持 WebGL 时什么都不画，留着 CSS 的水色底；「减少动效」时只画一帧。离开屏幕时停下。
 */
(function () {
  'use strict';

  var MAX_BALLS = 7;
  var MAX_RIPPLES = 6;

  var VERT = 'attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}';

  var FRAG = [
    'precision highp float;',
    'uniform vec2 uRes;uniform float uTime;uniform float uMode;',
    'uniform vec4 uBalls[' + MAX_BALLS + '];uniform int uBallCount;',
    'uniform vec4 uRipples[' + MAX_RIPPLES + '];',
    'vec2 hash2(vec2 p){p=vec2(dot(p,vec2(127.1,311.7)),dot(p,vec2(269.5,183.3)));return fract(sin(p)*43758.5453);}',
    'float hash1(vec2 p){return fract(sin(dot(p,vec2(41.3,289.1)))*45758.5453);}',
    // 动的 Voronoi：返回最近两点的距离差，越小越靠近网格的边（光纹亮的地方）
    'float cells(vec2 x,float t){vec2 n=floor(x);vec2 f=fract(x);float d1=8.,d2=8.;',
    ' for(int j=-1;j<=1;j++)for(int i=-1;i<=1;i++){vec2 g=vec2(float(i),float(j));vec2 o=hash2(n+g);',
    '  o=0.5+0.42*sin(t+6.2831*o);vec2 r=g+o-f;float d=dot(r,r);',
    '  if(d<d1){d2=d1;d1=d;}else if(d<d2){d2=d;}}',
    ' return sqrt(d2)-sqrt(d1);}',
    'float noise(vec2 p);',
    // 两层动的网格叠起来、再被水流扭一扭：线细、有粗有细，亮处是两层交叉的地方
    'float caustic(vec2 p,float t){',
    ' vec2 q=p*3.3;',
    ' q+=0.55*vec2(noise(q*0.7+t*0.15)-0.5,noise(q*0.7-t*0.13+4.1)-0.5);',
    ' q+=0.22*vec2(sin(q.y*1.7+t*0.8),cos(q.x*1.5-t*0.7));',
    ' float a=cells(q,t*0.8);float b=cells(q*1.7+vec2(5.2,1.3),t*1.15);',
    ' float wa=0.035+0.03*noise(q*1.3+t*0.2);',
    ' float la=exp(-a*a/(wa*wa));float lb=exp(-b*b/(0.03*0.03));',
    ' float glow=exp(-a*a/(0.16*0.16))*0.18;',
    ' return la*0.75+lb*0.4+la*lb*0.9+glow;}',
    'float noise(vec2 p){vec2 i=floor(p);vec2 f=fract(p);f=f*f*(3.-2.*f);',
    ' return mix(mix(hash1(i),hash1(i+vec2(1,0)),f.x),mix(hash1(i+vec2(0,1)),hash1(i+vec2(1,1)),f.x),f.y);}',
    'void main(){',
    ' vec2 p=(gl_FragCoord.xy-0.5*uRes)/uRes.y;',
    ' float t=uTime;',
    // 涟漪：把水面坐标往外推一推（折射），浪尖亮一点
    ' vec2 off=vec2(0.);float crest=0.;',
    ' for(int k=0;k<' + MAX_RIPPLES + ';k++){vec4 r=uRipples[k];if(r.w<=0.)continue;',
    '  float age=t-r.z;if(age<0.||age>4.)continue;vec2 dv=p-r.xy;float d=length(dv);',
    '  float front=age*0.32;float env=exp(-age*1.1)*exp(-abs(d-front)*9.)*r.w;',
    '  float w=sin((d-front)*46.)*env;off+=normalize(dv+1e-5)*w*0.018;crest+=max(w,0.)*0.5;}',
    ' vec2 wp=p+off;',
    // 柚子在水面上的影子（光从左上来）
    ' float shade=0.;',
    ' for(int k=0;k<' + MAX_BALLS + ';k++){if(k>=uBallCount)break;vec4 b=uBalls[k];',
    '  vec2 sc=b.xy+vec2(0.05,-0.07)*b.z/0.1;float sd=length(wp-sc);shade=max(shade,(1.-smoothstep(b.z*0.55,b.z*1.45,sd))*0.55);}',
    ' vec3 deepC=uMode>0.5?vec3(0.12,0.19,0.25):vec3(0.27,0.47,0.57);',
    ' vec3 shallowC=uMode>0.5?vec3(0.16,0.26,0.33):vec3(0.5,0.71,0.77);',
    ' float depth=smoothstep(0.75,0.05,length(p*vec2(0.85,1.)));',
    ' vec3 col=mix(deepC,shallowC,depth);',
    ' float c=caustic(wp,t*(uMode>0.5?0.45:0.7));',
    ' vec3 light=uMode>0.5?vec3(0.55,0.7,0.78):vec3(0.98,0.97,0.88);',
    ' col+=light*c*(uMode>0.5?0.28:0.55)*(1.-shade*0.9);',
    // 最亮的缝里分一点光谱
    ' col+=vec3(0.06,0.03,-0.02)*pow(c,3.)*(uMode>0.5?0.:1.);',
    ' col*=1.-shade*0.38;col+=crest*light*0.35;',
    // 柚子
    ' for(int k=0;k<' + MAX_BALLS + ';k++){if(k>=uBallCount)break;vec4 b=uBalls[k];',
    '  vec2 dv=p-b.xy;float d=length(dv);float r=b.z;if(d>r*1.02)continue;',
    '  float edge=smoothstep(r,r-1.5/uRes.y,d);',
    '  vec2 q=dv/r;float z=sqrt(max(0.,1.-dot(q,q)));vec3 n=normalize(vec3(q,z));',
    '  float ca=cos(b.w),sa=sin(b.w);vec2 rq=mat2(ca,-sa,sa,ca)*q;',
    '  float pores=noise(rq*16.+b.w)*0.55+noise(rq*34.-b.w)*0.45;',
    '  vec3 alb=mix(vec3(0.93,0.74,0.2),vec3(0.99,0.86,0.4),pores*0.7+0.15);',
    '  vec3 L=normalize(vec3(-0.55,0.6,0.75));float diff=max(dot(n,L),0.);',
    '  float spec=pow(max(dot(reflect(-L,n),vec3(0.,0.,1.)),0.),26.)*0.55;',
    '  vec3 fc=alb*(0.5+0.62*diff)+vec3(1.,0.98,0.9)*spec*(0.6+0.4*pores);',
    '  fc*=0.75+0.25*z;',
    // 柚子顶上的蒂和一片叶子
    '  vec2 tip=vec2(-0.22,0.6);vec2 lq=rq-tip;',
    '  float stem=1.-smoothstep(0.045,0.07,length(lq));',
    '  vec2 la=lq-vec2(0.2,0.1);la=mat2(0.82,-0.57,0.57,0.82)*la;',
    '  float lw=1.-abs(la.x)/0.26;float leaf=step(0.,lw)*(1.-smoothstep(lw*0.075,lw*0.075+0.012,abs(la.y)));',
    '  float vein=(1.-smoothstep(0.,0.008,abs(la.y)))*step(0.,lw);',
    '  fc=mix(fc,vec3(0.42,0.36,0.16),stem);fc=mix(fc,vec3(0.43,0.45,0.2)*(0.75+0.45*diff),leaf);fc=mix(fc,vec3(0.6,0.62,0.32),vein*leaf*0.6);',
    // 泡在水里的下半截：发蓝、被水光盖一层
    '  float sub=smoothstep(-0.05,-0.45,q.y+0.06*sin(t*1.3+b.w*3.));',
    '  fc=mix(fc,fc*vec3(0.72,0.88,0.9)+light*c*0.22,sub*0.6);',
    '  col=mix(col,fc,edge);',
    // 水线上一圈亮边
    '  float rim=(1.-smoothstep(0.,0.05,abs(d-r*0.985)))*smoothstep(0.1,-0.5,q.y)*0.25;col+=rim;}',
    ' gl_FragColor=vec4(col,1.);}',
  ].join('\n');

  function compile(gl, type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
    return s;
  }

  function mount(canvas, opts) {
    var mode = opts && opts.mode === 'ledger' ? 1 : 0;
    var gl = canvas.getContext('webgl', { antialias: false, alpha: false, premultipliedAlpha: false });
    if (!gl) return null;
    var prog;
    try {
      prog = gl.createProgram();
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link');
    } catch (e) {
      return null;
    }
    gl.useProgram(prog);
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(prog, 'a');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    var U = {
      res: gl.getUniformLocation(prog, 'uRes'),
      time: gl.getUniformLocation(prog, 'uTime'),
      mode: gl.getUniformLocation(prog, 'uMode'),
      balls: gl.getUniformLocation(prog, 'uBalls'),
      count: gl.getUniformLocation(prog, 'uBallCount'),
      ripples: gl.getUniformLocation(prog, 'uRipples'),
    };
    gl.uniform1f(U.mode, mode);

    var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var W = 1;
    var H = 1;
    var aspect = 1;
    function resize() {
      var dpr = Math.min(window.devicePixelRatio || 1, mode ? 1 : 1.6);
      var rect = canvas.getBoundingClientRect();
      W = Math.max(1, Math.round(rect.width * dpr));
      H = Math.max(1, Math.round(rect.height * dpr));
      canvas.width = W;
      canvas.height = H;
      aspect = W / H;
      gl.viewport(0, 0, W, H);
      gl.uniform2f(U.res, W, H);
    }
    resize();

    // 柚子：位置在着色器的坐标里（高度方向 -0.5 到 0.5）
    var balls = [];
    if (!mode) {
      var seeds = [
        [-0.17, 0.15, 0.095],
        [0.16, 0.21, 0.08],
        [0.03, -0.05, 0.11],
        [-0.19, -0.21, 0.08],
        [0.2, -0.17, 0.088],
      ];
      for (var i = 0; i < seeds.length; i++) {
        balls.push({ x: seeds[i][0], y: seeds[i][1], r: seeds[i][2], vx: 0, vy: 0, rot: i * 1.7, phase: i * 1.3 });
      }
    }
    var ripples = [];
    var start = performance.now();
    var now = function () {
      return (performance.now() - start) / 1000;
    };
    var pointer = { x: 9, y: 9, active: false, lastRipple: 0, px: 9, py: 9 };

    function toLocal(ev) {
      var rect = canvas.getBoundingClientRect();
      var x = (ev.clientX - rect.left) / rect.width;
      var y = (ev.clientY - rect.top) / rect.height;
      return { x: (x - 0.5) * (rect.width / rect.height), y: 0.5 - y };
    }
    function addRipple(x, y, strength) {
      ripples.push({ x: x, y: y, t: now(), s: strength });
      if (ripples.length > MAX_RIPPLES) ripples.shift();
    }

    if (!mode) {
      canvas.addEventListener('pointermove', function (ev) {
        var p = toLocal(ev);
        pointer.x = p.x;
        pointer.y = p.y;
        pointer.active = true;
        var moved = Math.hypot(p.x - pointer.px, p.y - pointer.py);
        var t = now();
        if (moved > 0.06 && t - pointer.lastRipple > 0.18) {
          addRipple(p.x, p.y, 0.35);
          pointer.lastRipple = t;
          pointer.px = p.x;
          pointer.py = p.y;
        }
      });
      canvas.addEventListener('pointerleave', function () {
        pointer.active = false;
      });
      canvas.addEventListener('pointerdown', function (ev) {
        var p = toLocal(ev);
        addRipple(p.x, p.y, 1);
        for (var i = 0; i < balls.length; i++) {
          var b = balls[i];
          var dx = b.x - p.x;
          var dy = b.y - p.y;
          var d = Math.hypot(dx, dy) || 0.001;
          if (d < 0.35) {
            var f = (0.35 - d) * 0.06;
            b.vx += (dx / d) * f;
            b.vy += (dy / d) * f;
          }
        }
        if (opts && opts.onTouch) opts.onTouch();
        if (reduce) draw(now());
      });
    }

    function step(dt, t) {
      var bound = 0.44;
      for (var i = 0; i < balls.length; i++) {
        var b = balls[i];
        // 水在慢慢转：一点点漂
        b.vx += Math.sin(t * 0.37 + b.phase) * 0.00002 + Math.cos(t * 0.21 + b.phase * 2.0) * 0.000015;
        b.vy += Math.cos(t * 0.31 + b.phase) * 0.00002;
        if (pointer.active) {
          var dx = b.x - pointer.x;
          var dy = b.y - pointer.y;
          var d = Math.hypot(dx, dy) || 0.001;
          var reach = b.r + 0.13;
          if (d < reach) {
            var f = (reach - d) * 0.0045;
            b.vx += (dx / d) * f;
            b.vy += (dy / d) * f;
          }
        }
        for (var j = i + 1; j < balls.length; j++) {
          var o = balls[j];
          var ex = o.x - b.x;
          var ey = o.y - b.y;
          var ed = Math.hypot(ex, ey) || 0.001;
          var min = b.r + o.r + 0.006;
          if (ed < min) {
            var push = (min - ed) * 0.5;
            var nx = ex / ed;
            var ny = ey / ed;
            b.x -= nx * push;
            b.y -= ny * push;
            o.x += nx * push;
            o.y += ny * push;
            var rel = (o.vx - b.vx) * nx + (o.vy - b.vy) * ny;
            if (rel < 0) {
              b.vx += nx * rel * 0.5;
              b.vy += ny * rel * 0.5;
              o.vx -= nx * rel * 0.5;
              o.vy -= ny * rel * 0.5;
            }
          }
        }
        b.vx *= 0.965;
        b.vy *= 0.965;
        b.x += b.vx * dt * 60;
        b.y += b.vy * dt * 60;
        // 池子是个圆：碰到池边轻轻弹回
        var lim = Math.min(bound * aspect, bound) - b.r * 0.6;
        var rx = b.x / (bound * Math.min(aspect, 1.2));
        var ry = b.y / bound;
        var rr = Math.hypot(rx, ry);
        if (rr > 1 - b.r / bound && rr > 0) {
          var k = (1 - b.r / bound) / rr;
          b.x *= k;
          b.y *= k;
          b.vx *= -0.4;
          b.vy *= -0.4;
        }
        if (lim < 0) b.x = 0;
        b.rot += (b.vx - b.vy) * 3.2 + 0.0008;
      }
    }

    var ballData = new Float32Array(MAX_BALLS * 4);
    var rippleData = new Float32Array(MAX_RIPPLES * 4);
    function draw(t) {
      for (var i = 0; i < balls.length; i++) {
        var b = balls[i];
        var bob = 1 + Math.sin(t * 1.1 + b.phase) * 0.025;
        ballData[i * 4] = b.x;
        ballData[i * 4 + 1] = b.y + Math.sin(t * 0.9 + b.phase) * 0.004;
        ballData[i * 4 + 2] = b.r * bob;
        ballData[i * 4 + 3] = b.rot;
      }
      rippleData.fill(0);
      for (var k = 0; k < ripples.length; k++) {
        rippleData[k * 4] = ripples[k].x;
        rippleData[k * 4 + 1] = ripples[k].y;
        rippleData[k * 4 + 2] = ripples[k].t;
        rippleData[k * 4 + 3] = ripples[k].s;
      }
      gl.uniform1f(U.time, t + (mode ? 40 : 0));
      gl.uniform4fv(U.balls, ballData);
      gl.uniform1i(U.count, balls.length);
      gl.uniform4fv(U.ripples, rippleData);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    var running = false;
    var visible = true;
    var last = 0;
    function frame() {
      if (!running) return;
      var t = now();
      var dt = Math.min(0.05, t - last || 0.016);
      last = t;
      step(dt, t);
      draw(t);
      requestAnimationFrame(frame);
    }
    function play() {
      if (running || reduce || !visible || document.hidden) return;
      running = true;
      last = now();
      requestAnimationFrame(frame);
    }
    function pause() {
      running = false;
    }

    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
        if (visible) play();
        else pause();
      }).observe(canvas);
    }
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) pause();
      else play();
    });
    window.addEventListener('resize', function () {
      resize();
      if (!running) draw(now());
    });

    draw(reduce ? 6 : 0);
    play();
    return { pause: pause, play: play };
  }

  window.YuzuPool = { mount: mount };
})();
