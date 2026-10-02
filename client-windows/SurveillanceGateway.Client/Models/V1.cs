using System.Collections.Generic;
using System.ComponentModel;
using System.Text.Json.Serialization;

namespace SurveillanceGateway.Client.Models;

/// <summary>
/// A camera as the published gateway contract describes it - `GET /api/v1/cameras`.
///
/// This is deliberately not the shape of the `cameras` table. /api/v1 hands out a curated view
/// (`SAFE_CAMERA_COLUMNS` plus derived fields) and never a row, which is why no credential can
/// leak through it and why the client has no idea what an RTSP URL for a camera looks like.
/// </summary>
public sealed class V1Camera : INotifyPropertyChanged
{
    private bool? _online;

    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    [JsonPropertyName("group")]
    public string? Group { get; set; }

    [JsonPropertyName("brand")]
    public string? Brand { get; set; }

    [JsonPropertyName("type")]
    public string? Type { get; set; }

    [JsonPropertyName("location")]
    public V1Location? Location { get; set; }

    [JsonPropertyName("alwaysOn")]
    public bool AlwaysOn { get; set; }

    [JsonPropertyName("analytics")]
    public V1Analytics? Analytics { get; set; }

    [JsonPropertyName("streams")]
    public V1CameraStreams? Streams { get; set; }

    /// <summary>
    /// enabled / reachable / streaming, from gateways since 1.3.4's server. Null from older ones.
    /// </summary>
    [JsonPropertyName("state")]
    public V1CameraState? State { get; set; }

    [JsonPropertyName("globalId")]
    public string? GlobalId { get; set; }

    [JsonPropertyName("origin")]
    public V1CameraOrigin? Origin { get; set; }

    [JsonPropertyName("streamConfigured")]
    public bool? StreamConfigured { get; set; }

    /// <summary>สถานะที่ผู้ใช้เห็น โดยแยก Edge ติดต่อไม่ได้ออกจากกล้องออฟไลน์</summary>
    [JsonPropertyName("availability")]
    public string Availability => State?.Enabled == false ? "disabled"
        : Origin?.Kind == "edge" && Origin.Reachable == false ? "edgeUnavailable"
        : Origin?.MissingAtSource == true ? "missing"
        : StreamConfigured == false ? "awaitingStream"
        : Online == true ? "online"
        : Online == false ? "offline"
        : "unknown";

    [JsonIgnore]
    public string AvailabilityText => Services.Strings.T($"status.{Availability}");

    /// <summary>นับช่องที่รอ RTSP และ edge ยืนยันว่ากล้องไม่ตอบเป็นออฟไลน์ในภาพรวม</summary>
    [JsonIgnore]
    public bool IsOfflineForSummary => Availability == "offline"
        || (Availability == "awaitingStream" && State?.Reachable == false);

    /// <summary>อัปเดตจาก camera_state โดยคง null เมื่อสถานะกล้องยังไม่ทราบ</summary>
    public void ApplyState(bool enabled, bool? reachable, bool streaming)
    {
        State ??= new V1CameraState();
        State.Enabled = enabled;
        State.Reachable = reachable;
        State.Streaming = streaming;
        if (Origin?.Kind == "edge") Origin.Reachable = reachable.HasValue;
        Online = enabled ? reachable : null;
        NotifyAvailability();
    }

    private void NotifyAvailability()
    {
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(Availability)));
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(AvailabilityText)));
    }

    /// <summary>
    /// What to paint before the first event arrives.
    ///
    /// Reachable is the camera answering, which is the question the dot asks. The old fallback,
    /// streams.main.ready, only says a source is configured - it is true for a camera with its
    /// cable pulled - so it is used only against a gateway that does not send a state at all.
    /// A disabled camera is null (grey): it is neither up nor down, somebody switched it off.
    /// </summary>
    public bool? InitialOnline => State is null
        ? Streams?.Main?.Ready
        : State.Enabled ? State.Reachable : null;

    /// <summary>
    /// Whether the gateway currently has this camera's main stream.
    ///
    /// Three states, and the third is not a nuisance: null means nobody has said yet, which is
    /// what a client knows about a camera it has heard no event for. Painting that as offline
    /// would claim a fact the client does not have.
    ///
    /// It is serialised because the map page draws pins from this same object, and it raises
    /// change notifications because the camera list keeps the same instances for the life of a
    /// session - the list is not reloaded when a status arrives.
    /// </summary>
    [JsonPropertyName("online")]
    public bool? Online
    {
        get => _online;
        set
        {
            if (_online == value) return;
            _online = value;
            PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(Online)));
            NotifyAvailability();
        }
    }

    public string DisplayName => string.IsNullOrWhiteSpace(Name) ? Id : Name;

    public string GroupLabel => string.IsNullOrWhiteSpace(Group) ? Services.Strings.T("wall.noGroup") : Group!;

    /// <summary>
    /// The second line under a camera's name in a picker.
    ///
    /// It says what the gateway can actually offer for this camera, not its group - the list is
    /// grouped by group, so repeating it on every row says nothing.
    /// </summary>
    public string StreamHint
    {
        get
        {
            // The tracks the core actually negotiated: "H265" or "H265, PCMA". They exist only
            // once a stream has run, so an empty list means "nothing has played yet", which is
            // different from a camera being down and is said differently.
            var tracks = Streams?.Main?.Tracks;
            return tracks is { Count: > 0 }
                ? string.Join(", ", tracks)
                : Services.Strings.T("wall.hintUnknown");
        }
    }

    public event PropertyChangedEventHandler? PropertyChanged;
}

public sealed class V1CameraState
{
    [JsonPropertyName("enabled")]
    public bool Enabled { get; set; } = true;

    /// <summary>Null when nobody knows - the edge holding the camera cannot be reached.</summary>
    [JsonPropertyName("reachable")]
    public bool? Reachable { get; set; }

    /// <summary>The gateway is pulling the picture right now. Not a health signal.</summary>
    [JsonPropertyName("streaming")]
    public bool Streaming { get; set; }
}

public sealed class V1Location
{
    [JsonPropertyName("lat")]
    public double Lat { get; set; }

    [JsonPropertyName("lng")]
    public double Lng { get; set; }
}

public sealed class V1Analytics
{
    /// <summary>
    /// False covers both "no AI in this camera" and "AI present but switched off". The contract
    /// draws no distinction because a caller cannot act on one, and neither means a count of 0 -
    /// zero would mean nobody walked past.
    /// </summary>
    [JsonPropertyName("supported")]
    public bool Supported { get; set; }

    [JsonPropertyName("kind")]
    public string? Kind { get; set; }

    [JsonPropertyName("probedAt")]
    public string? ProbedAt { get; set; }

    [JsonPropertyName("capabilities")]
    public List<V1Capability> Capabilities { get; set; } = new();
}

public sealed class V1Capability
{
    [JsonPropertyName("label")]
    public string? Label { get; set; }

    [JsonPropertyName("rule")]
    public string? Rule { get; set; }

    [JsonPropertyName("topic")]
    public string? Topic { get; set; }
}

public sealed class V1CameraStreams
{
    [JsonPropertyName("main")]
    public V1StreamStatus? Main { get; set; }

    [JsonPropertyName("sub")]
    public V1StreamStatus? Sub { get; set; }
}

public sealed class V1StreamStatus
{
    /// <summary>Null when the gateway could not reach the streaming core, not false.</summary>
    [JsonPropertyName("ready")]
    public bool? Ready { get; set; }

    [JsonPropertyName("tracks")]
    public List<string> Tracks { get; set; } = new();
}

/// <summary>The whole `GET /api/v1/cameras` response.</summary>
public sealed class V1CameraList
{
    [JsonPropertyName("cameras")]
    public List<V1Camera> Cameras { get; set; } = new();

    /// <summary>False means every `ready` in this response is null, not that cameras are down.</summary>
    [JsonPropertyName("streamStatusAvailable")]
    public bool StreamStatusAvailable { get; set; }
}

/// <summary>`GET /api/v1/cameras/:id/streams`.</summary>
public sealed class V1StreamSet
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("name")]
    public string? Name { get; set; }

    [JsonPropertyName("core")]
    public string? Core { get; set; }

    /// <summary>Which stream the gateway suggests for machine consumers - "sub" today.</summary>
    [JsonPropertyName("recommendedForAnalytics")]
    public string? RecommendedForAnalytics { get; set; }

    [JsonPropertyName("main")]
    public V1Stream? Main { get; set; }

    [JsonPropertyName("sub")]
    public V1Stream? Sub { get; set; }

    public V1Stream? For(string streamType) => streamType == "main" ? Main : Sub;
}

public sealed class V1Stream
{
    [JsonPropertyName("path")]
    public string? Path { get; set; }

    [JsonPropertyName("urls")]
    public V1StreamUrls Urls { get; set; } = new();

    [JsonPropertyName("ready")]
    public bool? Ready { get; set; }

    [JsonPropertyName("tracks")]
    public List<string> Tracks { get; set; } = new();

    [JsonPropertyName("raw")]
    public V1StreamStatus? Raw { get; set; }
}

/// <summary>
/// The URLs the gateway hands out for one stream.
///
/// A client must use these verbatim. Composing them locally would mean reproducing the gateway's
/// path-naming rule and its port numbers in every consumer, which is exactly the coupling the
/// gateway exists to remove - and the tokens cannot be forged anyway.
/// </summary>
public sealed class V1StreamUrls
{
    /// <summary>fMP4 through the gateway, transcoded to H.264. Plays in a browser.</summary>
    [JsonPropertyName("mp4")]
    public string? Mp4 { get; set; }

    /// <summary>
    /// fMP4 through the gateway with no transcode - the camera's own codec, usually H.265.
    /// Present only while the gateway runs with raw streams enabled. Preferred by this client:
    /// same port, same token scheme, no NVENC session on the server.
    /// </summary>
    [JsonPropertyName("mp4Raw")]
    public string? Mp4Raw { get; set; }

    [JsonPropertyName("hls")]
    public string? Hls { get; set; }

    /// <summary>Straight to the streaming core on 8555. No token, and a separate firewall rule.</summary>
    [JsonPropertyName("rtsp")]
    public string? Rtsp { get; set; }

    [JsonPropertyName("rtspRaw")]
    public string? RtspRaw { get; set; }
}

/// <summary>`GET /api/v1/health` - used to check an address before credentials are sent.</summary>
public sealed class V1Health
{
    [JsonPropertyName("ok")]
    public bool Ok { get; set; }

    [JsonPropertyName("gateway")]
    public string? Gateway { get; set; }

    [JsonPropertyName("streamCore")]
    public string? StreamCore { get; set; }

    /// <summary>"central" or "edge".</summary>
    [JsonPropertyName("role")]
    public string? Role { get; set; }

    /// <summary>The git commit the gateway runs.</summary>
    [JsonPropertyName("build")]
    public string? Build { get; set; }

    /// <summary>Central only: every edge it pulls from, with the build each one runs.</summary>
    [JsonPropertyName("edges")]
    public List<V1EdgeInfo>? Edges { get; set; }

    /// <summary>The name the gateway gave this API key, so a person can tell which key they hold.</summary>
    [JsonPropertyName("client")]
    public string? Client { get; set; }
}

public sealed class V1EdgeInfo
{
    [JsonPropertyName("node")]
    public string? Node { get; set; }

    [JsonPropertyName("name")]
    public string? Name { get; set; }

    [JsonPropertyName("build")]
    public string? Build { get; set; }

    [JsonPropertyName("reachable")]
    public bool? Reachable { get; set; }
}

/// <summary>
/// `GET /api/v1/cameras/{id}/ptz` - whether a camera can be turned, and by this key.
///
/// Asked when a player window opens, not with the camera list: the gateway answers it by talking
/// to the camera itself over ONVIF, which takes a second the first time.
/// </summary>
public sealed class V1Ptz
{
    [JsonPropertyName("supported")]
    public bool Supported { get; set; }

    /// <summary>Whether this API key may send commands. Seeing a camera does not mean steering it.</summary>
    [JsonPropertyName("allowed")]
    public bool Allowed { get; set; }

    /// <summary>
    /// Which controls mean anything on this camera. A varifocal lens reports PTZ but only zooms,
    /// and direction buttons that do nothing read as a broken camera.
    /// </summary>
    [JsonPropertyName("panTilt")]
    public bool PanTilt { get; set; }

    [JsonPropertyName("zoom")]
    public bool Zoom { get; set; }

    [JsonPropertyName("reason")]
    public string? Reason { get; set; }

    [JsonPropertyName("presets")]
    public List<V1PtzPreset> Presets { get; set; } = new();

    /// <summary>Set when the camera moves but refused to list presets - it has none to offer.</summary>
    [JsonPropertyName("presetError")]
    public string? PresetError { get; set; }
}

public sealed class V1PtzPreset
{
    [JsonPropertyName("token")]
    public string Token { get; set; } = string.Empty;

    [JsonPropertyName("name")]
    public string? Name { get; set; }

    /// <summary>What the preset list shows. Some cameras leave names empty, and the token is all there is.</summary>
    public string Label => string.IsNullOrWhiteSpace(Name) ? Token : $"{Token} · {Name}";

    public override string ToString() => Label;
}

public sealed class V1CameraOrigin
{
    [JsonPropertyName("kind")]
    public string? Kind { get; set; }

    [JsonPropertyName("node")]
    public string? Node { get; set; }

    [JsonPropertyName("reachable")]
    public bool? Reachable { get; set; }

    [JsonPropertyName("missingAtSource")]
    public bool MissingAtSource { get; set; }
}
