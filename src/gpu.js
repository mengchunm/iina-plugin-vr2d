"use strict";

/**
 * GPU reprojection for mpv's vo=gpu-next/libplacebo renderer.
 *
 * The shader is deliberately limited to equirectangular input. Fisheye and
 * EAC sources stay on the well-tested CPU v360 path until their projection
 * math has an independent rendered-frame reference.
 */

var mpv = iina.mpv;
var file = iina.file;

var SHADER_PATH = "/private/tmp/iina-vr2d-" + Math.random().toString(36).slice(2, 10) + ".glsl";
var active = false;

var SHADER = [
  "//!PARAM yaw",
  "//!TYPE float",
  "//!MINIMUM -180",
  "//!MAXIMUM 180",
  "0.0",
  "//!PARAM pitch",
  "//!TYPE float",
  "//!MINIMUM -90",
  "//!MAXIMUM 90",
  "0.0",
  "//!PARAM fov",
  "//!TYPE float",
  "//!MINIMUM 5",
  "//!MAXIMUM 150",
  "90.0",
  "//!PARAM aspect",
  "//!TYPE float",
  "1.0",
  "//!PARAM half_equirect",
  "//!TYPE int",
  "0",
  "//!PARAM layout",
  "//!TYPE int",
  "0",
  "//!PARAM eye",
  "//!TYPE int",
  "0",
  "//!PARAM swap_eyes",
  "//!TYPE int",
  "0",
  "//!PARAM input_hfov",
  "//!TYPE float",
  "360.0",
  "//!PARAM input_vfov",
  "//!TYPE float",
  "180.0",
  "//!HOOK MAIN",
  "//!BIND HOOKED",
  "//!SAVE HOOKED",
  "//!WIDTH OUTPUT.w",
  "//!HEIGHT OUTPUT.h",
  "",
  "const float PI = 3.14159265358979323846;",,
  "const float TAU = 6.28318530717958647692;",
  "",
  "vec3 rotate_view(vec3 ray) {",
  "    float y = radians(yaw);",
  "    float p = radians(pitch);",
  "    float cy = cos(y);",
  "    float sy = sin(y);",
  "    float cp = cos(p);",
  "    float sp = sin(p);",
  "    vec3 r;",
  "    r.x = cy * ray.x + sy * ray.z;",
  "    r.z = -sy * ray.x + cy * ray.z;",
  "    r.y = cp * ray.y - sp * r.z;",
  "    r.z = sp * ray.y + cp * r.z;",
  "    return normalize(r);",
  "}",
  "",
  "vec2 source_uv(vec3 ray) {",
  "    float longitude = atan(ray.x, ray.z);",
  "    float latitude = asin(clamp(ray.y, -1.0, 1.0));",
  "    float u;",
  "    float v;",
  "    if (half_equirect != 0) {",
  "        float hfov = radians(input_hfov);",
  "        float vfov = radians(input_vfov);",
  "        if (abs(longitude) > hfov * 0.5 || abs(latitude) > vfov * 0.5)",
  "            return vec2(-1.0);",
  "        u = 0.5 + longitude / hfov;",
  "        v = 0.5 - latitude / vfov;",
  "    } else {",
  "        u = longitude / TAU + 0.5;",
  "        v = 0.5 - latitude / PI;",
  "    }",
  "    bool second = (eye != 0) != (swap_eyes != 0);",
  "    if (layout == 1) u = u * 0.5 + (second ? 0.5 : 0.0);",
  "    if (layout == 2) v = v * 0.5 + (second ? 0.5 : 0.0);",
  "    return vec2(u, v);",
  "}",
  "",
  "vec4 hook() {",
  "    vec2 xy = HOOKED_pos * 2.0 - 1.0;",
  "    float diagonal = tan(radians(fov) * 0.5);",
  "    float scale = diagonal / sqrt(1.0 + aspect * aspect);",
  "    vec3 ray = normalize(vec3(xy.x * aspect * scale, -xy.y * scale, 1.0));",
  "    vec2 uv = source_uv(rotate_view(ray));",
  "    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0)",
  "        return vec4(0.0);",,
  "    return HOOKED_tex(uv);",
  "}",
].join("\n");

function isSupported(source) {
  return source && (source.projection === "e" || source.projection === "he") &&
    (source.layout === "mono" || source.layout === "sbs" || source.layout === "tb");
}

function currentVo() {
  try {
    return mpv.getString("vo");
  } catch (e) {
    return "";
  }
}

function setOptions(source, view, aspect, eye) {
  var layout = source.layout === "sbs" ? 1 : source.layout === "tb" ? 2 : 0;
  var options = {
    "vr2d/yaw": view.yaw,
    "vr2d/pitch": view.pitch,
    "vr2d/fov": view.fov,
    "vr2d/aspect": aspect,
    "vr2d/half_equirect": source.projection === "he" ? 1 : 0,
    "vr2d/layout": layout,
    "vr2d/eye": eye === "right" ? 1 : 0,
    "vr2d/swap_eyes": source.swapEyes ? 1 : 0,
    "vr2d/input_hfov": source.inHFov || (source.projection === "he" ? 180 : 360),
    "vr2d/input_vfov": source.inVFov || 180,
  };
  mpv.set("glsl-shader-opts", options);
}

function enable(source, view, out, eye, mode) {
  if (!isSupported(source) || mode === "off") return false;

  var vo = currentVo();
  // Changing vo while a video is already running causes IINA 1.5 to rebuild
  // the output asynchronously. Installing the shader during that rebuild can
  // leave a black frame, so GPU mode is opt-in through IINA's video output
  // setting and never changes vo at runtime.
  if (vo !== "gpu-next") return false;

  try {
    file.write(SHADER_PATH, SHADER);
    mpv.command("change-list", ["glsl-shaders", "append", SHADER_PATH]);
    setOptions(source, view, out.width / Math.max(1, out.height), eye);
    active = true;
    return true;
  } catch (e) {
    disable();
    return false;
  }
}

function update(source, view, out, eye) {
  if (!active) return false;
  try {
    setOptions(source, view, out.width / Math.max(1, out.height), eye);
    return true;
  } catch (e) {
    return false;
  }
}

function disable() {
  if (active) {
    try { mpv.command("change-list", ["glsl-shaders", "remove", SHADER_PATH]); } catch (e) {}
    active = false;
  }
  try { file.delete(SHADER_PATH); } catch (e) {}
}

module.exports = {
  enable: enable,
  update: update,
  disable: disable,
  isActive: function () { return active; },
  isSupported: isSupported,
};
