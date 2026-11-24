// Tube's floating player: a small always-on-top window with the system video controls (AVKit),
// run by /usr/bin/osascript -l JavaScript so it needs nothing installed.
// argv: videoURL audioURL startSeconds volume(0..1) title x y
// stdout: "T <seconds>" every half second; exits when the window closes.
ObjC.import('Cocoa')
ObjC.import('CoreMedia')
// AVFoundation / AVKit classes only appear once their bundles are loaded
for (const f of ['AVFoundation', 'AVKit']) $.NSBundle.bundleWithPath(`/System/Library/Frameworks/${f}.framework`).load

function run(argv) {
  const [vurl, aurl, start, vol, title, px, py] = argv
  const app = $.NSApplication.sharedApplication
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory)

  // separate video and audio streams, played together through one composition
  const comp = $.AVMutableComposition.composition
  const load = (u) => $.AVURLAsset.URLAssetWithURLOptions($.NSURL.URLWithString(u), $())
  const va = load(vurl)
  const vt = va.tracksWithMediaType($.AVMediaTypeVideo).firstObject
  const dur = va.duration
  const range = $.CMTimeRangeMake($.kCMTimeZero, dur)
  comp.addMutableTrackWithMediaTypePreferredTrackID($.AVMediaTypeVideo, 0).insertTimeRangeOfTrackAtTimeError(range, vt, $.kCMTimeZero, $())
  if (aurl && aurl !== '-') {
    const aa = load(aurl)
    const at = aa.tracksWithMediaType($.AVMediaTypeAudio).firstObject
    if (at && !at.isNil()) comp.addMutableTrackWithMediaTypePreferredTrackID($.AVMediaTypeAudio, 0).insertTimeRangeOfTrackAtTimeError(range, at, $.kCMTimeZero, $())
  }
  const item = $.AVPlayerItem.playerItemWithAsset(comp)
  const player = $.AVPlayer.playerWithPlayerItem(item)
  player.volume = Number(vol) || 1

  const w = 400
  const h = 225
  const mask = $.NSWindowStyleMaskTitled | $.NSWindowStyleMaskClosable | $.NSWindowStyleMaskResizable | $.NSWindowStyleMaskFullSizeContentView
  const win = $.NSPanel.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(Number(px), Number(py), w, h), mask, $.NSBackingStoreBuffered, false)
  win.title = title || 'Tube'
  win.titlebarAppearsTransparent = true
  win.titleVisibility = $.NSWindowTitleHidden
  win.movableByWindowBackground = true
  win.level = $.NSFloatingWindowLevel
  win.collectionBehavior = $.NSWindowCollectionBehaviorCanJoinAllSpaces | $.NSWindowCollectionBehaviorFullScreenAuxiliary
  win.contentAspectRatio = $.NSMakeSize(16, 9)
  win.releasedWhenClosed = false
  win.hidesOnDeactivate = false

  const view = $.AVPlayerView.alloc.initWithFrame($.NSMakeRect(0, 0, w, h))
  view.player = player
  view.controlsStyle = $.AVPlayerViewControlsStyleFloating
  view.showsFullScreenToggleButton = true
  view.allowsPictureInPicturePlayback = true
  view.autoresizingMask = $.NSViewWidthSizable | $.NSViewHeightSizable
  win.contentView = view
  win.makeKeyAndOrderFront($())

  player.seekToTimeToleranceBeforeToleranceAfter($.CMTimeMakeWithSeconds(Number(start) || 0, 600), $.kCMTimeZero, $.kCMTimeZero)
  player.play

  // run the app loop in slices so the position can be reported and the window watched
  const out = $.NSFileHandle.fileHandleWithStandardOutput
  const say = (s) => out.writeData($(s + '\n').dataUsingEncoding($.NSUTF8StringEncoding))
  for (;;) {
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.5))
    if (!win.isVisible) break
    say('T ' + $.CMTimeGetSeconds(player.currentTime) + ' ' + (player.rate > 0 ? 1 : 0))
  }
  player.pause
}
