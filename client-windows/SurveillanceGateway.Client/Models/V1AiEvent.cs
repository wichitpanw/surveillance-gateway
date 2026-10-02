using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace SurveillanceGateway.Client.Models;

/// <summary>
/// ผล AI จากกล้อง/NVR/VMS/API ที่ Edge รับแล้วส่งผ่าน Regional/Central
/// ใช้ GET /api/v1/ai/events และ SSE ai_event; Seq เป็นลำดับของ gateway ที่ Client ต่อ
/// สำหรับเปิดภาพเหตุการณ์ โดยยังอ่าน origin edge-ai ของเหตุเก่าได้
/// </summary>
public sealed class V1AiEvent
{
    [JsonPropertyName("seq")]
    public long Seq { get; set; }

    [JsonPropertyName("cameraId")]
    public string? CameraId { get; set; }

    [JsonPropertyName("cameraName")]
    public string? CameraName { get; set; }

    [JsonPropertyName("globalId")]
    public string? GlobalId { get; set; }

    [JsonPropertyName("edgeNode")]
    public string? EdgeNode { get; set; }

    [JsonPropertyName("group")]
    public string? Group { get; set; }

    [JsonIgnore]
    public string OriginText => Services.Strings.TOr($"events.origin.{Origin ?? "unknown"}", Origin ?? "-");

    [JsonPropertyName("origin")]
    public string? Origin { get; set; }

    /// <summary>line_cross, intrusion, loitering or object.</summary>
    [JsonPropertyName("type")]
    public string? Type { get; set; }

    /// <summary>What was seen: person, car, ...</summary>
    [JsonPropertyName("label")]
    public string? Label { get; set; }

    /// <summary>Name of the line or zone that fired, when there is one.</summary>
    [JsonPropertyName("rule")]
    public string? Rule { get; set; }

    /// <summary>ISO-8601 with +07:00, as every timestamp from the gateway.</summary>
    [JsonPropertyName("ts")]
    public string? Ts { get; set; }

    [JsonPropertyName("trackId")]
    public string? TrackId { get; set; }

    [JsonPropertyName("hasSnapshot")]
    public bool HasSnapshot { get; set; }

    [JsonPropertyName("attrs")]
    public JsonElement? Attrs { get; set; }

    /// <summary>A string attribute such as "direction", or null.</summary>
    public string? Attr(string name) =>
        Attrs is { ValueKind: JsonValueKind.Object } a && a.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString()
            : null;

    /// <summary>A number attribute such as "durationSec" or "maxScore", or null.</summary>
    public double? AttrNumber(string name) =>
        Attrs is { ValueKind: JsonValueKind.Object } a && a.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number
            ? v.GetDouble()
            : null;
}

public sealed class V1AiEventList
{
    [JsonPropertyName("events")]
    public List<V1AiEvent>? Events { get; set; }

    [JsonPropertyName("edges")]
    public List<string>? Edges { get; set; }

    [JsonPropertyName("groups")]
    public List<string>? Groups { get; set; }
}

/// <summary>
/// SSE `edge_state` from central: an edge has been unreachable for two minutes, or came back.
/// While an edge is down its cameras have no picture and no events.
/// </summary>
public sealed class V1EdgeState
{
    [JsonPropertyName("sourceId")]
    public string? SourceId { get; set; }

    [JsonPropertyName("node")]
    public string? Node { get; set; }

    [JsonPropertyName("name")]
    public string? Name { get; set; }

    [JsonPropertyName("reachable")]
    public bool Reachable { get; set; }

    [JsonPropertyName("downSince")]
    public string? DownSince { get; set; }

    [JsonPropertyName("cameras")]
    public int? Cameras { get; set; }
}
