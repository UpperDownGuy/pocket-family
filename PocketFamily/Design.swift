import SwiftUI

extension Color {
    static let pocketGreen = Color(red: 0.05, green: 0.43, blue: 0.35)
    static let pocketMint = Color(red: 0.65, green: 0.86, blue: 0.77)
}

func usd(_ cents: Int) -> String {
    (Double(cents) / 100).formatted(.currency(code: "USD"))
}

func receiptDate(_ value: String) -> Date {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value) ?? .distantPast
}

struct PocketBackground: View {
    @Environment(\.colorScheme) private var colorScheme
    var body: some View {
        ZStack {
            Color(uiColor: .systemGroupedBackground)
            LinearGradient(colors: [.pocketMint.opacity(colorScheme == .dark ? 0.12 : 0.35), .cyan.opacity(0.05), .clear], startPoint: .topLeading, endPoint: .bottomTrailing)
        }.ignoresSafeArea()
    }
}

struct MemberAvatar: View {
    let name: String
    let memberID: String
    var size: CGFloat = 42

    private static let colors: [Color] = [
        Color(red: 0.09, green: 0.43, blue: 0.35),
        Color(red: 0.19, green: 0.37, blue: 0.65),
        Color(red: 0.46, green: 0.33, blue: 0.67),
        Color(red: 0.66, green: 0.27, blue: 0.47),
        Color(red: 0.67, green: 0.33, blue: 0.17),
        Color(red: 0.25, green: 0.45, blue: 0.28),
        Color(red: 0.15, green: 0.43, blue: 0.55),
        Color(red: 0.36, green: 0.38, blue: 0.66),
    ]

    private var initials: String {
        name.split(whereSeparator: \.isWhitespace).prefix(2)
            .compactMap(\.first).map(String.init).joined().uppercased()
    }

    private var color: Color {
        // Stable across launches and devices, even when a member changes their name.
        let seed = memberID.isEmpty ? name : memberID
        let hash = seed.utf8.reduce(UInt64(14_695_981_039_346_656_037)) {
            ($0 ^ UInt64($1)) &* 1_099_511_628_211
        }
        return Self.colors[Int(hash % UInt64(Self.colors.count))]
    }

    var body: some View {
        ZStack {
            Circle().fill(color)
            if initials.isEmpty {
                Image(systemName: "person.fill")
                    .font(.system(size: size * 0.4, weight: .semibold))
                    .symbolRenderingMode(.monochrome)
            } else {
                Text(initials)
                    .font(.system(size: size * 0.34, weight: .bold, design: .rounded))
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    .padding(.horizontal, size * 0.12)
            }
        }
        .foregroundStyle(.white)
        .frame(width: size, height: size)
        .fixedSize()
        .accessibilityHidden(true)
    }
}

struct Panel<Content: View>: View {
    private let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        content
            .padding(20)
            .background(Color(uiColor: .secondarySystemGroupedBackground), in: .rect(cornerRadius: 24))
    }
}

struct ErrorLine: View {
    let message: String?
    var body: some View {
        if let message, !message.isEmpty {
            Label(message, systemImage: "exclamationmark.circle")
                .font(.footnote)
                .foregroundStyle(.red)
                .accessibilityAddTraits(.updatesFrequently)
        }
    }
}

struct TransactionRow: View {
    let transaction: LedgerTransaction
    var showChild = true
    private var isAddition: Bool { transaction.kind == "addition" }
    var body: some View {
        HStack(spacing: 13) {
            Image(systemName: isAddition ? "plus" : "bag")
                .font(.system(size: 19, weight: .medium))
                .foregroundStyle(isAddition ? Color.pocketGreen : Color.primary)
                .frame(width: 43, height: 43)
                .background(isAddition ? Color.pocketMint.opacity(0.3) : Color.secondary.opacity(0.08), in: .rect(cornerRadius: 14))
            VStack(alignment: .leading, spacing: 5) {
                Text(transaction.merchant).font(.subheadline.weight(.semibold))
                Text(showChild ? transaction.childName : receiptDate(transaction.createdAt).formatted(date: .abbreviated, time: .shortened))
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Text("\(isAddition ? "+" : "−")\(usd(transaction.amountCents))")
                .font(.subheadline.weight(.semibold)).monospacedDigit()
                .foregroundStyle(isAddition ? Color.pocketGreen : Color.primary)
        }
        .padding(.vertical, 7)
        .accessibilityElement(children: .combine)
    }
}
