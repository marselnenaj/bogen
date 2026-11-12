// A stand-in for Omarchy's shell/plugins/background/Background.qml: only the lines the portrait patch anchors on, in
// the stock file's order and indentation, so the patch can be tested on a machine without Omarchy. The real file is
// tested too where it is installed.
import QtQuick

Item {
  id: root
  property real revealProgress: 1

  function transitionBackground(fromPath, path, finalPath, instant, force) {
    lastTransitionPath = path
  }

  ShellIpc {
    target: "background"

    function prepare(path: string): void {
      root.prepareBackground(path)
    }
  }

  Variants {
    PanelWindow {
      id: panel
      function decodeSize(path) {
        var native = root.nativeSizes[path]
        return native
      }

      function maybeStartReveal() {
        if (!root.incomingBackground || root.revealProgress !== 0 || maskReady) return
      }

      BackgroundMedia {
        id: base
        path: root.displayedBackground
        decodeSize: panel.decodeSize(root.displayedBackground)
        onFailedChanged: if (failed) root.recoverBackground(path)
      }

      Image {
        id: oldFrame
        readonly property size decode: panel.decodeSize(root.oldBackground)
        source: decode.width > 0 ? root.imageUrl(root.oldBackground) : ""
      }

      Image {
        id: incomingFrame
          readonly property string framePath: root.incomingBackground || root.preparedBackground
      }

      MouseArea {
      }
    }
  }
}
