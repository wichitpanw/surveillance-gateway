using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using SurveillanceGateway.Client.Models;
using SurveillanceGateway.Client.Services;

namespace SurveillanceGateway.Client.Views;

/// <summary>
/// AI events from the edges, newest first (docs/EDGE-PLAN.md phase 5).
///
/// The last 24 hours are fetched when the page is shown and on Refresh; after that the shell pushes
/// every live `ai_event` in through <see cref="Add"/>, so the page never polls. Snapshots load one
/// at a time in the background - a busy day has hundreds of rows and firing all their requests at
/// once would stall the camera list and PTZ calls that share the same HttpClient.
/// </summary>
public partial class EventsView : UserControl, IDisposable
{
    private const int MaxRows = 500;

    private readonly GatewayClient _client;
    private readonly ObservableCollection<EventRow> _rows = new();
    private readonly SemaphoreSlim _thumbGate = new(1, 1);
    private readonly HashSet<long> _seen = new();
    private bool _loading;
    private bool _changingFilters;
    private bool _disposed;
    private int _loadVersion;
    private readonly CancellationTokenSource _lifetime = new();
    private CancellationTokenSource? _loadCts;
    private readonly Dictionary<long, V1AiEvent> _liveDuringLoad = new();
    private List<string> _edges = new();
    private List<string> _groups = new();
    private sealed record FilterOption(string Value, string Text) { public override string ToString() => Text; }

    public EventsView(GatewayClient client)
    {
        _client = client;
        InitializeComponent();
        EventList.ItemsSource = _rows;
        RefreshButton.Click += async (_, _) => await LoadAsync().ConfigureAwait(true);
        EdgeFilter.SelectionChanged += OnFilterChanged;
        GroupFilter.SelectionChanged += OnFilterChanged;
        OriginFilter.SelectionChanged += OnFilterChanged;
        RebuildFilters();
        Strings.Current.PropertyChanged += OnLanguageChanged;
        RefreshText();
    }

    private void OnLanguageChanged(object? sender, PropertyChangedEventArgs e) { RebuildFilters(); RefreshText(); }

    private async void OnFilterChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!_changingFilters && !_disposed) await LoadAsync().ConfigureAwait(true);
    }

    private string EdgeValue => EdgeFilter.SelectedValue as string ?? "";
    private string GroupValue => GroupFilter.SelectedValue as string ?? "";
    private string OriginValue => OriginFilter.SelectedValue as string ?? "";

    /// <summary>คงตัวกรองที่เลือกเมื่อภาษา/ตัวเลือกจาก server เปลี่ยน</summary>
    private void RebuildFilters()
    {
        var edge = EdgeValue; var group = GroupValue; var origin = OriginValue;
        _changingFilters = true;
        try
        {
            EdgeFilter.ItemsSource = new[] { new FilterOption("", Strings.T("events.filter.allEdges")) }
                .Concat(_edges.Select((v) => new FilterOption(v, Strings.T("events.edgeValue", v)))).ToList();
            GroupFilter.ItemsSource = new[] { new FilterOption("", Strings.T("events.filter.allGroups")) }
                .Concat(_groups.Select((v) => new FilterOption(v, v))).ToList();
            OriginFilter.ItemsSource = new[] { new FilterOption("", Strings.T("events.filter.allOrigins")) }
                .Concat(new[] { "camera", "nvr", "vms", "api", "edge-ai" }
                    .Select((v) => new FilterOption(v, Strings.T($"events.origin.{v}")))).ToList();
            EdgeFilter.SelectedValue = _edges.Contains(edge) ? edge : "";
            GroupFilter.SelectedValue = _groups.Contains(group) ? group : "";
            OriginFilter.SelectedValue = origin;
        }
        finally { _changingFilters = false; }
    }

    private bool Matches(V1AiEvent e) =>
        (EdgeValue.Length == 0 || e.EdgeNode == EdgeValue) &&
        (GroupValue.Length == 0 || e.Group == GroupValue) &&
        (OriginValue.Length == 0 || e.Origin == OriginValue);

    /// <summary>Detaches from Strings.Current, which outlives every page; called when the tab closes or on sign-out.</summary>
    public void Dispose()
    {
        _disposed = true;
        _lifetime.Cancel();
        _loadCts?.Cancel();
        Strings.Current.PropertyChanged -= OnLanguageChanged;
    }

    /// <summary>Loads the last 24 hours, replacing what is shown.</summary>
    public async Task LoadAsync()
    {
        if (_disposed) return;
        _loadCts?.Cancel(); _loadCts?.Dispose();
        _loadCts = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);
        var ct = _loadCts.Token;
        var version = ++_loadVersion;
        var edge = EdgeValue; var group = GroupValue; var origin = OriginValue;
        _loading = true;
        SubText.Text = Strings.T("events.loading");
        try
        {
            var now = DateTimeOffset.Now;
            var page = await _client.GetAiEventPageAsync(now.AddHours(-24), now.AddMinutes(1),
                edgeNode: edge.Length == 0 ? null : edge, group: group.Length == 0 ? null : group,
                origin: origin.Length == 0 ? null : origin, ct: ct).ConfigureAwait(true);
            if (_disposed || version != _loadVersion) return;
            _edges = page.Edges ?? new List<string>(); _groups = page.Groups ?? new List<string>();
            RebuildFilters();
            _rows.Clear(); _seen.Clear();
            foreach (var item in (page.Events ?? new List<V1AiEvent>()).Concat(_liveDuringLoad.Values)
                .OrderByDescending((item) => item.Seq)) if (Matches(item)) AddRow(item, atTop: false);
            _liveDuringLoad.Clear();
        }
        catch (OperationCanceledException) { }
        catch (Exception ex)
        {
            if (!_disposed && version == _loadVersion) SubText.Text = Strings.T("events.loadFailed", ex.Message);
            return;
        }
        finally
        {
            if (version == _loadVersion) _loading = false;
        }
        if (!_disposed && version == _loadVersion) RefreshText();
    }

    /// <summary>A live event from the stream - goes to the top.</summary>
    public void Add(V1AiEvent e)
    {
        if (_disposed) return;
        if (_loading)
        {
            _liveDuringLoad[e.Seq] = e;
            while (_liveDuringLoad.Count > MaxRows) _liveDuringLoad.Remove(_liveDuringLoad.Keys.Min());
        }
        if (Matches(e)) AddRow(e, atTop: true);
        RefreshText();
    }

    private void AddRow(V1AiEvent e, bool atTop)
    {
        if (!_seen.Add(e.Seq)) return;
        var row = new EventRow(e);
        if (atTop) _rows.Insert(0, row); else _rows.Add(row);
        while (_rows.Count > MaxRows)
        {
            _seen.Remove(_rows[^1].Seq);
            _rows.RemoveAt(_rows.Count - 1);
        }
        if (e.HasSnapshot) _ = LoadThumbAsync(row, _loadCts?.Token ?? _lifetime.Token);
    }

    /// <summary>ยกเลิก thumbnail ของตัวกรองเก่า ไม่ให้คิวภาพเก่าถ่วงหน้าที่เลือกใหม่</summary>
    private async Task LoadThumbAsync(EventRow row, CancellationToken ct)
    {
        var entered = false;
        try
        {
            await _thumbGate.WaitAsync(ct).ConfigureAwait(false);
            entered = true;
            var bytes = await _client.GetAiSnapshotAsync(row.Seq, ct).ConfigureAwait(false);
            if (bytes is null || ct.IsCancellationRequested) return;
            using var stream = new MemoryStream(bytes);
            var image = new BitmapImage();
            image.BeginInit();
            image.CacheOption = BitmapCacheOption.OnLoad;
            image.DecodePixelWidth = 256;
            image.StreamSource = stream;
            image.EndInit(); image.Freeze();
            _ = Dispatcher.BeginInvoke(() => { if (!_disposed && !ct.IsCancellationRequested) row.Thumb = image; });
        }
        catch (OperationCanceledException) { }
        catch (Exception) { /* ภาพที่โหลดไม่ได้ไม่ขัดจังหวะหน้ารายการ */ }
        finally { if (entered) _thumbGate.Release(); }
    }

    /// <summary>Row clicked: open the popup on it (Views/EventDetailWindow).</summary>
    private void OnRowClick(object sender, System.Windows.Input.MouseButtonEventArgs e)
    {
        if (sender is FrameworkElement { DataContext: EventRow row }) EventDetailWindow.Open(_client, _rows, row.Seq);
    }

    private void RefreshText()
    {
        EmptyText.Visibility = _rows.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        if (!_loading) SubText.Text = Strings.T("events.sub", _rows.Count);
        foreach (var row in _rows) row.Relabel();
    }

    /// <summary>One row of the list. Text is rebuilt when the language changes.</summary>
    public sealed class EventRow : INotifyPropertyChanged
    {
        private readonly V1AiEvent _e;
        private ImageSource? _thumb;

        public EventRow(V1AiEvent e)
        {
            _e = e;
            Relabel();
        }

        public long Seq => _e.Seq;
        public V1AiEvent Event => _e;
        public string Time { get; private set; } = string.Empty;
        public string Title { get; private set; } = string.Empty;
        public string Detail { get; private set; } = string.Empty;

        public ImageSource? Thumb
        {
            get => _thumb;
            set { _thumb = value; PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(Thumb))); }
        }

        public event PropertyChangedEventHandler? PropertyChanged;

        public void Relabel()
        {
            Time = DateTimeOffset.TryParse(_e.Ts, out var ts) ? ts.ToLocalTime().ToString("HH:mm:ss") : "--:--:--";
            var kind = Strings.TOr($"events.type.{_e.Type}", _e.Type ?? "-");
            var what = string.IsNullOrEmpty(_e.Label) ? null : Strings.TOr($"events.label.{_e.Label}", _e.Label);
            Title = what is null ? kind : $"{kind} · {what}";

            var parts = new List<string> { _e.CameraName ?? _e.CameraId ?? "-" };
            if (!string.IsNullOrEmpty(_e.Rule)) parts.Add(_e.Rule!);
            var dir = _e.Attr("direction");
            if (dir is not null) parts.Add(Strings.T("events.direction", dir));
            parts.Add(_e.OriginText);
            if (!string.IsNullOrEmpty(_e.EdgeNode)) parts.Add(Strings.T("events.edgeValue", _e.EdgeNode));
            if (!string.IsNullOrEmpty(_e.Group)) parts.Add(_e.Group);
            Detail = string.Join(" · ", parts);

            PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(Time)));
            PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(Title)));
            PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(Detail)));
        }
    }
}
