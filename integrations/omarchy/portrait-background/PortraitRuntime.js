.pragma library

// Bogen portrait background: the pure part. No files, no processes, no QML types: the plugin's PortraitMapping.qml
// feeds it text and numbers, and the Bogen test suite loads this same file in Node (packages/server/test/
// omarchy-portrait-runtime.test.ts) after dropping the pragma line above.
//
// A theme exported by Bogen may carry displays/portrait-runtime.json: data only, naming one composition per screen
// shape that is not landscape. Everything in it is untrusted. It is bounded and checked here, field by field; its
// pictures are measured from their own header bytes, never decoded by a tool that runs delegates, and a picture
// whose bytes, size or shape disagree with the manifest is not shown. A screen with no matching, verified
// composition keeps Omarchy's own background, so the desktop is never left blank.

var KIND = "bogen-portrait-runtime"
var FORMAT = 1
var MAX_MANIFEST_BYTES = 65536
var MAX_ENTRIES = 6
var MAX_ASSET_BYTES = 48 * 1024 * 1024
var MAX_HEADER_BYTES = 262144
var MIN_SIDE = 320
var MAX_SIDE = 16384
var SHAPE_TOLERANCE = 0.015
var DONE = ["artwork", "composed"]
var FILE_RE = /^displays\/[a-z0-9][a-z0-9._-]{0,80}\.(png|jpg|jpeg|webp)$/
var SHA_RE = /^[0-9a-f]{64}$/
var ASPECT_RE = /^(\d{1,3}(?:\.\d{1,3})?):(\d{1,3}(?:\.\d{1,3})?)$/
var VIDEO_RE = /\.(mp4|m4v|mov|webm|mkv|avi)$/i

function isVideoPath(path) {
  return VIDEO_RE.test(String(path || ""))
}

function orientationOf(width, height) {
  if (Math.abs(width - height) <= Math.max(width, height) * 0.05) return "square"
  return width > height ? "landscape" : "portrait"
}

function sameShape(aw, ah, bw, bh) {
  if (!(aw > 0 && ah > 0 && bw > 0 && bh > 0)) return false
  return Math.abs((aw / ah) / (bw / bh) - 1) <= SHAPE_TOLERANCE
}

function isInt(v, min, max) {
  return typeof v === "number" && isFinite(v) && Math.floor(v) === v && v >= min && v <= max
}

function plainText(v, max) {
  return String(v === undefined || v === null ? "" : v).replace(/[\u0000-\u001f\u007f<>&]/g, " ").slice(0, max)
}

// ------------------------------------------------------------------ base64 and headers

var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

/** Decodes base64 to a byte array, at most `limit` bytes. Null on anything that is not base64. */
function decodeBase64(text, limit) {
  var s = String(text || "").replace(/\s+/g, "")
  var max = limit || MAX_HEADER_BYTES
  if (s.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(s) || /=[^=]/.test(s)) return null
  var out = []
  for (var i = 0; i < s.length && out.length < max; i += 4) {
    var a = B64.indexOf(s.charAt(i)), b = B64.indexOf(s.charAt(i + 1))
    var c = s.charAt(i + 2) === "=" ? -1 : B64.indexOf(s.charAt(i + 2))
    var d = s.charAt(i + 3) === "=" ? -1 : B64.indexOf(s.charAt(i + 3))
    if (a < 0 || b < 0) return null
    out.push(((a << 2) | (b >> 4)) & 255)
    if (c >= 0) out.push((((b & 15) << 4) | (c >> 2)) & 255)
    if (d >= 0) out.push((((c & 3) << 6) | d) & 255)
  }
  return out.length > max ? out.slice(0, max) : out
}

function u16be(b, i) { return (b[i] << 8) | b[i + 1] }
function u32be(b, i) { return ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) }
function u16le(b, i) { return b[i] | (b[i + 1] << 8) }
function u24le(b, i) { return b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) }

/**
 * A picture's format and size from its first bytes: PNG, JPEG or WebP, as Bogen's own export writes them. Null for
 * anything else, including GIF, AVIF and SVG, and for a header that is cut short or out of bounds.
 */
function imageHeader(bytes) {
  var b = bytes
  if (!b || b.length < 24) return null
  var out = null
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    // The first chunk of a PNG is IHDR.
    if (b[12] !== 0x49 || b[13] !== 0x48 || b[14] !== 0x44 || b[15] !== 0x52) return null
    out = { format: "png", width: u32be(b, 16), height: u32be(b, 20) }
  } else if (b[0] === 0xff && b[1] === 0xd8) {
    var i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null
      var marker = b[i + 1]
      if (marker === 0xff) { i += 1; continue }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
      if (marker === 0xd9 || marker === 0xda) return null
      var len = u16be(b, i + 2)
      if (len < 2) return null
      var sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (sof) { out = { format: "jpeg", width: u16be(b, i + 7), height: u16be(b, i + 5) }; break }
      i += 2 + len
    }
    if (!out) return null
  } else if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    if (b.length < 30) return null
    var tag = String.fromCharCode(b[12], b[13], b[14], b[15])
    if (tag === "VP8 ") {
      if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null
      out = { format: "webp", width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff }
    } else if (tag === "VP8L") {
      if (b[20] !== 0x2f) return null
      var bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)
      out = { format: "webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
    } else if (tag === "VP8X") {
      out = { format: "webp", width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 }
    } else return null
  } else return null
  if (!isInt(out.width, 1, MAX_SIDE) || !isInt(out.height, 1, MAX_SIDE)) return null
  return out
}

function formatOfFile(file) {
  var ext = String(file).split(".").pop().toLowerCase()
  return ext === "jpg" || ext === "jpeg" ? "jpeg" : ext
}

// ------------------------------------------------------------------ the manifest

/**
 * Checks a parsed displays/portrait-runtime.json. Returns the compositions that may be shown, each with the reason
 * any other was left out. Only `artwork` and `composed` are ever shown: a stand-in from the palette, a picture of
 * another shape, or one whose size is unknown is listed as incomplete and keeps the global background.
 */
function validateManifest(raw) {
  var result = { ok: false, entries: [], incomplete: [], problems: [], theme: "", revision: "" }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) { result.problems.push("The runtime manifest is not a JSON object."); return result }
  if (raw.kind !== KIND) { result.problems.push("The runtime manifest is not a " + KIND + " file."); return result }
  if (raw.format !== FORMAT) { result.problems.push("The runtime manifest has format " + plainText(raw.format, 8) + "; this plugin reads format " + FORMAT + "."); return result }
  if (raw.appliesTo !== undefined && raw.appliesTo !== "theme-backgrounds") { result.problems.push("The runtime manifest applies to something this plugin does not know."); return result }
  result.theme = /^[a-z0-9][a-z0-9._-]{0,63}$/.test(String(raw.theme || "")) ? String(raw.theme) : ""
  result.revision = /^[0-9a-f]{8,64}$/.test(String(raw.revision || "")) ? String(raw.revision) : ""
  var list = Array.isArray(raw.wallpapers) ? raw.wallpapers : []
  if (list.length > MAX_ENTRIES) result.problems.push("The runtime manifest names " + list.length + " compositions; only the first " + MAX_ENTRIES + " are read.")
  var seen = {}
  for (var i = 0; i < Math.min(list.length, MAX_ENTRIES); i++) {
    var w = list[i]
    var label = "Composition " + (i + 1)
    if (!w || typeof w !== "object") { result.problems.push(label + " is not an object."); continue }
    var aspect = String(w.aspect || "")
    var m = ASPECT_RE.exec(aspect)
    if (!m) { result.problems.push(label + " has no readable aspect."); continue }
    label = "The " + aspect + " composition"
    var status = String(w.status || "")
    if (DONE.indexOf(status) === -1) {
      result.incomplete.push({ aspect: aspect, status: plainText(status || "unknown", 24), reason: plainText(w.reason || "It is not designed for this shape yet.", 300) })
      continue
    }
    if (!isInt(w.width, MIN_SIDE, MAX_SIDE) || !isInt(w.height, MIN_SIDE, MAX_SIDE)) { result.problems.push(label + " has no valid width and height."); continue }
    var ar = parseFloat(m[1]) / parseFloat(m[2])
    if (!(ar > 0) || Math.abs((w.width / w.height) / ar - 1) > SHAPE_TOLERANCE) { result.problems.push(label + " is " + w.width + " × " + w.height + ", which is not " + aspect + "."); continue }
    var o = orientationOf(w.width, w.height)
    if (o === "landscape") { result.problems.push(label + " is landscape; landscape screens use the theme's own backgrounds."); continue }
    if (w.orientation !== undefined && w.orientation !== o) { result.problems.push(label + " says it is " + plainText(w.orientation, 16) + ", but it is " + o + "."); continue }
    var file = String(w.file || "")
    if (!FILE_RE.test(file) || file.indexOf("..") !== -1) { result.problems.push(label + " names a file outside displays/ or of a kind this plugin does not show (PNG, JPEG, WebP)."); continue }
    if (!SHA_RE.test(String(w.sha256 || ""))) { result.problems.push(label + " has no sha256."); continue }
    if (!isInt(w.bytes, 1, MAX_ASSET_BYTES)) { result.problems.push(label + " has no size in bytes, or is larger than " + (MAX_ASSET_BYTES / 1048576) + " MB."); continue }
    if (seen[aspect]) { result.problems.push(label + " is named twice; the first is used."); continue }
    seen[aspect] = true
    result.entries.push({ aspect: aspect, orientation: o, width: w.width, height: w.height, file: file, sha256: String(w.sha256), bytes: w.bytes, status: status, format: formatOfFile(file) })
  }
  var extra = Array.isArray(raw.incomplete) ? raw.incomplete.slice(0, MAX_ENTRIES) : []
  for (var j = 0; j < extra.length; j++) {
    var x = extra[j]
    if (!x || typeof x !== "object" || !ASPECT_RE.test(String(x.aspect || ""))) continue
    result.incomplete.push({ aspect: String(x.aspect), status: plainText(x.status || "needs-design", 24), reason: plainText(x.reason || "It is not designed for this shape yet.", 300) })
  }
  result.ok = result.entries.length > 0
  return result
}

/** Parses a manifest from text, bounded. */
function parseManifestText(text) {
  var s = String(text || "")
  if (s.length > MAX_MANIFEST_BYTES) return validateManifest(null)
  var raw = null
  try { raw = JSON.parse(s) } catch (e) { raw = null }
  return validateManifest(raw)
}

/** `key value` lines from the plugin's fixed scripts; the value runs to the end of its line. */
function parseKeyLines(text) {
  var out = {}
  var lines = String(text || "").split("\n")
  for (var i = 0; i < lines.length && i < 64; i++) {
    var line = lines[i]
    var sp = line.indexOf(" ")
    var key = sp === -1 ? line : line.slice(0, sp)
    if (!/^[a-z][a-z-]{0,23}$/.test(key) || out[key] !== undefined) continue
    out[key] = sp === -1 ? "" : line.slice(sp + 1)
  }
  return out
}

/**
 * Checks what the asset script found against the manifest entry: the copy's sha256, its byte count and its header.
 * Returns the entry, ready to show, or a reason it is not.
 */
function verifyAsset(entry, report) {
  if (!report || report.status) return { ok: false, reason: assetReason(report ? report.status : "no-report") }
  var path = String(report.path || "")
  if (!path || path.charAt(0) !== "/" || path.indexOf("/../") !== -1 || path.indexOf("\n") !== -1) return { ok: false, reason: "The copy has no usable path." }
  if (String(report.bytes) !== String(entry.bytes)) return { ok: false, reason: "The file is " + plainText(report.bytes, 16) + " bytes; the manifest says " + entry.bytes + ". It changed after the theme was exported." }
  var head = imageHeader(decodeBase64(report.header, MAX_HEADER_BYTES))
  if (!head) return { ok: false, reason: "Its header is not a PNG, JPEG or WebP this plugin can measure." }
  if (head.format !== entry.format) return { ok: false, reason: "It is a " + head.format + " named ." + entry.file.split(".").pop() + "." }
  if (head.width !== entry.width || head.height !== entry.height) return { ok: false, reason: "It is " + head.width + " × " + head.height + "; the manifest says " + entry.width + " × " + entry.height + "." }
  return { ok: true, entry: { aspect: entry.aspect, orientation: entry.orientation, width: head.width, height: head.height, path: path, file: entry.file, status: entry.status } }
}

function assetReason(status) {
  var s = String(status || "")
  if (s === "missing") return "The file is not in the theme."
  if (s === "link") return "The file is a link, or under one; this plugin shows only files inside the theme."
  if (s === "not-file") return "It is not a regular file."
  if (s.indexOf("size") === 0) return "Its size is outside what this plugin shows (at most " + (MAX_ASSET_BYTES / 1048576) + " MB)."
  if (s.indexOf("sha") === 0) return "Its bytes do not match the manifest's sha256: it changed after the theme was exported."
  if (s === "cache") return "The plugin could not copy it into its cache."
  return "It could not be checked (" + plainText(s, 40) + ")."
}

// ------------------------------------------------------------------ choosing per screen

/** Whether a background path is one of the current theme's own stills: under its backgrounds/ folder, not a video. */
function isThemeStill(path, themeDirs) {
  var p = String(path || "")
  if (!p || p.charAt(0) !== "/" || isVideoPath(p) || p.indexOf("/../") !== -1 || p.indexOf("/./") !== -1) return false
  for (var i = 0; i < (themeDirs || []).length; i++) {
    var dir = String(themeDirs[i] || "").replace(/\/+$/, "")
    if (!dir) continue
    var prefix = dir + "/backgrounds/"
    if (p.indexOf(prefix) === 0 && p.slice(prefix.length).indexOf("/") === -1 && p.length > prefix.length) return true
  }
  return false
}

/**
 * The composition a screen of this logical size shows from `map`, or null. Only a screen whose shape matches a
 * composition within 1.5 % takes it, so nothing is cropped beyond a sliver; a landscape screen never does. The
 * transform (rotation, mirroring) and scale are already in the logical size the shell lays the screen out in.
 */
function entryFor(map, width, height, failed) {
  if (!map || !map.entries || !(width > 0) || !(height > 0)) return null
  if (orientationOf(width, height) === "landscape") return null
  var best = null
  for (var i = 0; i < map.entries.length; i++) {
    var e = map.entries[i]
    if (failed && failed[e.path]) continue
    if (!sameShape(width, height, e.width, e.height)) continue
    if (!best || e.width * e.height > best.width * best.height) best = e
  }
  return best
}

/** What a screen draws for a global background path: its composition when the map has one for it, else the path. */
function screenPath(globalPath, map, width, height, failed) {
  if (!globalPath || isVideoPath(globalPath)) return globalPath
  var e = entryFor(map, width, height, failed)
  return e ? e.path : globalPath
}

/** The cache files a set of maps still needs, so the rest can go. */
function pathsOf(maps) {
  var out = []
  for (var i = 0; i < maps.length; i++) {
    var m = maps[i]
    if (!m || !m.entries) continue
    for (var j = 0; j < m.entries.length; j++) if (out.indexOf(m.entries[j].path) === -1) out.push(m.entries[j].path)
  }
  return out
}

// ------------------------------------------------------------------ what a check leaves

/**
 * The outcome of one check of the current theme, every field set, so nothing of an earlier theme survives it: a theme
 * without a manifest reports no theme name or revision, not the last theme's. `details` may hold theme, revision,
 * problems, incomplete and rejected; the name and revision count only where a manifest was read.
 */
function outcome(map, state, details) {
  var d = details || {}
  var read = state === "active" || state === "incomplete" || state === "invalid"
  var list = function(v) { return Array.isArray(v) ? v.slice(0, 16) : [] }
  return {
    map: map || null,
    state: String(state || "error"),
    theme: read && d.theme ? plainText(d.theme, 64) : "",
    revision: read && d.revision ? plainText(d.revision, 64) : "",
    problems: list(d.problems),
    incomplete: list(d.incomplete),
    rejected: list(d.rejected)
  }
}

// ------------------------------------------------------------------ which map each frame takes

/**
 * The maps the frames on screen take once the current theme's map is known, or known to be absent. `frames` is the
 * background service's state: the incoming, current and displayed paths, revealProgress, and the maps the incoming
 * and displayed frames hold. A displayed frame under a running reveal keeps the map it started with; otherwise it
 * takes the new one, also when its path did not change, as when a theme is applied again on the same still. (Omarchy
 * then ends the reveal on an unchanged path, so no change of the displayed path ever says so.)
 */
function mapsAfterResolve(frames, mapFor) {
  var revealing = !!frames.incoming && frames.revealProgress < 1
  return {
    incomingMap: frames.incoming ? mapFor(frames.current) : frames.incomingMap,
    displayedMap: revealing ? frames.displayedMap : mapFor(frames.displayed)
  }
}

/** The displayed frame's map when a reveal ends: the incoming frame's, whether or not the displayed path changed. */
function displayedMapAtRevealEnd(frames) {
  return frames.incoming ? frames.incomingMap : frames.displayedMap
}

/** The displayed frame's map when its path changes: the incoming frame's at a reveal's end, else none while checking. */
function displayedMapOnPathChange(frames, holding, mapFor) {
  if (frames.incoming) return frames.incomingMap
  return holding ? null : mapFor(frames.displayed)
}
