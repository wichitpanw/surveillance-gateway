using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Data;
using System.Windows.Media;
using System.Windows.Threading;
using SurveillanceGateway.Client.Models;
using SurveillanceGateway.Client.Services;

namespace SurveillanceGateway.Client.Views;

/// <summary>
/// What the gateway knows about one camera.
///
/// This page used to be half video and half text, which made it a poor player - one camera, fixed
/// size, no second monitor - and a poor reference, with the text squeezed into a column beside it.
/// Watching now belongs to <see cref="PlayerWindow"/>, and this is the reference: identity, what
/// streams exist and in which codec, and what the camera's own AI reports.
/// </summary>
public partial class CameraDetailView : UserControl, IDisposable
{
    private readonly GatewayClient _client;
    private readonly ObservableCollection<V1Camera> _visible = new();

    private IReadOnlyList<V1Camera> _all = Array.Empty<V1Camera>();
    private V1Camera? _camera;

    public CameraDetailView(GatewayClient client)
    {
        InitializeComponent();
        _client = client;

        // Grouped like the wall's picker, and for the same reason: a key scoped to several
        // sites lists them all, and eighty-five cameras from one VMS in a flat list means reading
        // every row to find the one that is wanted.
        var grouped = new CollectionViewSource { Source = _visible };
        grouped.GroupDescriptions.Add(new PropertyGroupDescription(nameof(V1Camera.GroupLabel)));
        CameraList.ItemsSource = grouped.View;
        CameraList.SelectionChanged += async (_, _) =>
        {
            if (CameraList.SelectedItem is V1Camera camera)
            {
                await ShowSafeAsync(camera).ConfigureAwait(true);
            }
        };

        SearchBox.TextChanged += (_, _) =>
        {
            SearchHint.Visibility = SearchBox.Text.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
            ApplyFilter();
            Dispatcher.BeginInvoke(DispatcherPriority.Loaded,
                new Action(() => SetGroupExpansion(CameraList, SearchBox.Text.Trim().Length > 0)));
        };

        // Nothing to open, map or return to until a camera is picked. Enabled buttons that do
        // nothing read as a broken page.
        SetActionsEnabled(false);

        // The panels are built as text, not bound, so they are rebuilt when the language changes.
        Strings.Current.LanguageChanged += OnLanguageChanged;
        BackButton.Click += (_, _) => BackRequested?.Invoke(this, EventArgs.Empty);
        OpenButton.Click += (_, _) =>
        {
            if (_camera is not null) PlayRequested?.Invoke(this, _camera);
        };
        MapButton.Click += (_, _) =>
        {
            if (_camera is not null) MapRequested?.Invoke(this, _camera);
        };
    }

    public event EventHandler? BackRequested;

    /// <summary>The panels are built as text, not bound, so they are rebuilt when the language changes.</summary>
    private async void OnLanguageChanged(object? sender, EventArgs e)
    {
        CameraCountText.Text = Strings.T("wall.scopeSimple", _all.Count);
        if (_camera is not null) await ShowSafeAsync(_camera).ConfigureAwait(true);
    }

    /// <summary>
    /// ShowAsync from an event handler. An async void handler that throws takes the whole app
    /// down, so a failure here stays on this page as the unhandled-exception log entry instead.
    /// </summary>
    private async Task ShowSafeAsync(V1Camera camera)
    {
        try
        {
            await ShowAsync(camera).ConfigureAwait(true);
        }
        catch (Exception ex)
        {
            App.LogError("CameraDetailView.ShowAsync", ex);
        }
    }

    /// <summary>Detaches from Strings.Current, which outlives every page; called when the tab closes or on sign-out.</summary>
    public void Dispose() => Strings.Current.LanguageChanged -= OnLanguageChanged;

    /// <summary>Asks the shell to open this camera in a player window.</summary>
    public event EventHandler<V1Camera>? PlayRequested;

    /// <summary>Asks the shell to switch to the map, centred on this camera.</summary>
    public event EventHandler<V1Camera>? MapRequested;

    /// <summary>
    /// Hands over the camera list the wall already loaded.
    ///
    /// Reusing those instances rather than fetching again is what keeps the status dots here in
    /// step with the event stream: the shell updates one object, and every list bound to it
    /// follows.
    /// </summary>
    public void SetCameras(IReadOnlyList<V1Camera> cameras)
    {
        _all = cameras;
        CameraCountText.Text = Strings.T("wall.scopeSimple", cameras.Count);
        ApplyFilter();
    }

    /// <summary>เปิดกลุ่มที่ตรงคำค้นและหุบกลุ่มเมื่อกลับสู่รายการทั้งหมด</summary>
    private void OnCameraGroupLoaded(object sender, RoutedEventArgs e)
    {
        if (sender is Expander group) group.IsExpanded = SearchBox.Text.Trim().Length > 0;
    }

    private static void SetGroupExpansion(DependencyObject root, bool expanded)
    {
        for (var i = 0; i < VisualTreeHelper.GetChildrenCount(root); i++)
        {
            var child = VisualTreeHelper.GetChild(root, i);
            if (child is Expander { Tag: "CameraGroup" } group) group.IsExpanded = expanded;
            else SetGroupExpansion(child, expanded);
        }
    }

    public async Task ShowAsync(V1Camera camera)
    {
        _camera = camera;
        SetActionsEnabled(true);
        TitleText.Text = camera.DisplayName;
        GroupText.Text = $"{camera.GroupLabel} · {camera.AvailabilityText}";
        InfoText.Text = DescribeCamera(camera);
        AnalyticsText.Text = DescribeAnalytics(camera);
        StreamText.Text = Strings.T("detail.asking");

        if (!ReferenceEquals(CameraList.SelectedItem, camera))
        {
            CameraList.SelectedItem = camera;
        }

        // Track codecs are the gateway's view of the streaming core, so they exist only once a
        // stream is actually running - which is exactly why they are worth showing here.
        try
        {
            var set = await _client.GetStreamsAsync(camera.Id).ConfigureAwait(true);
            StreamText.Text = DescribeStreams(set);
        }
        catch (Exception ex)
        {
            StreamText.Text = Strings.T("detail.askFailed", ex.Message);
        }
    }

    /// <summary>Reflects a status change from the gateway's event stream.</summary>
    public void ApplyStatus(V1Event evt)
    {
        if (_camera is null
            || !string.Equals(evt.CameraId, _camera.Id, StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        GroupText.Text = $"{_camera.GroupLabel} · {_camera.AvailabilityText}";
    }

    private void SetActionsEnabled(bool enabled)
    {
        OpenButton.IsEnabled = enabled;
        MapButton.IsEnabled = enabled;
    }

    private void ApplyFilter()
    {
        var term = SearchBox.Text.Trim();
        _visible.Clear();

        foreach (var cam in _all)
        {
            if (term.Length > 0
                && cam.DisplayName.IndexOf(term, StringComparison.OrdinalIgnoreCase) < 0
                && cam.GroupLabel.IndexOf(term, StringComparison.OrdinalIgnoreCase) < 0)
            {
                continue;
            }

            _visible.Add(cam);
        }
    }

    /*
      The three text blocks

      Laid out as aligned label/value lines rather than as a grid of controls: the values are all
      short, several are identifiers meant to be copied, and a monospace block reads better for
      that than a form would. Labels are translated; identifiers, codec names and core names are
      not, because those are what appears in the gateway's own logs.
    */

    private static string DescribeCamera(V1Camera camera)
    {
        var text = new StringBuilder();
        Line(text, "detail.id", camera.Id);
        Line(text, "detail.group", camera.GroupLabel);
        Line(text, "detail.brand", camera.Brand ?? "-");
        Line(text, "detail.type", camera.Type ?? "-");
        Line(text, "detail.alwaysOn", Strings.T(camera.AlwaysOn ? "detail.yes" : "detail.no"));
        Line(text, "detail.location", camera.Location is not null
            ? $"{camera.Location.Lat:F5}, {camera.Location.Lng:F5}"
            : Strings.T("detail.noLocation"));
        return text.ToString().TrimEnd();
    }

    private static string DescribeAnalytics(V1Camera camera)
    {
        var ai = camera.Analytics;
        if (ai?.Supported != true)
        {
            // The contract does not separate "no AI in this camera" from "AI switched off",
            // because a caller cannot act on the difference.
            return Strings.T("detail.aiNone");
        }

        var text = new StringBuilder();
        Line(text, "detail.aiKind", ai.Kind ?? "-");
        Line(text, "detail.aiProbedAt", ai.ProbedAt ?? "-");

        if (ai.Capabilities.Count == 0)
        {
            Line(text, "detail.aiRules", "-");
            return text.ToString().TrimEnd();
        }

        text.AppendLine($"{Strings.T("detail.aiRules")}");
        foreach (var cap in ai.Capabilities)
        {
            text.AppendLine($"  · {cap.Label ?? cap.Rule ?? "-"}{(cap.Topic is null ? "" : $"  [{cap.Topic}]")}");
        }

        return text.ToString().TrimEnd();
    }

    private static string DescribeStreams(V1StreamSet set)
    {
        var text = new StringBuilder();
        Line(text, "detail.core", set.Core ?? "-");
        Line(text, "detail.recommended", set.RecommendedForAnalytics ?? "-");
        AppendStream(text, Strings.T("detail.streamMain"), set.Main);
        AppendStream(text, Strings.T("detail.streamSub"), set.Sub);
        return text.ToString().TrimEnd();
    }

    /// <summary>One `label   value` line, with the label padded so a block of them lines up.</summary>
    private static void Line(StringBuilder text, string labelKey, string value) =>
        text.AppendLine($"{Strings.T(labelKey).PadRight(18)}{value}");

    private static void AppendStream(StringBuilder text, string label, V1Stream? stream)
    {
        if (stream is null)
        {
            text.AppendLine($"{label.PadRight(18)}{Strings.T("detail.streamMissing")}");
            return;
        }

        // Null ready means the gateway could not reach the core, which is not the same as a
        // camera being down - so it is said in words rather than shown as a state.
        var ready = stream.Ready switch
        {
            true => Strings.T("detail.ready"),
            false => Strings.T("detail.notReady"),
            _ => Strings.T("detail.readyUnknown"),
        };

        text.AppendLine($"{label.PadRight(18)}{ready}");
        text.AppendLine($"  {Strings.T("detail.tracks").PadRight(16)}{(stream.Tracks.Count > 0 ? string.Join(", ", stream.Tracks) : "-")}");
        text.AppendLine($"  {Strings.T("detail.passthrough").PadRight(16)}{Strings.T(string.IsNullOrEmpty(stream.Urls.Mp4Raw) ? "detail.unavailable" : "detail.available")}");
    }
}
