import Foundation

// Persists the list of paired squads (URL + token + name) as JSON in the app's
// Application Support directory. We deliberately don't use the iOS Keychain:
// the simulator drops Keychain entries for unsigned ad-hoc builds across
// reboots, which silently re-set up the app every time. Application Support
// is encrypted at rest on real devices via Data Protection, so the tokens
// are still reasonably protected.
//
// One JSON file is enough — there are only ever a handful of squads.

enum PairedSquadStore {
    private static let fileName = "paired-squads.json"

    private static var fileURL: URL {
        let fm = FileManager.default
        let dir = (try? fm.url(for: .applicationSupportDirectory,
                               in: .userDomainMask,
                               appropriateFor: nil,
                               create: true)) ?? fm.temporaryDirectory
        // Ensure the directory exists (first launch on a fresh container).
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent(fileName, isDirectory: false)
    }

    static func save(_ endpoints: [PairedSquad]) {
        guard let data = try? JSONEncoder().encode(endpoints) else { return }
        try? data.write(to: fileURL, options: [.atomic, .completeFileProtection])
    }

    static func load() -> [PairedSquad] {
        guard let data = try? Data(contentsOf: fileURL) else { return [] }
        return (try? JSONDecoder().decode([PairedSquad].self, from: data)) ?? []
    }

    static func clear() {
        try? FileManager.default.removeItem(at: fileURL)
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
