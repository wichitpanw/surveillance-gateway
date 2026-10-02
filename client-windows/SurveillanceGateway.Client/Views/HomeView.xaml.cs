using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using SurveillanceGateway.Client.Models;
using SurveillanceGateway.Client.Services;

namespace SurveillanceGateway.Client.Views;

/// <summary>
/// The page the client opens on.
///
/// It is a launcher, but not only a launcher: each card reports the state of what it opens, and
/// the side column carries the last few things the gateway's event feed said. The first screen of
/// a shift should answer "is anything wrong" before anyone opens a page.
///
/// It owns no data of its own. The shell hands it the camera list the wall already loaded and the
/// events as they arrive, because a second fetch would give this page a different truth than the
/// page next to it.
/// </summary>
public partial class HomeView : UserControl, IDisposable
{
    private const int FeedLength = 6;

    private readonly ObservableCollection<FeedEntry> _events = new();
    private IReadOnlyList<V1Camera>? _cameras;
    private int _wallCells;
    private int _wallFilled;
    private string? _viewName;

    public HomeView()
    {
        InitializeComponent();

        EventList.ItemsSource = _events;

        WallCard.Click += (_, _) => Open?.Invoke(this, PageKind.Wall);
        MapCard.Click += (_, _) => Open?.Invoke(this, PageKind.Map);
        DevicesCard.Click += (_, _) => Open?.Invoke(this, PageKind.Devices);

        Strings.Current.LanguageChanged += OnLanguageChanged;
        RefreshText();
    }

    private void OnLanguageChanged(object? sender, EventArgs e) => RefreshText();

    /// <summary>Strings.Current lives for the whole app - an attached handler keeps this page alive after sign-out.</summary>
    public void Dispose() => Strings.Current.LanguageChanged -= OnLanguageChanged;

    /// <summary>A card was clicked. The shell decides whether that opens a tab or selects one.</summary>
    public event EventHandler<PageKind>? Open;

    /// <summary>
    /// Fills in the figures from the camera list.
    ///
    /// ตัวเลขรวมแยกตามสถานะเพื่อให้ผู้ใช้เห็นกล้องที่ยังไม่ทราบสถานะด้วย
    /// </summary>
    public void SetCameras(IReadOnlyList<V1Camera> cameras, int wallCells, int wallFilled, string? viewName)
    {
        _cameras = cameras;
        _wallCells = wallCells;
        _wallFilled = wallFilled;
        _viewName = viewName;
        var online = cameras.Count(c => c.Availability == "online");
        var offline = cameras.Count(c => c.IsOfflineForSummary);

        OnlineFigure.Text = online.ToString();
        OfflineFigure.Text = offline.ToString();
        TotalFigure.Text = cameras.Count.ToString();
        OtherFigure.Text = (cameras.Count - online - offline).ToString();

        var other = new[] { "edgeUnavailable", "missing", "awaitingStream", "disabled", "unknown" }
            .Select(key => (key, count: cameras.Count(c => c.Availability == key)))
            .Where(item => item.count > 0)
            .Select(item => $"{item.count} {Strings.T($"status.{item.key}")}");
        SubText.Text = string.Join(" · ", new[] { Strings.T("home.sub", cameras.Count) }.Concat(other));
        WallState.Text = viewName is null
            ? Strings.T("home.wallState", wallFilled, wallCells)
            : Strings.T("home.wallStateView", viewName, wallFilled, wallCells);

        var pinned = cameras.Count(c => c.Location is not null);
        MapState.Text = Strings.T("home.mapState", pinned, cameras.Count - pinned);
        DevicesState.Text = Strings.T("home.devicesState", cameras.Count);
    }

    /// <summary>Shows the build-mismatch warning, or hides it when <paramref name="text"/> is null.</summary>
    public void SetBuildWarning(string? text)
    {
        BuildWarningText.Text = text ?? string.Empty;
        BuildWarning.Visibility = string.IsNullOrEmpty(text) ? Visibility.Collapsed : Visibility.Visible;
    }

    /// <summary>
    /// Adds one event to the feed.
    ///
    /// Newest first, and only the last few are kept: this is a glance surface, not a log. The log
    /// lives at Central, which keeps them beyond the life of this process.
    /// </summary>
    public void AddEvent(V1Event evt)
    {
        var entry = new FeedEntry(
            evt.CameraName ?? evt.CameraId ?? "-",
            Strings.T(evt.IsOnline ? "home.evtOnline" : "home.evtOffline", evt.StreamType ?? "-"),
            DateTime.Now.ToString("HH:mm"),
            Brush(evt.IsOnline ? "StatusOkBrush" : "StatusCritBrush"));

        _events.Insert(0, entry);
        while (_events.Count > FeedLength)
        {
            _events.RemoveAt(_events.Count - 1);
        }

        EmptyFeed.Visibility = Visibility.Collapsed;
        FeedSub.Text = Strings.T("home.eventsSince");
    }

    private void RefreshText()
    {
        // Not a clock-based greeting: this app runs on machines that are watched at 03:00 as often
        // as at 09:00, and "Good morning" on a night shift reads as a bug.
        GreetingText.Text = Strings.T("home.greeting", Environment.MachineName);
        FeedSub.Text = Strings.T(_events.Count > 0 ? "home.eventsSince" : "home.eventsSub");
        if (_cameras is not null) SetCameras(_cameras, _wallCells, _wallFilled, _viewName);
    }

    private static Brush Brush(string key) =>
        (Application.Current.TryFindResource(key) as Brush) ?? Brushes.Gray;

    /// <summary>One line in the side feed.</summary>
    public sealed record FeedEntry(string Camera, string Detail, string At, Brush Accent);
}
