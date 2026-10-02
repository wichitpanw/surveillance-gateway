using System;
using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace SurveillanceGateway.Client.Models;

public sealed class V1RecordingRange
{
    [JsonPropertyName("start")]
    public DateTimeOffset Start { get; set; }

    [JsonPropertyName("end")]
    public DateTimeOffset End { get; set; }
}

public sealed class V1RecordingList
{
    [JsonPropertyName("ranges")]
    public List<V1RecordingRange> Ranges { get; set; } = new();
}

public sealed class V1PlaybackGrant
{
    [JsonPropertyName("token")]
    public string Token { get; set; } = string.Empty;

    [JsonPropertyName("video")]
    public string Video { get; set; } = string.Empty;
}
