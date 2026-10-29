import SwiftUI

struct AgentConfigurationView: View {
    let chat: SessionChatModel
    @State private var configuration: JSONValue?
    @State private var values: [String: JSONValue] = [:]
    @State private var pending = false
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss
    private var schema: JSONValue { AgentForm.configurationSchema(configuration ?? .object([:]), includeModel: true) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if configuration != nil {
                    StructuredAgentFields(schema: schema, values: $values, disabled: pending || !chat.canUpdateAgentConfiguration)
                }
                if pending { ProgressView() }
                if let error { Text(error).foregroundStyle(.secondary) }
                Button("刷新当前配置") { Task { await load() } }.disabled(pending)
                Button("保存") { Task { await save() } }
                    .disabled(pending || !chat.canUpdateAgentConfiguration || configuration == nil || !AgentForm.valid(schema, values))
            }.padding()
        }
        .navigationTitle("Agent 配置")
        .task(id: chat.session.id) { await load() }
        .interactiveDismissDisabled(pending)
    }
    @MainActor private func load() async {
        pending = true; error = nil
        defer { pending = false }
        do {
            let result = try await chat.agentConfiguration()
            guard let snapshot = result["configuration"] else { throw HTTPError.invalidResponse }
            configuration = snapshot
            values = AgentForm.defaults(AgentForm.configurationSchema(snapshot, includeModel: true))
        } catch is CancellationError { }
        catch { self.error = error.localizedDescription }
    }
    @MainActor private func save() async {
        guard !pending, chat.canUpdateAgentConfiguration, let revision = configuration?["revision"]?.intValue else { return }
        pending = true; error = nil
        defer { pending = false }
        do {
            let result = try await chat.updateAgentConfiguration(revision: revision, values: values)
            if let snapshot = result["configuration"] {
                configuration = snapshot
                values = AgentForm.defaults(AgentForm.configurationSchema(snapshot, includeModel: true))
            }
            if result["phase"] == .string("completed") { dismiss() }
            else { error = "配置结果尚未确认，请查询当前配置。" }
        } catch is CancellationError { }
        catch { self.error = error.localizedDescription }
    }
}
