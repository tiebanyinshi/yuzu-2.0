/*
 * 首屏的柚子池（8.2.0，docs/WEBSITE.md 第 6 节）：three.js 实时 3D。
 *   · 水面是 PBR 的透射材质（折射池底、按深度染蓝），顶点按几层波浪和点出来的涟漪起伏，法线跟着算；
 *   · 池底是一片小方砖，水面焦散的光纹打在上面（自己写的着色器，与 pool.js 的光纹同一套算法），柚子的影子落在池底；
 *   · 柚子是 PBR 材质：打蜡的果皮（清漆层）、凹凹的油胞（程序生成的法线贴图）、黄里带一点绿的斑驳，顶上一个蒂、有的带一片叶子；
 *     浮在水上跟着浪起伏、倾斜，躲开指针，互相碰一碰，点一下水面起涟漪、把附近的柚子推开；
 *   · 光：RoomEnvironment 的环境光（三维版的「影棚 HDRI」）+ 一盏偏暖的主光；
 *   · 后期（pmndrs/postprocessing）：Bloom 只让最亮的光纹和高光微微泛开，ACES 色调映射，一点点色差与胶片颗粒、四角压暗——去掉「塑料感」。
 * 退路：浏览器不支持 WebGL2、3D 库没加载到、着色器编不过时，换回原来的 2D 柚子池（pool.js，main.js 的 YuzuHeroFallback）。
 * 「减少动效」时只画一帧、不动；离开屏幕、切走标签页时停下；首屏视频放起来时整个停掉（suspend / resume）。
 */

const hero = document.querySelector('.hero-pool');
const poolCanvas = document.querySelector('[data-pool]');

function fallback() {
  if (hero) delete hero.dataset.hero3d;
  if (typeof window.YuzuHeroFallback === 'function') window.YuzuHeroFallback();
}

function supportsWebGL2() {
  try {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl2');
  } catch (e) {
    return false;
  }
}

if (!hero || !poolCanvas || !supportsWebGL2()) {
  fallback();
} else {
  import('./vendor/three-bundle.js')
    .then((THREE) => {
      try {
        mount(THREE);
      } catch (e) {
        console.warn('柚子池 3D 没起来，换回 2D：', e);
        fallback();
      }
    })
    .catch(fallback);
}

// ───────────────────────── 水面的起伏（着色器与 JS 同一套，柚子按它浮） ─────────────────────────

const MAX_RIPPLES = 6;
const MAX_FRUITS = 7;

const WAVE_GLSL = /* glsl */ `
uniform float uTime;
uniform vec4 uRipples[${MAX_RIPPLES}];
float yzWave(vec2 p, float t) {
  float h = 0.032 * sin(dot(p, vec2(0.92, 0.39)) * 2.1 + t * 1.05)
          + 0.022 * sin(dot(p, vec2(-0.31, 0.95)) * 3.4 + t * 1.55)
          + 0.011 * sin(dot(p, vec2(0.71, -0.70)) * 6.3 + t * 2.25)
          + 0.005 * sin(dot(p, vec2(-0.86, -0.51)) * 11.0 + t * 3.10);
  for (int k = 0; k < ${MAX_RIPPLES}; k++) {
    vec4 r = uRipples[k];
    if (r.w <= 0.0) continue;
    float age = t - r.z;
    if (age < 0.0 || age > 5.0) continue;
    float d = length(p - r.xy);
    float front = age * 1.15;
    float env = exp(-age * 0.9) * exp(-abs(d - front) * 2.6) * r.w;
    h += 0.085 * sin((d - front) * 13.0) * env;
  }
  return h;
}
`;

function waveJS(x, z, t, ripples) {
  let h =
    0.032 * Math.sin((x * 0.92 + z * 0.39) * 2.1 + t * 1.05) +
    0.022 * Math.sin((x * -0.31 + z * 0.95) * 3.4 + t * 1.55) +
    0.011 * Math.sin((x * 0.71 + z * -0.7) * 6.3 + t * 2.25) +
    0.005 * Math.sin((x * -0.86 + z * -0.51) * 11.0 + t * 3.1);
  for (const r of ripples) {
    if (r.w <= 0) continue;
    const age = t - r.z;
    if (age < 0 || age > 5) continue;
    const d = Math.hypot(x - r.x, z - r.y);
    const front = age * 1.15;
    const env = Math.exp(-age * 0.9) * Math.exp(-Math.abs(d - front) * 2.6) * r.w;
    h += 0.085 * Math.sin((d - front) * 13.0) * env;
  }
  return h;
}

// ───────────────────────── 程序生成的柚子皮（颜色 + 法线） ─────────────────────────

function hash(i, j, seed) {
  const s = Math.sin(i * 127.1 + j * 311.7 + seed * 74.7) * 43758.5453;
  return s - Math.floor(s);
}
function valueNoise(x, y, seed) {
  const i = Math.floor(x);
  const j = Math.floor(y);
  const fx = x - i;
  const fy = y - j;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hash(i, j, seed);
  const b = hash(i + 1, j, seed);
  const c = hash(i, j + 1, seed);
  const d = hash(i + 1, j + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function peelTextures(THREE) {
  const W = 512;
  const H = 256;
  const height = new Float32Array(W * H);
  // 油胞：许多小凹坑（经度方向按纬度收窄，免得赤道外的坑被拉长）
  for (let y = 0; y < H; y++) {
    const lat = (y / (H - 1) - 0.5) * Math.PI;
    const squeeze = Math.max(0.2, Math.cos(lat));
    for (let x = 0; x < W; x++) {
      const u = (x / W) * 90 * squeeze;
      const v = (y / H) * 45;
      // 细胞噪声近似：在 3×3 邻格里找最近的随机点
      const ci = Math.floor(u);
      const cj = Math.floor(v);
      let best = 9;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const px = ci + di + hash(ci + di, cj + dj, 3.1);
          const py = cj + dj + hash(ci + di, cj + dj, 7.7);
          const dd = (u - px) * (u - px) + (v - py) * (v - py);
          if (dd < best) best = dd;
        }
      }
      const pore = Math.exp(-best * 9); // 坑中心为 1
      const swell = valueNoise(u * 0.18, v * 0.18, 1.3) * 0.6 + valueNoise(u * 0.5, v * 0.5, 2.9) * 0.4;
      height[y * W + x] = swell * 0.35 - pore * 0.55;
    }
  }
  const normal = new Uint8Array(W * H * 4);
  const color = new Uint8Array(W * H * 4);
  const at = (x, y) => height[((y + H) % H) * W + ((x + W) % W)];
  for (let y = 0; y < H; y++) {
    const yy = y / (H - 1);
    for (let x = 0; x < W; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * 2.2;
      const dy = (at(x, y + 1) - at(x, y - 1)) * 2.2;
      let nx = -dx;
      let ny = -dy;
      let nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l;
      ny /= l;
      nz /= l;
      const o = (y * W + x) * 4;
      normal[o] = Math.round((nx * 0.5 + 0.5) * 255);
      normal[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      normal[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      normal[o + 3] = 255;
      // 颜色：柚子黄，斑驳一点；靠蒂（上极）偏青，坑里稍暗
      const mott = valueNoise(x * 0.035, y * 0.05, 5.5) * 0.6 + valueNoise(x * 0.11, y * 0.13, 8.2) * 0.4;
      const green = Math.max(0, (yy - 0.78) / 0.22) * 0.7 + Math.max(0, mott - 0.72) * 0.9;
      const shade = 0.9 + at(x, y) * 0.22 + mott * 0.12;
      const r = (228 - green * 70) * shade;
      const g = (162 - green * 4) * shade;
      const b = (22 - green * 6) * shade;
      color[o] = Math.max(0, Math.min(255, Math.round(r)));
      color[o + 1] = Math.max(0, Math.min(255, Math.round(g)));
      color[o + 2] = Math.max(0, Math.min(255, Math.round(b)));
      color[o + 3] = 255;
    }
  }
  const mk = (data, space) => {
    const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.wrapS = THREE.RepeatWrapping;
    t.colorSpace = space;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.anisotropy = 4;
    t.needsUpdate = true;
    return t;
  };
  return { normal: mk(normal, THREE.NoColorSpace), color: mk(color, THREE.SRGBColorSpace) };
}

// ───────────────────────── 池底：方砖 + 焦散光纹 + 柚子的影子 ─────────────────────────

const FLOOR_FRAG = /* glsl */ `
precision highp float;
uniform float uTime;
uniform vec4 uFruits[${MAX_FRUITS}];
uniform int uFruitCount;
varying vec2 vXZ;
vec2 hash2(vec2 p){p=vec2(dot(p,vec2(127.1,311.7)),dot(p,vec2(269.5,183.3)));return fract(sin(p)*43758.5453);}
float hash1(vec2 p){return fract(sin(dot(p,vec2(41.3,289.1)))*45758.5453);}
float noise(vec2 p){vec2 i=floor(p);vec2 f=fract(p);f=f*f*(3.-2.*f);
  return mix(mix(hash1(i),hash1(i+vec2(1,0)),f.x),mix(hash1(i+vec2(0,1)),hash1(i+vec2(1,1)),f.x),f.y);}
float cells(vec2 x,float t){vec2 n=floor(x);vec2 f=fract(x);float d1=8.,d2=8.;
  for(int j=-1;j<=1;j++)for(int i=-1;i<=1;i++){vec2 g=vec2(float(i),float(j));vec2 o=hash2(n+g);
    o=0.5+0.42*sin(t+6.2831*o);vec2 r=g+o-f;float d=dot(r,r);
    if(d<d1){d2=d1;d1=d;}else if(d<d2){d2=d;}}
  return sqrt(d2)-sqrt(d1);}
float caustic(vec2 p,float t){
  vec2 q=p*1.9;
  q+=0.55*vec2(noise(q*0.7+t*0.15)-0.5,noise(q*0.7-t*0.13+4.1)-0.5);
  q+=0.22*vec2(sin(q.y*1.7+t*0.8),cos(q.x*1.5-t*0.7));
  float a=cells(q,t*0.8);float b=cells(q*1.7+vec2(5.2,1.3),t*1.15);
  float wa=0.035+0.03*noise(q*1.3+t*0.2);
  float la=exp(-a*a/(wa*wa));float lb=exp(-b*b/(0.03*0.03));
  float glow=exp(-a*a/(0.16*0.16))*0.18;
  return la*0.75+lb*0.4+la*lb*0.9+glow;}
void main(){
  vec2 p=vXZ;
  // 小方砖（边长 0.42），砖缝细、颜色微微不一
  vec2 tile=p/0.42;vec2 tf=fract(tile);vec2 tid=floor(tile);
  float grout=smoothstep(0.0,0.035,min(min(tf.x,1.-tf.x),min(tf.y,1.-tf.y)));
  float tv=hash1(tid)*0.06;
  vec3 tileC=vec3(0.50,0.70,0.74)*(0.95+tv);
  vec3 col=mix(vec3(0.30,0.44,0.48),tileC,grout);
  // 远处深一点
  col*=mix(0.82,1.05,smoothstep(-4.0,2.5,p.y));
  // 光纹（亮处超过 1，Bloom 会让它微微泛开）
  float c=caustic(p,uTime*0.7);
  vec3 light=vec3(1.0,0.97,0.86);
  // 柚子的影子：光从左上来，影子偏到右下
  float shade=0.;
  for(int k=0;k<${MAX_FRUITS};k++){if(k>=uFruitCount)break;vec4 f=uFruits[k];
    vec2 sc=f.xy+vec2(0.85,-0.22);float sd=length(p-sc);
    shade=max(shade,(1.-smoothstep(f.z*0.35,f.z*1.6,sd))*0.8);}
  col+=light*c*0.85*(1.-shade*0.95);
  col*=1.-shade*0.45;
  gl_FragColor=vec4(col,1.);
}
`;

const FLOOR_VERT = /* glsl */ `
varying vec2 vXZ;
void main(){
  vec4 w=modelMatrix*vec4(position,1.);
  vXZ=w.xz;
  gl_Position=projectionMatrix*viewMatrix*w;
}
`;

// ───────────────────────── 场景 ─────────────────────────

function mount(THREE) {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const lite = window.matchMedia('(max-width: 899px)').matches || (navigator.hardwareConcurrency || 8) <= 4;

  const canvas = document.createElement('canvas');
  canvas.className = 'pool-canvas pool-canvas-3d';
  canvas.setAttribute('aria-hidden', 'true');
  poolCanvas.after(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance', stencil: false, depth: true });
  // 色调映射交给后期的 ToneMappingEffect（ACES），渲染器这里不再映射一次
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x2f5a6a, 1);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 60);
  camera.position.set(0, 5.4, 6.4);
  camera.lookAt(0, -0.35, -0.1);

  // 环境光：RoomEnvironment（程序生成的影棚，相当于一张柔和的 HDRI），不用下载 .hdr
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(new THREE.RoomEnvironment(), 0.035).texture;
  scene.environment = envTex;
  scene.environmentIntensity = 0.38;
  pmrem.dispose();

  const sun = new THREE.DirectionalLight(0xffeccc, 2.3);
  sun.position.set(-5, 5, 1.6);
  scene.add(sun);
  scene.add(new THREE.HemisphereLight(0xeaf4f2, 0x3a5d68, 0.25));

  // 池底
  const floorU = {
    uTime: { value: 0 },
    uFruits: { value: Array.from({ length: MAX_FRUITS }, () => new THREE.Vector4()) },
    uFruitCount: { value: 0 },
  };
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(22, 18).rotateX(-Math.PI / 2),
    new THREE.ShaderMaterial({ uniforms: floorU, vertexShader: FLOOR_VERT, fragmentShader: FLOOR_FRAG }),
  );
  floor.position.y = -1.05;
  scene.add(floor);

  // 水面：透射（折射池底与水下的半截柚子）、按厚度染成泳池蓝
  const ripples = Array.from({ length: MAX_RIPPLES }, () => new THREE.Vector4(0, 0, -99, 0));
  const waterU = { uTime: { value: 0 }, uRipples: { value: ripples } };
  const seg = lite ? 120 : 200;
  const waterGeo = new THREE.PlaneGeometry(22, 18, seg, Math.round(seg * 0.82)).rotateX(-Math.PI / 2);
  const water = new THREE.Mesh(
    waterGeo,
    new THREE.MeshPhysicalMaterial({
      color: 0xbfe6ea,
      metalness: 0,
      roughness: 0.055,
      transmission: 1,
      thickness: 0.1,
      ior: 1.333,
      attenuationColor: new THREE.Color(0x3f8da0),
      attenuationDistance: 0.5,
      specularIntensity: 1,
      envMapIntensity: 1.15,
    }),
  );
  water.material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = waterU.uTime;
    shader.uniforms.uRipples = waterU.uRipples;
    shader.vertexShader =
      WAVE_GLSL +
      shader.vertexShader
        .replace(
          '#include <beginnormal_vertex>',
          /* glsl */ `
          vec2 yzP = (modelMatrix * vec4(position, 1.0)).xz;
          float yzE = 0.03;
          float yzH = yzWave(yzP, uTime);
          float yzHx = yzWave(yzP + vec2(yzE, 0.0), uTime);
          float yzHz = yzWave(yzP + vec2(0.0, yzE), uTime);
          vec3 objectNormal = normalize(vec3(-(yzHx - yzH) / yzE, 1.0, -(yzHz - yzH) / yzE));
          `,
        )
        .replace('#include <begin_vertex>', 'vec3 transformed = vec3(position); transformed.y += yzH;');
  };
  scene.add(water);

  // 柚子
  const peel = peelTextures(THREE);
  const peelMat = new THREE.MeshPhysicalMaterial({
    map: peel.color,
    normalMap: peel.normal,
    normalScale: new THREE.Vector2(0.4, 0.4),
    roughness: 0.5,
    clearcoat: 0.45,
    clearcoatRoughness: 0.22,
    sheen: 0.35,
    sheenRoughness: 0.6,
    sheenColor: new THREE.Color(0xfff2b8),
    envMapIntensity: 0.7,
  });
  const stemMat = new THREE.MeshPhysicalMaterial({ color: 0x5b4f2a, roughness: 0.7 });
  const leafMat = new THREE.MeshPhysicalMaterial({
    color: 0x4f6427,
    roughness: 0.42,
    clearcoat: 0.4,
    clearcoatRoughness: 0.35,
    sheen: 0.4,
    sheenColor: new THREE.Color(0xc8d88a),
    side: THREE.DoubleSide,
  });
  const leafShape = new THREE.Shape();
  leafShape.moveTo(0, 0);
  leafShape.bezierCurveTo(0.12, 0.08, 0.36, 0.1, 0.56, 0);
  leafShape.bezierCurveTo(0.36, -0.1, 0.12, -0.08, 0, 0);
  const leafGeo = new THREE.ShapeGeometry(leafShape, 16).rotateX(-Math.PI / 2);
  const fruitGeo = new THREE.SphereGeometry(1, lite ? 48 : 72, lite ? 32 : 48);
  const stemGeo = new THREE.CylinderGeometry(0.045, 0.06, 0.08, 10);

  const specs = [
    { r: 0.56, leaf: true },
    { r: 0.48, leaf: false },
    { r: 0.52, leaf: true },
    { r: 0.44, leaf: false },
    { r: 0.5, leaf: false },
  ];
  const fruits = specs.map((s, i) => {
    const g = new THREE.Group();
    const body = new THREE.Mesh(fruitGeo, peelMat);
    body.scale.set(s.r, s.r * 0.88, s.r);
    body.rotation.y = i * 1.7;
    g.add(body);
    const stem = new THREE.Mesh(stemGeo, stemMat);
    stem.position.y = s.r * 0.88 + 0.02;
    g.add(stem);
    if (s.leaf) {
      const leaf = new THREE.Mesh(leafGeo, leafMat);
      leaf.position.set(0.02, s.r * 0.88 + 0.03, 0);
      leaf.rotation.set(0.0, i * 2.1, -0.32);
      g.add(leaf);
    }
    // 自转轴各不一样，柚子不会都朝一个方向
    g.userData = {
      r: s.r,
      x: [-1.6, 0.2, 1.7, -0.7, 1.1][i],
      z: [-0.9, -1.2, -0.4, 0.8, 1.1][i],
      vx: 0,
      vz: 0,
      spin: i * 1.3,
      spinV: (i % 2 ? 1 : -1) * 0.08,
      phase: i * 0.9,
    };
    scene.add(g);
    return g;
  });
  floorU.uFruitCount.value = fruits.length;

  // ── 后期 ──
  const P = THREE;
  const composer = new P.EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType });
  composer.addPass(new P.RenderPass(scene, camera));
  const bloom = new P.BloomEffect({ luminanceThreshold: 0.92, luminanceSmoothing: 0.22, intensity: 0.6, mipmapBlur: true, radius: 0.72 });
  const toneMap = new P.ToneMappingEffect({ mode: P.ToneMappingMode.ACES_FILMIC });
  composer.addPass(new P.EffectPass(camera, bloom, toneMap));
  if (!lite) {
    const ca = new P.ChromaticAberrationEffect({ offset: new THREE.Vector2(0.0007, 0.0005), radialModulation: true, modulationOffset: 0.3 });
    composer.addPass(new P.EffectPass(camera, ca));
  }
  const grain = new P.NoiseEffect({ premultiply: true, blendFunction: P.BlendFunction.SCREEN });
  grain.blendMode.opacity.value = 0.32;
  const vignette = new P.VignetteEffect({ offset: 0.3, darkness: 0.42 });
  const finals = lite ? [grain, vignette] : [new P.SMAAEffect({ preset: P.SMAAPreset.HIGH }), grain, vignette];
  composer.addPass(new P.EffectPass(camera, ...finals));

  // ── 尺寸与可见范围 ──
  const bounds = { x0: -3, x1: 3, z0: -2, z1: 2 };
  const raycaster = new THREE.Raycaster();
  const waterPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hit = new THREE.Vector3();
  function toWater(nx, ny) {
    raycaster.setFromCamera(new THREE.Vector2(nx, ny), camera);
    return raycaster.ray.intersectPlane(waterPlane, hit) ? hit.clone() : null;
  }
  function resize() {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, lite ? 1.25 : 1.75);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    composer.setSize(w, h, false);
    camera.aspect = w / h;
    // 竖长的画面拉远一点，横着的近一点，柚子都在框里
    camera.fov = w / h < 1 ? 34 : 29;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    // 首屏的池子是一块圆润的不规则形（CSS 圆角遮罩），四角看不到：范围取画面中间一圈
    const a = toWater(-0.62, -0.6);
    const b = toWater(0.62, -0.6);
    const c = toWater(0, 0.5);
    if (a && b && c) {
      bounds.x0 = Math.max(a.x, -4.5);
      bounds.x1 = Math.min(b.x, 4.5);
      bounds.z0 = Math.max(c.z, -4);
      bounds.z1 = Math.min(a.z, 4);
    }
  }

  // ── 指针与涟漪 ──
  const pointer = { x: 0, z: 0, on: false };
  let rippleIdx = 0;
  let t = 0;
  function local(ev) {
    const r = canvas.getBoundingClientRect();
    return toWater(((ev.clientX - r.left) / r.width) * 2 - 1, -(((ev.clientY - r.top) / r.height) * 2 - 1));
  }
  function addRipple(x, z, s) {
    ripples[rippleIdx % MAX_RIPPLES].set(x, z, t, s);
    rippleIdx++;
  }
  if (!reduce) {
    canvas.addEventListener('pointermove', (ev) => {
      const p = local(ev);
      if (!p) return;
      // 划过去也带起一点点水纹（不要太密）
      if (pointer.on && Math.hypot(p.x - pointer.x, p.z - pointer.z) > 0.9) addRipple(p.x, p.z, 0.25);
      pointer.x = p.x;
      pointer.z = p.z;
      pointer.on = true;
    });
    canvas.addEventListener('pointerleave', () => {
      pointer.on = false;
    });
    canvas.addEventListener('pointerdown', (ev) => {
      const p = local(ev);
      if (!p) return;
      addRipple(p.x, p.z, 1);
      hero.dataset.touched = 'true';
      for (const f of fruits) {
        const u = f.userData;
        const dx = u.x - p.x;
        const dz = u.z - p.z;
        const d = Math.hypot(dx, dz) || 1;
        if (d < 2.4) {
          const k = (2.4 - d) * 1.6;
          u.vx += (dx / d) * k;
          u.vz += (dz / d) * k;
          u.spinV += (Math.random() - 0.5) * 0.8;
        }
      }
    });
  }

  // ── 一步 ──
  function step(dt) {
    for (const f of fruits) {
      const u = f.userData;
      // 慢慢漂：一股很缓的水流
      u.vx += Math.sin(t * 0.21 + u.phase) * 0.012 * dt * 60 * 0.016;
      u.vz += Math.cos(t * 0.17 + u.phase * 1.3) * 0.01 * dt * 60 * 0.016;
      if (pointer.on) {
        const dx = u.x - pointer.x;
        const dz = u.z - pointer.z;
        const d = Math.hypot(dx, dz) || 1;
        const R = 1.35 + u.r;
        if (d < R) {
          const k = ((R - d) / R) * 4.2 * dt;
          u.vx += (dx / d) * k;
          u.vz += (dz / d) * k;
        }
      }
    }
    // 互相碰一碰
    for (let i = 0; i < fruits.length; i++) {
      for (let j = i + 1; j < fruits.length; j++) {
        const a = fruits[i].userData;
        const b = fruits[j].userData;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const d = Math.hypot(dx, dz) || 1e-4;
        const min = (a.r + b.r) * 1.02;
        if (d < min) {
          const push = (min - d) * 0.5;
          const nx = dx / d;
          const nz = dz / d;
          a.x -= nx * push;
          a.z -= nz * push;
          b.x += nx * push;
          b.z += nz * push;
          const rel = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
          if (rel < 0) {
            a.vx += nx * rel * 0.8;
            a.vz += nz * rel * 0.8;
            b.vx -= nx * rel * 0.8;
            b.vz -= nz * rel * 0.8;
            a.spinV += rel * 0.4;
            b.spinV -= rel * 0.4;
          }
        }
      }
    }
    const drag = Math.exp(-dt * 1.1);
    floorU.uFruits.value.forEach((v, k) => {
      const f = fruits[k];
      if (!f) return;
      const u = f.userData;
      u.x += u.vx * dt;
      u.z += u.vz * dt;
      u.vx *= drag;
      u.vz *= drag;
      u.spinV *= Math.exp(-dt * 0.6);
      u.spin += u.spinV * dt;
      // 软边界：靠近画面边缘就被轻轻推回来
      const m = u.r * 0.9;
      if (u.x < bounds.x0 + m) u.vx += (bounds.x0 + m - u.x) * 6 * dt;
      if (u.x > bounds.x1 - m) u.vx -= (u.x - (bounds.x1 - m)) * 6 * dt;
      if (u.z < bounds.z0 + m) u.vz += (bounds.z0 + m - u.z) * 6 * dt;
      if (u.z > bounds.z1 - m) u.vz -= (u.z - (bounds.z1 - m)) * 6 * dt;
      // 浮在浪上：吃水三分之一，跟着坡度歪一歪
      const h = waveJS(u.x, u.z, t, ripples);
      const e = 0.12;
      const sx = (waveJS(u.x + e, u.z, t, ripples) - h) / e;
      const sz = (waveJS(u.x, u.z + e, t, ripples) - h) / e;
      f.position.set(u.x, h + u.r * 0.88 * 0.3 + Math.sin(t * 1.3 + u.phase) * 0.012, u.z);
      f.rotation.set(sz * 0.9 + Math.sin(t * 0.7 + u.phase) * 0.05, u.spin, -sx * 0.9);
      v.set(u.x, u.z, u.r, 0);
    });
  }

  function render() {
    floorU.uTime.value = t;
    waterU.uTime.value = t;
    composer.render();
  }

  // ── 循环：看得见才动 ──
  let running = false;
  let visible = true;
  let suspended = false;
  let last = 0;
  let raf = 0;
  function frame(now) {
    raf = 0;
    if (!running) return;
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016);
    last = now;
    t += dt;
    step(dt);
    render();
    raf = requestAnimationFrame(frame);
  }
  function sync() {
    const should = !reduce && visible && !suspended && !document.hidden;
    if (should && !running) {
      running = true;
      last = 0;
      raf = requestAnimationFrame(frame);
    } else if (!should && running) {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    }
  }

  resize();
  t = 3.2;
  step(0.016);
  render();
  // 编不过的着色器在第一帧就会报：没画出东西就换回 2D
  const gl = renderer.getContext();
  if (gl.isContextLost()) throw new Error('context lost');

  hero.dataset.hero3d = 'on';
  poolCanvas.hidden = true;

  new IntersectionObserver((entries) => {
    visible = entries[0].isIntersecting;
    sync();
  }).observe(canvas);
  document.addEventListener('visibilitychange', sync);
  let rz = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(rz);
    rz = requestAnimationFrame(() => {
      resize();
      if (!running) render();
    });
  });
  canvas.addEventListener('webglcontextlost', (ev) => {
    ev.preventDefault();
    running = false;
    canvas.remove();
    poolCanvas.hidden = false;
    fallback();
  });

  // 首屏视频（main.js）放起来时整个停掉；视频出错拿掉时接着动
  window.YuzuHero = {
    suspend() {
      suspended = true;
      sync();
    },
    resume() {
      suspended = false;
      sync();
    },
  };
  if (window.YuzuHeroPendingSuspend) window.YuzuHero.suspend();
  sync();
}
