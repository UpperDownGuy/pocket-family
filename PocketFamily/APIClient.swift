import Foundation
import Security

enum APIError: LocalizedError {
    case invalidServer
    case invalidResponse
    case remote(Int, String)
    case message(String)
    case keychain(OSStatus)

    var errorDescription: String? {
        switch self {
        case .invalidServer:
            return "Use an HTTPS server address, or an HTTP address on your local network."
        case .invalidResponse:
            return "The server returned an unexpected response."
        case .remote(_, let message), .message(let message):
            return message
        case .keychain:
            return "The sign-in could not be saved securely. Try again."
        }
    }

    var isUnauthorized: Bool {
        if case .remote(401, _) = self { return true }
        return false
    }
}

struct APIClient {
    let baseURL: URL
    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        return URLSession(configuration: configuration, delegate: RejectRedirects(), delegateQueue: nil)
    }()

    init(serverURL: String) throws {
        baseURL = try Self.validateServerURL(serverURL)
    }

    static func validateServerURL(_ value: String) throws -> URL {
        guard var components = URLComponents(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = components.scheme?.lowercased(),
              let originalHost = components.host?.lowercased(),
              !originalHost.isEmpty,
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              components.path.isEmpty || components.path == "/" else { throw APIError.invalidServer }
        let host = originalHost.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        let hostParts = host.split(separator: ".", omittingEmptySubsequences: false)
        let octets = hostParts.compactMap { Int($0) }
        let privateIPv4 = hostParts.count == 4 && octets.count == 4 &&
            hostParts.allSatisfy { !$0.isEmpty && $0.allSatisfy { $0 >= "0" && $0 <= "9" } } &&
            octets.allSatisfy { (0...255).contains($0) } && (
            octets[0] == 10 || octets[0] == 127 ||
            (octets[0] == 192 && octets[1] == 168) ||
            (octets[0] == 172 && (16...31).contains(octets[1])) ||
            (octets[0] == 169 && octets[1] == 254)
        )
        let localHost = host == "localhost" || host.hasSuffix(".local") || privateIPv4 ||
            host == "::1" || (host.contains(":") && (host.hasPrefix("fc") || host.hasPrefix("fd") || host.hasPrefix("fe80:")))
        guard scheme == "https" || (scheme == "http" && localHost) else { throw APIError.invalidServer }
        components.scheme = scheme
        components.path = ""
        guard let result = components.url else { throw APIError.invalidServer }
        return result
    }

    func get<Response: Decodable>(_ path: String, token: String? = nil) async throws -> Response {
        let data = try await request(path, method: "GET", data: nil, token: token)
        return try decode(data)
    }

    func send<Body: Encodable>(_ path: String, method: String = "POST", body: Body, token: String? = nil) async throws {
        _ = try await request(path, method: method, data: JSONEncoder().encode(body), token: token)
    }

    func send<Body: Encodable, Response: Decodable>(_ path: String, method: String = "POST", body: Body, token: String? = nil) async throws -> Response {
        let data = try await request(path, method: method, data: JSONEncoder().encode(body), token: token)
        return try decode(data)
    }

    private func decode<Response: Decodable>(_ data: Data) throws -> Response {
        do { return try JSONDecoder().decode(Response.self, from: data) }
        catch { throw APIError.invalidResponse }
    }

    private func request(_ path: String, method: String, data: Data?, token: String?) async throws -> Data {
        var request = URLRequest(url: baseURL.appendingPathComponent(path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))))
        request.httpMethod = method
        request.httpBody = data
        request.timeoutInterval = 20
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if data != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let (responseData, response) = try await Self.session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        if (300..<400).contains(response.statusCode) {
            throw APIError.message("The server redirected this request. Use its direct address in Server settings.")
        }
        guard (200..<300).contains(response.statusCode) else {
            struct ErrorBody: Decodable { let error: String }
            let message = (try? JSONDecoder().decode(ErrorBody.self, from: responseData).error) ?? "The request could not be completed."
            throw APIError.remote(response.statusCode, message)
        }
        return responseData
    }
}

private final class RejectRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        // Bearer credentials and submitted passwords stay at the explicitly selected server.
        completionHandler(nil)
    }
}

enum SessionKeychain {
    private static let service = "PocketFamily.Session"

    static func read(server: String) -> String? {
        var query = query(server: server)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func save(_ token: String, server: String) throws {
        let query = query(server: server)
        let attributes: [String: Any] = [kSecValueData as String: Data(token.utf8)]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            item[kSecValueData as String] = Data(token.utf8)
            item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            status = SecItemAdd(item as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw APIError.keychain(status) }
    }

    static func delete(server: String) {
        SecItemDelete(query(server: server) as CFDictionary)
    }

    private static func query(server: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: server]
    }
}
