/**
 * 所有 GLSL。行星表面、太陽、星雲都是程序產生的，沒有任何貼圖檔。
 * 效能原則：雜訊的疊加層數（octave）依畫面佔比決定；全螢幕的星雲只在啟動時烤一次。
 */

const NOISE = /* glsl */ `
float hash31(vec3 p){
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vnoise(vec3 x){
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash31(i), hash31(i + vec3(1,0,0)), f.x),
        mix(hash31(i + vec3(0,1,0)), hash31(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(hash31(i + vec3(0,0,1)), hash31(i + vec3(1,0,1)), f.x),
        mix(hash31(i + vec3(0,1,1)), hash31(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p, int oct){
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    s += a * vnoise(p);
    p = p * 2.03 + vec3(1.7, 9.2, 3.1);
    a *= 0.5;
  }
  return s;
}
vec3 rotY(vec3 p, float a){
  float c = cos(a);
  float s = sin(a);
  return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
}
vec3 toDisplay(vec3 c){
  // 高光處柔和壓縮，再轉成顯示用的 gamma
  c = c / (1.0 + max(c - 0.85, 0.0) * 0.9);
  return pow(clamp(c, 0.0, 1.0), vec3(0.4545));
}
`;

export const BODY_VERT = /* glsl */ `
varying vec3 vObj;
varying vec3 vN;
varying vec3 vW;
void main(){
  vObj = position;
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

/** 行星表面。uType：0 岩石、1 氣態、2 海洋、3 冰 */
export const PLANET_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uA;
uniform vec3 uB;
uniform vec3 uC;
uniform vec3 uAtmo;
uniform float uType;
uniform float uSeed;
uniform float uSpin;
uniform float uTime;
uniform float uLightMix;
uniform float uDim;
uniform float uHover;
uniform int uOct;
uniform vec3 uSunDir;
uniform vec3 uPhaseDir;
varying vec3 vObj;
varying vec3 vN;
varying vec3 vW;
${NOISE}
void main(){
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vW);
  vec3 L = normalize(mix(uSunDir, uPhaseDir, uLightMix));
  vec3 p = rotY(normalize(vObj), uSpin);
  vec3 q = p * 2.2 + uSeed;
  vec3 alb;
  float spec = 0.0;
  float cloud = 0.0;

  if (uType < 0.5) {
    float n = fbm(q * 1.3, uOct);
    float m = fbm(q * 3.1 + n * 1.5, uOct);
    alb = mix(uA, uB, smoothstep(0.35, 0.7, n));
    alb = mix(alb, uC, smoothstep(0.5, 0.8, m) * 0.65);
    float ridge = abs(vnoise(q * 4.3) - 0.5) * 2.0;
    alb *= 0.74 + 0.26 * smoothstep(0.0, 0.35, ridge);
  } else if (uType < 1.5) {
    float t = fbm(q * vec3(1.0, 0.35, 1.0) * 1.2, uOct);
    float lat = p.y * 5.5 + (t - 0.5) * 2.4 + sin(p.y * 17.0 + uSeed) * 0.15;
    float band = sin(lat * 3.14159) * 0.5 + 0.5;
    alb = mix(uA, uB, band);
    float storm = fbm(q * vec3(2.0, 6.0, 2.0) + t * 2.0, uOct);
    alb = mix(alb, uC, smoothstep(0.58, 0.92, storm) * 0.55);
  } else if (uType < 2.5) {
    float n = fbm(q * 1.15, uOct);
    float land = smoothstep(0.5, 0.56, n + (fbm(q * 4.0, 3) - 0.5) * 0.18);
    vec3 ocean = mix(uA * 0.5, uA, smoothstep(0.3, 0.5, n));
    vec3 ground = mix(uB, uC, smoothstep(0.5, 0.8, fbm(q * 2.7 + 4.0, 3)));
    alb = mix(ocean, ground, land);
    float ice = smoothstep(0.72, 0.86, abs(p.y) + (n - 0.5) * 0.25);
    alb = mix(alb, vec3(0.9, 0.94, 0.98), ice);
    spec = (1.0 - land) * (1.0 - ice);
    vec3 cp = rotY(p, uTime * 0.012) * 3.1 + uSeed * 1.7;
    cloud = smoothstep(0.52, 0.78, fbm(cp, uOct));
  } else {
    float n = fbm(q * 1.6, uOct);
    float crack = 1.0 - smoothstep(0.0, 0.07, abs(vnoise(q * 3.0) - 0.5));
    alb = mix(uA, uB, n);
    alb = mix(alb, uC, crack * 0.7);
    spec = 0.3;
  }

  float d = dot(N, L);
  // 晨昏線：不是硬邊，有一段薄暮
  float lit = smoothstep(mix(-0.16, -0.03, uLightMix), mix(0.32, 0.2, uLightMix), d);
  vec3 col = alb * (lit * 1.1 + mix(0.055, 0.014, uLightMix));
  col = mix(col, vec3(lit * 1.02 + 0.02), cloud * 0.72);
  vec3 H = normalize(L + V);
  col += spec * pow(max(dot(N, H), 0.0), 56.0) * lit * vec3(1.0, 0.94, 0.84) * 0.9;

  // 大氣邊緣：只有受光的那一側亮
  float fres = pow(1.0 - max(dot(N, V), 0.0), 3.2);
  float rimLit = smoothstep(-0.35, 0.35, d);
  col += uAtmo * fres * (rimLit * 0.85 + 0.035) * (1.0 + uHover * 0.9);

  col *= mix(1.0, 0.022, uDim);
  gl_FragColor = vec4(toDisplay(col), 1.0);
}
`;

/** 大氣外殼：畫球的背面，只有超出行星輪廓的那一圈會露出來 */
export const ATMO_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uAtmo;
uniform float uLightMix;
uniform float uDim;
uniform float uHover;
uniform vec3 uSunDir;
uniform vec3 uPhaseDir;
varying vec3 vN;
varying vec3 vW;
void main(){
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vW);
  vec3 L = normalize(mix(uSunDir, uPhaseDir, uLightMix));
  float g = smoothstep(0.0, 0.5, -dot(N, V));
  g = pow(g, 1.8);
  float sun = smoothstep(-0.45, 0.55, dot(N, L));
  float a = g * (sun * 0.9 + 0.03) * (0.55 + uHover * 0.5) * mix(1.0, 0.08, uDim);
  gl_FragColor = vec4(uAtmo * a, a);
}
`;

export const SUN_FRAG = /* glsl */ `
precision highp float;
uniform float uTime;
uniform float uGain;
uniform vec3 uTint;
varying vec3 vObj;
varying vec3 vN;
varying vec3 vW;
${NOISE}
void main(){
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vW);
  vec3 p = normalize(vObj) * 2.4;
  float warp = fbm(p * 1.7 - uTime * 0.02, 3);
  float n = fbm(p + vec3(0.0, uTime * 0.03, 0.0) + warp * 0.9, 4);
  float cells = vnoise(p * 7.0 + uTime * 0.05);
  float heat = n * 0.75 + cells * 0.25;
  float mu = max(dot(N, V), 0.0);
  float limb = 0.5 + 0.5 * pow(mu, 0.45);
  vec3 c = mix(vec3(1.0, 0.4, 0.07), vec3(1.0, 0.8, 0.42), smoothstep(0.3, 0.7, heat));
  c = mix(c, vec3(1.0, 0.97, 0.9), smoothstep(0.62, 0.9, heat));
  c *= limb * 1.3 * uGain * uTint;
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

export const BILLBOARD_VERT = /* glsl */ `
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * 日冕，以及環繞太陽的計時弧。
 * 計時弧畫在這裡而不是另開一個物件：同一張面片、同一次繪製。
 */
export const CORONA_FRAG = /* glsl */ `
precision highp float;
uniform float uTime;
uniform float uGain;
uniform vec3 uTint;
uniform float uR0;
uniform float uArc;
uniform float uProgress;
uniform vec3 uArcColor;
varying vec2 vUv;
void main(){
  vec2 c = vUv * 2.0 - 1.0;
  float r = length(c);
  float x = max(r - uR0, 0.0);
  float g = exp(-x * 9.0) * 0.85 + exp(-x * 3.2) * 0.2 + exp(-x * 1.3) * 0.05;
  float a = atan(c.y, c.x);
  float rays = 0.5 + 0.5 * sin(a * 9.0 + uTime * 0.05 + sin(a * 4.0 - uTime * 0.03) * 2.0);
  rays = mix(1.0, rays, smoothstep(uR0, uR0 + 0.45, r) * 0.32);
  float fade = smoothstep(1.0, 0.5, r);
  vec3 col = vec3(1.0, 0.7, 0.36) * uTint * g * rays * fade * uGain;

  // 計時弧：從正上方順時針走
  float R1 = uR0 * 1.62;
  float w = 0.0045;
  float ring = smoothstep(w * 2.2, w * 0.4, abs(r - R1));
  float t = fract(atan(c.x, c.y) / 6.2831853);
  float on = step(t, uProgress);
  float tick = smoothstep(0.022, 0.0, abs(fract(t * 60.0) - 0.5) - 0.46);
  float tickBand = smoothstep(0.016, 0.006, abs(r - (R1 + 0.022)));
  vec3 arc = uArcColor * (ring * mix(0.14, 1.0, on) + tick * tickBand * 0.22);
  col += arc * uArc;

  float alpha = clamp(max(col.r, max(col.g, col.b)), 0.0, 1.0);
  gl_FragColor = vec4(col, alpha);
}
`;

export const RING_VERT = /* glsl */ `
varying vec2 vLocal;
varying vec3 vW;
void main(){
  vLocal = position.xy;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

/** 行星環：做完幾顆番茄就有幾道。行星落在環上的影子是解析算出來的，不用陰影貼圖 */
export const RING_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uColor;
uniform float uBands;
uniform float uInner;
uniform float uBandW;
uniform float uGap;
uniform vec3 uCenter;
uniform float uPlanetR;
uniform float uLightMix;
uniform float uDim;
uniform vec3 uSunDir;
uniform vec3 uPhaseDir;
varying vec2 vLocal;
varying vec3 vW;
void main(){
  float r = length(vLocal);
  float k = (r - uInner) / (uBandW + uGap);
  float idx = floor(k);
  if (k < 0.0 || idx >= uBands) discard;
  float f = fract(k) * (uBandW + uGap);
  float aa = fwidth(r) * 1.5;
  float band = smoothstep(0.0, aa, f) * smoothstep(uBandW, uBandW - aa, f);
  if (band < 0.01) discard;

  vec3 L = normalize(mix(uSunDir, uPhaseDir, uLightMix));
  vec3 rel = vW - uCenter;
  float along = dot(rel, L);
  float miss = length(rel - along * L);
  float shadow = along < 0.0 ? smoothstep(uPlanetR * 0.92, uPlanetR * 1.04, miss) : 1.0;

  float grain = 0.84 + 0.16 * sin(r * 70.0);
  vec3 col = uColor * grain * (0.16 + 0.84 * shadow);
  float a = band * 0.86 * mix(1.0, 0.1, uDim);
  gl_FragColor = vec4(pow(col, vec3(0.4545)) * a, a);
}
`;

/**
 * 專注時繞著行星的月亮軌道，畫成一只細琉璃鐲子：一圈是一顆番茄。
 * 幾何是一個圓環體（torus）。管子的粗細在頂點 shader 裡重設，
 * 所以不管軌道半徑多大，鐲子在畫面上都是一樣細。
 */
export const BANGLE_VERT = /* glsl */ `
uniform float uTube;
varying vec3 vN;
varying vec3 vW;
varying vec2 vXY;
void main(){
  // 管子的中心線在半徑 1 的圓上；把頂點相對中心線的偏移縮放成想要的粗細
  vec3 c = vec3(normalize(position.xy), 0.0);
  vec3 p = c + (position - c) * (uTube / 0.01);
  vXY = position.xy;
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 w = modelMatrix * vec4(p, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

/**
 * 琉璃的本體。玻璃幾乎是透明的：正對視線的地方只留一點點顏色，
 * 看得到的是邊緣的反光（Fresnel）與一道很小的高光。
 * 走過的部分帶一點暖色、管心有一絲光；還沒走的是極淡的冷色。每分鐘留一道細縫。
 */
export const BANGLE_FRAG = /* glsl */ `
precision highp float;
uniform float uProgress;
uniform float uTicks;
uniform float uStart;
uniform float uDir;
uniform float uAlpha;
uniform float uMoonGap;
uniform vec3 uLightDir;
varying vec3 vN;
varying vec3 vW;
varying vec2 vXY;
void main(){
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vW);
  float ndv = abs(dot(N, V));
  float fres = pow(1.0 - ndv, 1.6);
  float t = fract(uDir * (atan(vXY.y, vXY.x) - uStart) / 6.2831853);
  float done = step(t, uProgress);
  float toTick = abs(fract(t * uTicks + 0.5) - 0.5) / uTicks * 6.2831853;
  float gap = smoothstep(0.011, 0.017, toTick);
  // 離月亮多遠（弧度）；太近的地方不畫，軌道不穿過月亮
  float dm = abs(t - uProgress);
  dm = min(dm, 1.0 - dm) * 6.2831853;
  float clearMoon = smoothstep(uMoonGap, uMoonGap * 1.3, dm);

  vec3 tint = mix(vec3(0.78, 0.9, 1.0), vec3(1.0, 0.8, 0.5), done);
  float spec = pow(max(dot(N, normalize(normalize(uLightDir) + V)), 0.0), 90.0);
  float core = pow(ndv, 5.0) * done;
  float a = (mix(0.035, 0.15, done) + fres * mix(0.3, 0.5, done) + core * 0.28) * gap + spec * 0.8;
  vec3 col = tint * (0.9 + fres * 0.5 + core * 0.8) + vec3(spec);
  a = clamp(a, 0.0, 1.0) * uAlpha * clearMoon;
  gl_FragColor = vec4(col * a, a);
}
`;

/** 原本的細線：一分鐘一段，段與段之間留縫；走過的段比較亮也比較粗 */
export const MOON_ORBIT_FRAG = /* glsl */ `
precision highp float;
uniform float uProgress;
uniform float uTicks;
uniform float uStart;
uniform float uDir;
uniform vec3 uColor;
uniform float uAlpha;
uniform float uMoonGap;
varying vec2 vLocal;
void main(){
  float r = length(vLocal);
  float aa = fwidth(r);
  float t = fract(uDir * (atan(vLocal.y, vLocal.x) - uStart) / 6.2831853);
  float done = step(t, uProgress);
  // 離月亮多遠（弧度）；太近的地方不畫，軌道不穿過月亮
  float dm = abs(t - uProgress);
  dm = min(dm, 1.0 - dm) * 6.2831853;
  float clearMoon = smoothstep(uMoonGap, uMoonGap * 1.3, dm);
  float w = mix(0.7, 1.5, done);
  float line = 1.0 - smoothstep(aa * w, aa * (w + 1.0), abs(r - 1.0));
  float arc = abs(fract(t * uTicks + 0.5) - 0.5) / uTicks * 6.2831853 * r;
  float seg = smoothstep(0.012, 0.012 + fwidth(arc) * 1.5, arc);
  float a = line * seg * mix(0.3, 1.0, done) * uAlpha * clearMoon;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor * a, a);
}
`;

/** 鐲子外面那層淡淡的光暈：一個比較粗的圓環體，中心線最亮、往外淡出，用加色疊上去 */
export const BANGLE_GLOW_FRAG = /* glsl */ `
precision highp float;
uniform float uProgress;
uniform float uStart;
uniform float uDir;
uniform float uAlpha;
uniform float uGlow;
uniform float uMoonGap;
varying vec3 vN;
varying vec3 vW;
varying vec2 vXY;
void main(){
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vW);
  float core = pow(abs(dot(N, V)), 3.0);
  float t = fract(uDir * (atan(vXY.y, vXY.x) - uStart) / 6.2831853);
  float done = step(t, uProgress);
  // 離月亮多遠（弧度）；太近的地方不畫，軌道不穿過月亮
  float dm = abs(t - uProgress);
  dm = min(dm, 1.0 - dm) * 6.2831853;
  float clearMoon = smoothstep(uMoonGap, uMoonGap * 1.3, dm);
  vec3 c = mix(vec3(0.5, 0.66, 0.95) * 0.07, vec3(1.0, 0.7, 0.38) * 0.2, done);
  gl_FragColor = vec4(c * core * uAlpha * uGlow * clearMoon, 1.0);
}
`;

/** 軌道線：行星後方拖著一段亮尾；游標靠近時被重力拉彎 */
export const ORBIT_VERT = /* glsl */ `
attribute float aAngle;
uniform float uRadius;
uniform vec2 uCursor;
uniform float uPull;
varying float vAngle;
void main(){
  vAngle = aAngle;
  vec3 p = vec3(cos(aAngle), 0.0, sin(aAngle)) * uRadius;
  vec2 d = uCursor - p.xz;
  float w = uPull * exp(-dot(d, d) / 2.6);
  p.xz += d * w;
  p.y -= w * 0.9;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

export const ORBIT_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uColor;
uniform float uPlanetAngle;
uniform float uBase;
uniform float uDash;
uniform float uDim;
uniform float uFade;
varying float vAngle;
void main(){
  float behind = mod(uPlanetAngle - vAngle, 6.2831853);
  float trail = exp(-behind * 1.5);
  // 還沒動過的待辦是虛線，做過至少一顆的是實線
  float dash = mix(1.0, step(0.5, fract(vAngle * 28.0)), uDash);
  float a = (uBase + trail * 0.6) * dash * mix(1.0, 0.1, uDim) * uFade;
  vec3 col = mix(vec3(0.62, 0.68, 0.8), uColor, 0.35 + trail * 0.65);
  gl_FragColor = vec4(col * a, a);
}
`;

export const STARS_VERT = /* glsl */ `
attribute float aSize;
attribute vec3 aColor;
attribute float aPhase;
uniform float uPx;
uniform float uTime;
uniform float uTwinkle;
varying vec3 vC;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float ph = fract(abs(aPhase));
  float tw = 1.0 + uTwinkle * 0.3 * sin(uTime * (0.6 + ph * 1.7) + ph * 40.0);
  // aPhase 大於 1 的是星座的星：aPhase-1 是它出生的時刻，出生時從大縮到定位
  float born = aPhase > 1.0 ? clamp((uTime - (aPhase - 1.0)) / 1.2, 0.0, 1.0) : 1.0;
  float pop = 1.0 + (1.0 - born) * (1.0 - born) * 3.0;
  gl_PointSize = aSize * uPx * tw * pop;
  vC = aColor * (aPhase > 1.0 ? born : 1.0);
}
`;

export const STARS_FRAG = /* glsl */ `
precision highp float;
varying vec3 vC;
void main(){
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d) * 2.0;
  float a = smoothstep(1.0, 0.0, r);
  a = a * (0.55 + 2.2 * smoothstep(0.5, 0.0, r));
  gl_FragColor = vec4(vC * a, a);
}
`;

/** 星雲與銀河：只在啟動時畫進一張立方體貼圖，之後每幀只是取樣 */
export const SKY_FRAG = /* glsl */ `
precision highp float;
varying vec3 vObj;
${NOISE}
void main(){
  vec3 d = normalize(vObj);
  vec3 gn = normalize(vec3(0.45, 0.74, -0.5));
  float off = dot(d, gn);
  float band = exp(-off * off * 11.0);
  float dust = fbm(d * 2.2 + 2.0, 4);
  float lanes = fbm(d * 4.2 + 7.0, 4);
  float mw = band * (0.25 + 0.75 * dust) * smoothstep(0.3, 0.75, lanes + 0.2 * band);
  vec3 base = mix(vec3(0.0035, 0.005, 0.012), vec3(0.006, 0.009, 0.022), d.y * 0.5 + 0.5);
  vec3 col = base;
  col += mw * vec3(0.042, 0.05, 0.085);
  col += band * dust * dust * vec3(0.03, 0.017, 0.012);
  float cloud = smoothstep(0.5, 0.9, fbm(d * 1.5 + 11.0, 4));
  col += cloud * vec3(0.004, 0.012, 0.024);
  float ember = smoothstep(0.58, 0.92, fbm(d * 1.2 + 31.0, 4)) * (1.0 - band);
  col += ember * vec3(0.016, 0.005, 0.011);
  col += (hash31(d * 913.0) - 0.5) / 255.0 * 0.9;
  gl_FragColor = vec4(pow(max(col, 0.0), vec3(0.4545)), 1.0);
}
`;

/** 把烤好的星雲貼到跟著鏡頭走的天球上 */
export const SKYBOX_FRAG = /* glsl */ `
precision highp float;
uniform samplerCube uSky;
uniform float uGain;
varying vec3 vObj;
void main(){
  gl_FragColor = vec4(textureCube(uSky, normalize(vObj)).rgb * uGain, 1.0);
}
`;

/** 刻度盤、今日紀錄的弧、星座連線：單色、可調透明度 */
export const FLAT_VERT = /* glsl */ `
attribute float aBirth;
uniform float uTime;
varying float vBorn;
void main(){
  vBorn = aBirth > 0.0 ? clamp((uTime - aBirth - 0.9) / 1.0, 0.0, 1.0) : 1.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const FLAT_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uColor;
uniform float uAlpha;
varying float vBorn;
void main(){
  float a = uAlpha * vBorn;
  gl_FragColor = vec4(uColor * a, a);
}
`;
