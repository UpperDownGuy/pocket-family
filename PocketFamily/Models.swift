import Foundation

struct Member: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let username: String
    let role: String
    let balanceCents: Int?

    var isParent: Bool { role == "parent" }
    var initials: String {
        name.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined().uppercased()
    }
    var balanceDisplay: String { Money.format(balanceCents ?? 0) }
}

struct LedgerTransaction: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let childId: String
    let childName: String
    let kind: String
    let amountCents: Int
    let merchant: String
    let note: String
    let createdAt: String

    var isAddition: Bool { kind == "addition" }
    var signedCents: Int { isAddition ? amountCents : -amountCents }
    var amountDisplay: String { "\(isAddition ? "+" : "−")\(Money.format(amountCents))" }
    var title: String { merchant.isEmpty ? (isAddition ? "Money added" : "Purchase") : merchant }
    var symbol: String { isAddition ? "arrow.down.left" : "bag" }
    var date: Date { ISODate.parse(createdAt) ?? .distantPast }
}

struct InboxNotification: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let transactionId: String
    let title: String
    let body: String
    let createdAt: String
    let readAt: String?

    var isUnread: Bool { readAt == nil }
    var date: Date { ISODate.parse(createdAt) ?? .distantPast }
}

struct FamilyState: Codable, Sendable {
    let user: Member
    let familyName: String
    let members: [Member]
    let transactions: [LedgerTransaction]
    let notifications: [InboxNotification]
    let pushConfigured: Bool

    var children: [Member] { members.filter { !$0.isParent } }
    var parents: [Member] { members.filter(\.isParent) }
    var unreadCount: Int { notifications.filter(\.isUnread).count }
    var totalBalanceCents: Int { children.reduce(0) { $0 + ($1.balanceCents ?? 0) } }
}

struct AuthResponse: Decodable, Sendable {
    let token: String
    let user: Member
    let familyName: String
}

struct ServerHealth: Decodable, Sendable {
    let setupRequired: Bool
    let pushConfigured: Bool
}

enum Money {
    static func format(_ cents: Int) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        formatter.locale = Locale(identifier: "en_US")
        return formatter.string(from: NSNumber(value: Double(cents) / 100)) ?? "$0.00"
    }

    /// Parses decimal dollars without binary floating-point rounding.
    static func cents(from input: String) -> Int? {
        let value = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.range(of: #"^[0-9]+(?:\.[0-9]{1,2})?$"#, options: .regularExpression) != nil else { return nil }
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        guard let dollars = Int(parts[0]), dollars <= 10_000 else { return nil }
        let fractional = parts.count == 2 ? String(parts[1]).padding(toLength: 2, withPad: "0", startingAt: 0) : "00"
        guard let pennies = Int(fractional) else { return nil }
        let cents = dollars * 100 + pennies
        return (1...1_000_000).contains(cents) ? cents : nil
    }
}

enum ISODate {
    static func parse(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }
}
