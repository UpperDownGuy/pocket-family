import Foundation
import SafariServices
import Security

final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        guard let item = context.inputItems.first as? NSExtensionItem,
              let message = item.userInfo?[SFExtensionMessageKey] as? [String: Any] else {
            finish(context, ["ok": false, "error": "Invalid extension request."])
            return
        }
        let profile = (item.userInfo?[SFExtensionProfileKey] as? UUID)?.uuidString ?? "default"
        Task {
            do { self.finish(context, try await self.handle(message, profile: profile)) }
            catch { self.finish(context, ["ok": false, "error": error.localizedDescription]) }
        }
    }

    private func finish(_ context: NSExtensionContext, _ value: [String: Any]) {
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: value]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }

    private func handle(_ message: [String: Any], profile: String) async throws -> [String: Any] {
        let defaults = UserDefaults.standard
        let serverKey = "server.\(profile)"
        let nameKey = "name.\(profile)"
        let currentServer = defaults.string(forKey: serverKey) ?? "http://127.0.0.1:8787"
        let currentAccount = "\(profile)|\(currentServer)"
        switch message["type"] as? String {
        case "status":
            return ["ok": true, "signedIn": readToken(currentAccount) != nil,
                    "name": defaults.string(forKey: nameKey) ?? "Child", "serverURL": currentServer]
        case "login":
            guard let rawServer = message["serverURL"] as? String,
                  let username = message["username"] as? String,
                  let password = message["password"] as? String,
                  !username.isEmpty, username.count <= 100, !password.isEmpty, password.count <= 1024 else {
                throw PocketExtensionError.message("Enter your server, username, and password.")
            }
            let server = try validateServer(rawServer)
            let result = try await request(server, path: "login", body: ["username": username, "password": password])
            guard let token = result["token"] as? String,
                  let user = result["user"] as? [String: Any] else {
                throw PocketExtensionError.message("The server returned an unexpected sign-in response.")
            }
            guard user["role"] as? String == "child" else {
                _ = try? await request(server, path: "logout", body: [:], token: token)
                throw PocketExtensionError.message("Use the child's account in Safari. Parents manage balances in Pocket.")
            }
            try saveToken(token, account: "\(profile)|\(server.absoluteString)")
            if currentServer != server.absoluteString { deleteToken(currentAccount) }
            defaults.set(server.absoluteString, forKey: serverKey)
            defaults.set(user["name"] as? String ?? username, forKey: nameKey)
            return ["ok": true]
        case "logout":
            if let token = readToken(currentAccount), let server = try? validateServer(currentServer) {
                _ = try? await request(server, path: "logout", body: [:], token: token)
            }
            deleteToken(currentAccount)
            defaults.removeObject(forKey: nameKey)
            return ["ok": true]
        case "purchase":
            guard let token = readToken(currentAccount) else {
                throw PocketExtensionError.message("Sign in to Pocket from the Safari extension first.")
            }
            guard let receipt = message["receipt"] as? [String: Any],
                  let rawURL = receipt["url"] as? String,
                  let url = URL(string: rawURL), url.scheme == "https", url.user == nil, url.password == nil,
                  let host = url.host, url.query == nil, url.fragment == nil, url.path.isEmpty || url.path == "/",
                  let amount = receipt["amountCents"] as? Int, (1...1_000_000).contains(amount),
                  let reference = receipt["orderReference"] as? String,
                  reference.range(of: #"^[A-Z0-9][A-Z0-9_-]{3,63}$"#, options: .regularExpression) != nil,
                  reference.rangeOfCharacter(from: .decimalDigits) != nil else {
                throw PocketExtensionError.message("This page does not contain a clear receipt.")
            }
            let server = try validateServer(currentServer)
            do {
                let result = try await request(server, path: "browser/purchase", body: [
                    "merchant": host, "note": "Online purchase", "amountCents": amount,
                    "orderReference": reference, "url": rawURL, "currency": "USD"
                ], token: token)
                return ["ok": true, "duplicate": result["replayed"] as? Bool ?? false]
            } catch PocketExtensionError.unauthorized {
                deleteToken(currentAccount)
                throw PocketExtensionError.message("Your session expired. Sign in again in the Safari extension.")
            }
        default:
            throw PocketExtensionError.message("Unknown extension request.")
        }
    }

    private func validateServer(_ raw: String) throws -> URL {
        guard var parts = URLComponents(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = parts.scheme?.lowercased(), let rawHost = parts.host?.lowercased(),
              !rawHost.isEmpty, parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil, parts.path.isEmpty || parts.path == "/" else {
            throw PocketExtensionError.message("Enter an HTTPS server or a local development address.")
        }
        let host = rawHost.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        let pieces = host.split(separator: ".")
        let octets = pieces.compactMap { Int($0) }
        let localIPv4 = pieces.count == 4 && octets.count == 4 && octets.allSatisfy { (0...255).contains($0) } && (
            octets[0] == 10 || octets[0] == 127 || (octets[0] == 192 && octets[1] == 168) ||
            (octets[0] == 172 && (16...31).contains(octets[1])) || (octets[0] == 169 && octets[1] == 254))
        let local = host == "localhost" || host.hasSuffix(".local") || localIPv4 || host == "::1" ||
            (host.contains(":") && (host.hasPrefix("fc") || host.hasPrefix("fd") || host.hasPrefix("fe80:")))
        guard scheme == "https" || (scheme == "http" && local) else {
            throw PocketExtensionError.message("HTTP is only available for local development servers.")
        }
        parts.scheme = scheme
        parts.path = ""
        guard let url = parts.url else { throw PocketExtensionError.message("Invalid server address.") }
        return url
    }

    private func request(_ server: URL, path: String, body: [String: Any], token: String? = nil) async throws -> [String: Any] {
        var request = URLRequest(url: server.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let session = URLSession(configuration: .ephemeral, delegate: NoRedirect(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw PocketExtensionError.message("No response from Pocket.") }
        let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        if response.statusCode == 401 { throw PocketExtensionError.unauthorized }
        guard (200..<300).contains(response.statusCode) else {
            throw PocketExtensionError.message(value["error"] as? String ?? "Pocket could not save this request.")
        }
        return value
    }

    private func keychainQuery(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "\(Bundle.main.bundleIdentifier ?? "PocketSafari").Session",
         kSecAttrAccount as String: account]
    }
    private func readToken(_ account: String) -> String? {
        var query = keychainQuery(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
    private func saveToken(_ token: String, account: String) throws {
        let query = keychainQuery(account)
        let data = Data(token.utf8)
        var status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            item[kSecValueData as String] = data
            item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            status = SecItemAdd(item as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw PocketExtensionError.message("Could not save this sign-in securely.") }
    }
    private func deleteToken(_ account: String) { SecItemDelete(keychainQuery(account) as CFDictionary) }
}

private final class NoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

private enum PocketExtensionError: LocalizedError {
    case message(String)
    case unauthorized
    var errorDescription: String? {
        switch self {
        case .message(let value): return value
        case .unauthorized: return "Sign-in failed. Check your username and password."
        }
    }
}
