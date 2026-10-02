using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.IO;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using SurveillanceGateway.Client.Models;

namespace SurveillanceGateway.Client.Services;

/// <summary>Raised when the gateway rejects the API key.</summary>
public sealed class GatewayAuthException : Exception
{
    public GatewayAuthException(string message) : base(message)
    {
    }
}

/// <summary>
/// This client's whole view of the gateway.
///
/// Everything about cameras and video comes from the published contract at **/api/v1**, with an
/// `Authorization: Bearer sgw_…` key - the same surface `demo-client/` consumes, and for the
/// same reason: a consumer should not need to know the gateway's internal path-naming rule, its
/// core's port numbers, or anything about the cameras themselves. It asks for a camera's streams
/// and plays the URLs it is handed.
///
/// There is no user login. The key is the identity: the gateway decides what this client may see
/// from the key's own camera-group scope, and a key can be revoked on its own without touching
/// anyone's account. Adding a person's login on top would mean holding two different kinds of
/// scope that neither subsumes the other, for no access this client actually needs.
///
/// Every request carries an instance id so Central can report how many clients are running on one
/// key - the number an administrator needs before deciding whether a key is safe to revoke.
/// </summary>
public sealed partial class GatewayClient : IDisposable
{
    private readonly HttpClient _http;

    /// <summary>Separate client for the event stream - see <see cref="OpenEventsAsync"/>.</summary>
    private readonly HttpClient _events;

    private string _baseUrl = string.Empty;
    private string _apiKey = string.Empty;
    private string _instanceId = string.Empty;
    private string _instanceLabel = Environment.MachineName;

    /// <summary>
    /// SQLite has no fixed column types, so the gateway can serialise the same column as 3 or as
    /// "3" depending on how the row was written. Accepting both keeps one loosely typed column
    /// from failing a whole response.
    /// </summary>
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        NumberHandling = JsonNumberHandling.AllowReadingFromString,
    };

    public GatewayClient()
    {
        _http = new HttpClient
        {
            // Long enough for a busy gateway, short enough that a wrong address fails while the
            // person who typed it is still looking at the screen.
            Timeout = TimeSpan.FromSeconds(15),
        };

        _events = new HttpClient
        {
            Timeout = Timeout.InfiniteTimeSpan,
        };
    }

    public string BaseUrl => _baseUrl;

    /// <summary>Name the gateway gave this API key, from /api/v1/health.</summary>
    public string? ApiClientName { get; private set; }

    public bool HasKey => _apiKey.Length > 0;

    public void Configure(string baseUrl, string apiKey, string instanceId = "", string? instanceLabel = null)
    {
        _baseUrl = (baseUrl ?? string.Empty).TrimEnd('/');
        _apiKey = (apiKey ?? string.Empty).Trim();
        _instanceId = (instanceId ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(instanceLabel)) _instanceLabel = instanceLabel!;
    }

    /// <summary>
    /// Verifies the address and the key together.
    ///
    /// /api/v1/health is the endpoint the contract nominates for exactly this: 200 means the key
    /// works, 401 means the key is wrong or disabled, and anything else means the address does
    /// not point at a gateway. Distinguishing those three is what stops a mistyped address from
    /// being reported as a bad key.
    /// </summary>
    public async Task<V1Health> CheckAsync(CancellationToken ct = default)
    {
        using var req = KeyedRequest(HttpMethod.Get, "/api/v1/health");
        using var res = await _http.SendAsync(req, ct).ConfigureAwait(false);

        if (res.StatusCode == HttpStatusCode.Unauthorized)
        {
            throw new GatewayAuthException(Strings.T("error.badKey"));
        }

        res.EnsureSuccessStatusCode();

        var health = await res.Content
            .ReadFromJsonAsync<V1Health>(JsonOptions, ct)
            .ConfigureAwait(false);

        if (health is null || !health.Ok)
        {
            throw new GatewayAuthException(Strings.T("error.notGateway"));
        }

        ApiClientName = health.Client;
        return health;
    }

    /// <summary>
    /// The cameras this key may see.
    ///
    /// No filtering happens here on purpose. The gateway narrows the list in SQL from the key's
    /// scope, which is the only place it can be enforced - a client-side filter would be a
    /// display convention, not a boundary.
    /// </summary>
    public async Task<IReadOnlyList<V1Camera>> GetCamerasAsync(CancellationToken ct = default)
    {
        using var req = KeyedRequest(HttpMethod.Get, "/api/v1/cameras");
        using var res = await _http.SendAsync(req, ct).ConfigureAwait(false);
        ThrowIfUnauthorized(res);
        res.EnsureSuccessStatusCode();

        var body = await res.Content
            .ReadFromJsonAsync<V1CameraList>(JsonOptions, ct)
            .ConfigureAwait(false);

        return body?.Cameras ?? new List<V1Camera>();
    }

    /// <summary>
    /// The playable URLs for one camera, minted fresh by the gateway.
    ///
    /// Call this immediately before playing, every time, including on a reconnect. The mp4 URLs
    /// carry a stream token with about five minutes of life, checked once when the connection
    /// opens - so a URL kept from an earlier attempt will be refused, and the failure looks like
    /// a dead camera rather than an expired token.
    /// </summary>
    public async Task<V1StreamSet> GetStreamsAsync(string cameraId, CancellationToken ct = default)
    {
        using var req = KeyedRequest(HttpMethod.Get, $"/api/v1/cameras/{Uri.EscapeDataString(cameraId)}/streams");
        using var res = await _http.SendAsync(req, ct).ConfigureAwait(false);
        ThrowIfUnauthorized(res);

        if (res.StatusCode == HttpStatusCode.NotFound)
        {
            // On this endpoint 404 means "not in this key's scope" as well as "no such camera",
            // and the gateway does not separate them on purpose.
            throw new GatewayAuthException(Strings.T("error.outOfScope"));
        }

        res.EnsureSuccessStatusCode();

        var body = await res.Content
            .ReadFromJsonAsync<V1StreamSet>(JsonOptions, ct)
            .ConfigureAwait(false);

        return body ?? new V1StreamSet { Id = cameraId };
    }

    /// <summary>อ่านช่วงบันทึกของกล้องที่คีย์นี้มีสิทธิ์ดูย้อนหลัง</summary>
    public async Task<V1RecordingList> GetRecordingsAsync(string cameraId, DateTimeOffset from, DateTimeOffset to, CancellationToken ct = default)
    {
        var path = $"/api/v1/cameras/{Uri.EscapeDataString(cameraId)}/recordings"
            + $"?from={Uri.EscapeDataString(from.ToString("o"))}&to={Uri.EscapeDataString(to.ToString("o"))}";
        using var req = KeyedRequest(HttpMethod.Get, path);
        using var res = await _http.SendAsync(req, ct).ConfigureAwait(false);
        ThrowIfUnauthorized(res);
        if (res.StatusCode == HttpStatusCode.Forbidden) throw new GatewayAuthException(Strings.T("playback.forbidden"));
        res.EnsureSuccessStatusCode();
        return await res.Content.ReadFromJsonAsync<V1RecordingList>(JsonOptions, ct).ConfigureAwait(false)
            ?? new V1RecordingList();
    }

    /// <summary>ออก URL อายุสั้นสำหรับ libVLC; API key ไม่อยู่ใน URL</summary>
    public async Task<string> GetPlaybackUrlAsync(string cameraId, DateTimeOffset start, int durationSeconds, CancellationToken ct = default)
    {
        using var req = KeyedRequest(HttpMethod.Get,
            $"/api/v1/cameras/{Uri.EscapeDataString(cameraId)}/playback-token");
        using var res = await _http.SendAsync(req, ct).ConfigureAwait(false);
        ThrowIfUnauthorized(res);
        if (res.StatusCode == HttpStatusCode.Forbidden) throw new GatewayAuthException(Strings.T("playback.forbidden"));
        res.EnsureSuccessStatusCode();
        var grant = await res.Content.ReadFromJsonAsync<V1PlaybackGrant>(JsonOptions, ct).ConfigureAwait(false);
        if (grant is null || string.IsNullOrWhiteSpace(grant.Token) || string.IsNullOrWhiteSpace(grant.Video))
            throw new HttpRequestException(Strings.T("playback.noUrl"));
        var query = $"?t={Uri.EscapeDataString(grant.Token)}&start={Uri.EscapeDataString(start.ToString("o"))}&duration={durationSeconds}&video=raw";
        return Url(grant.Video + query);
    }

    /// <summary>
    /// Whether this camera can be steered, and by this key.
    ///
    /// Null when the gateway could not reach the camera. That is kept apart from "no PTZ" on
    /// purpose: the window then simply shows no controls, rather than claiming the camera is fixed.
    /// </summary>
    /// <summary>
    /// AI events between two times, newest first (`GET /api/v1/ai/events`). The gateway limits the
    /// cameras to this key's scope, so the list never shows a camera the key cannot see.
    /// </summary>
    public async Task<IReadOnlyList<V1AiEvent>> GetAiEventsAsync(DateTimeOffset from, DateTimeOffset to, int limit = 300, CancellationToken ct = default) =>
        (await GetAiEventPageAsync(from, to, limit, ct: ct).ConfigureAwait(false)).Events ?? new List<V1AiEvent>();

    /// <summary>ค้น event และตัวเลือก Edge/กลุ่มภายในสิทธิ์ของ API key ก่อนจำกัดจำนวน</summary>
    public async Task<V1AiEventList> GetAiEventPageAsync(DateTimeOffset from, DateTimeOffset to, int limit = 500,
        string? edgeNode = null, string? group = null, string? origin = null, CancellationToken ct = default)
    {
        var q = $"?from={Uri.EscapeDataString(from.ToString("o"))}&to={Uri.EscapeDataString(to.ToString("o"))}&limit={limit}";
        if (!string.IsNullOrEmpty(edgeNode)) q += "&edgeNode=" + Uri.EscapeDataString(edgeNode);
        if (group is not null) q += "&group=" + Uri.EscapeDataString(group);
        if (!string.IsNullOrEmpty(origin)) q += "&origin=" + Uri.EscapeDataString(origin);
        using var req = KeyedRequest(HttpMethod.Get, "/api/v1/ai/events" + q);
        using var res = await _http.SendAsync(req, ct).ConfigureAwait(false);
        ThrowIfUnauthorized(res);
        if (res.StatusCode == HttpStatusCode.NotFound) return new V1AiEventList();
        res.EnsureSuccessStatusCode();
        return await res.Content.ReadFromJsonAsync<V1AiEventList>(JsonOptions, ct).ConfigureAwait(false) ?? new V1AiEventList();
    }

    /// <summary>The JPEG attached to an event, or null when it has none or the request fails.</summary>
    public async Task<byte[]?> GetAiSnapshotAsync(long seq, CancellationToken ct = default)
    {
        using var req = KeyedRequest(HttpMethod.Get, $"/api/v1/ai/events/{seq}/snapshot.jpg");
        req.Headers.CacheControl = new System.Net.Http.Headers.CacheControlHeaderValue { NoCache = true, NoStore = true };
        using var res = await _http.SendAsync(req, ct).ConfigureAwait(false);
        if (!res.IsSuccessStatusCode) return null;
        return await res.Content.ReadAsByteArrayAsync(ct).ConfigureAwait(false);
    }

    public async Task<V1Ptz?> GetPtzAsync(string cameraId, CancellationToken ct = default)
    {
        using var req = KeyedRequest(HttpMethod.Get, $"/api/v1/cameras/{Uri.EscapeDataString(cameraId)}/ptz");
        using var res = await _http.SendAsync(req, ct).ConfigureAwait(false);
        ThrowIfUnauthorized(res);
        if (!res.IsSuccessStatusCode) return null;

        return await res.Content
            .ReadFromJsonAsync<V1Ptz>(JsonOptions, ct)
            .ConfigureAwait(false);
    }

    /// <summary>
    /// Sends one PTZ command - see the gateway's POST /api/v1/cameras/{id}/ptz for the actions.
    ///
    /// Returns the gateway's own error text on failure rather than throwing: a camera refusing a
    /// preset is an everyday answer the window shows in a line, not an exception.
    /// </summary>
    public async Task<(bool Ok, string? Error, string? Token)> SendPtzAsync(
        string cameraId,
        object command,
        CancellationToken ct = default)
    {
        using var req = KeyedRequest(HttpMethod.Post, $"/api/v1/cameras/{Uri.EscapeDataString(cameraId)}/ptz");
        req.Content = JsonContent.Create(command);

        using var res = await _http.SendAsync(req, ct).ConfigureAwait(false);
        ThrowIfUnauthorized(res);

        PtzReply? reply = null;
        try
        {
            reply = await res.Content.ReadFromJsonAsync<PtzReply>(JsonOptions, ct).ConfigureAwait(false);
        }
        catch (JsonException)
        {
            // A proxy's HTML error page. The status code below still says what happened.
        }

        return res.IsSuccessStatusCode
            ? (true, null, reply?.Token)
            : (false, reply?.Error ?? $"HTTP {(int)res.StatusCode}", null);
    }

    private sealed class PtzReply
    {
        [JsonPropertyName("error")]
        public string? Error { get; set; }

        [JsonPropertyName("token")]
        public string? Token { get; set; }
    }

    /// <summary>
    /// Picks the URL to play from what the gateway offered.
    ///
    /// Preference order is deliberate: the untranscoded path first, because most of this fleet is
    /// H.265 and a native client decodes that on its own GPU, leaving the server's encoders idle.
    /// It falls back to the transcoded path when the gateway does not offer the raw one - which is
    /// what happens when raw streams are switched off server-side.
    /// </summary>
    public static string? PlayableUrl(V1StreamSet set, string streamType, bool preferPassthrough) =>
        PlayableUrl(set, streamType, preferPassthrough, out _);

    /// <summary>
    /// Same, and says which stream it actually picked.
    ///
    /// Not every camera has both. Everything behind the Digifort relay has a main stream only -
    /// the VMS answers substream requests with the same line - so asking such a camera for "sub"
    /// used to return null here and the cell simply stayed black, with nothing anywhere saying
    /// why. Falling back to main is what an operator wants in that moment; reporting the stream
    /// that was really used is what stops the cell from labelling itself with a stream it is not
    /// playing.
    /// </summary>
    public static string? PlayableUrl(
        V1StreamSet set,
        string streamType,
        bool preferPassthrough,
        out string actualStreamType)
    {
        actualStreamType = streamType;
        var stream = set.For(streamType);

        if (stream is null && streamType != "main")
        {
            stream = set.Main;
            actualStreamType = "main";
        }

        if (stream is null)
        {
            return null;
        }

        if (preferPassthrough && !string.IsNullOrEmpty(stream.Urls.Mp4Raw))
        {
            return stream.Urls.Mp4Raw;
        }

        return stream.Urls.Mp4;
    }

    /// <summary>
    /// Which stream this camera can really play when asked for <paramref name="streamType"/>.
    ///
    /// The wall calls this before it starts a cell, so the cell can be labelled with the stream
    /// it will actually show rather than the one that was requested.
    /// </summary>
    public static string EffectiveStreamType(V1StreamSet set, string streamType) =>
        set.For(streamType) is null && set.Main is not null ? "main" : streamType;

    /// <summary>
    /// Opens the gateway's server-sent event stream and hands back the raw body.
    ///
    /// It uses its own HttpClient because this connection is meant to stay open for hours, and
    /// the shared one has a 15 second timeout - which HttpClient applies to the whole response,
    /// not to the wait for headers, so the stream would be cut every 15 seconds.
    ///
    /// ResponseHeadersRead matters for the same reason: the default buffers the entire response
    /// before returning, and this response never ends.
    /// </summary>
    public async Task<Stream> OpenEventsAsync(CancellationToken ct)
    {
        using var req = KeyedRequest(HttpMethod.Get, "/api/v1/events");
        req.Headers.Remove("Accept");
        req.Headers.TryAddWithoutValidation("Accept", "text/event-stream");

        var res = await _events
            .SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct)
            .ConfigureAwait(false);

        try
        {
            ThrowIfUnauthorized(res);
            res.EnsureSuccessStatusCode();

            return await res.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        }
        catch
        {
            // The retry loop calls this again every few seconds while the gateway answers with an
            // error; an undisposed response each time holds a pooled connection until GC.
            res.Dispose();
            throw;
        }
    }

    private HttpRequestMessage KeyedRequest(HttpMethod method, string path)
    {
        var req = new HttpRequestMessage(method, Url(path));
        // Header only. The gateway rejects keys passed in the query string by design, because a
        // query string ends up in the access log of every proxy the request passes through.
        req.Headers.TryAddWithoutValidation("Authorization", $"Bearer {_apiKey}");
        req.Headers.TryAddWithoutValidation("Accept", "application/json");

        // Lets the gateway tell one running client from another on the same key. Without it every
        // machine behind one NAT address counts as a single client, which is the case an
        // administrator most needs to see apart.
        if (_instanceId.Length > 0)
        {
            req.Headers.TryAddWithoutValidation("X-Client-Instance", _instanceId);
            req.Headers.TryAddWithoutValidation("X-Client-Name", _instanceLabel);
        }

        return req;
    }

    private void ThrowIfUnauthorized(HttpResponseMessage res)
    {
        if (res.StatusCode == HttpStatusCode.Unauthorized)
        {
            throw new GatewayAuthException(Strings.T("error.keyRejected"));
        }
    }

    private string Url(string path) => _baseUrl + (path.StartsWith('/') ? path : "/" + path);

    public void Dispose()
    {
        _http.Dispose();
        _events.Dispose();
    }
}
