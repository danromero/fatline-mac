import Foundation

/// Reads Snapchain directly, so a test can check what the network holds without trusting the app.
struct LiveNetwork: Sendable {
    struct Cast: Sendable {
        let hash: String
        let signer: String
        let text: String
    }

    struct Signer: Decodable, Sendable {
        let key: String
        let addedAt: TimeInterval
        let scopes: [String]?
    }

    enum Problem: Error, CustomStringConvertible {
        case status(String, Int)
        case timedOut(String)

        var description: String {
            switch self {
            case .status(let route, let code): "\(route) answered HTTP \(code)"
            case .timedOut(let what): "Timed out waiting for \(what)"
            }
        }
    }

    private static let base = URL(string: "https://snapchain-api.neynar.com/v1")!
    /// How long a cast can take to show up on, or leave, the node after the app reports success.
    private static let settleTime: TimeInterval = 45

    let fid: UInt64
    let apiKey: String

    private func get<Answer: Decodable>(_ route: String, _ query: [String: String]) async throws -> Answer {
        var parts = URLComponents(url: Self.base.appending(path: route), resolvingAgainstBaseURL: false)!
        parts.queryItems = query.merging(["fid": String(fid)]) { new, _ in new }.map(URLQueryItem.init)
        var request = URLRequest(url: parts.url!, timeoutInterval: 20)
        request.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else { throw Problem.status(route, status) }
        return try JSONDecoder().decode(Answer.self, from: data)
    }

    func recentCasts() async throws -> [Cast] {
        struct Page: Decodable {
            struct Message: Decodable {
                struct Body: Decodable {
                    struct Add: Decodable { let text: String? }
                    let castAddBody: Add?
                }
                let hash: String
                let signer: String
                let data: Body
            }
            let messages: [Message]
        }
        let page: Page = try await get("castsByFid", ["pageSize": "100", "reverse": "true"])
        return page.messages.map { Cast(hash: $0.hash, signer: $0.signer, text: $0.data.castAddBody?.text ?? "") }
    }

    func signers() async throws -> [Signer] {
        struct Page: Decodable { let signers: [Signer] }
        let page: Page = try await get("signersByFid", ["pageSize": "1000"])
        return page.signers
    }

    func followCount() async throws -> Int {
        struct Page: Decodable {
            struct Link: Decodable {}
            let messages: [Link]
            let nextPageToken: String?
        }
        var count = 0
        var token: String?
        repeat {
            var query = ["link_type": "follow", "pageSize": "100"]
            if let token { query["pageToken"] = token }
            let page: Page = try await get("linksByFid", query)
            count += page.messages.count
            token = page.nextPageToken?.isEmpty == false ? page.nextPageToken : nil
        } while token != nil
        return count
    }

    func waitForCast(text: String) async throws -> Cast {
        let deadline = Date.now.addingTimeInterval(Self.settleTime)
        while Date.now < deadline {
            if let cast = try await recentCasts().first(where: { $0.text == text }) { return cast }
            try await Task.sleep(for: .seconds(1))
        }
        throw Problem.timedOut("the cast to reach Snapchain")
    }

    func waitUntilGone(text: String) async throws {
        let deadline = Date.now.addingTimeInterval(Self.settleTime)
        while Date.now < deadline {
            if try await !recentCasts().contains(where: { $0.text == text }) { return }
            try await Task.sleep(for: .seconds(1))
        }
        throw Problem.timedOut("the cast to leave Snapchain")
    }
}
