import QtQuick
import Quickshell
import Quickshell.Io
import "PortraitRuntime.js" as Portrait

// Bogen portrait background: which composition each screen draws. Background.qml (Omarchy's own, patched in a few
// marked places when Bogen installs this plugin) asks screenPath() for every frame it draws; everything else it does,
// transitions, decode sizes, intros, OWE's videos, clicks and IPC, stays Omarchy's.
//
// A map is a verified set of compositions for one theme. Three are kept on the host, one per frame on screen: the
// displayed one, the incoming one of a running reveal, and the outgoing one. A map is taken when the frame starts,
// so a reveal never mixes the old theme's picture with the new theme's map, and a portrait screen falls back to the
// global background, never to nothing, while a new theme is checked.
//
// Nothing from a theme is run. The theme's manifest and pictures are read by the fixed scripts below, which take
// every path as an argument: realpath containment (no links, nothing outside the theme's displays/), size bounds, a
// copy into a private cache, and the copy's sha256 against the manifest. The copy is what is shown, measured from its
// own header, so a file swapped after the check is never drawn.
Item {
  id: mapping
  visible: false

  required property var host

  readonly property string pluginVersion: "1.0.2"
  readonly property string home: Quickshell.env("HOME")
  readonly property string themeLink: home + "/.local/state/omarchy/current/theme"
  readonly property string cacheDir: (Quickshell.env("XDG_CACHE_HOME") || (home + "/.cache")) + "/bogen/portrait-background"

  // The current theme's verified map, or null.
  property var active: null
  // starting, resolving, active, no-theme, no-manifest, incomplete, invalid or error.
  property string mapState: "starting"
  property var problems: []
  property var incomplete: []
  property var rejected: []
  property string themeName: ""
  property string revision: ""
  property var failed: ({})
  property int failedVersion: 0
  // Held while a new theme's map is checked, at most holdTimer's interval, so the reveal starts on the right picture.
  property bool holding: false
  property bool again: false
  property var work: null

  function isVideo(path) { return Portrait.isVideoPath(path) }

  function mapFor(path) {
    return active && Portrait.isThemeStill(path, active.themeDirs) ? active : null
  }

  // Called by Background.transitionBackground as each frame starts, before anything changes on screen.
  function beginTransition(fromPath, path, finalPath) {
    host.portraitOldMap = host.portraitDisplayedMap
    host.portraitIncomingMap = null
    holding = true
    holdTimer.restart()
    resolve()
  }

  function screenPath(globalPath, map, width, height) {
    var _ = failedVersion
    return Portrait.screenPath(globalPath, map, width, height, failed)
  }

  function owns(path) {
    return String(path || "").indexOf(cacheDir + "/") === 0
  }

  function markFailed(path) {
    if (!owns(path) || failed[path]) return
    var next = Object.assign({}, failed)
    next[path] = true
    failed = next
    failedVersion += 1
    console.warn("bogen.portrait-background: could not load " + path + "; that screen keeps the global background")
  }

  function nativeSize(path) {
    var maps = [host.portraitDisplayedMap, host.portraitIncomingMap, host.portraitOldMap, active]
    for (var i = 0; i < maps.length; i++) {
      var m = maps[i]
      if (!m) continue
      for (var j = 0; j < m.entries.length; j++) if (m.entries[j].path === path) return { width: m.entries[j].width, height: m.entries[j].height }
    }
    return undefined
  }

  function resolve() {
    if (resolveProc.running || assetProc.running) { again = true; return }
    again = false
    mapState = "resolving"
    work = null
    resolveProc.running = true
  }

  function fail(newState, list, details) {
    finish(Portrait.outcome(null, newState, Object.assign({}, details || {}, { problems: list || [] })))
  }

  // Everything the status reports is set from one outcome, so a theme without a manifest never shows the last one's.
  function finish(result) {
    work = null
    // A theme switched while this one was checked: check again rather than show a map of the wrong theme.
    if (again) { Qt.callLater(mapping.resolve); return }
    active = result.map
    mapState = result.state
    themeName = result.theme
    revision = result.revision
    problems = result.problems
    incomplete = result.incomplete
    rejected = result.rejected
    var next = Portrait.mapsAfterResolve(frames(), mapFor)
    host.portraitIncomingMap = next.incomingMap
    host.portraitDisplayedMap = next.displayedMap
    holding = false
    holdTimer.stop()
    prune()
  }

  // The background service's frames, as PortraitRuntime.js reads them.
  function frames() {
    return {
      incoming: String(host.incomingBackground || ""), current: String(host.currentBackground || ""), displayed: String(host.displayedBackground || ""),
      revealProgress: host.revealProgress, incomingMap: host.portraitIncomingMap, displayedMap: host.portraitDisplayedMap
    }
  }

  function onResolved(text) {
    var s = String(text || "")
    var cut = s.indexOf("\nmanifest\n")
    var head = Portrait.parseKeyLines(cut === -1 ? s : s.slice(0, cut))
    if (head.status !== undefined) {
      var st = head.status
      if (st === "no-theme") return fail("no-theme", ["There is no current Omarchy theme."])
      if (st === "no-manifest") return fail("no-manifest", [])
      if (st === "link") return fail("invalid", ["displays/portrait-runtime.json is a link; it is not read."])
      if (st === "too-large") return fail("invalid", ["displays/portrait-runtime.json is larger than 64 KB; it is not read."])
      return fail("error", ["The theme could not be read (" + Portrait.plainText(st, 24) + ")."])
    }
    var theme = String(head.theme || "")
    if (cut === -1 || theme.charAt(0) !== "/") return fail("error", ["The theme could not be read."])
    var m = Portrait.parseManifestText(s.slice(cut + 10))
    if (!m.ok) return fail(m.incomplete.length && !m.problems.length ? "incomplete" : "invalid", m.problems, { theme: m.theme, revision: m.revision, incomplete: m.incomplete })
    work = { theme: theme, themeName: m.theme, revision: m.revision, queue: m.entries.slice(), entries: [], rejected: [], problems: m.problems, incomplete: m.incomplete }
    nextAsset()
  }

  function nextAsset() {
    if (!work) return
    if (!work.queue.length) {
      var map = work.entries.length ? { themeDirs: [themeLink, work.theme], theme: work.themeName, revision: work.revision, entries: work.entries } : null
      var verdict = map ? "active" : (work.incomplete.length && !work.rejected.length ? "incomplete" : "invalid")
      return finish(Portrait.outcome(map, verdict, { theme: work.themeName, revision: work.revision, problems: work.problems, incomplete: work.incomplete, rejected: work.rejected }))
    }
    var e = work.queue[0]
    assetProc.entry = e
    assetProc.command = ["bash", "-c", assetScript, "bogen-portrait-asset", work.theme, e.file, cacheDir, e.sha256, String(e.bytes), e.file.split(".").pop().toLowerCase()]
    assetProc.running = true
  }

  function onAsset(text) {
    if (!work) return
    var e = work.queue.shift()
    var verdict = Portrait.verifyAsset(e, Portrait.parseKeyLines(text))
    if (verdict.ok && !owns(verdict.entry.path)) verdict = { ok: false, reason: "The copy is outside the plugin's cache." }
    if (verdict.ok) work.entries.push(verdict.entry)
    else {
      work.rejected.push({ aspect: e.aspect, file: e.file, reason: verdict.reason })
      console.warn("bogen.portrait-background: " + e.file + " is not shown: " + verdict.reason)
    }
    nextAsset()
  }

  function prune() {
    if (pruneProc.running) return
    var keep = Portrait.pathsOf([active, host.portraitDisplayedMap, host.portraitIncomingMap, host.portraitOldMap])
    var names = []
    for (var i = 0; i < keep.length; i++) if (owns(keep[i])) names.push(keep[i].slice(cacheDir.length + 1))
    pruneProc.command = ["bash", "-c", pruneScript, "bogen-portrait-prune", cacheDir].concat(names)
    pruneProc.running = true
  }

  // What `omarchy-shell background portraitStatus` prints: the plugin, the theme's map and every screen's choice.
  function status() {
    var screens = []
    var list = Quickshell.screens
    for (var i = 0; i < list.length && i < 16; i++) {
      var s = list[i]
      var e = Portrait.entryFor(host.portraitDisplayedMap, s.width, s.height, failed)
      screens.push({
        name: String(s.name || ""), width: s.width, height: s.height, orientation: Portrait.orientationOf(s.width, s.height),
        shows: e ? "portrait " + e.aspect : "global background",
        reason: e ? "" : (Portrait.orientationOf(s.width, s.height) === "landscape" ? "landscape" : (active ? "no verified composition of this shape" : "no verified map for this theme"))
      })
    }
    return JSON.stringify({
      plugin: "bogen.portrait-background", version: pluginVersion, state: mapState, theme: themeName, revision: revision,
      compositions: active ? active.entries.map(function(x) { return { aspect: x.aspect, width: x.width, height: x.height, file: x.file, status: x.status } }) : [],
      incomplete: incomplete, rejected: rejected, problems: problems, screens: screens,
      displayed: String(host.displayedBackground || ""), video: isVideo(host.displayedBackground)
    })
  }

  Connections {
    target: mapping.host
    function onDisplayedBackgroundChanged() {
      mapping.host.portraitDisplayedMap = Portrait.displayedMapOnPathChange(mapping.frames(), mapping.holding, mapping.mapFor)
    }
    // A reveal ends by setting finishingTransition, also when the displayed path stays the same (a theme applied
    // again on the same still), which onDisplayedBackgroundChanged never hears about.
    function onFinishingTransitionChanged() {
      if (mapping.host.finishingTransition) mapping.host.portraitDisplayedMap = Portrait.displayedMapAtRevealEnd(mapping.frames())
    }
  }

  Timer {
    id: holdTimer
    interval: 1500
    repeat: false
    onTriggered: mapping.holding = false
  }

  readonly property string resolveScript: [
    'theme=$(realpath -e -- "$1" 2>/dev/null) || { echo "status no-theme"; exit 0; }',
    '[[ -d $theme ]] || { echo "status no-theme"; exit 0; }',
    'm="$theme/displays/portrait-runtime.json"',
    '[[ -e $m || -L $m ]] || { echo "status no-manifest"; exit 0; }',
    'real=$(realpath -e -- "$m" 2>/dev/null) || { echo "status link"; exit 0; }',
    '[[ $real == "$m" && -f $real ]] || { echo "status link"; exit 0; }',
    'size=$(stat -c %s -- "$real") || { echo "status unreadable"; exit 0; }',
    '(( size <= 65536 )) || { echo "status too-large"; exit 0; }',
    'printf "theme %s\\n" "$theme"',
    'echo manifest',
    'cat -- "$real"'
  ].join("\n")

  readonly property string assetScript: [
    'theme=$1 rel=$2 cache=$3 sha=$4 want=$5 ext=$6',
    '[[ $sha =~ ^[0-9a-f]{64}$ && $ext =~ ^(png|jpg|jpeg|webp)$ && $rel =~ ^displays/[a-z0-9][a-z0-9._-]*$ ]] || { echo "status arguments"; exit 0; }',
    'src="$theme/$rel"',
    'real=$(realpath -e -- "$src" 2>/dev/null) || { echo "status missing"; exit 0; }',
    '[[ $real == "$src" ]] || { echo "status link"; exit 0; }',
    '[[ -f $real ]] || { echo "status not-file"; exit 0; }',
    'size=$(stat -c %s -- "$real") || { echo "status missing"; exit 0; }',
    '(( size > 0 && size <= 50331648 )) || { echo "status size"; exit 0; }',
    '(umask 077; mkdir -p -- "$cache") || { echo "status cache"; exit 0; }',
    '[[ -d $cache && ! -L $cache ]] || { echo "status cache"; exit 0; }',
    'dst="$cache/$sha.$ext"',
    'if [[ -L $dst || ! -f $dst ]]; then',
    '  rm -f -- "$dst"',
    '  tmp=$(mktemp -- "$cache/.incoming.XXXXXX") || { echo "status cache"; exit 0; }',
    '  if ! { cp -- "$real" "$tmp" && mv -f -- "$tmp" "$dst"; }; then rm -f -- "$tmp"; echo "status cache"; exit 0; fi',
    'fi',
    'got=$(sha256sum -- "$dst") || { echo "status cache"; exit 0; }',
    '[[ ${got%% *} == "$sha" ]] || { rm -f -- "$dst"; echo "status sha"; exit 0; }',
    'printf "path %s\\n" "$dst"',
    'printf "bytes %s\\n" "$(stat -c %s -- "$dst")"',
    'printf "header "; head -c 262144 -- "$dst" | base64 -w 0; echo'
  ].join("\n")

  readonly property string pruneScript: [
    'cache=$1; shift',
    '[[ -d $cache && ! -L $cache ]] || exit 0',
    'for f in "$cache"/*; do',
    '  [[ -f $f && ! -L $f ]] || continue',
    '  n=${f##*/}; keep=0',
    '  for k in "$@"; do [[ $n == "$k" ]] && keep=1; done',
    '  (( keep )) || rm -f -- "$f"',
    'done'
  ].join("\n")

  Process {
    id: resolveProc
    command: ["bash", "-c", mapping.resolveScript, "bogen-portrait-resolve", mapping.themeLink]
    stdout: StdioCollector { id: resolveOut }
    onExited: function(exitCode) {
      if (exitCode !== 0) mapping.fail("error", ["The theme check exited with " + exitCode + "."])
      else mapping.onResolved(resolveOut.text)
    }
  }

  Process {
    id: assetProc
    property var entry: null
    stdout: StdioCollector { id: assetOut }
    onExited: function(exitCode) {
      mapping.onAsset(exitCode === 0 ? assetOut.text : "status exit-" + exitCode)
    }
  }

  Process {
    id: pruneProc
  }
}
