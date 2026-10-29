package com.agentsanywhere.app.feature.sessions

import org.json.JSONObject

/** Structured form values stay typed; empty text, false and cancellation are distinct. */
object AgentForm {
    fun defaults(schema: JSONObject): Map<String, Any> {
        val properties = schema.optJSONObject("properties") ?: return emptyMap()
        val required = schema.optJSONArray("required")?.let { list -> (0 until list.length()).map { list.getString(it) }.toSet() }.orEmpty()
        return properties.keys().asSequence().mapNotNull { key ->
            val field = properties.getJSONObject(key)
            val value = if (field.has("default")) field.get("default") else if (key !in required) null else when (field.optString("type")) {
                "boolean" -> false
                "string" -> if (field.has("enum")) null else ""
                "array" -> org.json.JSONArray()
                else -> null
            }
            value?.let { key to it }
        }.toMap()
    }

    fun valid(schema: JSONObject, values: Map<String, Any>): Boolean {
        val properties = schema.optJSONObject("properties") ?: return false
        val required = schema.optJSONArray("required")
        if ((0 until (required?.length() ?: 0)).any { !values.containsKey(required!!.getString(it)) }) return false
        return values.all { (key, value) ->
            val field = properties.optJSONObject(key) ?: return@all false
            when (field.optString("type")) {
                "boolean" -> value is Boolean
                "string" -> value is String && value.codePointCount(0, value.length) >= field.optInt("minLength", 0) && value.codePointCount(0, value.length) <= field.optInt("maxLength", Int.MAX_VALUE) && (!field.has("enum") || (0 until field.getJSONArray("enum").length()).any { field.getJSONArray("enum").getString(it) == value })
                "number", "integer" -> value is Number && value.toDouble().isFinite() && value.toDouble() >= field.optDouble("minimum", Double.NEGATIVE_INFINITY) && value.toDouble() <= field.optDouble("maximum", Double.POSITIVE_INFINITY) && (field.optString("type") != "integer" || value.toDouble() % 1.0 == 0.0)
                "array" -> value is org.json.JSONArray && value.length() >= field.optInt("minItems", 0) && value.length() <= field.optInt("maxItems", Int.MAX_VALUE)
                else -> false
            }
        }
    }

}
