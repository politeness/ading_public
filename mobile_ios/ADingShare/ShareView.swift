import SwiftUI

/// Share sheet: the items to send and a note on top, the target conversation below.
struct ShareView: View {
    @Bindable var model: ShareModel

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("share.title")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("share.cancel") { model.cancel() }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        if model.phase == .sending {
                            ProgressView()
                        } else {
                            Button("chat.send") { Task { await model.send() } }
                                .disabled(!model.canSend)
                        }
                    }
                }
        }
        .task { await model.load() }
    }

    @ViewBuilder private var content: some View {
        switch model.phase {
        case .loading:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case .signedOut:
            ContentUnavailableView("share.signedOut", systemImage: "person.crop.circle.badge.exclamationmark",
                                   description: Text("share.signedOut.detail"))
        case .ready, .sending, .failed:
            form
        }
    }

    private var form: some View {
        Form {
            Section {
                if !model.attachments.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(model.attachments) { attachment in
                                SharedItemThumbnail(attachment: attachment)
                            }
                        }
                    }
                }
                TextField("share.comment", text: $model.text, axis: .vertical)
                    .lineLimit(1...5)
            } footer: {
                if !model.skipped.isEmpty {
                    Text(model.skipped.joined(separator: "\n")).foregroundStyle(.orange)
                }
            }
            if case .failed(let message) = model.phase {
                Section {
                    Text(message).foregroundStyle(.red)
                    Button("share.retry") { Task { await model.retry() } }
                }
            }
            Section("tab.contacts") {
                if model.contacts.isEmpty {
                    Text("contacts.empty.title").foregroundStyle(.secondary)
                }
                ForEach(model.contacts) { contact in
                    Button {
                        model.selectedRecipient = .contact(contact.userId)
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(contact.displayName).foregroundStyle(Color.primary).lineLimit(1)
                                if contact.isAgent, let computerName = contact.computerName, !computerName.isEmpty {
                                    Text(computerName).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                }
                            }
                            Spacer()
                            if model.selectedRecipient == .contact(contact.userId) {
                                Image(systemName: "checkmark").foregroundStyle(Color.accentColor)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .accessibilityAddTraits(model.selectedRecipient == .contact(contact.userId) ? .isSelected : [])
                }
            }
            Section("conversation.permanent") {
                if model.permanentConversations.isEmpty {
                    Text("share.noPermanentConversations").foregroundStyle(.secondary)
                }
                ForEach(model.permanentConversations) { conversation in
                    Button {
                        model.selectedRecipient = .conversation(conversation.conversationId)
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(title(of: conversation)).foregroundStyle(Color.primary).lineLimit(1)
                                if let members = memberNames(of: conversation) {
                                    Text(members).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                }
                            }
                            Spacer()
                            if model.selectedRecipient == .conversation(conversation.conversationId) {
                                Image(systemName: "checkmark").foregroundStyle(Color.accentColor)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                }
            }
        }
        .disabled(model.phase == .sending)
    }

    /// Same as in the App: unnamed tasks show the other party's name
    private func title(of conversation: RemoteConversation) -> String {
        if ["新会话", "新任务"].contains(conversation.name) {
            return memberNames(of: conversation) ?? L10n.string("conversation.draftName")
        }
        return conversation.name
    }

    private func memberNames(of conversation: RemoteConversation) -> String? {
        let me = Credentials.user?.userId
        let names = conversation.members.filter { $0.userId != me }.compactMap(\.displayName)
        return names.isEmpty ? nil : names.joined(separator: "、")
    }
}

private struct SharedItemThumbnail: View {
    let attachment: LocalAttachment
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                VStack(spacing: 4) {
                    Image(systemName: attachment.isVideo ? "video" : "doc").font(.system(size: 20))
                    Text(attachment.name).font(.caption2).lineLimit(2).multilineTextAlignment(.center)
                }
                .foregroundStyle(.secondary)
                .padding(4)
            }
        }
        .frame(width: 72, height: 72)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .task {
            guard attachment.isImage, let full = UIImage(contentsOfFile: attachment.fileURL.path) else { return }
            image = await full.byPreparingThumbnail(ofSize: CGSize(width: 180, height: 180 * full.size.height / max(full.size.width, 1)))
        }
    }
}
