using System.Text.Json.Serialization;

namespace SurveillanceGateway.Client.Models;

/// <summary>
/// One event from `GET /api/v1/events`.
///
/// The gateway sends a change, not a state: it compares the streaming core against what it saw
/// five seconds ago and reports only the transitions. That is why this carries both `from` and
/// `to` - a consumer that has just connected knows nothing about the cameras it has not heard
/// about yet, and must not infer that silence means offline.
/// </summary>
public sealed class V1Event
{
    /// <summary>"camera_status" or "camera_removed".</summary>
    [JsonPropertyName("type")]
    public string? Type { get; set; }

    [JsonPropertyName("cameraId")]
    public string? CameraId { get; set; }

    [JsonPropertyName("cameraName")]
    public string? CameraName { get; set; }

    /// <summary>"main" or "sub". A camera reports each stream separately.</summary>
    [JsonPropertyName("streamType")]
    public string? StreamType { get; set; }

    [JsonPropertyName("path")]
    public string? Path { get; set; }

    [JsonPropertyName("from")]
    public string? From { get; set; }

    /// <summary>"online" or "offline".</summary>
    [JsonPropertyName("to")]
    public string? To { get; set; }

    [JsonPropertyName("at")]
    public string? At { get; set; }

    [JsonPropertyName("enabled")]
    public bool Enabled { get; set; } = true;

    [JsonPropertyName("reachable")]
    public bool? Reachable { get; set; }

    [JsonPropertyName("streaming")]
    public bool Streaming { get; set; }

    public bool IsOnline => To == "online";
}
