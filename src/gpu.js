"use strict";

/**
 * GPU reprojection using mpv's user-shader pipeline.
 *
 * IINA 1.5.1 embeds mpv 0.41 and exposes the renderer as `libmpv`. That
 * renderer has the legacy shader parser, which does not understand PARAM
 * blocks. In that mode the shader is generated with camera values compiled in
 * and replaced only when the view changes. mpv gpu-next uses PARAM blocks and
 * updates the values without replacing the shader.
 */

var mpv = iina.mpv;
var file = iina.file;
var console = iina.console;
var geometry = require("./geometry.js");
var shader = require("./gpu-shader.js");

var SHADER_NAME = "iina-vr2d";
var SHADER_PATH = null;
var active = false;
var legacyMode = false;
var lastError = null;
var shaderOptsBefore = null;
var lastLegacyKey = null;
var RAD = Math.PI / 180;

function projectionName(source) {
  if (!source) return null;
  if (source.projection === "e") {
    if (source.layout === "mono") return "equirectangular";
    if (source.layout === "sbs") return "dual_equirectangular";
    if (source.layout === "tb") return "dual_vert_equirectangular";
    return null;
  }
  if (source.projection === "he") {
    if (source.layout === "mono") return "half_equirectangular";
    if (source.layout === "sbs") return "dual_half_equirectangular";
    return null;
  }
  if (source.projection === "fisheye") {
    if (source.layout === "mono") return "fisheye";
    if (source.layout === "sbs") return "dual_fisheye";
  }
  if (source.projection === "eac") {
    if (source.layout === "mono") return "equiangular_cubemap";
    if (source.layout === "sbs") return "dual_equiangular_cubemap";
  }
  return null;
}

function isSupported(source) {
  return projectionName(source) !== null;
}

function currentVo() {
  try {
    return mpv.getString("vo") || "";
  } catch (e) {
    return "";
  }
}

function gpuOutputActive() {
  var vo = currentVo();
  if (!vo) return true; // video output may still be initializing at file load
  if (vo === "gpu-next" || vo === "libmpv") return true;
  try {
    var passes = mpv.getNative("vo-passes");
    return !!(passes && (Array.isArray(passes) ? passes.length : true));
  } catch (e) {
    return false;
  }
}

function fail(reason) {
  lastError = reason;
  try { console.error("VR2D GPU: " + reason); } catch (e) {}
  return false;
}

function samplingName(interp) {
  if (interp === "lanczos") return "lanczos";
  if (interp === "cubic") return "mitchell";
  return "linear";
}

function effectiveEye(source, eye) {
  var right = eye === "right";
  if (source.swapEyes) right = !right;
  return right ? "right" : "left";
}

function optionNumber(n) {
  return String(Math.round(n * 1000000) / 1000000);
}

function shaderPath() {
  return "/private/tmp/" + SHADER_NAME + "-" +
    Math.random().toString(36).slice(2, 10) + ".glsl";
}

function shaderParams(source, view, out, eye, dragging) {
  var projection = projectionName(source);
  if (!projection) return null;
  var horizontal = geometry.fovComponents(view.fov, out.width, out.height).h;
  var effective = effectiveEye(source, eye);
  var fishFov = source.inHFov || 180;
  return {
    projection: projection,
    fov: optionNumber(horizontal * RAD),
    yaw: optionNumber(view.yaw * RAD),
    pitch: optionNumber(view.pitch * RAD),
    roll: "0",
    eye: effective,
    fishFov: optionNumber(fishFov * RAD),
    sampling: dragging ? "linear" : samplingName(out.interp),
  };
}

function legacyKey(source, view, out, eye, dragging) {
  var params = shaderParams(source, view, out, eye, dragging);
  return params ? [
    params.projection, params.fov, params.yaw, params.pitch,
    params.eye, params.fishFov, params.sampling,
  ].join("|") : null;
}

/**
 * Convert the gpu-next shader into the legacy vo=gpu/libmpv format used by
 * IINA 1.5.1. mpv 0.41 rejects `//!PARAM`, so camera values become constants
 * in this copy. The projection code itself is shared with gpu-next.
 */
function legacyShader(source, view, out, eye, dragging) {
  var params = shaderParams(source, view, out, eye, dragging);
  if (!params) return null;

  // The legacy renderer recompiles the shader for every camera update. Keep
  // one texture sample per output pixel there; output dimensions and source
  // pixels stay unchanged.
  params.sampling = "linear";

  var desc = "//!DESC mpv360 - 360° Video Viewer";
  var marker = shader.indexOf(desc);
  if (marker < 0) return null;
  var bodyStart = shader.indexOf("\n", marker);
  if (bodyStart < 0) return null;

  var body = shader.slice(bodyStart + 1)
    .replace("const vec2 border =", "vec2 border =");
  var projectionNames = [
    "equirectangular",
    "dual_equirectangular",
    "dual_fisheye",
    "fisheye",
    "dual_half_equirectangular",
    "half_equirectangular",
    "dual_vert_equirectangular",
    "cylindrical",
    "equiangular_cubemap",
    "dual_equiangular_cubemap",
  ];
  var enumDefines = projectionNames.map(function (name, index) {
    return "#define " + name + " " + index;
  });

  return [
    "//!HOOK MAINPRESUB",
    "//!BIND HOOKED",
    desc,
    enumDefines.join("\n"),
    "#define left 0",
    "#define right 1",
    "#define both 2",
    "#define linear 0",
    "#define mitchell 1",
    "#define lanczos 2",
    "#define fov " + params.fov,
    "#define yaw " + params.yaw,
    "#define pitch " + params.pitch,
    "#define roll " + params.roll,
    "#define input_projection " + params.projection,
    "#define eye " + params.eye,
    "#define fisheye_fov " + params.fishFov,
    "#define sampling " + params.sampling,
    body,
  ].join("\n");
}

function setShaderOptions(params) {
  var options = [];
  try {
    var current = mpv.getNative("glsl-shader-opts");
    if (Array.isArray(current)) options = current.filter(function (item) {
      return typeof item === "string" && item.indexOf(SHADER_NAME + "/") !== 0;
    });
  } catch (e) {}
  options.push(params);
  mpv.command("change-list", ["glsl-shader-opts", "set", options.join(",")]);
}

function setOptions(source, view, out, eye, dragging) {
  var params = shaderParams(source, view, out, eye, dragging);
  if (!params) return false;
  setShaderOptions([
    SHADER_NAME + "/fov=" + params.fov,
    SHADER_NAME + "/yaw=" + params.yaw,
    SHADER_NAME + "/pitch=" + params.pitch,
    SHADER_NAME + "/roll=" + params.roll,
    SHADER_NAME + "/input_projection=" + params.projection,
    SHADER_NAME + "/eye=" + params.eye,
    SHADER_NAME + "/fisheye_fov=" + params.fishFov,
    SHADER_NAME + "/sampling=" + params.sampling,
  ].join(","));
  return true;
}

function replaceShader(oldPath, newPath) {
  var list = null;
  try {
    var current = mpv.getNative("glsl-shaders");
    if (Array.isArray(current)) list = current.slice();
    else if (typeof current === "string" && current.length) list = current.split(",");
  } catch (e) {}

  if (!list) {
    if (oldPath) mpv.command("change-list", ["glsl-shaders", "remove", oldPath]);
    mpv.command("change-list", ["glsl-shaders", "append", newPath]);
    return;
  }

  var index = oldPath ? list.indexOf(oldPath) : -1;
  if (index >= 0) list[index] = newPath;
  else list.push(newPath);
  mpv.command("change-list", ["glsl-shaders", "set", list.join(",")]);
}

function cleanup(path) {
  if (!path) return;
  try { file.trash(path); } catch (e) {}
}

function enable(source, view, out, eye, mode) {
  if (!isSupported(source) || mode === "off") {
    return fail(mode === "off" ? "GPU mode is off" : "projection is not supported by the GPU shader");
  }
  if (!gpuOutputActive()) return fail("IINA GPU passes are unavailable");

  legacyMode = currentVo() !== "gpu-next";
  var contents = legacyMode ? legacyShader(source, view, out, eye, false) : shader;
  if (!contents) return fail("could not generate GPU shader");

  try {
    if (!legacyMode) {
      shaderOptsBefore = [];
      try {
        var existing = mpv.getNative("glsl-shader-opts");
        if (Array.isArray(existing)) {
          shaderOptsBefore = existing.filter(function (item) {
            return typeof item === "string" && item.indexOf(SHADER_NAME + "/") !== 0;
          });
        }
      } catch (e) {}
    }

    SHADER_PATH = shaderPath();
    file.write(SHADER_PATH, contents);
    mpv.command("change-list", ["glsl-shaders", "append", SHADER_PATH]);
    if (!legacyMode && !setOptions(source, view, out, eye, false)) {
      disable();
      return fail("could not set GPU shader parameters");
    }
    active = true;
    lastLegacyKey = legacyMode ? legacyKey(source, view, out, eye, false) : null;
    lastError = null;
    return true;
  } catch (e) {
    try { console.error("VR2D GPU exception: " + String(e)); } catch (ignored) {}
    disable();
    return fail("shader file or GPU command failed: " + String(e));
  }
}

function update(source, view, out, eye, dragging) {
  if (!active) return false;
  try {
    if (!legacyMode) return setOptions(source, view, out, eye, !!dragging);

    var key = legacyKey(source, view, out, eye, !!dragging);
    if (key === lastLegacyKey) return true;
    var contents = legacyShader(source, view, out, eye, !!dragging);
    if (!contents) return false;
    var nextPath = shaderPath();
    file.write(nextPath, contents);
    var previousPath = SHADER_PATH;
    replaceShader(previousPath, nextPath);
    SHADER_PATH = nextPath;
    lastLegacyKey = key;
    cleanup(previousPath);
    return true;
  } catch (e) {
    try { console.error("VR2D legacy GPU update failed: " + String(e)); } catch (ignored) {}
    return false;
  }
}

function disable() {
  if (active && SHADER_PATH) {
    try { mpv.command("change-list", ["glsl-shaders", "remove", SHADER_PATH]); } catch (e) {}
    active = false;
  }
  if (!legacyMode) {
    try {
      if (shaderOptsBefore !== null) {
        mpv.command("change-list", ["glsl-shader-opts", "set", shaderOptsBefore.join(",")]);
      }
    } catch (e) {}
  }
  cleanup(SHADER_PATH);
  SHADER_PATH = null;
  shaderOptsBefore = null;
  lastLegacyKey = null;
  legacyMode = false;
}

module.exports = {
  enable: enable,
  update: update,
  disable: disable,
  isActive: function () { return active; },
  isLegacy: function () { return legacyMode; },
  lastError: function () { return lastError; },
  isSupported: isSupported,
};
