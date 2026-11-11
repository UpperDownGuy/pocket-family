import SwiftUI

@main
struct PocketFamilyApp: App {
    @State private var store = AppStore()
    @UIApplicationDelegateAdaptor(PushManager.self) private var pushManager
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
                .tint(.pocketGreen)
                .task {
                    pushManager.tokenHandler = { token in
                        Task { await store.registerDevice(token: token) }
                    }
                    pushManager.refreshHandler = {
                        Task { await store.refresh() }
                    }
                    pushManager.registrationErrorHandler = { message in
                        store.error = message
                    }
                    if let token = pushManager.lastDeviceToken {
                        await store.registerDevice(token: token)
                    }
                    await store.checkServer()
                    if store.isSignedIn { await store.refresh() }
                }
                .task(id: scenePhase) {
                    guard scenePhase == .active else { return }
                    while !Task.isCancelled {
                        if store.isSignedIn { await store.refresh() }
                        do { try await Task.sleep(for: .seconds(8)) }
                        catch { return }
                    }
                }
        }
    }
}

struct RootView: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        Group {
            if store.isSignedIn, store.state != nil {
                TabView {
                    Tab("Balances", systemImage: "wallet.bifold") { BalanceView() }
                    Tab("Activity", systemImage: "arrow.up.arrow.down") { ActivityView() }
                    Tab("Inbox", systemImage: "bell") { InboxView() }
                        .badge(store.state?.notifications.filter { $0.readAt == nil }.count ?? 0)
                    Tab("Family", systemImage: "person.2") { FamilyView() }
                }
            } else if store.isSignedIn {
                ContentUnavailableView {
                    Label("Connecting", systemImage: "wifi")
                } description: {
                    Text(store.error ?? "Loading your balances.")
                } actions: {
                    Button("Try again") { Task { await store.refresh() } }
                    Button("Sign out") { Task { await store.signOut() } }
                }
            } else {
                SignInView()
            }
        }
    }
}
