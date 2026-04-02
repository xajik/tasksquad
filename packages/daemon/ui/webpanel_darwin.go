//go:build cgo && darwin

package ui

/*
#cgo CFLAGS: -x objective-c -fblocks
#cgo LDFLAGS: -framework Cocoa -framework WebKit
#include <stdlib.h>
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

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
        WKWebView* wv = [[WKWebView alloc] initWithFrame:frame configuration:cfg];
        wv.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;

        NSURL* loadURL = [NSURL URLWithString:nsURL];
        [wv loadRequest:[NSURLRequest requestWithURL:loadURL]];

        [win setContentView:wv];
        [win makeKeyAndOrderFront:nil];
        [NSApp activateIgnoringOtherApps:YES];
    });
}
*/
import "C"
import "unsafe"

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
