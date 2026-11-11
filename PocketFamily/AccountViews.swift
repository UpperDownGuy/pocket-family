import SwiftUI

struct SignInView: View {
    @Environment(AppStore.self) private var store
    @State private var familyName = ""
    @State private var name = ""
    @State private var username = ""
    @State private var password = ""
    @State private var setupCode = ""
    @State private var busy = false
    @State private var error: String?
    @State private var showingServer = false
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    VStack(alignment: .leading, spacing: 16) {
                        Image(systemName: "wallet.bifold.fill")
                            .font(.system(size: 32)).foregroundStyle(Color.pocketGreen)
                            .frame(width: 76, height: 76)
                            .glassEffect(.regular, in: .rect(cornerRadius: 24))
                        Text("Pocket").font(.system(size: 46, weight: .semibold, design: .rounded))
                        Text(store.setupRequired ? "Set up your family" : "Sign in")
                            .font(.title3).foregroundStyle(.secondary)
                    }.padding(.top, 32)
                    Panel {
                        VStack(spacing: 16) {
                            if store.setupRequired {
                                TextField("Family name", text: $familyName).textContentType(.organizationName)
                                Divider()
                                TextField("Your name", text: $name).textContentType(.givenName)
                                Divider()
                            }
                            TextField("Username", text: $username)
                                .textContentType(.username).textInputAutocapitalization(.never).autocorrectionDisabled()
                            Divider()
                            SecureField("Password", text: $password)
                                .textContentType(store.setupRequired ? .newPassword : .password)
                            if store.setupRequired {
                                Divider()
                                SecureField("Setup code", text: $setupCode).textInputAutocapitalization(.never).autocorrectionDisabled()
                            }
                        }.padding(.vertical, 6)
                    }
                    if store.setupRequired {
                        Text("Use the setup code shown when you start the server. Passwords need at least 10 characters.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    ErrorLine(message: error ?? store.error)
                    Button {
                        busy = true
                        error = nil
                        Task {
                            do {
                                if store.setupRequired {
                                    try await store.setup(familyName: familyName, name: name, username: username, password: password, setupCode: setupCode)
                                } else {
                                    try await store.signIn(username: username, password: password)
                                }
                                password = ""
                                setupCode = ""
                            } catch { self.error = error.localizedDescription }
                            busy = false
                        }
                    } label: {
                        HStack {
                            Spacer()
                            if busy { ProgressView() } else { Text(store.setupRequired ? "Create family" : "Sign in").fontWeight(.semibold) }
                            Spacer()
                        }.padding(.vertical, 12)
                    }.buttonStyle(.glassProminent)
                        .disabled(busy || username.isEmpty || password.isEmpty || (store.setupRequired && (name.isEmpty || familyName.isEmpty || setupCode.isEmpty || password.count < 10)))
                    Button("Server settings", systemImage: "network") { showingServer = true }
                        .font(.footnote).frame(maxWidth: .infinity)
                }.padding(28)
            }
            .background { PocketBackground() }
            .sheet(isPresented: $showingServer) { ServerView() }
            .task { await store.checkServer() }
        }
    }
}

struct FamilyView: View {
    @Environment(AppStore.self) private var store
    @State private var showingMember = false
    @State private var showingServer = false
    @State private var error: String?
    @State private var notificationStatus: String?
    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(spacing: 16) {
                        Initials(name: store.state?.user.name ?? "", size: 56)
                        VStack(alignment: .leading, spacing: 5) {
                            Text(store.state?.user.name ?? "").font(.headline)
                            Text(store.state?.user.role == "parent" ? "Parent" : "Child").font(.subheadline).foregroundStyle(.secondary)
                        }
                    }.padding(.vertical, 10)
                }
                if store.state?.user.role == "parent" {
                    Section("Members") {
                        ForEach(store.state?.members ?? []) { member in
                            HStack(spacing: 12) {
                                Initials(name: member.name, size: 34)
                                Text(member.name)
                                Spacer()
                                Text(member.role == "parent" ? "Parent" : "Child").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        Button("Add member", systemImage: "person.badge.plus") { showingMember = true }
                    }
                }
                Section {
                    Button("Enable notifications", systemImage: "bell.badge") {
                        Task {
                            do {
                                try await store.enableNotifications()
                                notificationStatus = "Notification permission updated."
                            } catch { self.error = error.localizedDescription }
                        }
                    }
                    if let notificationStatus { Text(notificationStatus).font(.footnote).foregroundStyle(.secondary) }
                } header: { Text("Notifications") } footer: {
                    Text(store.state?.pushConfigured == true ? "Parents receive every update. Kids receive their own." : "Inbox alerts are on. Phone alerts need push notification setup.")
                }
                Section {
                    Label("Receipt detection", systemImage: "safari")
                    Text("In Safari, enable Pocket in Extensions. Sign in with the child’s account, then turn on each store.")
                        .font(.footnote).foregroundStyle(.secondary)
                } header: { Text("Safari purchases") } footer: {
                    Text("Clear USD confirmation pages can be logged automatically. Check Activity after checkout.")
                }
                Section {
                    Button("Server settings", systemImage: "network") { showingServer = true }
                    Button("Sign out", role: .destructive) { Task { await store.signOut() } }
                }
                if let error { Section { ErrorLine(message: error) } }
            }
            .scrollContentBackground(.hidden).background { PocketBackground() }
            .navigationTitle(store.state?.familyName ?? "Family")
            .sheet(isPresented: $showingMember) { AddMemberView() }
            .sheet(isPresented: $showingServer) { ServerView() }
        }
    }
}

struct AddMemberView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var username = ""
    @State private var password = ""
    @State private var role = "child"
    @State private var error: String?
    @State private var busy = false
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $name).textContentType(.givenName)
                    Picker("Role", selection: $role) {
                        Text("Child").tag("child")
                        Text("Parent").tag("parent")
                    }
                }
                Section {
                    TextField("Username", text: $username).textInputAutocapitalization(.never).autocorrectionDisabled().textContentType(.username)
                    SecureField("Password", text: $password).textContentType(.newPassword)
                } header: { Text("Sign-in") } footer: { Text("Use at least 10 characters for the password.") }
                if let error { Section { ErrorLine(message: error) } }
            }
            .disabled(busy)
            .navigationTitle("Add member").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(busy) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        busy = true
                        Task {
                            do {
                                try await store.addMember(name: name, username: username, password: password, role: role)
                                dismiss()
                            } catch { self.error = error.localizedDescription }
                            busy = false
                        }
                    }.disabled(busy || name.isEmpty || username.isEmpty || password.count < 10)
                }
            }.interactiveDismissDisabled(busy)
        }
    }
}

struct ServerView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var error: String?
    @State private var busy = false
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Server address", text: $address)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                } header: { Text("Address") } footer: {
                    Text("On an iPhone, enter your server’s local network address. Changing servers signs you out.")
                }
                if let error { Section { ErrorLine(message: error) } }
            }
            .navigationTitle("Server").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(busy) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        busy = true
                        Task {
                            do { try await store.changeServer(to: address); dismiss() }
                            catch { self.error = error.localizedDescription }
                            busy = false
                        }
                    }.disabled(busy || address.isEmpty)
                }
            }
            .onAppear { address = store.serverURL }
        }
    }
}
