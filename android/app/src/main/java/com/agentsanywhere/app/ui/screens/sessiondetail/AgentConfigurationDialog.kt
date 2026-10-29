package com.agentsanywhere.app.ui.screens.sessiondetail

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import com.agentsanywhere.app.feature.sessiondetail.SessionDetailController
import com.agentsanywhere.app.feature.sessions.AgentForm
import com.agentsanywhere.app.ui.screens.home.StructuredAgentFields
import kotlinx.coroutines.launch
import org.json.JSONObject

@Composable
internal fun AgentConfigurationDialog(sessionId: String, controller: SessionDetailController, canUpdate: Boolean, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var configuration by remember(sessionId) { mutableStateOf<JSONObject?>(null) }
    var values by remember(sessionId) { mutableStateOf<Map<String, Any>>(emptyMap()) }
    var pending by remember(sessionId) { mutableStateOf(false) }
    var error by remember(sessionId) { mutableStateOf<String?>(null) }
    suspend fun load() {
        pending = true; error = null
        try {
            controller.agentConfiguration(sessionId).onSuccess { result ->
                configuration = result.getJSONObject("configuration")
                values = AgentForm.defaults(AgentForm.configurationSchema(configuration!!, includeModel = true))
            }.onFailure { error = it.message }
        } finally { pending = false }
    }
    LaunchedEffect(sessionId) { load() }
    val schema = configuration?.let { AgentForm.configurationSchema(it, includeModel = true) }
    AlertDialog(onDismissRequest = { if (!pending) onDismiss() }, title = { Text("Agent 配置") }, text = {
        Column(Modifier.verticalScroll(rememberScrollState())) {
            schema?.let { StructuredAgentFields(it, values, canUpdate && !pending) { key, value ->
                values = if (value == null) values - key else values + (key to value)
            } }
            error?.let { Text(it) }
            TextButton(enabled = !pending, onClick = { scope.launch { load() } }) { Text("刷新当前配置") }
        }
    }, confirmButton = {
        TextButton(enabled = !pending && canUpdate && schema != null && AgentForm.valid(schema, values), onClick = {
            val snapshot = configuration ?: return@TextButton
            scope.launch {
                pending = true; error = null
                try {
                    controller.updateAgentConfiguration(sessionId, snapshot.getLong("revision"), values).onSuccess { result ->
                        configuration = result.getJSONObject("configuration")
                        values = AgentForm.defaults(AgentForm.configurationSchema(configuration!!, includeModel = true))
                        if (result.optString("phase") == "completed") onDismiss()
                        else error = "配置结果尚未确认，请查询当前配置。"
                    }.onFailure { error = it.message }
                } finally { pending = false }
            }
        }) { Text("保存") }
    }, dismissButton = { TextButton(enabled = !pending, onClick = onDismiss) { Text("取消") } })
}
