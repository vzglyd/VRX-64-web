/**
 * renderer.js — WebGPU renderer for vzglyd slide preview.
 *
 * Matches the native engine's shader contract, bind group layout,
 * vertex buffer layout, and uniform buffer layout exactly.
 */

import {
  decodeRuntimeMeshSet,
  decodeRuntimeOverlayBytes,
  packIndices,
  packVertices,
} from './postcard.js';


// ── Shader preludes (verbatim from src/shader_validation.rs) ─────────────────

const SCREEN2D_PRELUDE = `// VZGLYD shader contract v1: Screen2D
const VZGLYD_SHADER_CONTRACT_VERSION: u32 = 1u;

struct VzglydVertexInput {
    @location(0) position:   vec3<f32>,
    @location(1) tex_coords: vec2<f32>,
    @location(2) color:      vec4<f32>,
    @location(3) mode:       f32,
};

struct VzglydVertexOutput {
    @builtin(position) clip_pos: vec4<f32>,
    @location(0) tex_coords: vec2<f32>,
    @location(1) color:      vec4<f32>,
    @location(2) mode:       f32,
};

struct VzglydUniforms {
    time:  f32,
    _pad0: f32,
    _pad1: f32,
    _pad2: f32,
};

@group(0) @binding(0) var t_diffuse: texture_2d<f32>;
@group(0) @binding(1) var t_font:    texture_2d<f32>;
@group(0) @binding(2) var t_detail:  texture_2d<f32>;
@group(0) @binding(3) var t_lookup:  texture_2d<f32>;
@group(0) @binding(4) var s_diffuse: sampler;
@group(0) @binding(5) var s_font:    sampler;
@group(0) @binding(6) var<uniform> u: VzglydUniforms;
`;

const WORLD3D_PRELUDE = `// VZGLYD shader contract v1: World3D
const VZGLYD_SHADER_CONTRACT_VERSION: u32 = 1u;

struct VzglydVertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal:   vec3<f32>,
    @location(2) color:    vec4<f32>,
    @location(3) mode:     f32,
};

struct VzglydVertexOutput {
    @builtin(position) clip_pos: vec4<f32>,
    @location(0) world_pos: vec3<f32>,
    @location(1) normal:    vec3<f32>,
    @location(2) color:     vec4<f32>,
    @location(3) mode:      f32,
};

struct VzglydUniforms {
    view_proj:        mat4x4<f32>,
    cam_pos:          vec3<f32>,
    time:             f32,
    fog_color:        vec4<f32>,
    fog_start:        f32,
    fog_end:          f32,
    clock_seconds:    f32,
    _pad:             f32,
    ambient_light:    vec4<f32>,
    main_light_dir:   vec4<f32>,
    main_light_color: vec4<f32>,
};

@group(0) @binding(0) var<uniform> u:          VzglydUniforms;
@group(0) @binding(1) var t_font:              texture_2d<f32>;
@group(0) @binding(2) var t_noise:             texture_2d<f32>;
@group(0) @binding(3) var t_material_a:        texture_2d<f32>;
@group(0) @binding(4) var t_material_b:        texture_2d<f32>;
@group(0) @binding(5) var s_clamp:             sampler;
@group(0) @binding(6) var s_repeat:            sampler;

fn vzglyd_ambient_light() -> vec3<f32> { return u.ambient_light.rgb; }

fn vzglyd_main_light_dir() -> vec3<f32> {
    let dir = u.main_light_dir.xyz;
    let len_sq = dot(dir, dir);
    if len_sq <= 0.000001 { return vec3<f32>(0.0, 1.0, 0.0); }
    return normalize(dir);
}

fn vzglyd_main_light_rgb() -> vec3<f32> { return u.main_light_color.rgb; }

fn vzglyd_main_light_strength() -> f32 {
    return max(max(u.main_light_color.r, u.main_light_color.g), u.main_light_color.b);
}

fn vzglyd_direct_light_scale() -> f32 {
    let ambient = vzglyd_ambient_light();
    return max(1.0 - max(max(ambient.r, ambient.g), ambient.b), 0.0);
}

fn vzglyd_main_light_screen_uv() -> vec2<f32> {
    let dir = vzglyd_main_light_dir();
    return clamp(
        vec2<f32>(0.5 + dir.x * 0.22, 0.5 - dir.y * 0.30),
        vec2<f32>(0.05, 0.05),
        vec2<f32>(0.95, 0.95),
    );
}
`;

// ── Default shader bodies (used when the slide provides none) ─────────────────
//
// textureSample() requires uniform control flow (WGSL spec §16.7).
// Our fragment shaders branch on the per-fragment `in.mode` varying, so every
// textureSample inside a conditional is non-uniform.  We use textureSampleLevel
// with explicit LOD 0.0 everywhere — it has no derivative restriction and
// produces identical output at the base mip level.

const SCREEN2D_DEFAULT_BODY = `
@vertex
fn vs_main(in: VzglydVertexInput) -> VzglydVertexOutput {
    var out: VzglydVertexOutput;
    out.clip_pos   = vec4<f32>(in.position.xy, 0.0, 1.0);
    out.tex_coords = in.tex_coords;
    out.color      = in.color;
    out.mode       = in.mode;
    return out;
}

@fragment
fn fs_main(in: VzglydVertexOutput) -> @location(0) vec4<f32> {
    if in.mode > 0.5 {
        return textureSampleLevel(t_font, s_font, in.tex_coords, 0.0) * in.color;
    }
    return textureSampleLevel(t_diffuse, s_diffuse, in.tex_coords, 0.0) * in.color;
}
`;

// World3D default body — adapted from src/imported_scene_shader.wgsl.
// All textureSample calls replaced with textureSampleLevel(..., 0.0) so the
// shader compiles under WebGPU's strict uniform-control-flow validation.
const WORLD3D_DEFAULT_BODY = `
@vertex
fn vs_main(in: VzglydVertexInput) -> VzglydVertexOutput {
    var out: VzglydVertexOutput;
    out.clip_pos  = u.view_proj * vec4<f32>(in.position, 1.0);
    out.world_pos = in.position;
    out.normal    = normalize(in.normal);
    out.color     = in.color;
    out.mode      = in.mode;
    return out;
}

fn apply_fog(rgb: vec3<f32>, world_pos: vec3<f32>) -> vec3<f32> {
    let dist  = length(world_pos - u.cam_pos);
    let t     = clamp((dist - u.fog_start) / (u.fog_end - u.fog_start), 0.0, 1.0);
    let fog_f = t * t * (3.0 - 2.0 * t);
    return mix(rgb, u.fog_color.rgb, fog_f);
}

fn sky_at(_dir: vec3<f32>) -> vec3<f32> { return vec3<f32>(0.0, 0.0, 0.0); }

fn surface_pattern(world_pos: vec3<f32>) -> vec3<f32> {
    let uv_a = world_pos.xz * 0.065;
    let uv_b = world_pos.xz * 0.025 + vec2<f32>(11.3, 7.1);
    let a = textureSampleLevel(t_material_a, s_repeat, uv_a, 0.0).rgb;
    let b = textureSampleLevel(t_material_b, s_repeat, uv_b, 0.0).rgb;
    return mix(a, b, 0.45);
}

fn lit_surface(base_color: vec4<f32>, normal: vec3<f32>, world_pos: vec3<f32>) -> vec4<f32> {
    let view_dir  = normalize(u.cam_pos - world_pos);
    let light_dir = vzglyd_main_light_dir();
    let diff  = max(dot(normal, light_dir), 0.0);
    let rim   = pow(1.0 - max(dot(normal, view_dir), 0.0), 2.0) * 0.12;
    let light = vzglyd_ambient_light() + vzglyd_main_light_rgb() * diff * vzglyd_direct_light_scale();
    let albedo = base_color.rgb * mix(vec3<f32>(0.88, 0.90, 0.94), surface_pattern(world_pos), 0.20);
    return vec4<f32>(apply_fog(albedo * light + rim * (0.10 + vzglyd_main_light_strength() * 0.02), world_pos), base_color.a);
}

@fragment
fn fs_main(in: VzglydVertexOutput) -> @location(0) vec4<f32> {
    let material_mode = in.mode;
    let base = in.color;

    if material_mode >= 3.5 {
        let uv0 = in.world_pos.xz * 0.06 + vec2<f32>(u.time * 0.030, -u.time * 0.021);
        let uv1 = in.world_pos.xz * 0.11 + vec2<f32>(-u.time * 0.014, u.time * 0.018);
        let n0 = textureSampleLevel(t_material_a, s_repeat, uv0, 0.0).rg * 2.0 - 1.0;
        let n1 = textureSampleLevel(t_material_b, s_repeat, uv1, 0.0).rg * 2.0 - 1.0;
        let water_n  = normalize(vec3<f32>((n0.x + n1.x) * 0.45, 1.0, (n0.y + n1.y) * 0.45));
        let view_dir = normalize(u.cam_pos - in.world_pos);
        let fresnel  = pow(1.0 - max(dot(water_n, view_dir), 0.0), 3.0);
        let refl_col = sky_at(reflect(-view_dir, water_n));
        let water_base = mix(base.rgb, surface_pattern(in.world_pos), 0.35);
        let water_col  = mix(water_base, refl_col, clamp(fresnel * 0.8 + 0.15, 0.0, 1.0));
        return vec4<f32>(apply_fog(water_col, in.world_pos), max(base.a, 0.45));
    }

    var shaded = lit_surface(base, in.normal, in.world_pos);
    if material_mode >= 2.5 {
        let pulse    = 0.65 + 0.35 * sin(u.time * 1.6);
        let emissive = base.rgb * (1.10 + pulse);
        return vec4<f32>(apply_fog(emissive, in.world_pos), base.a);
    }
    if material_mode >= 1.5 { shaded.a = base.a * 0.55; return shaded; }
    if material_mode >= 0.5 {
        if base.a < 0.5 { discard; }
        shaded.a = 1.0;
        return shaded;
    }
    return shaded;
}
`;

// ── Matrix math (column-major, WebGPU convention) ─────────────────────────────

function mat4MulInto(out, a, b) {
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

/** Standard perspective projection (right-handed, depth 0..1). */
function mat4PerspectiveInto(out, fovYRad, aspect, near, far) {
  const f = 1.0 / Math.tan(fovYRad / 2);
  const nf = 1 / (near - far);
  out[0] = f / aspect;
  out[1] = 0;
  out[2] = 0;
  out[3] = 0;
  out[4] = 0;
  out[5] = f;
  out[6] = 0;
  out[7] = 0;
  out[8] = 0;
  out[9] = 0;
  out[10] = far * nf;
  out[11] = -1;
  out[12] = 0;
  out[13] = 0;
  out[14] = (far * near) * nf;
  out[15] = 0;
  return out;
}

/** Standard lookAt view matrix (right-handed). */
function mat4LookAtInto(out, eye, center, up) {
  const [ex, ey, ez] = eye;
  const [cx, cy, cz] = center;
  const [ux, uy, uz] = up;

  let fx = cx - ex, fy = cy - ey, fz = cz - ez;
  const fl = Math.hypot(fx, fy, fz);
  fx /= fl; fy /= fl; fz /= fl;

  let sx = fy * uz - fz * uy, sy = fz * ux - fx * uz, sz = fx * uy - fy * ux;
  const sl = Math.hypot(sx, sy, sz);
  sx /= sl; sy /= sl; sz /= sl;

  const rx = sy * fz - sz * fy, ry = sz * fx - sx * fz, rz = sx * fy - sy * fx;

  out[0] = sx;
  out[1] = rx;
  out[2] = -fx;
  out[3] = 0;
  out[4] = sy;
  out[5] = ry;
  out[6] = -fy;
  out[7] = 0;
  out[8] = sz;
  out[9] = rz;
  out[10] = -fz;
  out[11] = 0;
  out[12] = -(sx * ex + sy * ey + sz * ez);
  out[13] = -(rx * ex + ry * ey + rz * ez);
  out[14] = fx * ex + fy * ey + fz * ez;
  out[15] = 1;
  return out;
}

function setVec3(out, src) {
  out[0] = src[0];
  out[1] = src[1];
  out[2] = src[2];
  return out;
}

function normalize3Into(out, x, y, z) {
  const len = Math.hypot(x, y, z);
  if (len === 0) {
    out[0] = 0;
    out[1] = 1;
    out[2] = 0;
    return out;
  }
  out[0] = x / len;
  out[1] = y / len;
  out[2] = z / len;
  return out;
}

function lerp(a, b, t) { return a + (b - a) * t; }

// ── Local clock helper ────────────────────────────────────────────────────────

function localClockSeconds(nowMs) {
  if (!Number.isFinite(nowMs)) {
    return 0;
  }
  const d = new Date(nowMs);
  return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000;
}

// ── Texture helpers ───────────────────────────────────────────────────────────

function wrapModeToGPU(mode) {
  return mode === 'Repeat' ? 'repeat' : 'clamp-to-edge';
}

function filterModeToGPU(mode) {
  return mode === 'Nearest' ? 'nearest' : 'linear';
}

/** Upload a TextureDesc (from postcard) as a GPUTexture and return a GPUTextureView. */
function uploadTextureDesc(device, queue, desc) {
  const tex = device.createTexture({
    label: desc.label,
    size:  [desc.width, desc.height, 1],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  queue.writeTexture(
    { texture: tex },
    desc.data,
    { bytesPerRow: desc.width * 4 },
    [desc.width, desc.height],
  );
  return tex.createView();
}

/** Upload raw RGBA8 pixel data as a GPUTextureView. */
function uploadRawTexture(device, queue, width, height, pixels, label) {
  const tex = device.createTexture({
    label,
    size:   [width, height, 1],
    format: 'rgba8unorm',
    usage:  GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  queue.writeTexture(
    { texture: tex },
    pixels,
    { bytesPerRow: width * 4 },
    [width, height],
  );
  return tex.createView();
}

/** Create a 1×1 white fallback texture view. */
function create1x1Texture(device, queue, r = 255, g = 255, b = 255, a = 255) {
  return uploadRawTexture(device, queue, 1, 1, new Uint8Array([r, g, b, a]), 'fallback_1x1');
}

function createSamplerFromDesc(device, desc) {
  return device.createSampler({
    addressModeU:  wrapModeToGPU(desc.wrap_u),
    addressModeV:  wrapModeToGPU(desc.wrap_v),
    addressModeW:  wrapModeToGPU(desc.wrap_w),
    magFilter:     filterModeToGPU(desc.mag_filter),
    minFilter:     filterModeToGPU(desc.min_filter),
    mipmapFilter:  filterModeToGPU(desc.mip_filter),
  });
}

// ── HUD overlay shader ────────────────────────────────────────────────────────
//
// Matches the OverlayVertex layout produced by vzglyd_kernel::overlay:
//   offset  0: position vec2<f32>  (8 bytes)
//   offset  8: uv       vec2<f32>  (8 bytes)
//   offset 16: color    vec4<f32>  (16 bytes)
//   offset 32: mode     f32        (4 bytes)
//   offset 36: _pad     f32        (4 bytes — alignment, not read by shader)
//   stride: 40 bytes
//
// mode < 0.5 → solid colour quad
// mode >= 0.5 → font-atlas glyph (samples red channel for alpha)

const HUD_SHADER_SRC = `
struct HudVertex {
    @location(0) position: vec2<f32>,
    @location(1) uv:       vec2<f32>,
    @location(2) color:    vec4<f32>,
    @location(3) mode:     f32,
};

struct HudVaryings {
    @builtin(position) clip_pos: vec4<f32>,
    @location(0) uv:    vec2<f32>,
    @location(1) color: vec4<f32>,
    @location(2) mode:  f32,
};

@group(0) @binding(0) var hud_atlas:   texture_2d<f32>;
@group(0) @binding(1) var hud_sampler: sampler;

@vertex
fn vs_main(v: HudVertex) -> HudVaryings {
    var out: HudVaryings;
    out.clip_pos = vec4<f32>(v.position, 0.0, 1.0);
    out.uv       = v.uv;
    out.color    = v.color;
    out.mode     = v.mode;
    return out;
}

@fragment
fn fs_main(in: HudVaryings) -> @location(0) vec4<f32> {
    // textureSample must be in uniform control flow, so always sample and blend:
    // solid quads (mode < 0.5) use color.a directly; glyph quads use atlas red.
    let atlas_r = textureSample(hud_atlas, hud_sampler, in.uv).r;
    let t = step(0.5, in.mode); // 0.0 for solid, 1.0 for glyph
    let alpha = mix(in.color.a, in.color.a * atlas_r, t);
    return vec4<f32>(in.color.rgb, alpha);
}
`;

// ── Vertex / index buffer helpers ─────────────────────────────────────────────

function createVertexBuffer(device, floatData, label) {
  const buf = device.createBuffer({
    label,
    size:  floatData.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buf, 0, floatData);
  return buf;
}

function createIndexBuffer(device, uint16Data, label) {
  const buf = device.createBuffer({
    label,
    size:  Math.ceil(uint16Data.byteLength / 4) * 4, // 4-byte alignment
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buf, 0, uint16Data);
  return buf;
}

function createStaticMeshBuffers(device, meshes, sceneSpace, labelPrefix) {
  return meshes.map((mesh, index) => {
    const verts = packVertices(mesh.vertices, sceneSpace);
    const indices = packIndices(mesh.indices);
    return {
      vertex: createVertexBuffer(device, verts, `${labelPrefix}_vertex_${index}`),
      index: createIndexBuffer(device, indices, `${labelPrefix}_index_${index}`),
      indexCount: indices.length,
    };
  });
}

// ── Camera interpolation ──────────────────────────────────────────────────────

const DEFAULT_CAMERA_SAMPLE = {
  position: [0, 1, 3],
  target: [0, 0, 0],
  up: [0, 1, 0],
  fov_y_deg: 60,
};

function copyCameraSample(out, sample) {
  setVec3(out.position, sample.position);
  setVec3(out.target, sample.target);
  setVec3(out.up, sample.up);
  out.fov_y_deg = sample.fov_y_deg;
  return out;
}

function sampleCameraInto(out, cameraPath, elapsed) {
  if (!cameraPath || cameraPath.keyframes.length === 0) {
    return copyCameraSample(out, DEFAULT_CAMERA_SAMPLE);
  }

  const kf = cameraPath.keyframes;
  let t = elapsed;

  if (cameraPath.looped && kf.length >= 2) {
    const duration = kf[kf.length - 1].time;
    if (duration > 0) t = t % duration;
  } else {
    t = Math.min(t, kf[kf.length - 1].time);
  }

  if (t <= kf[0].time) return copyCameraSample(out, kf[0]);
  if (t >= kf[kf.length - 1].time) return copyCameraSample(out, kf[kf.length - 1]);

  for (let i = 0; i < kf.length - 1; i++) {
    const a = kf[i], b = kf[i + 1];
    if (t >= a.time && t <= b.time) {
      const alpha = (b.time === a.time) ? 0 : (t - a.time) / (b.time - a.time);
      out.position[0] = lerp(a.position[0], b.position[0], alpha);
      out.position[1] = lerp(a.position[1], b.position[1], alpha);
      out.position[2] = lerp(a.position[2], b.position[2], alpha);
      out.target[0] = lerp(a.target[0], b.target[0], alpha);
      out.target[1] = lerp(a.target[1], b.target[1], alpha);
      out.target[2] = lerp(a.target[2], b.target[2], alpha);
      normalize3Into(
        out.up,
        lerp(a.up[0], b.up[0], alpha),
        lerp(a.up[1], b.up[1], alpha),
        lerp(a.up[2], b.up[2], alpha),
      );
      out.fov_y_deg = lerp(a.fov_y_deg, b.fov_y_deg, alpha);
      return out;
    }
  }

  return copyCameraSample(out, kf[kf.length - 1]);
}

export function computeRenderTimeSeconds(simulationTimeSecs, alpha, fixedStepSecs) {
  const safeSimulationTimeSecs = Number.isFinite(simulationTimeSecs) ? simulationTimeSecs : 0;
  const safeFixedStepSecs = Number.isFinite(fixedStepSecs) ? Math.max(0, fixedStepSecs) : 0;
  const safeAlpha = Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 0;
  return safeSimulationTimeSecs + (safeAlpha * safeFixedStepSecs);
}

// ── Bind group layout definitions ─────────────────────────────────────────────

function makeScreen2DBindGroupLayout(device) {
  return device.createBindGroupLayout({
    label: 'screen2d_bgl',
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture:  { sampleType: 'float' } },  // t_diffuse
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture:  { sampleType: 'float' } },  // t_font
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture:  { sampleType: 'float' } },  // t_detail
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture:  { sampleType: 'float' } },  // t_lookup
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler:  {} },                       // s_diffuse
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler:  {} },                       // s_font
      { binding: 6, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' } },                                                          // u
    ],
  });
}

function makeWorld3DBindGroupLayout(device) {
  return device.createBindGroupLayout({
    label: 'world3d_bgl',
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' } },                                                          // u
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture:  { sampleType: 'float' } },  // t_font
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture:  { sampleType: 'float' } },  // t_noise
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture:  { sampleType: 'float' } },  // t_material_a
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture:  { sampleType: 'float' } },  // t_material_b
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler:  {} },                       // s_clamp
      { binding: 6, visibility: GPUShaderStage.FRAGMENT, sampler:  {} },                       // s_repeat
    ],
  });
}

// ── Pipeline helpers ──────────────────────────────────────────────────────────

const SCREEN2D_VERTEX_LAYOUT = {
  arrayStride: 40, // 10 × f32
  stepMode: 'vertex',
  attributes: [
    { shaderLocation: 0, offset: 0,  format: 'float32x3' }, // position
    { shaderLocation: 1, offset: 12, format: 'float32x2' }, // tex_coords
    { shaderLocation: 2, offset: 20, format: 'float32x4' }, // color
    { shaderLocation: 3, offset: 36, format: 'float32'   }, // mode
  ],
};

const WORLD3D_VERTEX_LAYOUT = {
  arrayStride: 44, // 11 × f32
  stepMode: 'vertex',
  attributes: [
    { shaderLocation: 0, offset: 0,  format: 'float32x3' }, // position
    { shaderLocation: 1, offset: 12, format: 'float32x3' }, // normal
    { shaderLocation: 2, offset: 24, format: 'float32x4' }, // color
    { shaderLocation: 3, offset: 40, format: 'float32'   }, // mode
  ],
};

function buildShaderSource(prelude, body) {
  return prelude + '\n' + body;
}

const VZGLYD_VERTEX_ENTRY_POINT = 'vs_main';
const VZGLYD_FRAGMENT_ENTRY_POINT = 'fs_main';

function countEntryPoint(source, entryPoint) {
  if (!source) return 0;
  const pattern = new RegExp(`\\bfn\\s+${entryPoint}\\s*\\(`, 'g');
  return [...source.matchAll(pattern)].length;
}

function analyzeShaderChunk(label, source) {
  const text = source ?? null;
  if (!text || text.trim() === '') {
    return {
      label,
      source: null,
      present: false,
      vsCount: 0,
      fsCount: 0,
      kind: 'empty',
    };
  }

  const vsCount = countEntryPoint(text, VZGLYD_VERTEX_ENTRY_POINT);
  const fsCount = countEntryPoint(text, VZGLYD_FRAGMENT_ENTRY_POINT);

  let kind = 'helper';
  if (vsCount > 0 && fsCount > 0) kind = 'full';
  else if (vsCount > 0) kind = 'vertex';
  else if (fsCount > 0) kind = 'fragment';

  return {
    label,
    source: text,
    present: true,
    vsCount,
    fsCount,
    kind,
  };
}

function shaderChunkSummary(chunk) {
  return `${chunk.label} (kind=${chunk.kind}, vs_main=${chunk.vsCount}, fs_main=${chunk.fsCount})`;
}

function preflightShaderBody(body) {
  const vsCount = countEntryPoint(body, VZGLYD_VERTEX_ENTRY_POINT);
  const fsCount = countEntryPoint(body, VZGLYD_FRAGMENT_ENTRY_POINT);
  if (vsCount !== 1 || fsCount !== 1) {
    return {
      error:
        `expected exactly one ${VZGLYD_VERTEX_ENTRY_POINT} and one ${VZGLYD_FRAGMENT_ENTRY_POINT} ` +
        `after normalization, got ${VZGLYD_VERTEX_ENTRY_POINT}=${vsCount}, ${VZGLYD_FRAGMENT_ENTRY_POINT}=${fsCount}`,
    };
  }
  return { error: null };
}

export function normalizeCustomShaderBody(shaders) {
  const warnings = [];
  const infos = [];
  if (!shaders) return { body: null, warnings, infos, error: null };

  const vertex = analyzeShaderChunk('vertex_wgsl', shaders.vertex_wgsl);
  const fragment = analyzeShaderChunk('fragment_wgsl', shaders.fragment_wgsl);
  const present = [vertex, fragment].filter(chunk => chunk.present);

  if (present.length === 0) {
    return { body: null, warnings, infos, error: null };
  }

  const duplicateInChunk = present.find(chunk => chunk.vsCount > 1 || chunk.fsCount > 1);
  if (duplicateInChunk) {
    return {
      body: null,
      warnings,
      infos,
      error: `${shaderChunkSummary(duplicateInChunk)} declares duplicate entry points inside a single source blob`,
    };
  }

  const fullChunks = present.filter(chunk => chunk.kind === 'full');
  if (fullChunks.length === 1) {
    const winner = fullChunks[0];
    const ignored = present.find(chunk => chunk !== winner);
    if (ignored) {
      warnings.push(
        `${winner.label} already defines both ${VZGLYD_VERTEX_ENTRY_POINT} and ${VZGLYD_FRAGMENT_ENTRY_POINT}; ignoring ${ignored.label}`,
      );
    }
    return { body: winner.source, warnings, infos, error: null };
  }

  if (fullChunks.length === 2) {
    const sameModule = vertex.source.trim() === fragment.source.trim();
    (sameModule ? infos : warnings).push(
      sameModule
        ? 'vertex_wgsl and fragment_wgsl both contain the same full shader module; using fragment_wgsl'
        : 'vertex_wgsl and fragment_wgsl both contain full shader modules; using fragment_wgsl and ignoring vertex_wgsl',
    );
    return { body: fragment.source, warnings, infos, error: null };
  }

  const helperChunk = present.find(chunk => chunk.kind === 'helper');
  if (helperChunk) {
    return {
      body: null,
      warnings,
      infos,
      error:
        `${shaderChunkSummary(helperChunk)} does not declare ${VZGLYD_VERTEX_ENTRY_POINT} ` +
        `or ${VZGLYD_FRAGMENT_ENTRY_POINT}`,
    };
  }

  const vertexChunks = present.filter(chunk => chunk.kind === 'vertex');
  const fragmentChunks = present.filter(chunk => chunk.kind === 'fragment');

  if (vertexChunks.length > 1 || fragmentChunks.length > 1) {
    return {
      body: null,
      warnings,
      infos,
      error:
        `conflicting split-stage shader payload: ` +
        `${present.map(shaderChunkSummary).join(', ')}`,
    };
  }

  if (vertexChunks.length === 1 && fragmentChunks.length === 1) {
    if (vertexChunks[0].label !== 'vertex_wgsl' || fragmentChunks[0].label !== 'fragment_wgsl') {
      infos.push('custom shader stages were supplied in the opposite fields; reordering by detected entry point');
    }

    const body = vertexChunks[0].source + '\n' + fragmentChunks[0].source;
    const preflight = preflightShaderBody(body);
    return { body: preflight.error ? null : body, warnings, infos, error: preflight.error };
  }

  return {
    body: null,
    warnings,
    infos,
    error:
      `incomplete custom shader payload: ${present.map(shaderChunkSummary).join(', ')}; ` +
      `expected either one full module or one vertex stage plus one fragment stage`,
  };
}

export function fingerprintRuntimeBytes(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    return null;
  }

  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return `${bytes.length}:${hash.toString(16).padStart(8, '0')}`;
}

export function shouldUploadRuntimeBytes(previousFingerprint, bytes) {
  const fingerprint = fingerprintRuntimeBytes(bytes);
  return {
    fingerprint,
    shouldUpload: fingerprint !== null && fingerprint !== previousFingerprint,
  };
}

function resolveCustomShaderSource(prelude, shaders) {
  const normalized = normalizeCustomShaderBody(shaders);
  if (!normalized.body || normalized.error) return { ...normalized, source: null };

  const preflight = preflightShaderBody(normalized.body);
  if (preflight.error) {
    return {
      body: null,
      warnings: normalized.warnings,
      infos: normalized.infos,
      error: preflight.error,
      source: null,
    };
  }

  return {
    body: normalized.body,
    warnings: normalized.warnings,
    infos: normalized.infos,
    error: null,
    source: buildShaderSource(prelude, normalized.body),
  };
}

function createPipeline(device, bgl, shaderSrc, vertexLayout, pipelineKind, format, hasDepth, sceneSpace = 'World3D') {
  const shaderModule = device.createShaderModule({ code: shaderSrc });

  const colorTarget = { format };
  if (pipelineKind === 'Transparent') {
    colorTarget.blend = {
      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one',       dstFactor: 'one-minus-src-alpha', operation: 'add' },
    };
  }

  const pipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [bgl],
  });

  // Screen2D transparent quads always face the camera and should render unconditionally.
  // Using 'always' depth compare and no culling prevents intermittent missing triangles
  // caused by residual background depth values or viewport-space winding edge cases.
  const isScreen2DTransparent = sceneSpace === 'Screen2D' && pipelineKind === 'Transparent';
  const depthStencil = hasDepth ? {
    format: 'depth32float',
    depthWriteEnabled: pipelineKind === 'Opaque',
    depthCompare: isScreen2DTransparent ? 'always'
                  : (pipelineKind === 'Opaque' ? 'less' : 'less-equal'),
  } : undefined;

  return device.createRenderPipeline({
    layout: pipelineLayout,
    vertex: {
      module:     shaderModule,
      entryPoint: 'vs_main',
      buffers:    [vertexLayout],
    },
    fragment: {
      module:     shaderModule,
      entryPoint: 'fs_main',
      targets:    [colorTarget],
    },
    primitive: {
      topology:  'triangle-list',
      cullMode:  isScreen2DTransparent ? 'none' : 'back',
    },
    depthStencil,
  });
}

/**
 * Patch custom WGSL: replace textureSample(t, s, coords) with
 * textureSampleLevel(t, s, coords, 0.0) to comply with WebGPU's strict
 * uniform-control-flow requirement for implicit-derivative texture instructions.
 * textureSampleLevel has an explicit LOD and is allowed anywhere.
 *
 * Matches `textureSample(` (with open paren) only, so it never touches
 * textureSampleLevel, textureSampleBias, textureSampleCompare, etc.
 */
function patchTextureSampleToLevel(wgsl) {
  let result = '';
  let i = 0;
  const needle = 'textureSample(';
  while (i < wgsl.length) {
    const idx = wgsl.indexOf(needle, i);
    if (idx === -1) { result += wgsl.slice(i); break; }

    result += wgsl.slice(i, idx) + 'textureSampleLevel(';
    i = idx + needle.length;

    // Copy all arguments up to the matching closing paren, then append , 0.0.
    // Strip any trailing comma + whitespace before adding the new argument to
    // handle calls written with a trailing comma, e.g.:
    //   textureSample(
    //       t, s,
    //       coords,      ← trailing comma
    //   ).r
    const argStart = i;
    let depth = 1;
    while (i < wgsl.length && depth > 0) {
      if (wgsl[i] === '(') depth++;
      else if (wgsl[i] === ')') { depth--; if (depth === 0) break; }
      i++;
    }
    let args = wgsl.slice(argStart, i);
    // Remove trailing comma/whitespace so we can append ', 0.0' cleanly.
    args = args.replace(/,\s*$/, '');
    result += args + ', 0.0)';
    i++; // skip closing paren
  }
  return result;
}

/**
 * Try creating a pipeline from `customSrc`; if the GPU reports a validation
 * error fall back to `defaultSrc` and return `{ pipeline, usedFallback: true }`.
 * Uses pushErrorScope/popErrorScope so the error does NOT bubble to the device
 * uncaptured-error handler.
 *
 * Before the first attempt, proactively patches textureSample → textureSampleLevel
 * so the shader compiles cleanly on strict WebGPU implementations (Edge, Safari).
 */
async function createPipelineWithFallback(device, bgl, customSrc, defaultSrc, vertexLayout, pipelineKind, format, hasDepth, sceneSpace = 'World3D') {
  // Proactively replace textureSample with textureSampleLevel so the shader
  // works under strict uniform-control-flow validation (Edge, Safari).
  const patchedSrc = patchTextureSampleToLevel(customSrc);

  device.pushErrorScope('validation');
  const pipeline = createPipeline(device, bgl, patchedSrc, vertexLayout, pipelineKind, format, hasDepth, sceneSpace);
  const err = await device.popErrorScope();
  if (!err) return { pipeline, usedFallback: false };

  console.warn(`[vzglyd] Custom ${pipelineKind} shader failed GPU validation after textureSample patch — falling back to default shader.\n${err.message}`);
  return {
    pipeline: createPipeline(device, bgl, defaultSrc, vertexLayout, pipelineKind, format, hasDepth, sceneSpace),
    usedFallback: true,
  };
}

async function buildPipelines(device, bgl, prelude, customShaders, defaultBody, vertexLayout, format, hasDepth, sceneSpace) {
  const defaultSrc = buildShaderSource(prelude, defaultBody);
  const resolved = resolveCustomShaderSource(prelude, customShaders);

  for (const info of resolved.infos) {
    console.info(`[vzglyd] ${sceneSpace} custom shader: ${info}.`);
  }
  for (const warning of resolved.warnings) {
    console.warn(`[vzglyd] ${sceneSpace} custom shader: ${warning}.`);
  }

  if (!resolved.source) {
    if (resolved.error) {
      console.warn(`[vzglyd] ${sceneSpace} custom shader rejected before GPU validation — falling back to default shader.\n${resolved.error}`);
    }

    return {
      opaque: createPipeline(device, bgl, defaultSrc, vertexLayout, 'Opaque', format, hasDepth, sceneSpace),
      transparent: createPipeline(device, bgl, defaultSrc, vertexLayout, 'Transparent', format, hasDepth, sceneSpace),
      usedFallback: Boolean(resolved.error),
    };
  }

  const opaqueResult = await createPipelineWithFallback(
    device,
    bgl,
    resolved.source,
    defaultSrc,
    vertexLayout,
    'Opaque',
    format,
    hasDepth,
    sceneSpace,
  );

  if (opaqueResult.usedFallback) {
    return {
      opaque: opaqueResult.pipeline,
      transparent: createPipeline(device, bgl, defaultSrc, vertexLayout, 'Transparent', format, hasDepth, sceneSpace),
      usedFallback: true,
    };
  }

  const transparentResult = await createPipelineWithFallback(
    device,
    bgl,
    resolved.source,
    defaultSrc,
    vertexLayout,
    'Transparent',
    format,
    hasDepth,
    sceneSpace,
  );

  return {
    opaque: opaqueResult.pipeline,
    transparent: transparentResult.pipeline,
    usedFallback: transparentResult.usedFallback,
  };
}

// ── VzglydRenderer ────────────────────────────────────────────────────────────

export class VzglydRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object}            spec     decoded SlideSpec
   * @param {object|null}       gpuState reusable WebGPU state for this canvas
   */
  constructor(canvas, spec, gpuState = null) {
    this._canvas   = canvas;
    this._spec     = spec;
    this._adapter  = gpuState?.adapter ?? null;
    this._device   = gpuState?.device ?? null;
    this._queue    = gpuState?.queue ?? null;
    this._context  = gpuState?.context ?? null;
    this._format   = gpuState?.format ?? null;
    this._configuredWidth = 0;
    this._configuredHeight = 0;

    this._uniformBuf  = null;
    this._bindGroup   = null;
    this._pipelines   = {};  // { Opaque: GPURenderPipeline, Transparent: GPURenderPipeline }
    this._staticBufs  = [];  // [{ vertex, index, indexCount }]
    this._dynamicBufs = [];  // [{ vertex, index, indexCount }]
    this._overlayBuf  = null;
    this._overlayFingerprint = null;
    this._dynamicMeshFingerprint = null;
    this._backgroundWorld = null;

    this._screen2DUniformData = new Float32Array(4);
    this._worldUniformData = new Float32Array(40);
    this._viewMatrix = new Float32Array(16);
    this._projectionMatrix = new Float32Array(16);
    this._viewProjectionMatrix = new Float32Array(16);
    this._cameraSample = {
      position: [0, 1, 3],
      target: [0, 0, 0],
      up: [0, 1, 0],
      fov_y_deg: 60,
    };

    this._frameCount = 0;
    this._fpsLastTime = 0;
    this._fps = 0;
    this._onFps = null; // optional callback(fps)

    // HUD overlay state (populated by initHud / applyHudGeometry)
    this._hudPipeline   = null;
    this._hudBindGroup  = null;
    this._hudVertexBuf  = null;
    this._hudIndexBuf   = null;
    this._hudIndexCount = 0;

    this._clearColor = { r: 0, g: 0, b: 0, a: 1 };
    this._backgroundColorAttachment = {
      view: null,
      clearValue: this._clearColor,
      loadOp: 'clear',
      storeOp: 'store',
    };
    this._backgroundDepthAttachment = {
      view: null,
      depthClearValue: 1.0,
      depthLoadOp: 'clear',
      depthStoreOp: 'store',
    };
    this._mainColorAttachment = {
      view: null,
      clearValue: this._clearColor,
      loadOp: 'clear',
      storeOp: 'store',
    };
    this._mainDepthAttachment = {
      view: null,
      depthClearValue: 1.0,
      depthLoadOp: 'clear',
      depthStoreOp: 'store',
    };
    this._backgroundPassDescriptor = {
      colorAttachments: [this._backgroundColorAttachment],
      depthStencilAttachment: this._backgroundDepthAttachment,
    };
    this._mainPassDescriptor = {
      colorAttachments: [this._mainColorAttachment],
      depthStencilAttachment: this._mainDepthAttachment,
    };
  }

  /** Must be called before render(). Returns false if WebGPU is unavailable. */
  async init() {
    if (!this._device || !this._queue || !this._context || !this._format) {
      this._adapter =
        await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }) ??
        await navigator.gpu.requestAdapter() ??
        await navigator.gpu.requestAdapter({ forceFallbackAdapter: true });
      if (!this._adapter) throw new Error(
        'WebGPU adapter unavailable. Make sure hardware acceleration is enabled ' +
        '(edge://settings/system) and you are on Edge 113+, Chrome 113+, or Safari 18+.'
      );

      this._device = await this._adapter.requestDevice();
      this._queue  = this._device.queue;

      this._context = this._canvas.getContext('webgpu');
      this._format  = navigator.gpu.getPreferredCanvasFormat();
    }

    this._configureContext();

    // Expose device globally so tests/debug tools can read back pixels.
    window.__vzglyd_device = this._device;

    await this._buildResources();
  }

  gpuState() {
    return {
      adapter: this._adapter,
      device: this._device,
      queue: this._queue,
      context: this._context,
      format: this._format,
    };
  }

  async _buildResources() {
    const device = this._device;
    const queue  = this._queue;
    const spec   = this._spec;
    const is3D   = spec.scene_space === 'World3D';

    console.log(`[vzglyd] scene_space=${spec.scene_space} draws=${spec.draws.length} static_meshes=${spec.static_meshes.length} custom_shader=${!!(spec.shaders?.vertex_wgsl || spec.shaders?.fragment_wgsl)}`);

    // ── Textures ──────────────────────────────────────────────────────────────
    const fallback = create1x1Texture(device, queue);

    if (is3D) {
      // World3D: textures[0]=t_font, [1]=t_noise, [2]=t_material_a, [3]=t_material_b
      const views = this._uploadWorld3DTextures(spec, fallback);
      const samplers = this._world3DSamplers(spec);
      await this._buildWorld3DResources(views, samplers);
    } else {
      if (spec.background_world) {
        await this._buildHybridWorldBackgroundResources(spec.background_world, fallback);
      }
      // Screen2D: textures[0]=t_diffuse, font=t_font, [1]=t_detail, [2]=t_lookup
      const views = this._uploadScreen2DTextures(spec, fallback);
      const samplers = this._screen2DSamplers(spec);
      await this._buildScreen2DResources(views, samplers);
    }
  }

  // ── Screen2D setup ────────────────────────────────────────────────────────

  _uploadScreen2DTextures(spec, fallback) {
    const { _device: device, _queue: queue } = this;
    const t = spec.textures;

    const diffuse = t[0] ? uploadTextureDesc(device, queue, t[0]) : fallback;
    const detail  = t[1] ? uploadTextureDesc(device, queue, t[1]) : diffuse;
    const lookup  = t[2] ? uploadTextureDesc(device, queue, t[2]) : detail;

    let fontView = diffuse;
    if (spec.font) {
      fontView = uploadRawTexture(device, queue,
        spec.font.width, spec.font.height, spec.font.pixels, 'font_atlas');
    }

    return { diffuse, fontView, detail, lookup };
  }

  _screen2DSamplers(spec) {
    const device = this._device;
    const t = spec.textures;
    const mainSampler = t[0] ? createSamplerFromDesc(device, t[0])
      : device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

    const fontSampler = spec.font
      ? device.createSampler({ magFilter: 'nearest', minFilter: 'nearest', mipmapFilter: 'nearest' })
      : mainSampler;

    return { mainSampler, fontSampler };
  }

  async _buildScreen2DResources(views, samplers) {
    const device = this._device;
    const spec   = this._spec;

    // Uniform buffer: 16 bytes (time + 3 pads)
    this._uniformBuf = device.createBuffer({
      label: 'screen2d_uniforms',
      size:  16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const bgl = makeScreen2DBindGroupLayout(device);
    this._bindGroup = device.createBindGroup({
      layout:  bgl,
      entries: [
        { binding: 0, resource: views.diffuse },
        { binding: 1, resource: views.fontView },
        { binding: 2, resource: views.detail },
        { binding: 3, resource: views.lookup },
        { binding: 4, resource: samplers.mainSampler },
        { binding: 5, resource: samplers.fontSampler },
        { binding: 6, resource: { buffer: this._uniformBuf } },
      ],
    });

    const vertLayout = SCREEN2D_VERTEX_LAYOUT;
    const fmt        = this._format;
    const hasDepth   = true;

    const { opaque, transparent, usedFallback } = await buildPipelines(
      device,
      bgl,
      SCREEN2D_PRELUDE,
      spec.shaders,
      SCREEN2D_DEFAULT_BODY,
      vertLayout,
      fmt,
      hasDepth,
      'Screen2D',
    );
    this._pipelines.Opaque = opaque;
    this._pipelines.Transparent = transparent;
    if (usedFallback) this._shaderFallback = true;

    this._uploadStaticMeshes(SCREEN2D_VERTEX_LAYOUT.arrayStride);
    this._allocDynamicMeshes(SCREEN2D_VERTEX_LAYOUT.arrayStride);
    this._buildDepthTexture();
  }

  async _buildHybridWorldBackgroundResources(backgroundSpec, fallback) {
    const device = this._device;

    const uniformBuf = device.createBuffer({
      label: 'hybrid_world_uniforms',
      size:  160,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const views = this._uploadWorld3DTextures(backgroundSpec, fallback);
    const samplers = this._world3DSamplers(backgroundSpec);
    const bgl = makeWorld3DBindGroupLayout(device);
    const bindGroup = device.createBindGroup({
      layout:  bgl,
      entries: [
        { binding: 0, resource: { buffer: uniformBuf } },
        { binding: 1, resource: views.font },
        { binding: 2, resource: views.noise },
        { binding: 3, resource: views.materialA },
        { binding: 4, resource: views.materialB },
        { binding: 5, resource: samplers.clampSampler },
        { binding: 6, resource: samplers.repeatSampler },
      ],
    });

    const { opaque, transparent, usedFallback } = await buildPipelines(
      device,
      bgl,
      WORLD3D_PRELUDE,
      backgroundSpec.shaders,
      WORLD3D_DEFAULT_BODY,
      WORLD3D_VERTEX_LAYOUT,
      this._format,
      true,
      'HybridWorld3D',
    );

    this._backgroundWorld = {
      spec: backgroundSpec,
      uniformBuf,
      bindGroup,
      pipelines: {
        Opaque: opaque,
        Transparent: transparent,
      },
      staticBufs: createStaticMeshBuffers(device, backgroundSpec.static_meshes, 'World3D', 'bg_world_static'),
    };

    if (usedFallback) this._shaderFallback = true;
  }

  // ── World3D setup ──────────────────────────────────────────────────────────

  _uploadWorld3DTextures(spec, fallback) {
    const { _device: device, _queue: queue } = this;
    const t = spec.textures;

    const font       = t[0] ? uploadTextureDesc(device, queue, t[0]) : fallback;
    const noise      = t[1] ? uploadTextureDesc(device, queue, t[1]) : font;
    const materialA  = t[2] ? uploadTextureDesc(device, queue, t[2]) : noise;
    const materialB  = t[3] ? uploadTextureDesc(device, queue, t[3]) : materialA;

    return { font, noise, materialA, materialB };
  }

  _world3DSamplers(spec) {
    const device = this._device;
    const t = spec.textures;

    const clampSampler  = t[0] ? createSamplerFromDesc(device, t[0])
      : device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    const repeatSampler = t[1] ? createSamplerFromDesc(device, t[1])
      : device.createSampler({
          addressModeU: 'repeat', addressModeV: 'repeat',
          magFilter: 'linear', minFilter: 'linear',
        });

    return { clampSampler, repeatSampler };
  }

  async _buildWorld3DResources(views, samplers) {
    const device = this._device;
    const spec   = this._spec;

    // Uniform buffer: 160 bytes
    // view_proj(64) + cam_pos(12) + time(4) + fog_color(16) +
    // fog_start(4) + fog_end(4) + clock_seconds(4) + _pad(4) +
    // ambient_light(16) + main_light_dir(16) + main_light_color(16)
    this._uniformBuf = device.createBuffer({
      label: 'world3d_uniforms',
      size:  160,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const bgl = makeWorld3DBindGroupLayout(device);
    this._bindGroup = device.createBindGroup({
      layout:  bgl,
      entries: [
        { binding: 0, resource: { buffer: this._uniformBuf } },
        { binding: 1, resource: views.font },
        { binding: 2, resource: views.noise },
        { binding: 3, resource: views.materialA },
        { binding: 4, resource: views.materialB },
        { binding: 5, resource: samplers.clampSampler },
        { binding: 6, resource: samplers.repeatSampler },
      ],
    });

    const vertLayout = WORLD3D_VERTEX_LAYOUT;
    const fmt        = this._format;
    const hasDepth   = true;

    const { opaque, transparent, usedFallback } = await buildPipelines(
      device,
      bgl,
      WORLD3D_PRELUDE,
      spec.shaders,
      WORLD3D_DEFAULT_BODY,
      vertLayout,
      fmt,
      hasDepth,
      'World3D',
    );
    this._pipelines.Opaque = opaque;
    this._pipelines.Transparent = transparent;
    if (usedFallback) this._shaderFallback = true;

    this._uploadStaticMeshes(WORLD3D_VERTEX_LAYOUT.arrayStride);
    this._allocDynamicMeshes(WORLD3D_VERTEX_LAYOUT.arrayStride);
    this._buildDepthTexture();
  }

  // ── Mesh buffer management ─────────────────────────────────────────────────

  _uploadStaticMeshes(stride) {
    const spec = this._spec;
    this._staticBufs = createStaticMeshBuffers(this._device, spec.static_meshes, spec.scene_space, 'static');
  }

  _allocDynamicMeshes(stride) {
    const device = this._device;
    const spec   = this._spec;

    this._dynamicBufs = spec.dynamic_meshes.map((mesh, i) => {
      const vertBytes  = mesh.max_vertices * stride;
      const indices    = packIndices(mesh.indices);
      const vertBuf    = device.createBuffer({
        label: `dyn_vertex_${i}`,
        size:  vertBytes,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      const indexBuf   = createIndexBuffer(device, indices, `dyn_index_${i}`);
      return { vertex: vertBuf, index: indexBuf, indexCount: indices.length };
    });
  }

  _buildDepthTexture() {
    const w = this._canvas.width;
    const h = this._canvas.height;
    this._depthTexture = this._device.createTexture({
      label:  'depth',
      size:   [w, h],
      format: 'depth32float',
      usage:  GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this._depthView = this._depthTexture.createView();
    this._backgroundDepthAttachment.view = this._depthView;
    this._mainDepthAttachment.view = this._depthView;
  }

  _configureContext() {
    this._context.configure({ device: this._device, format: this._format, alphaMode: 'opaque' });
    this._configuredWidth = this._canvas.width;
    this._configuredHeight = this._canvas.height;
  }

  _ensureCanvasConfigured() {
    const width = this._canvas.width;
    const height = this._canvas.height;

    if (!width || !height) {
      return false;
    }

    if (width === this._configuredWidth && height === this._configuredHeight) {
      return true;
    }

    this._configureContext();
    this._buildDepthTexture();
    return true;
  }

  // ── Runtime updates ────────────────────────────────────────────────────────

  /**
   * Apply a RuntimeOverlay decoded from guest memory.
   * @param {Uint8Array|null} overlayBytes
   */
  applyOverlayBytes(overlayBytes) {
    const { fingerprint, shouldUpload } = shouldUploadRuntimeBytes(
      this._overlayFingerprint,
      overlayBytes,
    );
    if (!shouldUpload) return false;

    const overlay = decodeRuntimeOverlayBytes(overlayBytes, this._spec.scene_space);
    if (!overlay || overlay.vertices.length === 0) {
      const hadOverlay = Boolean(this._overlayBuf && this._overlayBuf.indexCount > 0);
      this._overlayBuf = null;
      this._overlayFingerprint = fingerprint;
      return hadOverlay;
    }

    const verts   = packVertices(overlay.vertices, this._spec.scene_space);
    const indices = packIndices(overlay.indices);
    const device  = this._device;

    if (!this._overlayBuf || this._overlayBuf.indexCount < indices.length) {
      this._overlayBuf = {
        vertex:     createVertexBuffer(device, verts,   'overlay_vertex'),
        index:      createIndexBuffer (device, indices, 'overlay_index'),
        indexCount: indices.length,
      };
    } else {
      device.queue.writeBuffer(this._overlayBuf.vertex, 0, verts);
      device.queue.writeBuffer(this._overlayBuf.index,  0, indices);
      this._overlayBuf.indexCount = indices.length;
    }

    this._overlayFingerprint = fingerprint;
    return true;
  }

  /**
   * Apply a RuntimeMeshSet decoded from guest memory.
   * @param {Uint8Array|null} meshBytes
   */
  applyDynamicMeshBytes(meshBytes) {
    const { fingerprint, shouldUpload } = shouldUploadRuntimeBytes(
      this._dynamicMeshFingerprint,
      meshBytes,
    );
    if (!shouldUpload) return false;

    const meshSet = decodeRuntimeMeshSet(meshBytes, this._spec.scene_space);
    const stride  = this._spec.scene_space === 'Screen2D' ? 40 : 44;
    let wroteMeshBuffer = false;

    for (const rm of meshSet.meshes) {
      const buf = this._dynamicBufs[rm.mesh_index];
      if (!buf) continue;
      const verts = packVertices(rm.vertices, this._spec.scene_space);
      this._device.queue.writeBuffer(buf.vertex, 0, verts);
      buf.activeIndexCount = Math.min(rm.index_count, buf.indexCount);
      wroteMeshBuffer = true;
    }

    this._dynamicMeshFingerprint = fingerprint;
    return wroteMeshBuffer;
  }

  // ── HUD overlay ────────────────────────────────────────────────────────────

  /**
   * Initialize the HUD pipeline and font atlas texture.
   * Called once by the Rust host after the surface is ready.
   * @param {Uint8Array} atlasBytes  flat RGBA8 pixel data
   * @param {number}     atlasWidth
   * @param {number}     atlasHeight
   */
  initHud(atlasBytes, atlasWidth, atlasHeight) {
    const device = this._device;
    if (!device) return;

    const atlasTexture = device.createTexture({
      label: 'hud_font_atlas',
      size: [atlasWidth, atlasHeight, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: atlasTexture },
      atlasBytes,
      { bytesPerRow: atlasWidth * 4 },
      [atlasWidth, atlasHeight, 1],
    );

    const bgl = device.createBindGroupLayout({
      label: 'hud_bgl',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'non-filtering' },
        },
      ],
    });

    this._hudBindGroup = device.createBindGroup({
      label: 'hud_bind_group',
      layout: bgl,
      entries: [
        { binding: 0, resource: atlasTexture.createView() },
        { binding: 1, resource: device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' }) },
      ],
    });

    const shaderModule = device.createShaderModule({ label: 'hud_shader', code: HUD_SHADER_SRC });
    const pipelineLayout = device.createPipelineLayout({
      label: 'hud_pipeline_layout',
      bindGroupLayouts: [bgl],
    });

    this._hudPipeline = device.createRenderPipeline({
      label: 'hud_pipeline',
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: [{
          arrayStride: 40,
          stepMode: 'vertex',
          attributes: [
            { shaderLocation: 0, offset:  0, format: 'float32x2' }, // position
            { shaderLocation: 1, offset:  8, format: 'float32x2' }, // uv
            { shaderLocation: 2, offset: 16, format: 'float32x4' }, // color
            { shaderLocation: 3, offset: 32, format: 'float32'   }, // mode
          ],
        }],
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{
          format: this._format,
          blend: {
            color: { srcFactor: 'src-alpha',     dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one',            dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
    });
  }

  /**
   * Upload pre-built HUD geometry for the upcoming frame.
   * @param {Uint8Array} vertsBytes  packed OverlayVertex data (stride 40 bytes)
   * @param {Uint8Array} idxsBytes   packed u16 index data
   */
  applyHudGeometry(vertsBytes, idxsBytes) {
    const device = this._device;
    if (!device || !this._hudPipeline) return;

    if (!this._hudVertexBuf || this._hudVertexBuf.size < vertsBytes.byteLength) {
      this._hudVertexBuf?.destroy();
      this._hudVertexBuf = device.createBuffer({
        label: 'hud_vertex',
        size: Math.max(vertsBytes.byteLength, 4096),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }
    const idxAligned = Math.ceil(idxsBytes.byteLength / 4) * 4;
    if (!this._hudIndexBuf || this._hudIndexBuf.size < idxAligned) {
      this._hudIndexBuf?.destroy();
      this._hudIndexBuf = device.createBuffer({
        label: 'hud_index',
        size: Math.max(idxAligned, 1024),
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
    }

    device.queue.writeBuffer(this._hudVertexBuf, 0, vertsBytes);
    device.queue.writeBuffer(this._hudIndexBuf,  0, idxsBytes);
    this._hudIndexCount = idxsBytes.byteLength / 2; // u16 = 2 bytes each
  }

  // ── Uniform updates ────────────────────────────────────────────────────────

  _writeScreen2DUniforms(elapsed) {
    const data = this._screen2DUniformData;
    data[0] = elapsed;
    data[1] = 0;
    data[2] = 0;
    data[3] = 0;
    this._queue.writeBuffer(this._uniformBuf, 0, data);
  }

  _writeWorldUniforms(spec, uniformBuf, elapsed, wallClockMs) {
    const cam = sampleCameraInto(this._cameraSample, spec.camera_path, elapsed);
    const aspect = this._canvas.width / this._canvas.height;

    const view = mat4LookAtInto(this._viewMatrix, cam.position, cam.target, cam.up);
    const proj = mat4PerspectiveInto(
      this._projectionMatrix,
      cam.fov_y_deg * Math.PI / 180,
      aspect,
      0.15,
      180.0,
    );
    const viewProj = mat4MulInto(this._viewProjectionMatrix, proj, view);

    const lighting = spec.lighting ?? {
      ambient_color:     [1, 1, 1],
      ambient_intensity: 0.22,
      directional_light: { direction: [0.55, 1.0, 0.38], color: [1, 1, 1], intensity: 1.0 },
    };

    const ambIntensity = Math.max(0, lighting.ambient_intensity);
    const dl = lighting.directional_light;
    const data = this._worldUniformData; // 160 bytes = 40 f32
    // view_proj (col-major mat4): indices 0-15
    data.set(viewProj, 0);
    // cam_pos: 16-18, time: 19
    data[16] = cam.position[0];
    data[17] = cam.position[1];
    data[18] = cam.position[2];
    data[19] = elapsed;
    // fog_color: 20-23
    data[20] = 0; data[21] = 0; data[22] = 0; data[23] = 1;
    // fog_start: 24, fog_end: 25, clock_seconds: 26, _pad: 27
    data[24] = 18.0;
    data[25] = 75.0;
    data[26] = localClockSeconds(wallClockMs);
    data[27] = 0;
    // ambient_light: 28-31
    data[28] = lighting.ambient_color[0] * ambIntensity;
    data[29] = lighting.ambient_color[1] * ambIntensity;
    data[30] = lighting.ambient_color[2] * ambIntensity;
    data[31] = 0;
    // main_light_dir: 32-35
    if (dl) {
      const mainLightLength = Math.hypot(dl.direction[0], dl.direction[1], dl.direction[2]);
      if (mainLightLength === 0) {
        data[32] = 0;
        data[33] = 1;
        data[34] = 0;
      } else {
        data[32] = dl.direction[0] / mainLightLength;
        data[33] = dl.direction[1] / mainLightLength;
        data[34] = dl.direction[2] / mainLightLength;
      }
      data[35] = 1.0;
      data[36] = dl.color[0] * dl.intensity;
      data[37] = dl.color[1] * dl.intensity;
      data[38] = dl.color[2] * dl.intensity;
      data[39] = 0;
    } else {
      data[32] = 0;
      data[33] = 1;
      data[34] = 0;
      data[35] = 0;
      data[36] = 0;
      data[37] = 0;
      data[38] = 0;
      data[39] = 0;
    }

    this._queue.writeBuffer(uniformBuf, 0, data);
  }

  _writeWorld3DUniforms(elapsed, wallClockMs) {
    this._writeWorldUniforms(this._spec, this._uniformBuf, elapsed, wallClockMs);
  }

  _writeHybridWorldBackgroundUniforms(elapsed, wallClockMs) {
    if (!this._backgroundWorld) return;
    this._writeWorldUniforms(
      this._backgroundWorld.spec,
      this._backgroundWorld.uniformBuf,
      elapsed,
      wallClockMs,
    );
  }

  _renderDrawList(renderPass, pipelines, bindGroup, draws, staticBufs, dynamicBufs = null) {
    renderPass.setBindGroup(0, bindGroup);

    for (const draw of draws) {
      const pipeline = pipelines[draw.pipeline];
      if (!pipeline) continue;
      renderPass.setPipeline(pipeline);

      const { kind, index } = draw.source;
      const buf = kind === 'Static'
        ? staticBufs[index]
        : dynamicBufs?.[index];
      if (!buf) continue;

      renderPass.setVertexBuffer(0, buf.vertex);
      renderPass.setIndexBuffer(buf.index, 'uint16');
      const count = kind === 'Dynamic'
        ? (buf.activeIndexCount ?? buf.indexCount)
        : buf.indexCount;
      const start = draw.index_range.start;
      const end   = Math.min(draw.index_range.end, count);
      if (end > start) renderPass.drawIndexed(end - start, 1, start, 0);
    }
  }

  // ── Render pass ────────────────────────────────────────────────────────────

  renderFrame(frameTiming = {}) {
    if (!this._ensureCanvasConfigured()) {
      return;
    }

    const simulationTimeSecs = Number.isFinite(frameTiming.simulationTimeSecs)
      ? frameTiming.simulationTimeSecs
      : 0;
    const fixedStepSecs = Number.isFinite(frameTiming.fixedStepSecs)
      ? Math.max(0, frameTiming.fixedStepSecs)
      : 0;
    const frameTimestampMs = Number.isFinite(frameTiming.frameTimestampMs)
      ? frameTiming.frameTimestampMs
      : 0;
    const renderTimeSecs = computeRenderTimeSeconds(
      simulationTimeSecs,
      frameTiming.alpha,
      fixedStepSecs,
    );
    const wallClockMs = (globalThis.performance?.timeOrigin ?? 0) + frameTimestampMs;

    const spec = this._spec;
    if (this._backgroundWorld) {
      this._writeHybridWorldBackgroundUniforms(renderTimeSecs, wallClockMs);
    }
    if (spec.scene_space === 'Screen2D') {
      this._writeScreen2DUniforms(renderTimeSecs);
    } else {
      this._writeWorld3DUniforms(renderTimeSecs, wallClockMs);
    }

    // FPS counter
    this._frameCount++;
    if (this._fpsLastTime === 0) {
      this._fpsLastTime = frameTimestampMs;
    } else if (frameTimestampMs - this._fpsLastTime >= 500) {
      this._fps = Math.round(this._frameCount / ((frameTimestampMs - this._fpsLastTime) / 1000));
      this._frameCount = 0;
      this._fpsLastTime = frameTimestampMs;
      if (this._onFps) this._onFps(this._fps);
    }

    const device = this._device;
    const encoder = device.createCommandEncoder();
    const colorTex = this._context.getCurrentTexture();
    const colorView = colorTex.createView();

    if (this._backgroundWorld) {
      this._backgroundColorAttachment.view = colorView;
      this._backgroundDepthAttachment.view = this._depthView;
      const backgroundPass = encoder.beginRenderPass(this._backgroundPassDescriptor);
      this._renderDrawList(
        backgroundPass,
        this._backgroundWorld.pipelines,
        this._backgroundWorld.bindGroup,
        this._backgroundWorld.spec.draws,
        this._backgroundWorld.staticBufs,
      );
      backgroundPass.end();
    }

    this._mainColorAttachment.view = colorView;
    this._mainColorAttachment.loadOp = this._backgroundWorld ? 'load' : 'clear';
    this._mainDepthAttachment.view = this._depthView;
    const renderPass = encoder.beginRenderPass(this._mainPassDescriptor);

    this._renderDrawList(renderPass, this._pipelines, this._bindGroup, spec.draws, this._staticBufs, this._dynamicBufs);

    if (this._overlayBuf && this._overlayBuf.indexCount > 0) {
      renderPass.setPipeline(this._pipelines.Transparent);
      renderPass.setBindGroup(0, this._bindGroup);
      renderPass.setVertexBuffer(0, this._overlayBuf.vertex);
      renderPass.setIndexBuffer(this._overlayBuf.index, 'uint16');
      renderPass.drawIndexed(this._overlayBuf.indexCount);
    }

    renderPass.end();

    // HUD overlay pass — runs after slide content, before present.
    if (this._hudPipeline && this._hudIndexCount > 0) {
      const hudPass = encoder.beginRenderPass({
        colorAttachments: [{
          view: colorView,
          loadOp: 'load',
          storeOp: 'store',
        }],
      });
      hudPass.setPipeline(this._hudPipeline);
      hudPass.setBindGroup(0, this._hudBindGroup);
      hudPass.setVertexBuffer(0, this._hudVertexBuf);
      hudPass.setIndexBuffer(this._hudIndexBuf, 'uint16');
      hudPass.drawIndexed(this._hudIndexCount);
      hudPass.end();
    }

    this._queue.submit([encoder.finish()]);
  }

  stop() {
    // Renderer frame ownership stays in view.js; nothing to stop here.
  }

  get fps() {
    return this._fps;
  }
}
