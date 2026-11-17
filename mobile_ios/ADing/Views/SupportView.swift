import StoreKit
import SwiftUI

/// Tipping: only on mobile; desktop "Support ADing" just points here. All five tiers are repeatable consumables.
/// Every feature is free and tipping is fully voluntary and unlocks nothing, so no server validation or records are needed:
/// after purchase, finishing the transaction locally is the end; sales records are in App Store Connect reports.
enum Tip: String, CaseIterable, Identifiable {
    case small = "com.politeness.ading.tip.small"
    case friend = "com.politeness.ading.tip.friend"
    case milkTea = "com.politeness.ading.tip.milk_tea"
    case meal = "com.politeness.ading.tip.meal"
    case infra = "com.politeness.ading.tip.infra"

    var id: String { rawValue }

    /// Names use our own copy (same as desktop); prices use the local price returned by the App Store
    var title: LocalizedStringResource {
        switch self {
        case .small: "tip.small"
        case .friend: "tip.friend"
        case .milkTea: "tip.milkTea"
        case .meal: "tip.meal"
        case .infra: "tip.infra"
        }
    }
}

struct SupportView: View {
    @State private var products: [String: Product] = [:]
    @State private var loading = true
    @State private var buying: String?
    @State private var message: String?
    /// Payment pending (Ask to Buy etc.) isn't an error; show it in a normal color
    @State private var pending = false
    @State private var thanked = false

    var body: some View {
        List {
            Section {
                Text("support.intro")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Section {
                ForEach(Tip.allCases) { tip in
                    Button {
                        Task { await buy(tip) }
                    } label: {
                        HStack {
                            Text(tip.title).foregroundStyle(Color.primary)
                            Spacer()
                            if buying == tip.rawValue {
                                ProgressView()
                            } else if let product = products[tip.rawValue] {
                                Text(product.displayPrice)
                                    .font(.body.weight(.semibold))
                                    .foregroundStyle(Color.accentColor)
                            } else if loading {
                                ProgressView()
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .disabled(products[tip.rawValue] == nil || buying != nil)
                }
            } footer: {
                if let message {
                    Text(message).foregroundStyle(.red)
                } else if pending {
                    Text("support.pending")
                } else if !loading && products.isEmpty {
                    Text("support.unavailable")
                }
            }
        }
        .navigationTitle("support.title")
        .task { await load() }
        .alert("support.thanks", isPresented: $thanked) {
            Button("process.close") {}
        } message: {
            Text("support.thanks.detail")
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            let list = try await Product.products(for: Tip.allCases.map(\.rawValue))
            products = Dictionary(uniqueKeysWithValues: list.map { ($0.id, $0) })
            message = nil
        } catch {
            message = error.localizedDescription
        }
    }

    private func buy(_ tip: Tip) async {
        guard let product = products[tip.rawValue] else { return }
        buying = tip.rawValue
        pending = false
        defer { buying = nil }
        do {
            switch try await product.purchase() {
            case .success(let verification):
                // Only finish transactions whose signature Apple verified; unverified ones don't count as success
                guard case .verified(let transaction) = verification else {
                    message = L10n.string("support.unverified")
                    return
                }
                await transaction.finish()
                message = nil
                thanked = true
            case .pending:
                // Needs parental approval or extra verification; the result comes back via Transaction.updates
                message = nil
                pending = true
            case .userCancelled:
                break
            @unknown default:
                break
            }
        } catch {
            message = error.localizedDescription
        }
    }
}

/// Start listening at App launch: transactions needing extra verification, or not finished last time, come back here.
/// Finish them as StoreKit requires, otherwise Apple keeps redelivering them.
enum TipTransactions {
    static func listen() -> Task<Void, Never> {
        Task.detached {
            for await update in Transaction.updates {
                if case .verified(let transaction) = update {
                    await transaction.finish()
                }
            }
        }
    }
}
