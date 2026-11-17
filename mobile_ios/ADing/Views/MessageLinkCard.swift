import SwiftUI

struct MessageLinkCard: View {
    let title: String
    let summary: String
    let site: String
    var image: Image?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let image {
                    image.resizable().scaledToFill()
                        .frame(width: 60, height: 60).clipped()
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                }
            }
            if !summary.isEmpty {
                Text(summary).font(.footnote).foregroundStyle(Color(uiColor: .secondaryLabel)).lineLimit(5)
            }
            Text(site).font(.caption).foregroundStyle(Color(uiColor: .secondaryLabel)).lineLimit(2)
        }
        .multilineTextAlignment(.leading)
        .padding(12)
        // Hierarchical .primary/.secondary styles inherit the outgoing bubble's white foreground.
        // Use explicit adaptive system colors so the card owns both sides of its contrast.
        .foregroundStyle(Color(uiColor: .label))
        .background(Color(uiColor: .systemBackground), in: RoundedRectangle(cornerRadius: 12))
    }
}
