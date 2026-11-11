import Foundation
import Observation
import UIKit
import UserNotifications

@MainActor
@Observable
final class AppStore {
    private(set) var state: FamilyState?
    private(set) var serverURL: String
    private(set) var setupRequired = false
    private(set) var checkingServer = false
    var error: String?

    private var operationCount = 0
    private var token: String?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var stateRequestSequence = 0
    @ObservationIgnored private var healthRequestID = UUID()
    @ObservationIgnored private var pendingDeviceToken: String?

    var isLoading: Bool { operationCount > 0 }
    var isSignedIn: Bool { token != nil }

    init() {
        let savedURL = UserDefaults.standard.string(forKey: "PocketFamily.ServerURL") ?? "http://127.0.0.1:8787"
        serverURL = (try? APIClient.validateServerURL(savedURL).absoluteString) ?? "http://127.0.0.1:8787"
        token = SessionKeychain.read(server: serverURL)
    }

    func checkServer() async {
        let requestID = UUID()
        healthRequestID = requestID
        checkingServer = true
        defer { if healthRequestID == requestID { checkingServer = false } }
        let expectedGeneration = generation
        do {
            let health: ServerHealth = try await APIClient(serverURL: serverURL).get("/health")
            guard expectedGeneration == generation, healthRequestID == requestID else { return }
            setupRequired = health.setupRequired
            error = nil
        } catch {
            if expectedGeneration == generation, healthRequestID == requestID { show(error) }
        }
    }

    func signIn(username: String, password: String) async throws {
        generation += 1
        try await perform {
            let expectedGeneration = self.generation
            let client = try APIClient(serverURL: self.serverURL)
            let auth: AuthResponse = try await client.send("/login", body: SignInBody(username: username, password: password))
            try await self.accept(auth, client: client, expectedGeneration: expectedGeneration)
        }
    }

    func setup(familyName: String, name: String, username: String, password: String, setupCode: String) async throws {
        generation += 1
        try await perform {
            let expectedGeneration = self.generation
            let client = try APIClient(serverURL: self.serverURL)
            let auth: AuthResponse = try await client.send("/setup", body: SetupBody(
                familyName: familyName, name: name, username: username, password: password, setupCode: setupCode
            ))
            try await self.accept(auth, client: client, expectedGeneration: expectedGeneration)
            self.setupRequired = false
        }
    }

    func refresh() async {
        guard isSignedIn else { return }
        let expectedGeneration = generation
        do {
            let session = try authenticatedSession()
            try await loadState(session)
        } catch {
            if expectedGeneration == generation, !(error is CancellationError) { show(error) }
        }
    }

    func signOut() async {
        let oldToken = token
        let oldServer = serverURL
        generation += 1
        let signedOutGeneration = generation
        token = nil
        state = nil
        error = nil
        SessionKeychain.delete(server: oldServer)
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        UNUserNotificationCenter.current().removeAllPendingNotificationRequests()
        if let oldToken, let client = try? APIClient(serverURL: oldServer) {
            do {
                try await client.send("/logout", body: EmptyBody(), token: oldToken)
            } catch {
                if signedOutGeneration == generation {
                    self.error = "Signed out on this iPhone. The server could not be reached to end the session."
                }
            }
        }
    }

    func changeServer(to value: String) async throws {
        let newURL = try APIClient.validateServerURL(value).absoluteString
        guard newURL != serverURL else {
            await checkServer()
            return
        }
        await signOut()
        generation += 1
        serverURL = newURL
        UserDefaults.standard.set(newURL, forKey: "PocketFamily.ServerURL")
        token = SessionKeychain.read(server: newURL)
        state = nil
        setupRequired = false
        error = nil
        await checkServer()
        if isSignedIn { await refresh() }
    }

    func addMember(name: String, username: String, password: String, role: String) async throws {
        try await perform {
            let session = try self.authenticatedSession()
            try await session.client.send("/members", body: MemberBody(name: name, username: username, password: password, role: role), token: session.token)
            try await self.loadState(session)
        }
    }

    func recordTransaction(childId: String, kind: String, amountCents: Int, merchant: String, note: String, idempotencyKey: String) async throws {
        try await perform {
            let session = try self.authenticatedSession()
            guard (1...1_000_000).contains(amountCents), ["addition", "purchase"].contains(kind) else {
                throw APIError.message("Enter an amount between $0.01 and $10,000.00.")
            }
            try await session.client.send("/transactions", body: TransactionBody(
                childId: childId, kind: kind, amountCents: amountCents, merchant: merchant,
                note: note, idempotencyKey: idempotencyKey
            ), token: session.token)
            try await self.loadState(session)
        }
    }

    func markRead(ids: [String]) async throws {
        guard !ids.isEmpty else { return }
        try await perform {
            let session = try self.authenticatedSession()
            for start in stride(from: 0, to: ids.count, by: 1_000) {
                let batch = Array(ids[start..<min(start + 1_000, ids.count)])
                try await session.client.send("/notifications/read", body: ReadBody(ids: batch), token: session.token)
            }
            try await self.loadState(session)
        }
    }

    func enableNotifications() async throws {
        guard state?.pushConfigured == true else {
            throw APIError.message("Push alerts need to be configured on the server. Your inbox is available here.")
        }
        let allowed = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
        guard allowed else {
            throw APIError.message("Notifications are off. You can enable them for Pocket in iPhone Settings.")
        }
        UIApplication.shared.registerForRemoteNotifications()
        if let pendingDeviceToken { await registerDevice(token: pendingDeviceToken) }
    }

    /// Call from PushManager's tokenHandler. Tokens are kept in memory only.
    func registerDevice(token deviceToken: String) async {
        pendingDeviceToken = deviceToken
        guard isSignedIn else { return }
        let expectedGeneration = generation
        do {
            let session = try authenticatedSession()
            try await session.client.send("/devices", body: DeviceBody(token: deviceToken), token: session.token)
        } catch {
            if expectedGeneration == generation { show(error) }
        }
    }

    private func accept(_ auth: AuthResponse, client: APIClient, expectedGeneration: Int) async throws {
        guard expectedGeneration == generation else { throw CancellationError() }
        try SessionKeychain.save(auth.token, server: serverURL)
        token = auth.token
        try await loadState(Session(client: client, token: auth.token, generation: expectedGeneration))
        if let pendingDeviceToken { await registerDevice(token: pendingDeviceToken) }
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        if settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional {
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    private func loadState(_ session: Session) async throws {
        guard session.generation == generation, session.token == token else { throw CancellationError() }
        stateRequestSequence += 1
        let requestSequence = stateRequestSequence
        do {
            let result: FamilyState = try await session.client.get("/state", token: session.token)
            guard session.generation == generation, session.token == token else { throw CancellationError() }
            // A later poll or post-mutation refresh owns the current snapshot.
            guard requestSequence == stateRequestSequence else { return }
            state = result
            error = nil
        } catch {
            guard session.generation == generation, session.token == token else { throw CancellationError() }
            // An obsolete response must not replace a newer snapshot or its error state.
            guard requestSequence == stateRequestSequence else { return }
            throw error
        }
    }

    private func authenticatedSession() throws -> Session {
        guard let token else { throw APIError.message("Sign in to continue.") }
        return Session(client: try APIClient(serverURL: serverURL), token: token, generation: generation)
    }

    private func perform<T>(_ operation: () async throws -> T) async throws -> T {
        let expectedGeneration = generation
        operationCount += 1
        error = nil
        defer { operationCount -= 1 }
        do { return try await operation() }
        catch {
            if expectedGeneration == generation, !(error is CancellationError) { show(error) }
            throw error
        }
    }

    private func show(_ failure: Error) {
        if let apiError = failure as? APIError, apiError.isUnauthorized {
            generation += 1
            token = nil
            state = nil
            SessionKeychain.delete(server: serverURL)
            UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        }
        if let urlError = failure as? URLError {
            switch urlError.code {
            case .notConnectedToInternet, .cannotConnectToHost, .cannotFindHost, .timedOut:
                error = "Could not reach the family server. Check its address and your connection."
            case .cancelled:
                break
            default:
                error = urlError.localizedDescription
            }
        } else {
            error = failure.localizedDescription
        }
    }

    private struct Session {
        let client: APIClient
        let token: String
        let generation: Int
    }
    private struct EmptyBody: Encodable {}
    private struct SignInBody: Encodable { let username: String; let password: String }
    private struct SetupBody: Encodable {
        let familyName: String; let name: String; let username: String; let password: String; let setupCode: String
    }
    private struct MemberBody: Encodable { let name: String; let username: String; let password: String; let role: String }
    private struct TransactionBody: Encodable {
        let childId: String; let kind: String; let amountCents: Int; let merchant: String; let note: String; let idempotencyKey: String
    }
    private struct ReadBody: Encodable { let ids: [String] }
    private struct DeviceBody: Encodable { let token: String }
}
