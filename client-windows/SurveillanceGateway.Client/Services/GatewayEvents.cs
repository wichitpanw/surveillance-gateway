using System;
using System.IO;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Threading;
using SurveillanceGateway.Client.Models;

namespace SurveillanceGateway.Client.Services;

/// <summary>
/// Keeps one connection to `GET /api/v1/events` open and republishes what arrives.
///
/// Camera status used to be whatever the last camera list happened to say, which meant a camera
/// that went down was only noticed the next time something reloaded the list. The gateway already
/// watches the streaming core and publishes transitions, so this listens instead of asking.
///
/// The stream is the only thing that connects: nothing here polls, and a dropped connection is
/// retried with a growing delay rather than immediately, because the usual cause is the gateway
/// restarting and a tight retry loop would just fill its log while it comes up.
///
/// Every event is raised on the UI thread. Subscribers are views; making each one marshal for
/// itself is the kind of rule that holds until somebody forgets it once.
/// </summary>
public sealed class GatewayEvents : IDisposable
{
    private static readonly TimeSpan FirstRetry = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan MaxRetry = TimeSpan.FromSeconds(30);

    /// <summary>Three missed `: ping` comments (sent every 20 s) - the connection is dead.</summary>
    private static readonly TimeSpan IdleTimeout = TimeSpan.FromSeconds(60);

    private readonly GatewayClient _client;
    private readonly Dispatcher _dispatcher;

    private CancellationTokenSource? _cts;
    private Task? _loop;

    public GatewayEvents(GatewayClient client, Dispatcher dispatcher)
    {
        _client = client;
        _dispatcher = dispatcher;
    }

    /// <summary>A camera's stream changed between online and offline.</summary>
    public event EventHandler<V1Event>? CameraStatusChanged;

    /// <summary>An AI event from an edge (line crossed, zone entered, object seen).</summary>
    public event EventHandler<V1AiEvent>? AiEventReceived;

    /// <summary>An edge dropped for two minutes or came back - its cameras have no picture meanwhile.</summary>
    public event EventHandler<V1EdgeState>? EdgeStateChanged;

    /// <summary>True while the event stream is open. False means status is stale, not offline.</summary>
    public bool IsConnected { get; private set; }

    /// <summary>Raised when the stream opens or drops, so the shell can say which it is.</summary>
    public event EventHandler<bool>? ConnectionChanged;

    public void Start()
    {
        if (_loop is not null)
        {
            return;
        }

        _cts = new CancellationTokenSource();
        _loop = Task.Run(() => RunAsync(_cts.Token));
    }

    private async Task RunAsync(CancellationToken ct)
    {
        var retry = FirstRetry;

        while (!ct.IsCancellationRequested)
        {
            try
            {
                await ReadStreamAsync(ct).ConfigureAwait(false);

                // A clean end still means the connection is gone. Reconnect, but from the short
                // delay again: the gateway closing tidily is not the failure that needs backing off.
                retry = FirstRetry;
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                return;
            }
            catch (GatewayAuthException)
            {
                // The key stopped working. Retrying cannot fix that and would hammer the gateway
                // with rejected requests until the app is closed.
                SetConnected(false);
                return;
            }
            catch (Exception)
            {
                retry = TimeSpan.FromSeconds(Math.Min(MaxRetry.TotalSeconds, retry.TotalSeconds * 2));
            }

            SetConnected(false);

            try
            {
                await Task.Delay(retry, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    private async Task ReadStreamAsync(CancellationToken ct)
    {
        // Idle watchdog: the gateway writes `: ping` every 20 s, so a minute of silence means the
        // connection died without a FIN (NAT timeout, cable pulled, sleeping laptop). Without this
        // ReadLineAsync waits forever and the client shows "connected" with frozen status.
        using var idle = CancellationTokenSource.CreateLinkedTokenSource(ct);
        idle.CancelAfter(IdleTimeout);

        using var stream = await OpenOrTimeoutAsync(idle, ct).ConfigureAwait(false);
        using var reader = new StreamReader(stream);

        SetConnected(true);

        // Minimal SSE: the gateway sends `data:` lines, `event: hello`, and `: ping` comments.
        // Anything else is ignored rather than treated as an error - a field this client does not
        // understand is not a reason to drop a working connection.
        while (!ct.IsCancellationRequested)
        {
            idle.CancelAfter(IdleTimeout);

            string? line;
            try
            {
                line = await reader.ReadLineAsync(idle.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                throw new TimeoutException("Event stream idle for too long.");
            }

            if (line is null)
            {
                return;
            }

            if (!line.StartsWith("data:", StringComparison.Ordinal))
            {
                continue;
            }

            var payload = line[5..].Trim();
            if (payload.Length == 0)
            {
                continue;
            }

            V1Event? evt;
            try
            {
                // AI and edge events carry a different shape from camera status - pick them off first.
                using (var doc = JsonDocument.Parse(payload))
                {
                    var type = doc.RootElement.TryGetProperty("type", out var t) ? t.GetString() : null;
                    if (type == "ai_event" && doc.RootElement.TryGetProperty("event", out var body))
                    {
                        var ai = body.Deserialize<V1AiEvent>();
                        if (ai is not null) _ = _dispatcher.BeginInvoke(() => AiEventReceived?.Invoke(this, ai));
                        continue;
                    }
                    if (type == "edge_state")
                    {
                        var edge = doc.RootElement.Deserialize<V1EdgeState>();
                        if (edge is not null) _ = _dispatcher.BeginInvoke(() => EdgeStateChanged?.Invoke(this, edge));
                        continue;
                    }
                }
                evt = JsonSerializer.Deserialize<V1Event>(payload);
            }
            catch (JsonException)
            {
                continue;
            }

            if (evt?.Type is not ("camera_state" or "camera_status") || string.IsNullOrEmpty(evt.CameraId))
            {
                continue;
            }

            var captured = evt;
            _ = _dispatcher.BeginInvoke(() => CameraStatusChanged?.Invoke(this, captured));
        }
    }

    /// <summary>Opens the stream under the idle watchdog; a watchdog cancel becomes a timeout, not a shutdown.</summary>
    private async Task<Stream> OpenOrTimeoutAsync(CancellationTokenSource idle, CancellationToken ct)
    {
        try
        {
            return await _client.OpenEventsAsync(idle.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new TimeoutException("Event stream did not open in time.");
        }
    }

    private void SetConnected(bool connected)
    {
        if (IsConnected == connected)
        {
            return;
        }

        IsConnected = connected;
        _ = _dispatcher.BeginInvoke(() => ConnectionChanged?.Invoke(this, connected));
    }

    public void Dispose()
    {
        _cts?.Cancel();
        _cts?.Dispose();
        _cts = null;
        _loop = null;
    }
}
