//go:build cgo && darwin

package ui

/*
#cgo CFLAGS: -x objective-c -fblocks
#cgo LDFLAGS: -framework Cocoa -framework WebKit
#include <stdlib.h>
#include <objc/runtime.h>
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

// TSQUIDelegate forwards JS confirm/alert/prompt dialogs to native NSAlert sheets
// and auto-grants microphone/camera capture permissions to trusted local pages.
@interface TSQUIDelegate : NSObject <WKUIDelegate>
@end

@implementation TSQUIDelegate

- (void)webView:(WKWebView*)webView
    runJavaScriptConfirmPanelWithMessage:(NSString*)message
    initiatedByFrame:(WKFrameInfo*)frame
    completionHandler:(void (^)(BOOL))completionHandler {
    NSAlert* alert = [[NSAlert alloc] init];
    alert.messageText = message;
    [alert addButtonWithTitle:@"OK"];
    [alert addButtonWithTitle:@"Cancel"];
    completionHandler([alert runModal] == NSAlertFirstButtonReturn);
}

- (void)webView:(WKWebView*)webView
    runJavaScriptAlertPanelWithMessage:(NSString*)message
    initiatedByFrame:(WKFrameInfo*)frame
    completionHandler:(void (^)(void))completionHandler {
    NSAlert* alert = [[NSAlert alloc] init];
    alert.messageText = message;
    [alert addButtonWithTitle:@"OK"];
    [alert runModal];
    completionHandler();
}

// Grant microphone access to all pages loaded in TaskSquad panels.
// The system-level TCC prompt still fires the first time; after the user
// approves it once, subsequent requests are granted automatically.
- (void)webView:(WKWebView*)webView
    requestMediaCapturePermissionForOrigin:(WKSecurityOrigin*)origin
    initiatedByFrame:(WKFrameInfo*)frame
    type:(WKMediaCaptureType)type
    decisionHandler:(void (^)(WKPermissionDecision))decisionHandler
    API_AVAILABLE(macos(12.0)) {
    decisionHandler(WKPermissionDecisionGrant);
}

@end

void tsq_open_panel(const char* url, const char* title, int w, int h) {
    NSString* nsURL   = [[NSString alloc] initWithUTF8String:url];
    NSString* nsTitle = [[NSString alloc] initWithUTF8String:title];
    int width = w, height = h;

    dispatch_async(dispatch_get_main_queue(), ^{
        NSRect frame = NSMakeRect(0, 0, width, height);
        NSWindowStyleMask style =
            NSWindowStyleMaskTitled          |
            NSWindowStyleMaskClosable        |
            NSWindowStyleMaskMiniaturizable  |
            NSWindowStyleMaskResizable;
        NSWindow* win = [[NSWindow alloc]
            initWithContentRect:frame
            styleMask:style
            backing:NSBackingStoreBuffered
            defer:NO];
        [win setTitle:nsTitle];
        [win center];
        [win setReleasedWhenClosed:NO];

        WKWebViewConfiguration* cfg = [[WKWebViewConfiguration alloc] init];
        // Remove the user-gesture requirement so that MediaRecorder.start() works
        // without needing a click inside the WKWebView first.
        cfg.mediaTypesRequiringUserActionForPlayback = WKAudiovisualMediaTypeNone;
        WKWebView* wv = [[WKWebView alloc] initWithFrame:frame configuration:cfg];
        wv.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;

        TSQUIDelegate* delegate = [[TSQUIDelegate alloc] init];
        wv.UIDelegate = delegate;
        // Retain delegate for the lifetime of the window via associated objects.
        objc_setAssociatedObject(win, "tsq_ui_delegate", delegate, OBJC_ASSOCIATION_RETAIN_NONATOMIC);

        NSURL* loadURL = [NSURL URLWithString:nsURL];
        [wv loadRequest:[NSURLRequest requestWithURL:loadURL]];

        [win setContentView:wv];
        [win makeKeyAndOrderFront:nil];
        [NSApp activateIgnoringOtherApps:YES];
    });
}
*/
import "C"
import (
	"os/exec"
	"unsafe"

	"github.com/tasksquad/daemon/logger"
)

// openControlPanel opens the control-panel URL in a native macOS window
// (NSWindow + WKWebView) that shares the existing Cocoa application's event
// loop.  Safe to call from any goroutine.
func openControlPanel(url string) {
	cu := C.CString(url)
	defer C.free(unsafe.Pointer(cu))
	ct := C.CString("TaskSquad — Control Panel")
	defer C.free(unsafe.Pointer(ct))
	C.tsq_open_panel(cu, ct, 1024, 720)
}

// openVoiceToMD opens the voice-to-markdown editor in the default system browser.
// Using the browser avoids WKWebView microphone TCC permission issues with CLI binaries.
func openVoiceToMD(url string) {
	if err := exec.Command("open", url).Start(); err != nil {
		logger.Warn("[ui] openVoiceToMD: " + err.Error())
	}
}
