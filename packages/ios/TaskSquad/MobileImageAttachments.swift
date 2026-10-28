import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import TaskSquadPortal

/// Shared by task creation and the in-context reply composer.
struct MobileImageAttachments: View {
    @Binding var files: [CustomerUpload]
    var compact = false
    @Binding var loading: Bool
    let reportError: (String) -> Void
    @State private var choosePhotos = false
    @State private var chooseFiles = false
    @State private var photos: [PhotosPickerItem] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Menu {
                    Button("Photos") { choosePhotos = true }
                    Button("Image files") { chooseFiles = true }
                    #if DEBUG
                    if ProcessInfo.processInfo.arguments.contains("--ui-test-api") {
                        Button("Attach test image") {
                            if let data = UIImage(systemName: "star.fill")?.pngData() { add(data, name: "test.png", mime: "image/png") }
                        }
                    }
                    #endif
                } label: { Label("Attach", systemImage: "paperclip").frame(minHeight: 44) }
                .accessibilityIdentifier("attach-images")
                Spacer()
                Text("\(files.count)/5 images").font(.caption).foregroundStyle(MobileTheme.mutedForeground)
            }
            if !files.isEmpty {
                ScrollView(.horizontal) {
                    HStack(spacing: 12) {
                        ForEach(files) { file in
                            VStack(alignment: .leading, spacing: 4) {
                                HStack(spacing: 4) {
                                    if let image = UIImage(data: file.data) {
                                        Image(uiImage: image).resizable().scaledToFit().frame(width: 56, height: 56).accessibilityHidden(true)
                                    }
                                    Button { files = files.filter { $0.id != file.id } } label: {
                                        MobileIcon(name: "x", size: 16).frame(minWidth: 44, minHeight: 44)
                                    }.accessibilityLabel("Remove " + file.name)
                                }
                                Text(file.name).font(.caption).lineLimit(1).frame(maxWidth: 120, alignment: .leading)
                            }
                        }
                    }
                }
            }
            if !compact { Text("PNG, JPEG, GIF or WebP · up to 10 MiB each").font(.caption).foregroundStyle(MobileTheme.mutedForeground) }
        }
        .photosPicker(isPresented: $choosePhotos, selection: $photos, maxSelectionCount: 5, matching: .images)
        .onChange(of: photos) { _, items in Task {
            guard !items.isEmpty else { return }
            loading = true
            defer { loading = false }
            do {
                var additions: [CustomerUpload] = []
                for item in items {
                    if let data = try await item.loadTransferable(type: Data.self), let png = UIImage(data: data)?.pngData() { additions.append(CustomerUpload(name: "photo.png", mimeType: "image/png", data: png)) }
                }
                add(additions)
                photos = []
            } catch { reportError(error.localizedDescription) }
        } }
        .fileImporter(isPresented: $chooseFiles, allowedContentTypes: [.png, .jpeg, .gif, .webP], allowsMultipleSelection: true) { result in
            do {
                var additions: [CustomerUpload] = []
                for url in try result.get() {
                    let access = url.startAccessingSecurityScopedResource()
                    defer { if access { url.stopAccessingSecurityScopedResource() } }
                    additions.append(CustomerUpload(name: url.lastPathComponent, mimeType: UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "image/png", data: try Data(contentsOf: url)))
                }
                add(additions)
            } catch { reportError(error.localizedDescription) }
        }
    }
    private func add(_ data: Data, name: String, mime: String) {
        add([CustomerUpload(name: name, mimeType: mime, data: data)])
    }
    private func add(_ additions: [CustomerUpload]) {
        guard !additions.isEmpty else { return }
        let updated = files + additions
        do { try WorkspaceEditor.validateAttachments(updated); files = updated }
        catch { reportError(error.localizedDescription) }
    }
}
