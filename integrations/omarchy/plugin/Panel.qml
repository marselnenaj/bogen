import QtQuick
import QtQuick.Controls
import QtQuick.Shapes
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Commons as Commons
import qs.Ui

// Bogen in the Omarchy bar. One icon, one panel, nothing else mounted.
//
// Status comes from the server over XMLHttpRequest rather than a curl process:
// polling is in-process, forks nothing, and an unchanged answer is dropped before
// it can touch a binding, so an idle bar repaints nothing.
Panel {
  id: root
  moduleName: "dev.bogen.bogen"
  ipcTarget: "dev.bogen.bogen"
  // The shell routes summon/toggle to the focused monitor's instance. Only the
  // status/refresh handler below is ours, and only one instance may hold it.
  manageIpc: false

  readonly property color foreground: bar ? bar.foreground : Commons.Color.foreground
  readonly property color urgent: bar ? bar.urgent : Commons.Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  readonly property int port: Number(setting("port", 29990)) || 29990
  readonly property string baseUrl: "http://127.0.0.1:" + port
  readonly property string serviceName: "bogen.service"
  // Chromium names app windows after host and path: chrome-127.0.0.1__-Default.
  readonly property string windowPattern: "127\\.0\\.0\\.1__"

  // "unknown" until the first answer, so the icon doesn't flash stopped at login.
  property string serverState: "unknown"
  readonly property bool reachable: serverState === "running"
  // "start" or "stop" while systemctl and the server catch up with each other.
  property string transition: ""
  property double transitionStarted: 0

  property var status: ({ version: "", files: 0, agents: [] })
  property var files: []
  property string message: ""
  property double nowMs: Date.now()

  readonly property var agents: Array.isArray(status.agents) ? status.agents : []
  readonly property var workingAgents: agents.filter(function(a) { return a && a.status === "working" })
  readonly property bool working: reachable && workingAgents.length > 0
  readonly property int fileCount: Number(status.files) || 0
  readonly property var releaseUpdate: status.update && status.update.version ? status.update : null
  readonly property var recentFiles: files.slice(0, 6)
  property var runs: []
  property string lastRunsText: ""
  readonly property var recentRuns: runs.slice(0, 5)

  property bool hyprAnimations: true
  readonly property bool pulsing: working && setting("pulse", true) !== false && hyprAnimations

  // Set once per poll. Exactly one per-monitor instance notifies and answers IPC.
  property bool owner: false

  // Keyboard cursor over one flat list: switch, the two buttons, agents, files.
  property int cursorIndex: 0
  property bool cursorActive: false
  readonly property int rowNew: 1
  readonly property int rowOpen: 2
  readonly property int rowPair: 3
  readonly property int rowAgents: 4
  readonly property int rowRuns: rowAgents + workingAgents.length
  readonly property int rowFiles: rowRuns + recentRuns.length
  readonly property int rowCount: rowFiles + recentFiles.length

  // A pairing code for a phone while one is on show, with its link as QR rows, and who paired last.
  property var pairing: null
  property int pairDevices: 0
  property string pairedName: ""

  // What to do once a server we just asked to start answers.
  property var whenRunning: null

  property string lastStatusText: ""
  property string lastFilesText: ""
  property var statusRequest: null
  property int stalled: 0
  property var previousWorking: ({})
  property bool hasBaseline: false
  // Where the list of notifications was left. -1 until the first answer, so nothing old is announced.
  property double notifiedSeq: -1

  // -------------------------------------------------------------- wording

  function plural(count, word) { return count + " " + word + (count === 1 ? "" : "s") }

  function summary() {
    if (transition === "start") return "Starting server"
    if (transition === "stop") return "Stopping server"
    if (serverState === "unknown") return "Checking server"
    if (!reachable) return "Server stopped"
    if (working) return plural(workingAgents.length, "agent") + " working"
    return plural(fileCount, "file") + peerSummary()
  }

  // Device sync, when paired: " · MacBook connected".
  function peerSummary() {
    var peers = Array.isArray(status.peers) ? status.peers : []
    if (!peers.length) return ""
    var stale = peers.filter(function(p) { return p && p.versionMismatch === true })
    if (stale.length) return " · " + String(stale[0].name) + " runs another version"
    var up = peers.filter(function(p) { return p && p.state === "connected" })
    var first = up.length ? up[0] : peers[0]
    var more = peers.length > 1 ? " +" + (peers.length - 1) : ""
    return " · " + String(first.name) + more + (up.length ? " connected" : " offline")
  }

  function agentDetail(agent) {
    var parts = []
    if (agent.fileName) parts.push(String(agent.fileName))
    if (agent.lastTool) parts.push(String(agent.lastTool))
    return parts.join(" · ")
  }

  function ago(value) {
    var then = new Date(value).getTime()
    if (!isFinite(then)) return ""
    var seconds = Math.max(0, Math.round((nowMs - then) / 1000))
    if (seconds < 60) return "now"
    if (seconds < 3600) return Math.floor(seconds / 60) + "m"
    if (seconds < 86400) return Math.floor(seconds / 3600) + "h"
    return Math.floor(seconds / 86400) + "d"
  }

  // -------------------------------------------------------------- server API

  function request(method, path, body, done) {
    var xhr = new XMLHttpRequest()
    xhr.onreadystatechange = function() {
      if (xhr.readyState !== XMLHttpRequest.DONE) return
      done(xhr.status, xhr.responseText)
    }
    xhr.open(method, baseUrl + path)
    if (body !== null) xhr.setRequestHeader("Content-Type", "application/json")
    xhr.send(body === null ? "" : JSON.stringify(body))
    return xhr
  }

  function poll() {
    owner = computeOwner()
    if (transition !== "" && Date.now() - transitionStarted > 20000) {
      if (transition === "start") message = "The server did not answer in time. See: journalctl --user -u " + serviceName
      transition = ""
      whenRunning = null
    }
    // A request still open at the next tick is a server too busy to answer. Once
    // is a busy server; twice is the same as not running.
    if (statusRequest) {
      statusRequest.abort()
      statusRequest = null
      if (++stalled < 2) return
      markStopped()
      return
    }
    statusRequest = request("GET", "/api/status", null, function(code, text) {
      statusRequest = null
      if (code === 0) { markStopped(); return }
      stalled = 0
      if (code < 200 || code >= 300) { markStopped(); return }
      receiveStatus(text)
    })
    if (opened) {
      refreshFiles()
      refreshRuns()
    }
    if (owner && reachable) refreshNotifications()
    if (opened && pairing) checkPaired()
  }

  function refreshRuns() {
    if (!reachable) return
    request("GET", "/api/runs/recent?limit=5", null, function(code, text) {
      if (code < 200 || code >= 300 || text === lastRunsText) return
      try {
        let list = JSON.parse(text)
        if (!Array.isArray(list)) return
        runs = list
        lastRunsText = text
      } catch (e) {}
    })
  }

  function runDetail(run) {
    var parts = [String(run.runner || "")]
    var model = run.actualModel || run.model
    if (model) parts.push(String(model))
    if (run.fileName) parts.push(String(run.fileName))
    if (run.status && run.status !== "done") parts.push(String(run.status))
    return parts.join(" · ")
  }

  function refreshNotifications() {
    var since = notifiedSeq < 0 ? 0 : notifiedSeq
    request("GET", "/api/notifications?since=" + since, null, function(code, text) {
      if (code < 200 || code >= 300) return
      try {
        let answer = JSON.parse(text)
        var first = notifiedSeq < 0
        // A server that restarted counts from zero again.
        if (Number(answer.seq) < notifiedSeq) notifiedSeq = 0
        notifiedSeq = Number(answer.seq) || 0
        if (first || setting("notifyOnComment", true) === false) return
        var items = Array.isArray(answer.items) ? answer.items : []
        for (let i = 0; i < items.length; i++) notifyItem(items[i])
      } catch (e) {}
    })
  }

  function notifyItem(item) {
    var args = ["omarchy-notification-send", "--app-name=Bogen", "-i", "bogen", "-u", "normal",
                String(item.title || "Bogen"),
                String(item.body || item.fileName || "Bogen")]
    if (item.fileId) args = args.concat(["--exec", "omarchy-launch-webapp", fileUrl(item.fileId)])
    Util.execArgv(args)
  }

  function refreshFiles() {
    if (!reachable) return
    request("GET", "/api/files", null, function(code, text) {
      if (code < 200 || code >= 300 || text === lastFilesText) return
      try {
        let list = JSON.parse(text)
        if (!Array.isArray(list)) return
        list.sort(function(a, b) { return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime() })
        files = list
        lastFilesText = text
      } catch (e) {}
    })
  }

  function receiveStatus(text) {
    if (serverState !== "running") {
      serverState = "running"
      if (transition === "start") transition = ""
      message = ""
      if (opened) {
        refreshFiles()
        refreshRuns()
      }
      if (owner) refreshNotifications()
    }
    if (whenRunning) {
      let action = whenRunning
      whenRunning = null
      action()
    }
    if (text === lastStatusText) return
    try {
      let value = JSON.parse(text)
      lastStatusText = text
      status = value
      trackAgents(Array.isArray(value.agents) ? value.agents : [])
    } catch (e) {}
  }

  function markStopped() {
    stalled = 0
    if (transition === "stop") transition = ""
    if (serverState === "stopped") return
    serverState = "stopped"
    status = { version: "", files: 0, agents: [] }
    files = []
    runs = []
    lastStatusText = ""
    lastFilesText = ""
    lastRunsText = ""
    // A server that goes down took its agents with it. Nothing finished.
    previousWorking = ({})
    hasBaseline = false
  }

  function agentKey(agent) { return String(agent.name) + "\n" + String(agent.fileId) }

  function trackAgents(list) {
    var current = {}
    for (let i = 0; i < list.length; i++) {
      if (list[i] && list[i].status === "working") current[agentKey(list[i])] = list[i]
    }
    if (hasBaseline && owner && setting("notifyOnFinish", true) !== false) {
      for (let key in previousWorking) {
        if (!current[key]) notifyFinished(previousWorking[key])
      }
    }
    previousWorking = current
    hasBaseline = true
  }

  function notifyFinished(agent) {
    // bogen-place-screenshot says so itself, right away.
    if (agent.name === "Screenshot") return
    var args = ["omarchy-notification-send", "--app-name=Bogen", "-i", "bogen", "-u", "normal",
                String(agent.name || "Agent") + " finished",
                String(agent.fileName || "Bogen")]
    if (agent.fileId) args = args.concat(["--exec", "omarchy-launch-webapp", fileUrl(agent.fileId)])
    Util.execArgv(args)
  }

  // A bar surface exists per monitor. moduleWidgets knows them all; failing
  // that, the widget on the first screen speaks for the rest.
  function computeOwner() {
    var items = bar && typeof bar.moduleWidgets === "function" ? bar.moduleWidgets(moduleName) : []
    if (items.length > 0) return items[0] === root
    var window = button.QsWindow.window
    return !window || !window.screen || window.screen === Quickshell.screens[0]
  }

  // -------------------------------------------------------------- actions

  function fileUrl(id) { return baseUrl + "/#/file/" + encodeURIComponent(String(id)) }

  function openFile(id) {
    Util.execArgv(["omarchy-launch-webapp", fileUrl(id)])
    close()
  }

  function launchBogen() {
    Util.execArgv(["omarchy-launch-or-focus-webapp", windowPattern, baseUrl])
  }

  function openBogen() {
    close()
    if (reachable) launchBogen()
    else ensureRunning(launchBogen)
  }

  function createFile() {
    if (!reachable) { ensureRunning(createFile); return }
    request("POST", "/api/files", {}, function(code, text) {
      var created = null
      try { if (code >= 200 && code < 300) created = JSON.parse(text) } catch (e) {}
      if (!created || !created.id) { message = "Could not create a file."; return }
      message = ""
      lastFilesText = ""
      openFile(created.id)
    })
  }

  // The phone listener is turned on first if it is off, as `bogen phone pair` would ask you to.
  function pairPhone() {
    if (!reachable) { ensureRunning(pairPhone); return }
    message = ""
    pairedName = ""
    request("GET", "/api/phone", null, function(code, text) {
      var state = null
      try { if (code >= 200 && code < 300) state = JSON.parse(text) } catch (e) {}
      if (!state) { message = "This Bogen has no phone support yet. Update it."; return }
      pairDevices = Array.isArray(state.devices) ? state.devices.length : 0
      if (state.on) { requestPairCode(); return }
      request("POST", "/api/phone", { on: true }, function(onCode, onText) {
        if (onCode >= 200 && onCode < 300) requestPairCode()
        else message = errorText(onText, "Could not turn on the phone listener.")
      })
    })
  }

  function requestPairCode() {
    request("POST", "/api/phone/code?qr", {}, function(code, text) {
      var answer = null
      try { answer = JSON.parse(text) } catch (e) {}
      if (code < 200 || code >= 300 || !answer || !Array.isArray(answer.qr)) {
        message = errorText(text, "No pairing code: Bogen does not know this computer's tailnet name. Is Tailscale up?")
        return
      }
      pairing = answer
    })
  }

  function checkPaired() {
    if (Date.now() > Number(pairing.expiresAt)) {
      pairing = null
      message = "The pairing code ran out. Pair again for a new one."
      return
    }
    request("GET", "/api/phone", null, function(code, text) {
      try {
        var devices = JSON.parse(text).devices
        if (!pairing || !Array.isArray(devices) || devices.length <= pairDevices) return
        pairedName = String(devices[devices.length - 1].name || "Your phone")
        pairing = null
      } catch (e) {}
    })
  }

  function errorText(text, fallback) {
    try { return String(JSON.parse(text).error || fallback) } catch (e) { return fallback }
  }

  function ensureRunning(action) {
    whenRunning = action
    if (transition !== "start") startServer()
  }

  function startServer() {
    if (systemctl.running) return
    beginTransition("start")
    systemctl.launched = false
    systemctl.command = ["systemctl", "--user", "start", serviceName]
    systemctl.running = true
  }

  function stopServer() {
    if (systemctl.running) return
    whenRunning = null
    beginTransition("stop")
    systemctl.launched = false
    systemctl.command = ["systemctl", "--user", "stop", serviceName]
    systemctl.running = true
  }

  function beginTransition(kind) {
    message = ""
    transition = kind
    transitionStarted = Date.now()
    poll()
  }

  function toggleServer() {
    if (reachable) stopServer()
    else startServer()
  }

  // -------------------------------------------------------------- keyboard

  function moveCursor(delta) {
    cursorActive = true
    cursorIndex = Math.max(0, Math.min(rowCount - 1, cursorIndex + delta))
    keepCursorVisible()
  }

  function keepCursorVisible() {
    var row = rowItem(cursorIndex)
    if (!row) return
    var y = row.mapToItem(contents, 0, 0).y
    if (y < flick.contentY) flick.contentY = y
    else if (y + row.height > flick.contentY + flick.height) flick.contentY = y + row.height - flick.height
  }

  function rowItem(index) {
    if (index < rowPair) return actionRow
    if (index < rowAgents) return pairSection
    if (index < rowRuns) return agentRepeater.itemAt(index - rowAgents)
    if (index < rowFiles) return runRepeater.itemAt(index - rowRuns)
    return fileRepeater.itemAt(index - rowFiles)
  }

  function hoverRow(index) {
    cursorActive = true
    cursorIndex = index
  }

  function activateCursor() {
    if (cursorIndex === 0) toggleServer()
    else if (cursorIndex === rowNew) createFile()
    else if (cursorIndex === rowOpen) openBogen()
    else if (cursorIndex === rowPair) pairPhone()
    else if (cursorIndex < rowRuns) {
      let agent = workingAgents[cursorIndex - rowAgents]
      if (agent && agent.fileId) openFile(agent.fileId)
    } else if (cursorIndex < rowFiles) {
      let run = recentRuns[cursorIndex - rowRuns]
      if (run && run.fileId) openFile(run.fileId)
    } else {
      let file = recentFiles[cursorIndex - rowFiles]
      if (file) openFile(file.id)
    }
  }

  // -------------------------------------------------------------- lifecycle

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onRowCountChanged: if (cursorIndex >= rowCount) cursorIndex = Math.max(0, rowCount - 1)
  onOpenedChanged: if (opened) {
    cursorActive = false
    cursorIndex = 0
    nowMs = Date.now()
    message = ""
    flick.contentY = 0
    poll()
    Qt.callLater(function() { keys.forceActiveFocus() })
  }
  onWorkingChanged: if (working && !animationsChecked) {
    animationsChecked = true
    animationsProbe.running = true
  }

  property bool animationsChecked: false

  Component.onCompleted: owner = computeOwner()
  Component.onDestruction: if (statusRequest) statusRequest.abort()

  // Gentle by default. Only an open panel or a live transition or agent asks for more.
  Timer {
    interval: root.transition !== "" ? 1000 : root.opened ? 2000 : root.working ? 3000 : root.reachable ? 5000 : 15000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: root.poll()
  }

  Timer {
    interval: 30000
    running: root.opened
    repeat: true
    onTriggered: root.nowMs = Date.now()
  }

  Process {
    id: systemctl
    property bool launched: false
    onStarted: launched = true
    // A program that cannot start reports neither output nor an exit.
    onRunningChanged: if (!running && !launched) root.serviceFailed()
    onExited: function(code) {
      if (code !== 0) root.serviceFailed()
      else root.poll()
    }
  }

  function serviceFailed() {
    transition = ""
    whenRunning = null
    message = serviceName + " is not available. Run integrations/omarchy/install.sh from the Bogen repository."
  }

  // Omarchy has no reduced-motion switch of its own. Hyprland's animations toggle
  // is the nearest thing a person turns off on purpose, so the pulse follows it.
  Process {
    id: animationsProbe
    command: ["hyprctl", "getoption", "animations:enabled", "-j"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        try { root.hyprAnimations = JSON.parse(text).int !== 0 } catch (e) {}
      }
    }
  }

  IpcHandler {
    enabled: root.owner
    target: root.ipcTarget
    function status(): string { return root.serverState + " · " + root.summary() }
    function refresh(): string { root.poll(); return "ok" }
  }

  // The brand mark in the bar's own colour: a sheet with its folded corner and a >_ prompt, as on
  // the app icon. Drawn on the mark's 100-unit grid, scaled to fit, so it stays sharp at any bar size.
  component SheetGlyph: Item {
    id: glyph
    property color tint: root.foreground
    property bool pulsing: false

    readonly property real unit: Math.min(width, height)
    readonly property real k: unit / 100
    readonly property real line: Math.max(1.25, unit * 0.085)
    // The mark spans x 10..92 and y 4..96: centre that box in the item.
    readonly property real ox: (width - 82 * k) / 2 - 10 * k
    readonly property real oy: (height - 92 * k) / 2 - 4 * k

    SequentialAnimation on opacity {
      running: glyph.pulsing
      loops: Animation.Infinite
      alwaysRunToEnd: true
      NumberAnimation { to: 0.4; duration: 950; easing.type: Easing.InOutSine }
      NumberAnimation { to: 1; duration: 950; easing.type: Easing.InOutSine }
    }

    Shape {
      anchors.fill: parent
      preferredRendererType: Shape.CurveRenderer

      // The sheet, with the corner cut where the fold is.
      ShapePath {
        strokeColor: glyph.tint
        strokeWidth: glyph.line
        fillColor: "transparent"
        joinStyle: ShapePath.MiterJoin
        startX: glyph.ox + 10 * glyph.k; startY: glyph.oy + 4 * glyph.k
        PathLine { x: glyph.ox + 66 * glyph.k; y: glyph.oy + 4 * glyph.k }
        PathLine { x: glyph.ox + 92 * glyph.k; y: glyph.oy + 30 * glyph.k }
        PathLine { x: glyph.ox + 92 * glyph.k; y: glyph.oy + 96 * glyph.k }
        PathLine { x: glyph.ox + 10 * glyph.k; y: glyph.oy + 96 * glyph.k }
        PathLine { x: glyph.ox + 10 * glyph.k; y: glyph.oy + 4 * glyph.k }
      }
      // The fold, filled, as the darker corner is on the icon.
      ShapePath {
        strokeColor: "transparent"
        fillColor: glyph.tint
        startX: glyph.ox + 66 * glyph.k; startY: glyph.oy + 4 * glyph.k
        PathLine { x: glyph.ox + 66 * glyph.k; y: glyph.oy + 30 * glyph.k }
        PathLine { x: glyph.ox + 92 * glyph.k; y: glyph.oy + 30 * glyph.k }
        PathLine { x: glyph.ox + 66 * glyph.k; y: glyph.oy + 4 * glyph.k }
      }
      // > and _
      ShapePath {
        strokeColor: glyph.tint
        strokeWidth: glyph.line * 1.15
        fillColor: "transparent"
        joinStyle: ShapePath.MiterJoin
        startX: glyph.ox + 28 * glyph.k; startY: glyph.oy + 48 * glyph.k
        PathLine { x: glyph.ox + 48 * glyph.k; y: glyph.oy + 64 * glyph.k }
        PathLine { x: glyph.ox + 28 * glyph.k; y: glyph.oy + 80 * glyph.k }
      }
      ShapePath {
        strokeColor: glyph.tint
        strokeWidth: glyph.line * 1.15
        fillColor: "transparent"
        startX: glyph.ox + 55 * glyph.k; startY: glyph.oy + 78 * glyph.k
        PathLine { x: glyph.ox + 78 * glyph.k; y: glyph.oy + 78 * glyph.k }
      }
    }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    tooltipText: "Bogen · " + root.summary() + "\nLeft: panel · Middle: new file · Right: open"
    iconComponent: Component {
      Item {
        SheetGlyph {
          anchors.centerIn: parent
          width: parent.width
          height: Math.min(parent.height, Style.space(15))
          tint: root.working ? Commons.Color.accent
            : (root.serverState === "stopped" ? Commons.Color.muted : root.barForeground)
          pulsing: root.pulsing
        }
      }
    }
    onPressed: function(mouseButton) {
      if (mouseButton === Qt.RightButton) root.openBogen()
      else if (mouseButton === Qt.MiddleButton) root.createFile()
      else root.toggle()
    }
  }

  // Dot, title, detail, trailing note: one line of a list in the panel.
  component ListRow: CursorSurface {
    id: row
    property int rowIndex: -1
    property string title: ""
    property string detail: ""
    property string note: ""
    property bool live: false
    signal triggered()

    width: parent ? parent.width : 0
    implicitHeight: labels.implicitHeight + Style.spacing.xl
    foreground: root.foreground
    hasCursor: root.cursorActive && root.cursorIndex === rowIndex

    Rectangle {
      id: dot
      visible: row.live
      x: Style.space(8)
      anchors.verticalCenter: parent.verticalCenter
      width: Style.space(6)
      height: width
      radius: width / 2
      color: Commons.Color.accent
    }

    Column {
      id: labels
      anchors.left: row.live ? dot.right : parent.left
      anchors.leftMargin: Style.space(8)
      anchors.right: noteText.left
      anchors.rightMargin: Style.space(8)
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.spacing.hairline

      Text {
        width: parent.width
        textFormat: Text.PlainText
        text: row.title
        color: root.foreground
        elide: Text.ElideRight
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
      }

      Text {
        visible: text !== ""
        width: parent.width
        textFormat: Text.PlainText
        text: row.detail
        color: root.dim
        elide: Text.ElideRight
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
      }
    }

    Text {
      id: noteText
      anchors.right: parent.right
      anchors.rightMargin: Style.space(8)
      anchors.verticalCenter: parent.verticalCenter
      textFormat: Text.PlainText
      text: row.note
      color: root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
    }

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onEntered: root.hoverRow(row.rowIndex)
      onClicked: row.triggered()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keys
    contentWidth: panel.fittedContentWidth(Style.space(340))
    contentHeight: panel.fittedContentHeight(contents.implicitHeight, Style.space(560))

    PanelKeyCatcher {
      id: keys
      anchors.fill: parent

      onMoveRequested: function(dx, dy) { root.moveCursor(dx + dy) }
      onActivateRequested: root.activateCursor()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(key) {
        key = key.toLowerCase()
        if (key === "n") root.createFile()
        else if (key === "o") root.openBogen()
        else if (key === "p") root.pairPhone()
        else if (key === "s") root.toggleServer()
        else if (key === "r") root.poll()
      }

      Flickable {
        id: flick
        anchors.fill: parent
        contentWidth: width
        contentHeight: contents.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        Column {
          id: contents
          width: flick.width
          spacing: Style.space(12)

          PanelHero {
            width: parent.width
            title: "Bogen"
            meta: root.summary()
            foreground: root.foreground
            fontFamily: root.fontFamily
            iconOpacity: root.serverState === "stopped" ? 0.5 : 1.0
            iconComponent: Component {
              SheetGlyph {
                width: Style.font.display
                height: Style.font.display
                tint: root.working ? Commons.Color.accent : root.foreground
                pulsing: root.pulsing
              }
            }
            trailingControl: Component {
              ToggleSwitch {
                id: serverSwitch
                checked: root.reachable || root.transition === "start"
                busy: root.transition !== ""
                hasCursor: root.cursorActive && root.cursorIndex === 0
                foreground: root.foreground
                onHovered: function(on) { if (on) root.hoverRow(0) }
                onToggled: root.toggleServer()

                PanelToolTip {
                  visible: serverSwitch.containsMouse
                  text: root.reachable ? "Stop the server · S" : "Start the server · S"
                  fontFamily: root.fontFamily
                }
              }
            }
          }

          Text {
            visible: root.message !== ""
            width: parent.width
            textFormat: Text.PlainText
            text: root.message
            color: root.urgent
            wrapMode: Text.WordWrap
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }

          // Quiet: only when the server's daily check found a newer release, and never in the bar itself.
          Text {
            visible: root.reachable && root.releaseUpdate !== null
            width: parent.width
            textFormat: Text.PlainText
            text: root.releaseUpdate ? "Bogen " + String(root.releaseUpdate.version) + " is available · " + String(root.releaseUpdate.how) : ""
            color: root.dim
            wrapMode: Text.WordWrap
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }

          Row {
            id: actionRow
            width: parent.width
            spacing: Style.spacing.md

            readonly property real cellWidth: (width - spacing) / 2

            Button {
              width: actionRow.cellWidth
              text: "New file"
              bordered: true
              hasCursor: root.cursorActive && root.cursorIndex === root.rowNew
              foreground: root.foreground
              fontFamily: root.fontFamily
              tooltipText: "N"
              onClicked: root.createFile()
              onHovered: function(on) { if (on) root.hoverRow(root.rowNew) }
            }

            Button {
              width: actionRow.cellWidth
              text: "Open Bogen"
              bordered: true
              hasCursor: root.cursorActive && root.cursorIndex === root.rowOpen
              foreground: root.foreground
              fontFamily: root.fontFamily
              tooltipText: "O"
              onClicked: root.openBogen()
              onHovered: function(on) { if (on) root.hoverRow(root.rowOpen) }
            }
          }

          Column {
            id: pairSection
            width: parent.width
            spacing: Style.spacing.md

            Button {
              width: parent.width
              text: root.pairing ? "New pairing code" : "Pair a phone"
              bordered: true
              hasCursor: root.cursorActive && root.cursorIndex === root.rowPair
              foreground: root.foreground
              fontFamily: root.fontFamily
              tooltipText: "P"
              onClicked: root.pairPhone()
              onHovered: function(on) { if (on) root.hoverRow(root.rowPair) }
            }

            Text {
              visible: root.pairedName !== ""
              width: parent.width
              textFormat: Text.PlainText
              text: root.pairedName + " is paired. Open Bogen from its Home Screen."
              color: root.foreground
              wrapMode: Text.WordWrap
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
            }

            Row {
              visible: root.pairing !== null
              width: parent.width
              spacing: Style.spacing.md

              // Drawn from the rows the server sends, dark on white with a quiet zone, so any camera reads it.
              Canvas {
                id: qrCanvas
                width: Style.space(136)
                height: width
                readonly property var rows: root.pairing && Array.isArray(root.pairing.qr) ? root.pairing.qr : []
                onRowsChanged: requestPaint()
                onPaint: {
                  var ctx = getContext("2d")
                  ctx.reset()
                  ctx.fillStyle = "#ffffff"
                  ctx.fillRect(0, 0, width, height)
                  var n = rows.length
                  if (!n) return
                  var quiet = 3
                  var cell = width / (n + quiet * 2)
                  ctx.fillStyle = "#000000"
                  for (var y = 0; y < n; y++) {
                    for (var x = 0; x < n; x++) {
                      if (rows[y].charAt(x) === "1") ctx.fillRect((x + quiet) * cell, (y + quiet) * cell, Math.ceil(cell), Math.ceil(cell))
                    }
                  }
                }
              }

              Column {
                width: parent.width - qrCanvas.width - parent.spacing
                spacing: Style.spacing.sm

                Text {
                  width: parent.width
                  textFormat: Text.PlainText
                  text: root.pairing ? String(root.pairing.code) : ""
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.display
                  font.bold: true
                }

                Text {
                  width: parent.width
                  textFormat: Text.PlainText
                  text: "Scan with the iPhone camera, then Share, Add to Home Screen. Open Bogen there and type this code."
                  color: root.dim
                  wrapMode: Text.WordWrap
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                }

                Text {
                  width: parent.width
                  textFormat: Text.PlainText
                  text: root.pairing ? "Works once, until " + Qt.formatTime(new Date(Number(root.pairing.expiresAt)), "hh:mm") + "." : ""
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                }
              }
            }
          }

          PanelSeparator {
            visible: root.reachable
            foreground: root.foreground
          }

          Column {
            visible: root.reachable
            width: parent.width
            spacing: Style.spacing.sm

            PanelSectionHeader {
              text: "AGENTS"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            Text {
              visible: root.workingAgents.length === 0
              width: parent.width
              textFormat: Text.PlainText
              text: "No agent is working."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
            }

            Repeater {
              id: agentRepeater
              model: root.workingAgents

              ListRow {
                required property var modelData
                required property int index
                rowIndex: root.rowAgents + index
                live: true
                title: String(modelData.name || "Agent")
                detail: root.agentDetail(modelData)
                onTriggered: if (modelData.fileId) root.openFile(modelData.fileId)
              }
            }
          }

          PanelSeparator {
            visible: root.reachable && root.recentRuns.length > 0
            foreground: root.foreground
          }

          Column {
            visible: root.reachable && root.recentRuns.length > 0
            width: parent.width
            spacing: Style.spacing.sm

            PanelSectionHeader {
              text: "RUNS"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            Repeater {
              id: runRepeater
              model: root.recentRuns

              ListRow {
                required property var modelData
                required property int index
                rowIndex: root.rowRuns + index
                live: modelData.status === "running"
                title: String(modelData.prompt || "A run")
                detail: root.runDetail(modelData)
                note: root.ago(modelData.startedAt)
                onTriggered: if (modelData.fileId) root.openFile(modelData.fileId)
              }
            }
          }

          PanelSeparator {
            visible: root.reachable
            foreground: root.foreground
          }

          Column {
            visible: root.reachable
            width: parent.width
            spacing: Style.spacing.sm

            PanelSectionHeader {
              text: "RECENT"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            Text {
              visible: root.recentFiles.length === 0
              width: parent.width
              textFormat: Text.PlainText
              text: "No files yet."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
            }

            Repeater {
              id: fileRepeater
              model: root.recentFiles

              ListRow {
                required property var modelData
                required property int index
                rowIndex: root.rowFiles + index
                title: String(modelData.name || "Untitled")
                note: root.ago(modelData.updatedAt)
                onTriggered: root.openFile(modelData.id)
              }
            }
          }
        }
      }
    }
  }
}
