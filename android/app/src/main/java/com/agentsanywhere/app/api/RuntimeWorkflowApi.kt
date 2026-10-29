package com.agentsanywhere.app.api

import org.json.JSONObject

class RuntimeWorkflowApi(private val client: ApiClient = ApiClient()) {
    fun post(server: String, token: String, path: String, body: JSONObject): JSONObject =
        client.postJson(serverUrl = server, authorizationToken = token, path = "/runtime-workflows/$path", body = body)
    fun get(server: String, token: String, kind: String, id: String): JSONObject =
        client.getJson(serverUrl = server, authorizationToken = token, path = "/runtime-workflows/$kind/${id.urlEncode()}")
}
