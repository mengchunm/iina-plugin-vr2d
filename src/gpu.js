"use strict";

/**
 * GPU reprojection using the mpv360/libplacebo shader model.
 *
 * The shader is adapted from kasper93/mpv360 (MIT License). It runs at
 * MAINPRESUB and receives camera changes through glsl-shader-opts, so panning
 * never rebuilds an FFmpeg filter graph.
 */

var mpv = iina.mpv;
var file = iina.file;
var geometry = require("./geometry.js");
var shader = require("./gpu-shader.js");

var SHADER_NAME = "iina-vr2d";
var SHADER_PATH = "/private/tmp/" + SHADER_NAME + ".glsl";
var active = false;
var lastError = null;
var RAD = Math.PI / 180;

function projectionName(source) {
  if (!source) return null;
  if (source.projection === "e") {
    if (source.layout === "mono") return "equirectangular";
    if (source.layout === "tb") return "dual_vert_equirectangular";
    // The mature shader has no horizontal dual full-sphere mode. VR180 SBS
    // sources are detected as `he`, which is handled below.
    return null;
  }
  if (source.projection === "he") {
    if (source.layout === "mono") return "half_equirectangular";
    if (source.layout === "sbs") return "dual_half_equirectangular";
    return null;
  }
  if (source.projection === "fisheye" && source.layout === "sbs") {
    return "dual_fisheye";
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
    return mpv.getString("vo");
  } catch (e) {
    return "";
  }
}

function gpuOutputActive() {
  var vo = currentVo();
  if (vo === "gpu-next" || vo === "libmpv") return true;
  // IINA can expose libmpv as the vo property while its internal renderer is
  // gpu-next. vo-passes is populated by the libplacebo renderer and avoids
  // falling back to CPU just because of that wrapper name.
  try {
    var passes = mpv.getNative("vo-passes");
    return !!(passes && (Array.isArray(passes) ? passes.length : true));
  } catch (e) {
    return false;
  }
}

function fail(reason) {
  lastError = reason;
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

function setOptions(source, view, out, eye) {
  var projection = projectionName(source);
  if (!projection) return false;

  // The plugin stores a diagonal FOV in degrees; mpv360's shader expects a
  // horizontal FOV in radians.
  var horizontal = geometry.fovComponents(view.fov, out.width, out.height).h;
  var effective = effectiveEye(source, eye);
  var fishFov = source.inHFov || 180;
  var params = [
    SHADER_NAME + "/fov=" + optionNumber(horizontal * RAD),
    SHADER_NAME + "/yaw=" + optionNumber(view.yaw * RAD),
    SHADER_NAME + "/pitch=" + optionNumber(view.pitch * RAD),
    SHADER_NAME + "/roll=0",
    SHADER_NAME + "/input_projection=" + projection,
    SHADER_NAME + "/eye=" + effective,
    SHADER_NAME + "/fisheye_fov=" + optionNumber(fishFov * RAD),
    SHADER_NAME + "/sampling=" + samplingName(out.interp),
  ].join(",");

  // `change-list ... add` is the update pattern used by mpv360 itself. It
  // updates libplacebo parameters without rebuilding the video filter graph.
  mpv.command("change-list", ["glsl-shader-opts", "add", params]);
  return true;
}

function enable(source, view, out, eye, mode) {
  if (!isSupported(source) || mode === "off") return fail(mode === "off" ? "GPU mode is off" : "projection is not supported by the GPU shader");

  if (!gpuOutputActive()) return fail("IINA GPU passes are unavailable");

  try {
    file.write(SHADER_PATH, shader);
    mpv.command("change-list", ["glsl-shaders", "append", SHADER_PATH]);
    if (!setOptions(source, view, out, eye)) {
      disable();
      return fail("could not set GPU shader parameters");
    }
    active = true;
    lastError = null;
    return true;
  } catch (e) {
    disable();
    return fail("shader file or GPU command failed: " + String(e));
  }
}

function update(source, view, out, eye) {
  if (!active) return false;
  try {
    return setOptions(source, view, out, eye);
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
  lastError: function () { return lastError; },
  isSupported: isSupported,
};
