import PhotosUI
import SwiftUI
import UIKit

@MainActor
enum FeedbackCapture {
    static func image(_ image: UIImage, name: String) throws -> FeedbackImage {
        let scale = min(1, 1600 / max(image.size.width, image.size.height))
        let size = CGSize(width: max(1, image.size.width * scale), height: max(1, image.size.height * scale))
        let format = UIGraphicsImageRendererFormat(); format.scale = 1; format.opaque = true
        let reduced = UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
        guard let data = reduced.jpegData(compressionQuality: 0.85), data.count <= 5 * 1024 * 1024 else { throw ProblemFeedback.Failure.images }
        return FeedbackImage(name: name, jpeg: data)
    }
}

struct FeedbackButton: View {
    @State private var presented = false
    var body: some View {
        Button {
            presented = true
        } label: {
            Label {
                Text("feedback.title").foregroundStyle(Color.primary)
            } icon: {
                Image(systemName: "exclamationmark.bubble")
            }
        }
        .sheet(isPresented: $presented) { ProblemFeedbackView() }
    }
}

struct ProblemFeedbackView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var description = ""
    @State private var occurredAt = Date()
    @State private var images: [FeedbackImage] = []
    @State private var selected: [PhotosPickerItem] = []
    @State private var loadingImages = false
    @State private var submitting = false
    @State private var error: String?
    @State private var delivery: FeedbackDelivery?
    @State private var preview: FeedbackImage?
    // Capture the identity/environment once; a draft must not migrate accounts/servers.
    private let owner = Credentials.user?.userId
    private let environment = ServerEnvironment.current

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    DatePicker("feedback.occurredAt", selection: $occurredAt, in: ...Date(), displayedComponents: [.date, .hourAndMinute])
                    TextField("feedback.description", text: $description, axis: .vertical)
                        .lineLimit(5...12)
                        .accessibilityIdentifier("feedback-description")
                } footer: { Text("feedback.logsNotice") }
                Section("feedback.images") {
                    ForEach(images) { image in attachment(image) }
                    if images.count < 5 {
                        PhotosPicker(selection: $selected, maxSelectionCount: 5 - images.count, matching: .images) {
                            Label("feedback.addImages", systemImage: "photo.badge.plus")
                        }
                        .disabled(loadingImages)
                    }
                    if loadingImages { ProgressView() }
                }
                if let error { Section { Text(error).font(.footnote).foregroundStyle(.red) } }
            }
            .disabled(submitting)
            .navigationTitle("feedback.title")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("feedback.cancel") { dismiss() }.disabled(submitting) }
                ToolbarItem(placement: .confirmationAction) {
                    Button { Task { await submit() } } label: {
                        if submitting { ProgressView() } else { Text("feedback.submit") }
                    }
                    .disabled(submitting || loadingImages || !(5...4000).contains(description.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count))
                    .accessibilityIdentifier("feedback-submit")
                }
            }
            .interactiveDismissDisabled(submitting)
            .onChange(of: selected) { _, items in Task { await load(items) } }
            .alert(delivery == .submitted ? "feedback.submitted" : "feedback.queued", isPresented: Binding(get: { delivery != nil }, set: { if !$0 { delivery = nil } })) {
                Button("feedback.ok") { dismiss() }
            } message: {
                Text(delivery == .submitted ? "feedback.submittedDetail" : "feedback.queuedDetail")
            }
            .sheet(item: $preview) { image in
                NavigationStack {
                    if let data = image.bytes, let uiImage = UIImage(data: data) {
                        Image(uiImage: uiImage).resizable().scaledToFit()
                            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("feedback.close") { preview = nil } } }
                    }
                }
            }
        }
    }
    private func attachment(_ image: FeedbackImage) -> some View {
        HStack {
            Button { preview = image } label: {
                if let bytes = image.bytes, let uiImage = UIImage(data: bytes) {
                    Image(uiImage: uiImage).resizable().scaledToFit().frame(maxHeight: 120)
                }
            }.buttonStyle(.plain)
            Spacer()
            Button(role: .destructive) {
                images.removeAll { $0.id == image.id }
            } label: { Image(systemName: "trash") }
            .buttonStyle(.borderless).accessibilityLabel(Text("feedback.removeImage"))
        }
    }
    private func load(_ items: [PhotosPickerItem]) async {
        guard !items.isEmpty else { return }
        loadingImages = true; defer { loadingImages = false; selected = [] }
        do {
            var imported: [FeedbackImage] = []
            for item in items {
                guard let data = try await item.loadTransferable(type: Data.self), let image = UIImage(data: data) else { throw ProblemFeedback.Failure.images }
                imported.append(try FeedbackCapture.image(image, name: "ios-image-\(UUID().uuidString).jpg"))
            }
            guard images.count + imported.count <= 5 else { throw ProblemFeedback.Failure.images }
            let all = images + imported
            guard all.reduce(0, { $0 + ($1.bytes?.count ?? 0) }) <= 15 * 1024 * 1024 else { throw ProblemFeedback.Failure.images }
            images += imported; error = nil
        } catch { self.error = error.localizedDescription }
    }
    private func submit() async {
        guard !submitting else { return }
        submitting = true; defer { submitting = false }
        do {
            // Avoid attaching another account's diagnostics if the login state changed.
            guard Credentials.user?.userId == owner, ServerEnvironment.current == environment else { throw APIError.unauthorized }
            let scope = FeedbackDiagnostics.Scope(owner: owner, environment: environment.rawValue)
            await FeedbackDiagnostics.shared.record("feedback-snapshot", fields: ["version": AppVersion.display, "platform": "iOS \(UIDevice.current.systemVersion)"], scope: scope)
            let log = await FeedbackDiagnostics.shared.snapshot(scope)
            let formatter = ISO8601DateFormatter()
            let terminalId: String
            if let stored = Keychain.read("terminalFingerprint") ?? Keychain.read("supportTerminalId") { terminalId = stored }
            else { terminalId = "mobile_" + UUID().uuidString; Keychain.write(terminalId, for: "supportTerminalId") }
            #if arch(arm64)
            let arch = "arm64"
            #else
            let arch = "x64"
            #endif
            let payload = ProblemFeedback(reportId: "report_" + UUID().uuidString, createdAt: formatter.string(from: Date()), occurredAt: formatter.string(from: occurredAt),
                description: description.trimmingCharacters(in: .whitespacesAndNewlines), screenshot: nil, images: images,
                context: .init(appVersion: AppVersion.display, platform: "ios", arch: arch, mode: "remote", logs: [.init(name: "ios-last-48h.log", content: log)], userId: owner, terminalId: terminalId))
            try await ProblemFeedbackQueue.shared.enqueue(payload, baseURL: environment.baseURL)
            switch await ProblemFeedbackQueue.shared.upload(payload.reportId) {
            case .submitted: delivery = .submitted
            case .queued: delivery = .queued
            case .rejected(let message): error = message
            }
        } catch { self.error = error.localizedDescription }
    }
}
