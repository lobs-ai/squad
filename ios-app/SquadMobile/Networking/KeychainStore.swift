import Foundation
import Security

// Persists the list of paired squads (URL + token + name) in the iOS Keychain.
// We store one JSON blob keyed by service+account; that's enough — there are
// only ever a handful of squads and the data is small.

enum KeychainStore {
    private static let service = "dev.squad.SquadMobile"
    private static let account = "endpoints"

    static func save(_ endpoints: [PairedSquad]) {
        let data = (try? JSONEncoder().encode(endpoints)) ?? Data()
        let query: [String: Any] = [
            kSecClass as String:       kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
        var attrs = query
        attrs[kSecValueData as String] = data
        attrs[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(attrs as CFDictionary, nil)
    }

    static func load() -> [PairedSquad] {
        let query: [String: Any] = [
            kSecClass as String:       kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String:  true,
            kSecMatchLimit as String:  kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { return [] }
        return (try? JSONDecoder().decode([PairedSquad].self, from: data)) ?? []
    }

    static func clear() {
        let query: [String: Any] = [
            kSecClass as String:       kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

struct PairedSquad: Codable, Identifiable, Hashable {
    var id: String { url }
    var name: String       // friendly label — taken from admin.identity if available
    var url: String        // base URL e.g. "https://your-mbp.tail-scale.ts.net:8080"
    var token: String
    var pairedAt: Date

    var endpoint: SquadEndpoint { .init(url: url, token: token) }
}
