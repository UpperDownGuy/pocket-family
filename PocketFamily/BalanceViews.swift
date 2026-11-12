import SwiftUI

struct BalanceView: View {
    @Environment(AppStore.self) private var store
    @State private var showingEntry = false
    @State private var showingMember = false
    private var children: [Member] { store.state?.members.filter { $0.role == "child" } ?? [] }
    private var isParent: Bool { store.state?.user.role == "parent" }
    private var transactions: [LedgerTransaction] { store.state?.transactions ?? [] }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    VStack(alignment: .leading, spacing: 9) {
                        Text(isParent ? "Family balance" : "Your balance")
                            .font(.subheadline.weight(.medium)).foregroundStyle(.secondary)
                        Text(usd(children.reduce(0) { $0 + ($1.balanceCents ?? 0) }))
                            .font(.system(size: 54, weight: .semibold, design: .rounded))
                            .minimumScaleFactor(0.55).lineLimit(1).monospacedDigit()
                            .contentTransition(.numericText())
                        Label("USD", systemImage: "checkmark.shield")
                            .font(.caption.weight(.medium)).foregroundStyle(.secondary)
                    }
                    .padding(.top, 10)
                    .padding(.horizontal, 6)

                    if !children.isEmpty {
                        GlassEffectContainer(spacing: 16) {
                            HStack(spacing: 14) {
                                Button { showingEntry = true } label: {
                                    Label(isParent ? "Add or spend" : "Add purchase", systemImage: isParent ? "plus" : "bag.badge.plus")
                                        .font(.subheadline.weight(.semibold)).frame(maxWidth: .infinity).padding(.vertical, 8)
                                }.buttonStyle(.glassProminent)
                                if isParent {
                                    Button { showingMember = true } label: {
                                        Image(systemName: "person.badge.plus").frame(width: 35, height: 35)
                                    }.buttonStyle(.glass).accessibilityLabel("Add family member")
                                }
                            }
                        }
                    }

                    if isParent {
                        VStack(alignment: .leading, spacing: 13) {
                            Text("Kids").font(.title3.weight(.semibold)).padding(.horizontal, 6)
                            if children.isEmpty {
                                Panel {
                                    VStack(spacing: 16) {
                                        Image(systemName: "person.2").font(.largeTitle).foregroundStyle(Color.pocketGreen)
                                        Text("Add your first child").font(.headline)
                                        Button("Add child") { showingMember = true }.buttonStyle(.glass)
                                    }.frame(maxWidth: .infinity).padding(.vertical, 10)
                                }
                            }
                            ForEach(children) { child in
                                NavigationLink {
                                    ChildDetailView(childID: child.id)
                                } label: {
                                    Panel {
                                        HStack(spacing: 14) {
                                            MemberAvatar(name: child.name, memberID: child.id)
                                            VStack(alignment: .leading, spacing: 5) {
                                                Text(child.name).font(.headline)
                                                Text("Balance").font(.caption).foregroundStyle(.secondary)
                                            }
                                            Spacer()
                                            Text(usd(child.balanceCents ?? 0)).font(.title3.weight(.semibold)).monospacedDigit()
                                            Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
                                        }
                                    }
                                }.buttonStyle(.plain)
                            }
                        }
                    }

                    VStack(alignment: .leading, spacing: 12) {
                        Text("Recent activity").font(.title3.weight(.semibold)).padding(.horizontal, 6)
                        Panel {
                            if transactions.isEmpty {
                                Label("No activity yet", systemImage: "tray").foregroundStyle(.secondary).frame(maxWidth: .infinity).padding(.vertical, 22)
                            } else {
                                VStack(spacing: 2) {
                                    ForEach(Array(transactions.prefix(5).enumerated()), id: \.element.id) { index, item in
                                        NavigationLink { ReceiptView(transaction: item) } label: {
                                            TransactionRow(transaction: item, showChild: isParent)
                                        }.buttonStyle(.plain)
                                        if index < min(transactions.count, 5) - 1 { Divider().padding(.leading, 56) }
                                    }
                                }
                            }
                        }
                    }
                    ErrorLine(message: store.error)
                }.padding(20).padding(.bottom, 20)
            }
            .background { PocketBackground() }
            .navigationTitle("Pocket")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Text(store.state?.familyName ?? "Family").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                }
            }
            .refreshable { await store.refresh() }
            .sheet(isPresented: $showingEntry) { EntryView() }
            .sheet(isPresented: $showingMember) { AddMemberView() }
        }
    }
}

struct ChildDetailView: View {
    @Environment(AppStore.self) private var store
    let childID: String
    @State private var showingEntry = false
    private var child: Member? { store.state?.members.first { $0.id == childID } }
    var body: some View {
        List {
            Section {
                VStack(spacing: 16) {
                    MemberAvatar(name: child?.name ?? "", memberID: childID, size: 64)
                    Text(usd(child?.balanceCents ?? 0)).font(.system(size: 44, weight: .semibold, design: .rounded)).monospacedDigit()
                    Button("Add or spend", systemImage: "plus") { showingEntry = true }.buttonStyle(.glassProminent)
                }.frame(maxWidth: .infinity).padding(.vertical, 24)
            }.listRowBackground(Color.clear)
            Section("Activity") {
                let items = store.state?.transactions.filter { $0.childId == childID } ?? []
                if items.isEmpty { Text("No activity yet").foregroundStyle(.secondary) }
                ForEach(items) { item in
                    NavigationLink { ReceiptView(transaction: item) } label: { TransactionRow(transaction: item, showChild: false) }
                }
            }
        }
        .scrollContentBackground(.hidden).background { PocketBackground() }
        .navigationTitle(child?.name ?? "Balance")
        .sheet(isPresented: $showingEntry) { EntryView(initialChildID: childID) }
    }
}

struct EntryView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    var initialChildID: String? = nil
    @State private var childID = ""
    @State private var kind = "purchase"
    @State private var amount = ""
    @State private var merchant = ""
    @State private var note = ""
    @State private var error: String?
    @State private var saving = false
    @State private var requestID = UUID().uuidString
    private var isParent: Bool { store.state?.user.role == "parent" }
    private var children: [Member] { store.state?.members.filter { $0.role == "child" } ?? [] }
    private var cents: Int? {
        Money.cents(from: amount.replacingOccurrences(of: ",", with: "."))
    }
    var body: some View {
        NavigationStack {
            Form {
                if isParent {
                    Section {
                        Picker("Type", selection: $kind) {
                            Text("Purchase").tag("purchase")
                            Text("Add money").tag("addition")
                        }.pickerStyle(.segmented)
                        Picker("Child", selection: $childID) {
                            ForEach(children) { child in Text(child.name).tag(child.id) }
                        }
                    }
                }
                Section {
                    HStack(alignment: .firstTextBaseline) {
                        Text("$").foregroundStyle(.secondary)
                        TextField("0.00", text: $amount).keyboardType(.decimalPad).accessibilityLabel("Amount in US dollars")
                    }.font(.system(size: 42, weight: .medium, design: .rounded)).padding(.vertical, 15)
                    TextField(kind == "addition" ? "From, e.g. allowance" : "Store", text: $merchant).textInputAutocapitalization(.words)
                    TextField(kind == "addition" ? "Note (optional)" : "What did you buy?", text: $note, axis: .vertical).lineLimit(2...4)
                } header: { Text(kind == "addition" ? "Add money" : "Purchase") } footer: {
                    Text("Notifies the parents and \(children.first { $0.id == childID }?.name ?? "this child").")
                }
                if let error { Section { ErrorLine(message: error) } }
            }
            .disabled(saving)
            .navigationTitle(kind == "addition" ? "Add money" : "New purchase")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        guard let cents else { return }
                        saving = true
                        Task {
                            do {
                                try await store.recordTransaction(childId: childID, kind: kind, amountCents: cents, merchant: merchant.trimmingCharacters(in: .whitespacesAndNewlines), note: note, idempotencyKey: requestID)
                                dismiss()
                            } catch { self.error = error.localizedDescription }
                            saving = false
                        }
                    } label: {
                        if saving { ProgressView() } else { Text("Save") }
                    }.disabled(saving || cents == nil || childID.isEmpty || merchant.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .onAppear { childID = initialChildID ?? children.first?.id ?? "" }
            .onChange(of: amount) { requestID = UUID().uuidString }
            .onChange(of: merchant) { requestID = UUID().uuidString }
            .onChange(of: note) { requestID = UUID().uuidString }
            .onChange(of: kind) { requestID = UUID().uuidString }
            .onChange(of: childID) { requestID = UUID().uuidString }
            .interactiveDismissDisabled(saving)
        }
    }
}

struct ReceiptView: View {
    let transaction: LedgerTransaction
    var body: some View {
        List {
            Section {
                VStack(spacing: 12) {
                    Image(systemName: transaction.kind == "addition" ? "plus.circle" : "bag").font(.largeTitle).foregroundStyle(Color.pocketGreen)
                    Text("\(transaction.kind == "addition" ? "+" : "−")\(usd(transaction.amountCents))")
                        .font(.system(size: 42, weight: .semibold, design: .rounded)).monospacedDigit()
                    Text(transaction.merchant).font(.headline)
                }.frame(maxWidth: .infinity).padding(.vertical, 24)
            }.listRowBackground(Color.clear)
            Section {
                LabeledContent("Child", value: transaction.childName)
                LabeledContent("Date", value: receiptDate(transaction.createdAt).formatted(date: .abbreviated, time: .shortened))
                LabeledContent("Type", value: transaction.kind == "addition" ? "Money added" : "Purchase")
                if !transaction.note.isEmpty { Text(transaction.note) }
            }
            Section {
                Label("Parents + \(transaction.childName)", systemImage: "bell.badge")
            } header: { Text("Notified") }
        }
        .scrollContentBackground(.hidden).background { PocketBackground() }
        .navigationTitle("Details").navigationBarTitleDisplayMode(.inline)
    }
}
