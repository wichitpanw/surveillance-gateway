using System;
using System.Collections.Generic;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media.Imaging;
using SurveillanceGateway.Client.Models;
using SurveillanceGateway.Client.Services;

namespace SurveillanceGateway.Client.Views;

/// <summary>
/// Popup for one AI event: the full snapshot and its details, stepping through the page's list with
/// the arrow keys or the side buttons. It is modeless, so new events can keep arriving underneath.
/// Position follows the event's seq rather than its index, because a live event inserts at the top
/// and shifts every index by one.
/// </summary>
public partial class EventDetailWindow : Window
{
    private readonly Action<V1AiEvent, bool>? _investigate;
    private readonly GatewayClient _client;
    private readonly IList<EventsView.EventRow> _rows;
    private long _seq;
    private int _loadVersion;
    private System.Threading.CancellationTokenSource? _snapshotRequest;

    private EventDetailWindow(GatewayClient client, IList<EventsView.EventRow> rows, long seq, Action<V1AiEvent, bool>? investigate)
    {
        _investigate = investigate;
        _client = client;
        _rows = rows;
        _seq = seq;
        InitializeComponent();
        LiveButton.Click += (_, _) => Investigate(false);
        PlaybackButton.Click += (_, _) => Investigate(true);
        MaxWidth = SystemParameters.WorkArea.Width;
        MaxHeight = SystemParameters.WorkArea.Height;
        CloseButton.Click += (_, _) => Close();
        PrevButton.Click += (_, _) => Step(-1);
        NextButton.Click += (_, _) => Step(+1);
        PreviewKeyDown += (_, e) =>
        {
            if (e.Key == Key.Left) { Step(-1); e.Handled = true; }
            else if (e.Key == Key.Right) { Step(+1); e.Handled = true; }
        };
        // No title bar to drag by: the whole card moves the window instead.
        MouseLeftButtonDown += (_, e) =>
        {
            if (e.ButtonState == MouseButtonState.Pressed) DragMove();
        };
        Closed += (_, _) => { ++_loadVersion; _snapshotRequest?.Cancel(); _snapshotRequest?.Dispose(); SnapshotImage.Source = null; };
        ShowEvent(seq);
    }

    /// <summary>Opens the popup on the row with this seq, centred on the main window.</summary>
    public static void Open(GatewayClient client, IList<EventsView.EventRow> rows, long seq, Action<V1AiEvent, bool>? investigate = null)
    {
        var owner = Application.Current?.MainWindow;
        var window = new EventDetailWindow(client, rows, seq, investigate);
        if (owner is { IsLoaded: true }) window.Owner = owner;
        else window.WindowStartupLocation = WindowStartupLocation.CenterScreen;
        window.Show();
        window.Activate();
    }

    private void Investigate(bool playback)
    {
        var index = IndexOf(_seq);
        if (index < 0 || _investigate is null) return;
        _investigate(_rows[index].Event, playback);
        Close();
    }

    private int IndexOf(long seq)
    {
        for (var i = 0; i < _rows.Count; i++)
        {
            if (_rows[i].Seq == seq) return i;
        }
        return -1;
    }

    private void Step(int delta)
    {
        var i = IndexOf(_seq) + delta;
        if (i >= 0 && i < _rows.Count) ShowEvent(_rows[i].Seq);
    }

    private void ShowEvent(long seq)
    {
        _snapshotRequest?.Cancel(); _snapshotRequest?.Dispose();
        _snapshotRequest = new System.Threading.CancellationTokenSource();
        var index = IndexOf(seq);
        if (index < 0) { Close(); return; }
        _seq = seq;
        var row = _rows[index];
        var e = row.Event;
        LiveButton.IsEnabled = _investigate is not null && !string.IsNullOrEmpty(e.CameraId);
        PlaybackButton.IsEnabled = LiveButton.IsEnabled && DateTimeOffset.TryParse(e.Ts, out _);

        TitleText.Text = row.Title;
        SubtitleText.Text = $"{e.CameraName ?? e.CameraId ?? "-"} · {LocalTime(e.Ts, "yyyy-MM-dd HH:mm:ss")}";
        PositionText.Text = $"{index + 1} / {_rows.Count}";
        PrevButton.IsEnabled = index > 0;
        NextButton.IsEnabled = index < _rows.Count - 1;

        FieldPanel.Children.Clear();
        AddField("events.detail.time", LocalTime(e.Ts, "HH:mm:ss"));
        var first = e.Attr("firstSeen");
        var dur = e.AttrNumber("durationSec");
        if (first is not null)
        {
            AddField("events.detail.seen", Strings.T("events.detail.seenValue",
                LocalTime(first, "HH:mm:ss"), LocalTime(e.Attr("lastSeen"), "HH:mm:ss"), dur?.ToString("0.#") ?? "-"));
        }
        if (!string.IsNullOrEmpty(e.Rule)) AddField("events.detail.rule", e.Rule!);
        var dir = e.Attr("direction");
        if (dir is not null) AddField("events.detail.direction", dir);
        if (!string.IsNullOrEmpty(e.TrackId)) AddField("events.detail.track", e.TrackId!);
        var score = e.AttrNumber("maxScore");
        if (score is not null) AddField("events.detail.confidence", $"{Math.Round(score.Value * 100)}%");
        AddField("events.detail.source", e.OriginText);
        if (!string.IsNullOrEmpty(e.EdgeNode)) AddField("events.filter.edge", Strings.T("events.edgeValue", e.EdgeNode));
        if (!string.IsNullOrEmpty(e.Group)) AddField("events.filter.group", e.Group);
        var imageSource = e.Attr("imageSource");
        if (imageSource == "device-alarm-storage") AddField("events.detail.imageSource", Strings.T("events.image.device"));
        else if (imageSource == "onvif-event-triggered-snapshot") AddField("events.detail.imageSource", Strings.T("events.image.triggered"));
        var capturedAt = e.Attr("capturedAt");
        if (capturedAt is not null) AddField("events.detail.capturedAt", LocalTime(capturedAt, "HH:mm:ss"));

        SnapshotImage.Source = null;
        var version = ++_loadVersion;
        if (!e.HasSnapshot)
        {
            SnapshotText.Text = Strings.T("events.detail.noSnapshot");
            return;
        }
        SnapshotText.Text = Strings.T("events.loading");
        _ = LoadSnapshotAsync(e.Seq, version, _snapshotRequest.Token);
    }

    private async System.Threading.Tasks.Task LoadSnapshotAsync(long seq, int version, System.Threading.CancellationToken ct)
    {
        BitmapImage? image = null;
        try
        {
            var bytes = await _client.GetAiSnapshotAsync(seq, ct).ConfigureAwait(true);
            if (bytes is not null)
            {
                image = new BitmapImage();
                image.BeginInit();
                image.CacheOption = BitmapCacheOption.OnLoad;
                image.StreamSource = new MemoryStream(bytes);
                image.EndInit();
                image.Freeze();
            }
        }
        catch (Exception)
        {
            image = null;
        }
        if (version != _loadVersion) return; // the user already moved on to another event
        SnapshotImage.Source = image;
        SnapshotText.Text = image is null ? Strings.T("events.detail.noSnapshot") : string.Empty;
    }

    private void AddField(string labelKey, string value)
    {
        var panel = new StackPanel { Margin = new Thickness(0, 0, 28, 8) };
        panel.Children.Add(new TextBlock
        {
            Text = Strings.T(labelKey),
            Style = (Style)FindResource("EyebrowText"),
        });
        panel.Children.Add(new TextBlock
        {
            Text = value,
            Style = (Style)FindResource("BodyText"),
            FontSize = 13,
            Margin = new Thickness(0, 3, 0, 0),
        });
        FieldPanel.Children.Add(panel);
    }

    private static string LocalTime(string? iso, string format) =>
        DateTimeOffset.TryParse(iso, out var t) ? t.ToOffset(TimeSpan.FromHours(7)).ToString(format) : "-";
}
