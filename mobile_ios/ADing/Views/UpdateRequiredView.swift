import SwiftUI

/// Page blocking the whole App on forced update: goes to App Store / TestFlight by channel, or retries when offline.
struct UpdateRequiredView: View {
    @Environment(UpdateGate.self) private var gate
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(spacing: 20) {
            Spacer()
            Image(systemName: "arrow.down.app")
                .font(.system(size: 56))
                .foregroundStyle(.tint)
            Text("update.required.title")
                .font(.title2.bold())
            Text("update.required.message \(gate.requiredVersion ?? "")")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            if let error = gate.lastError {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
            }
            Spacer()
            if let url = gate.updateURL {
                Button {
                    openURL(url)
                } label: {
                    Text(LocalizedStringKey(ServerEnvironment.current == .pre ? "update.required.openTestFlight" : "update.required.open"))
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
            }
            Button {
                Task { await gate.check() }
            } label: {
                if gate.checking { ProgressView() } else { Text("update.required.retry") }
            }
            .disabled(gate.checking)
        }
        .padding(32)
    }
}
