import AVKit
import PhotosUI
import QuickLook
import SwiftUI
import UniformTypeIdentifiers

// MARK: - Picking attachments

/// Turn photos and videos picked from the library into attachments to send.
/// HEIC photos are converted to JPEG: HEIC is awkward for agents on the computer, JPEG opens anywhere.
enum PhotoAttachmentLoader {
    static func load(_ image: UIImage) throws -> LocalAttachment {
        guard let jpeg = image.jpegData(compressionQuality: 0.9) else {
            throw LocalAttachment.Failure.unreadable(L10n.string("attachment.preview.image"))
        }
        return try LocalAttachment.writing(jpeg, name: "IMG_\(stamp()).jpg")
    }

    static func load(_ item: PhotosPickerItem) async throws -> LocalAttachment {
        let type = item.supportedContentTypes.first
        let stamp = Self.stamp()
        if let type, type.conforms(to: .movie) {
            guard let movie = try await item.loadTransferable(type: PickedMovie.self) else {
                throw LocalAttachment.Failure.unreadable(L10n.string("attachment.preview.video"))
            }
            defer { try? FileManager.default.removeItem(at: movie.url.deletingLastPathComponent()) }
            let ext = movie.url.pathExtension.isEmpty ? "mov" : movie.url.pathExtension.lowercased()
            return try LocalAttachment.copying(movie.url, name: "VID_\(stamp).\(ext)")
        }
        guard let data = try await item.loadTransferable(type: Data.self) else {
            throw LocalAttachment.Failure.unreadable(L10n.string("attachment.preview.image"))
        }
        if let type, type.conforms(to: .heic) || type.conforms(to: .heif),
           let image = UIImage(data: data), let jpeg = image.jpegData(compressionQuality: 0.9) {
            return try LocalAttachment.writing(jpeg, name: "IMG_\(stamp).jpg")
        }
        let ext = type?.preferredFilenameExtension ?? "jpg"
        return try LocalAttachment.writing(data, name: "IMG_\(stamp).\(ext)")
    }

    private static func stamp() -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd_HHmmss_SSS"
        return formatter.string(from: Date())
    }
}

/// Library videos are taken as files, not read wholly into memory
struct PickedMovie: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .movie) { received in
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let copy = folder.appendingPathComponent(received.file.lastPathComponent)
            try FileManager.default.copyItem(at: received.file, to: copy)
            return PickedMovie(url: copy)
        }
    }
}

/// Confirming a photo only adds it to the composer; it doesn't call the message send API.
struct CameraAttachmentView: View {
    let usePhoto: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var photo: UIImage?
    @State private var captureRequest = 0
    @State private var capturing = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            CameraCaptureView(photo: $photo, capturing: $capturing, captureRequest: captureRequest)
                .ignoresSafeArea()
            if let photo {
                Color.black.ignoresSafeArea()
                ZoomableImage(image: photo)
                    .ignoresSafeArea()
            }
            VStack {
                HStack {
                    Button("share.cancel") { dismiss() }
                    Spacer()
                }
                .padding()
                .background(.black.opacity(0.6))
                Spacer()
                HStack {
                    if let photo {
                        Button("chat.camera.retake") { self.photo = nil }
                        Spacer()
                        Button("chat.camera.send") { usePhoto(photo) }
                            .fontWeight(.semibold)
                    } else {
                        Spacer()
                        Button {
                            capturing = true
                            captureRequest += 1
                        } label: {
                            Circle().fill(.white)
                                .frame(width: 64, height: 64)
                                .padding(5)
                                .overlay(Circle().stroke(.white, lineWidth: 3))
                        }
                        .disabled(capturing)
                        .accessibilityLabel(Text("chat.attach.camera"))
                        Spacer()
                    }
                }
                .padding(24)
                .background(.black.opacity(0.6))
            }
        }
        .foregroundStyle(.white)
        .interactiveDismissDisabled()
    }
}

private struct CameraCaptureView: UIViewControllerRepresentable {
    @Binding var photo: UIImage?
    @Binding var capturing: Bool
    let captureRequest: Int

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.mediaTypes = [UTType.image.identifier]
        picker.cameraCaptureMode = .photo
        picker.showsCameraControls = false
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ picker: UIImagePickerController, context: Context) {
        context.coordinator.parent = self
        guard captureRequest != context.coordinator.lastRequest else { return }
        context.coordinator.lastRequest = captureRequest
        picker.takePicture()
    }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        var parent: CameraCaptureView
        var lastRequest = 0

        init(_ parent: CameraCaptureView) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController,
                                   didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            parent.photo = info[.originalImage] as? UIImage
            parent.capturing = false
        }
    }
}

// MARK: - Above the composer: attachments not yet sent

struct PendingAttachmentsBar: View {
    let attachments: [LocalAttachment]
    let remove: (LocalAttachment) -> Void
    @State private var viewing: ViewingImage?
    @State private var playing: PlayingVideo?
    @State private var previewURL: URL?

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(attachments) { attachment in
                    ZStack(alignment: .topTrailing) {
                        Button { open(attachment) } label: {
                            PendingThumbnail(attachment: attachment)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(Text("attachment.open \(attachment.name)"))
                        Button {
                            remove(attachment)
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 18))
                                .symbolRenderingMode(.palette)
                                .foregroundStyle(.white, .black.opacity(0.6))
                        }
                        .offset(x: 6, y: -6)
                        .accessibilityLabel(Text("attachment.remove \(attachment.name)"))
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 10)
        }
        .quickLookPreview($previewURL)
        .fullScreenCover(item: $playing) { video in
            VideoScreen(url: video.url)
        }
        .fullScreenCover(item: $viewing) { image in
            ImageScreen(url: image.url) { viewing = nil }
        }
    }

    /// Same as attachments in messages: images zoom, videos play, other files use system preview
    private func open(_ attachment: LocalAttachment) {
        if attachment.isImage {
            viewing = ViewingImage(url: attachment.fileURL)
        } else if attachment.isVideo {
            playing = PlayingVideo(url: attachment.fileURL)
        } else {
            previewURL = attachment.fileURL
        }
    }
}

private struct PendingThumbnail: View {
    let attachment: LocalAttachment
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                VStack(spacing: 4) {
                    Image(systemName: attachment.isVideo ? "video" : "doc")
                        .font(.system(size: 20))
                    Text(attachment.name)
                        .font(.caption2)
                        .lineLimit(2)
                        .multilineTextAlignment(.center)
                }
                .foregroundStyle(.secondary)
                .padding(4)
            }
        }
        .frame(width: 64, height: 64)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .task {
            guard attachment.isImage else { return }
            image = await Thumbnails.image(at: attachment.fileURL, side: 160)
        }
    }
}

// MARK: - Attachments in messages

/// Images show a thumbnail and open in system preview (zoom, save to Photos, share); videos play on tap; files open a preview
struct MessageAttachmentsView: View {
    let conversationId: String
    let attachments: [RemoteAttachment]
    let mine: Bool
    @State private var previewURL: URL?
    @State private var playing: PlayingVideo?
    @State private var viewing: ViewingImage?
    @State private var opening: String?
    @State private var failure: String?

    var body: some View {
        VStack(alignment: mine ? .trailing : .leading, spacing: 6) {
            ForEach(attachments) { attachment in
                if attachment.isImage {
                    Button { view(attachment) } label: {
                        RemoteThumbnail(conversationId: conversationId, attachment: attachment)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(Text("attachment.open \(attachment.name)"))
                } else if attachment.isVideo {
                    Button { play(attachment) } label: {
                        tile(attachment, icon: "play.rectangle.fill")
                    }
                    .buttonStyle(.plain)
                } else {
                    Button { open(attachment) } label: {
                        tile(attachment, icon: "doc.fill")
                    }
                    .buttonStyle(.plain)
                }
            }
            if let failure {
                Text(failure).font(.caption).foregroundStyle(.red)
            }
        }
        .quickLookPreview($previewURL)
        .fullScreenCover(item: $playing) { video in
            VideoScreen(url: video.url)
        }
        .fullScreenCover(item: $viewing) { image in
            ImageScreen(url: image.url) { viewing = nil }
        }
    }

    private func tile(_ attachment: RemoteAttachment, icon: String) -> some View {
        HStack(spacing: 10) {
            if opening == attachment.attachmentId {
                ProgressView().frame(width: 24, height: 24)
            } else {
                Image(systemName: icon)
                    .font(.system(size: 22))
                    .foregroundStyle(Color.accentColor)
                    .frame(width: 24, height: 24)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(attachment.name).font(.subheadline).lineLimit(1).truncationMode(.middle)
                Text(attachment.size.fileSizeText).font(.caption2).foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .frame(maxWidth: 260, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color(.secondarySystemBackground)))
        .contentShape(Rectangle())
    }

    /// Download to cache, then hand to system preview
    private func open(_ attachment: RemoteAttachment) {
        guard opening == nil else { return }
        opening = attachment.attachmentId
        Task {
            defer { opening = nil }
            do {
                previewURL = try await APIClient.shared.downloadedFile(attachment, in: conversationId)
                failure = nil
            } catch {
                failure = error.localizedDescription
            }
        }
    }

    /// Images only zoom, without system preview: system preview has built-in markup editing that isn't needed here
    private func view(_ attachment: RemoteAttachment) {
        guard opening == nil else { return }
        opening = attachment.attachmentId
        Task {
            defer { opening = nil }
            do {
                viewing = ViewingImage(url: try await APIClient.shared.downloadedFile(attachment, in: conversationId))
                failure = nil
            } catch {
                failure = error.localizedDescription
            }
        }
    }

    /// Videos aren't downloaded first; stream directly from the time-limited URL
    private func play(_ attachment: RemoteAttachment) {
        guard opening == nil else { return }
        opening = attachment.attachmentId
        Task {
            defer { opening = nil }
            do {
                playing = PlayingVideo(url: try await APIClient.shared.attachmentURL(attachment, in: conversationId))
                failure = nil
            } catch {
                failure = error.localizedDescription
            }
        }
    }
}

private struct ViewingImage: Identifiable {
    let id = UUID()
    let url: URL
}

/// Full-screen image: pinch to zoom, double-tap to zoom in or reset; the close button always stays within the safe area.
private struct ImageScreen: View {
    let url: URL
    let onClose: () -> Void
    @State private var image: UIImage?

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                if let image {
                    ZoomableImage(image: image, onClose: onClose)
                        .accessibilityLabel(Text("attachment.preview.image"))
                } else {
                    ProgressView().tint(.white)
                }
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
            .clipped()
            .contentShape(Rectangle())
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            HStack {
                Button(action: onClose) {
                    Label("attachment.preview.close", systemImage: "xmark")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 16)
                        .frame(minHeight: 44)
                        .background(.white.opacity(0.15), in: Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("image-preview.close")
                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
        .background(Color.black.ignoresSafeArea())
        .accessibilityAction(.escape, onClose)
        .statusBarHidden()
        .task {
            // Keep detail for zooming while limiting decode memory for huge photos.
            let side = min(4096, max(UIScreen.main.bounds.width, UIScreen.main.bounds.height) * UIScreen.main.scale * 3)
            image = await Thumbnails.image(at: url, side: side)
        }
    }
}

/// Native scroll view handles pinch, drag and zoom bounds; when onClose is given, a tap closes when not zoomed.
private struct ZoomableImage: UIViewRepresentable {
    let image: UIImage
    var onClose: (() -> Void)?

    func makeUIView(context: Context) -> ImageZoomScrollView {
        ImageZoomScrollView()
    }

    func updateUIView(_ view: ImageZoomScrollView, context: Context) {
        view.onClose = onClose
        if view.imageView.image !== image { view.show(image) }
    }
}

private final class ImageZoomScrollView: UIScrollView, UIScrollViewDelegate {
    let imageView = UIImageView()
    var onClose: (() -> Void)?
    private var viewportSize = CGSize.zero

    init() {
        super.init(frame: .zero)
        delegate = self
        minimumZoomScale = 1
        maximumZoomScale = 5
        showsHorizontalScrollIndicator = false
        showsVerticalScrollIndicator = false
        contentInsetAdjustmentBehavior = .never
        imageView.contentMode = .scaleAspectFit
        imageView.isAccessibilityElement = true
        imageView.accessibilityLabel = L10n.string("attachment.preview.image")
        addSubview(imageView)

        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(toggleZoom(_:)))
        doubleTap.numberOfTapsRequired = 2
        addGestureRecognizer(doubleTap)
        let singleTap = UITapGestureRecognizer(target: self, action: #selector(closeIfFitted))
        singleTap.require(toFail: doubleTap)
        addGestureRecognizer(singleTap)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    /// After changing image, refit the viewport to the new image size
    func show(_ image: UIImage) {
        setZoomScale(1, animated: false)
        imageView.image = image
        viewportSize = .zero
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard bounds.width > 0, bounds.height > 0, let image = imageView.image else { return }
        if viewportSize != bounds.size {
            viewportSize = bounds.size
            setZoomScale(1, animated: false)
            let fit = min(bounds.width / image.size.width, bounds.height / image.size.height)
            imageView.frame = CGRect(origin: .zero, size: CGSize(
                width: image.size.width * fit, height: image.size.height * fit))
            contentSize = imageView.bounds.size
        }
        centerImage()
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }

    func scrollViewDidZoom(_ scrollView: UIScrollView) { centerImage() }

    private func centerImage() {
        contentInset = UIEdgeInsets(
            top: max(0, (bounds.height - imageView.frame.height) / 2), left: max(0, (bounds.width - imageView.frame.width) / 2),
            bottom: max(0, (bounds.height - imageView.frame.height) / 2), right: max(0, (bounds.width - imageView.frame.width) / 2))
    }

    @objc private func closeIfFitted() {
        if zoomScale <= minimumZoomScale + 0.01 { onClose?() }
    }

    @objc private func toggleZoom(_ gesture: UITapGestureRecognizer) {
        if zoomScale > minimumZoomScale + 0.01 {
            setZoomScale(minimumZoomScale, animated: true)
        } else {
            let point = gesture.location(in: imageView)
            let size = CGSize(width: bounds.width / 3, height: bounds.height / 3)
            zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2,
                            width: size.width, height: size.height), animated: true)
        }
    }
}

private struct PlayingVideo: Identifiable {
    let id = UUID()
    let url: URL
}

private struct VideoScreen: View {
    let url: URL
    @State private var player: AVPlayer?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.black.ignoresSafeArea()
            if let player {
                VideoPlayer(player: player).ignoresSafeArea()
            }
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 30))
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(.white, .white.opacity(0.25))
            }
            .padding()
            .accessibilityLabel(Text("attachment.preview.close"))
        }
        .onAppear {
            let player = AVPlayer(url: url)
            self.player = player
            player.play()
        }
        .onDisappear { player?.pause() }
    }
}

/// Thumbnail for image messages: downloaded to cache, then downscaled to display size, so large photos use little memory
private struct RemoteThumbnail: View {
    let conversationId: String
    let attachment: RemoteAttachment
    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: 220, maxHeight: 220)
            } else {
                ZStack {
                    RoundedRectangle(cornerRadius: 12).fill(Color(.secondarySystemBackground))
                    if failed {
                        Image(systemName: "photo").foregroundStyle(.secondary)
                    } else {
                        ProgressView()
                    }
                }
                .frame(width: 160, height: 120)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .task(id: attachment.attachmentId) {
            do {
                let file = try await APIClient.shared.downloadedFile(attachment, in: conversationId)
                image = await Thumbnails.image(at: file, side: 440)
                failed = image == nil
            } catch {
                failed = true
            }
        }
    }
}

enum Thumbnails {
    /// Downscale by the long edge; decode on a background thread so scrolling doesn't stutter
    static func image(at url: URL, side: CGFloat) async -> UIImage? {
        await Task.detached(priority: .userInitiated) {
            guard let image = UIImage(contentsOfFile: url.path) else { return nil }
            let scale = min(1, side / max(image.size.width, image.size.height))
            let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
            return await image.byPreparingThumbnail(ofSize: size) ?? image
        }.value
    }
}
