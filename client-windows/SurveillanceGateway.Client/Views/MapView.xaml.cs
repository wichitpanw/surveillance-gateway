using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Tasks;
using System.Windows.Controls;
using Microsoft.Web.WebView2.Core;
using SurveillanceGateway.Client.Models;
using SurveillanceGateway.Client.Services;

namespace SurveillanceGateway.Client.Views;

/// <summary>
/// The camera map.
///
/// The map itself is a page the gateway serves (`/client-map.html`), shown in WebView2. Drawing a
/// vector map natively in WPF would mean reimplementing what MapLibre already does against the
/// gateway's own tiles, and the tiles, the style and the map code would then have to be kept in
/// step across two languages. Hosting the page keeps one implementation and ships no map assets
/// with this client.
///
/// The page is deliberately ignorant: it holds no API key and never calls /api/v1. This class
/// fetches the cameras — already narrowed to the key's scope by the gateway — and hands them over.
/// A second place deciding who may see which camera is a mistake nothing would catch.
///
/// Clicking a pin does not play video in the page. WebView2 cannot decode the H.265 this fleet
/// mostly emits, and nothing can be drawn over a WebView2 anyway, so the click comes back here and
/// opens the native detail view.
/// </summary>
public partial class MapView : UserControl, IDisposable
{
    private readonly GatewayClient _client;
    private readonly AppSettings _settings;

    private bool _initialised;
    private IReadOnlyList<V1Camera> _cameras = Array.Empty<V1Camera>();

    public MapView(GatewayClient client, AppSettings settings)
    {
        InitializeComponent();
        _client = client;
        _settings = settings;

        ReloadButton.Click += async (_, _) => await PushCamerasAsync().ConfigureAwait(false);
        Loaded += async (_, _) => await InitialiseAsync().ConfigureAwait(false);
    }

    /// <summary>Raised when a pin is clicked, so the shell can open that camera natively.</summary>
    public event EventHandler<string>? CameraActivated;

    private async Task InitialiseAsync()
    {
        if (_initialised)
        {
            return;
        }

        _initialised = true;

        try
        {
            await Web.EnsureCoreWebView2Async().ConfigureAwait(true);
        }
        catch (Exception ex)
        {
            // The usual cause is a machine with no WebView2 runtime. Saying so beats a blank
            // rectangle that looks like the gateway is down.
            StatusText.Text = Strings.T("map.needsWebView", ex.Message);
            return;
        }

        Web.CoreWebView2.WebMessageReceived += OnWebMessage;
        Web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
        Web.CoreWebView2.Settings.IsStatusBarEnabled = false;

        Web.CoreWebView2.NavigationCompleted += async (_, e) =>
        {
            if (!e.IsSuccess)
            {
                StatusText.Text = Strings.T("map.loadFailed", e.WebErrorStatus);
                return;
            }

            await PushCamerasAsync().ConfigureAwait(true);
        };

        Navigate();

        // The page reads its language and theme from the query string, so a change to either is
        // applied by loading it again - it holds no state of its own, and the camera list is
        // pushed back in on NavigationCompleted.
        Strings.Current.LanguageChanged += OnLanguageChanged;
    }

    private void OnLanguageChanged(object? sender, EventArgs e) => Navigate();

    private void Navigate()
    {
        if (Web.CoreWebView2 is null)
        {
            return;
        }

        var theme = _settings.Theme == "light" ? "light" : "dark";
        Web.CoreWebView2.Navigate($"{_client.BaseUrl}/client-map.html?theme={theme}&lang={Strings.Current.Language}");
    }

    /// <summary>
    /// Sends the camera list into the page.
    ///
    /// Called on every navigation and whenever the operator asks to reload, rather than once: the
    /// page keeps no state of its own, so re-sending is the whole refresh mechanism.
    /// </summary>
    private async Task PushCamerasAsync()
    {
        if (Web.CoreWebView2 is null)
        {
            return;
        }

        try
        {
            var cameras = await _client.GetCamerasAsync().ConfigureAwait(true);
            _cameras = cameras;

            // The page colours a pin from `online`, which the gateway does not send on this
            // endpoint - it reports readiness per stream. Fill it in here so pins are right on
            // the first paint, before any event has arrived.
            foreach (var cam in cameras)
            {
                cam.Online = cam.InitialOnline;
            }

            var payload = JsonSerializer.Serialize(cameras, new JsonSerializerOptions
            {
                DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
            });

            // ExecuteScriptAsync takes one expression, so the list goes in as a JSON literal.
            await Web.CoreWebView2.ExecuteScriptAsync($"window.setCameras({payload})").ConfigureAwait(true);
            StatusText.Text = Strings.T("map.cameraCount", cameras.Count, _client.ApiClientName ?? "-");
        }
        catch (Exception ex)
        {
            StatusText.Text = Strings.T("map.listFailed", ex.Message);
        }
    }

    /// <summary>
    /// Recolours one pin from a gateway status event.
    ///
    /// It updates the pin in place rather than re-sending the list: re-sending redraws every
    /// marker and refits the view, so an operator zoomed in on one junction would be pulled back
    /// out every time any camera in the fleet changed state.
    /// </summary>
    public async Task ApplyStatusAsync(V1Event evt)
    {
        if (Web.CoreWebView2 is null || string.IsNullOrEmpty(evt.CameraId))
        {
            return;
        }

        var id = JsonSerializer.Serialize(evt.CameraId);
        var match = System.Linq.Enumerable.FirstOrDefault(_cameras, c => c.Id == evt.CameraId);
        if (match is null) return;
        if (evt.Type == "camera_state") match.ApplyState(evt.Enabled, evt.Reachable, evt.Streaming);
        else if (evt.Type == "camera_status" && evt.StreamType == "main" && match.State is null)
            match.Online = evt.IsOnline;
        var status = JsonSerializer.Serialize(match.Availability);
        await Web.CoreWebView2.ExecuteScriptAsync($"window.setCameraStatus({id},{status})").ConfigureAwait(true);
    }

    /// <summary>Moves the map to one camera - used when it is picked somewhere else in the app.</summary>
    public async Task FocusAsync(string cameraId)
    {
        if (Web.CoreWebView2 is null)
        {
            return;
        }

        var id = JsonSerializer.Serialize(cameraId);
        await Web.CoreWebView2.ExecuteScriptAsync($"window.focusCamera({id})").ConfigureAwait(true);
    }

    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        // The page posts a JSON string. Treat anything else as noise rather than trusting it:
        // this is a message boundary, and the far side is a browser.
        string raw;
        try
        {
            raw = e.TryGetWebMessageAsString();
        }
        catch (ArgumentException)
        {
            return;
        }

        MapMessage? message;
        try
        {
            message = JsonSerializer.Deserialize<MapMessage>(raw);
        }
        catch (JsonException)
        {
            return;
        }

        switch (message?.Type)
        {
            case "camera-activated" when !string.IsNullOrEmpty(message.CameraId):
                CameraActivated?.Invoke(this, message.CameraId!);
                break;

            case "rendered":
                StatusText.Text = message.Skipped > 0
                    ? Strings.T("map.placedWithSkipped", message.Placed, message.Skipped)
                    : Strings.T("map.placed", message.Placed);
                break;
        }
    }

    /// <summary>
    /// Shuts the embedded browser down.
    ///
    /// WebView2 runs its own processes; letting the control go out of scope without disposing
    /// leaves them alive for the life of the app, which on a machine that switches views all day
    /// is a browser process per visit.
    /// </summary>
    public void Dispose()
    {
        Strings.Current.LanguageChanged -= OnLanguageChanged;

        if (Web.CoreWebView2 is not null)
        {
            Web.CoreWebView2.WebMessageReceived -= OnWebMessage;
        }

        Web.Dispose();
    }

    /// <summary>What `/client-map.html` posts back. Kept minimal on purpose.</summary>
    private sealed class MapMessage
    {
        [JsonPropertyName("type")]
        public string? Type { get; set; }

        [JsonPropertyName("cameraId")]
        public string? CameraId { get; set; }

        [JsonPropertyName("placed")]
        public int Placed { get; set; }

        [JsonPropertyName("skipped")]
        public int Skipped { get; set; }
    }
}
