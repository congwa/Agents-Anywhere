import Foundation

struct V2RuntimeWorkflowAPI {
    let transport: any HTTPTransport
    func post(_ path: String, _ body: [String: JSONValue]) async throws -> V2RuntimeWorkflow {
        try await transport.send(HTTPRequest<JSONValue, V2RuntimeWorkflow>(method: .post, path: "/runtime-workflows/" + path, body: .object(body)))
    }
    func get(kind: String, id: String) async throws -> V2RuntimeWorkflow {
        try await transport.send(HTTPRequest<EmptyRequestBody, V2RuntimeWorkflow>(method: .get, path: "/runtime-workflows/\(kind)/\(id.v2URLPathComponentEncoded)"))
    }
    func get(_ value: V2RuntimeWorkflow) async throws -> V2RuntimeWorkflow {
        try await transport.send(HTTPRequest<EmptyRequestBody, V2RuntimeWorkflow>(method: .get, path: "/runtime-workflows/\(value.kind)/\(value.id.v2URLPathComponentEncoded)"))
    }
    func respond(_ value: V2RuntimeWorkflow, request: V2WorkflowInteraction, action: String, input: JSONValue?) async throws {
        var body: [String: JSONValue] = ["interactionId": .string(request.id), "ownerGeneration": .string(request.ownerGeneration),
            "requestRevision": .number(Double(request.requestRevision)), "responseOperationId": .string(UUID().uuidString), "actionId": .string(action)]
        if let input { body["input"] = input }
        let _: JSONValue = try await transport.send(HTTPRequest<JSONValue, JSONValue>(method: .post,
            path: "/runtime-workflows/\(value.kind)/\(value.id.v2URLPathComponentEncoded)/responses", body: .object(body)))
    }
}
