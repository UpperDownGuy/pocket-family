import SwiftUI

struct ActivityView: View {
    @Environment(AppStore.self) private var store
    @State private var search = ""
    @State private var filter = "all"
    private var filtered: [LedgerTransaction] {
        (store.state?.transactions ?? []).filter { item in
            (filter == "all" || item.kind == filter) &&
            (search.isEmpty || "\(item.merchant) \(item.note) \(item.childName)".localizedCaseInsensitiveContains(search))
        }
    }
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Picker("Type", selection: $filter) {
                        Text("All").tag("all")
                        Text("Purchases").tag("purchase")
                        Text("Added").tag("addition")
                    }.pickerStyle(.segmented)
                }.listRowBackground(Color.clear).listRowInsets(EdgeInsets())
                Section {
                    ForEach(filtered) { item in
                        NavigationLink { ReceiptView(transaction: item) } label: {
                            TransactionRow(transaction: item, showChild: store.state?.user.role == "parent")
                        }
                    }
                }
            }
            .overlay {
                if filtered.isEmpty { ContentUnavailableView("No activity", systemImage: "tray", description: Text(search.isEmpty ? "Purchases and additions appear here." : "Try another search.")) }
            }
            .scrollContentBackground(.hidden).background { PocketBackground() }
            .navigationTitle("Activity")
            .searchable(text: $search, prompt: "Search activity")
            .refreshable { await store.refresh() }
        }
    }
}

struct InboxView: View {
    @Environment(AppStore.self) private var store
    @State private var error: String?
    private var notifications: [InboxNotification] { store.state?.notifications ?? [] }
    var body: some View {
        NavigationStack {
            List {
                if let error { ErrorLine(message: error) }
                ForEach(notifications) { notification in
                    NavigationLink {
                        NotificationDetailView(notification: notification)
                    } label: {
                        HStack(alignment: .top, spacing: 13) {
                            Image(systemName: notification.readAt == nil ? "bell.badge.fill" : "bell")
                                .foregroundStyle(notification.readAt == nil ? Color.pocketGreen : Color.secondary)
                                .frame(width: 28).padding(.top, 4)
                            VStack(alignment: .leading, spacing: 6) {
                                Text(notification.title).font(.subheadline.weight(notification.readAt == nil ? .semibold : .regular))
                                Text(notification.body).font(.subheadline).foregroundStyle(.secondary)
                                Text(receiptDate(notification.createdAt), style: .relative).font(.caption).foregroundStyle(.tertiary)
                            }
                        }.padding(.vertical, 8)
                    }
                }
            }
            .overlay { if notifications.isEmpty { ContentUnavailableView("All quiet", systemImage: "bell", description: Text("Balance updates appear here.")) } }
            .scrollContentBackground(.hidden).background { PocketBackground() }
            .navigationTitle("Inbox")
            .toolbar {
                if notifications.contains(where: { $0.readAt == nil }) {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Read all", systemImage: "checkmark") {
                            Task {
                                do { try await store.markRead(ids: notifications.filter { $0.readAt == nil }.map(\.id)) }
                                catch { self.error = error.localizedDescription }
                            }
                        }
                    }
                }
            }
            .refreshable { await store.refresh() }
        }
    }
}

struct NotificationDetailView: View {
    @Environment(AppStore.self) private var store
    let notification: InboxNotification
    var body: some View {
        Group {
            if let item = store.state?.transactions.first(where: { $0.id == notification.transactionId }) {
                ReceiptView(transaction: item)
            } else {
                ContentUnavailableView(notification.title, systemImage: "bell", description: Text(notification.body))
            }
        }
        .task {
            do { try await store.markRead(ids: [notification.id]) }
            catch { store.error = error.localizedDescription }
        }
    }
}
