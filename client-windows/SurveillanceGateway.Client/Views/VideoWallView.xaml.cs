using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Data;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;
using LibVLCSharp.Shared;
using SurveillanceGateway.Client.Models;
using SurveillanceGateway.Client.Services;
using SurveillanceGateway.Client.Video;

namespace SurveillanceGateway.Client.Views;

/// <summary>
/// The video wall: a fixed grid of tiles playing what the gateway hands out.
///
/// This is the page the browser client is worst at and the reason the native client exists. It
/// plays the gateway's untranscoded fMP4 URLs, so H.265 cameras reach the screen in their own
/// codec and are decoded by this machine's GPU, instead of being transcoded to H.264 on the
/// server once per viewer.
/// </summary>
public partial class VideoWallView : UserControl, IDisposable
{
    private static readonly int[] LayoutOptions = { 1, 4, 9, 16, 25 };

    /// <summary>Clipboard format for a camera dragged out of the picker - carries its id.</summary>
    private const string CameraDragFormat = "SurveillanceGateway.CameraId";

    /// <summary>Clipboard format for a cell dragged to another cell - carries its slot number.</summary>
    private const string CellDragFormat = "SurveillanceGateway.WallSlot";

    private readonly GatewayClient _client;
    private readonly AppSettings _settings;
    private readonly LibVLC _libVlc;
    private readonly List<VideoTile> _tiles = new();
    private readonly ObservableCollection<V1Camera> _visibleCameras = new();
    private readonly DispatcherTimer _poll = new() { Interval = TimeSpan.FromSeconds(2) };
    private readonly DispatcherTimer _cycle = new();
    private bool _cycling;
    private bool _ptzMoving;
    private Task _ptzTail = Task.CompletedTask;
    private string? _focusedPtzCameraId;

    private IReadOnlyList<V1Camera> _allCameras = Array.Empty<V1Camera>();
    private VideoTile? _selectedTile;
    private VideoTile? _focusedTile;
    private GridLength _pickerWidthBeforeFocus;
    private DateTime _lastPollAt = DateTime.UtcNow;
    private bool _disposed;
    private bool _suppressViewChange;
    private readonly List<ToggleButton> _segments = new();
    private readonly List<ToggleButton> _streamSegments = new();

    /*
      What the wall is showing, independent of how many cells it has

      The wall used to be exactly its cells: a camera existed on it only if a tile held it, so a
      group of eighty-five could only be shown by growing the grid until it fitted - and at
      twenty-five cells the remaining sixty were dropped with a note about it.

      These two lists are the arrangement, and the grid is a window onto them. Index i is the
      i-th slot; a slot is empty when its id is empty. Slots beyond the current page exist and are
      remembered, they simply have no tile and therefore no decoder behind them, which is what
      keeps ten pages costing what one page costs.
    */
    private readonly List<string> _assignments = new();
    private readonly List<string> _assignmentStreams = new();
    private int _page;
    private string _wallStream = "sub";
    private bool _renderingPage;
    private int _renderGeneration;
    private Point? _listDragOrigin;

    public VideoWallView(GatewayClient client, AppSettings settings, LibVLC libVlc)
    {
        InitializeComponent();
        _client = client;
        _settings = settings;
        _libVlc = libVlc;

        // Grouped through a view rather than by building headers by hand: the ListBox's own
        // GroupStyle then draws the collapsible headers, and the grouping follows the list when
        // it is filtered.
        var view = new CollectionViewSource { Source = _visibleCameras };
        view.GroupDescriptions.Add(new PropertyGroupDescription(nameof(V1Camera.GroupLabel)));
        CameraList.ItemsSource = view.View;
        WallStage.SizeChanged += (_, _) => UpdateWallAspect();
        BuildLayoutSegments();
        _wallStream = _settings.WallStreamMode == "main" ? "main" : "sub";
        BuildStreamSegments();

        PrevPageButton.Click += async (_, _) => await GoToPageAsync(_page - 1).ConfigureAwait(false);
        NextPageButton.Click += async (_, _) => await GoToPageAsync(_page + 1).ConfigureAwait(false);
        foreach (var seconds in new[] { 5, 10, 15, 30, 60 }) CycleSecondsBox.Items.Add(seconds);
        CycleSecondsBox.SelectedItem = new[] { 5, 10, 15, 30, 60 }.Contains(_settings.WallCycleSeconds)
            ? _settings.WallCycleSeconds : 15;
        CycleSecondsBox.SelectionChanged += (_, _) =>
        {
            _settings.WallCycleSeconds = (int)CycleSecondsBox.SelectedItem;
            _settings.Save();
            _cycle.Interval = TimeSpan.FromSeconds(_settings.WallCycleSeconds);
        };
        _cycle.Interval = TimeSpan.FromSeconds(_settings.WallCycleSeconds);
        _cycle.Tick += async (_, _) =>
        {
            if (!_cycling || _focusedTile is not null || !IsVisible || _renderingPage || PageCount <= 1) return;
            await GoToPageAsync((_page + 1) % PageCount, manual: false).ConfigureAwait(true);
        };
        CycleButton.Click += (_, _) => SetCycling(!_cycling);

        StatusBox.Items.Add(Strings.T("wall.filterAll"));
        foreach (var key in StatusKeys) StatusBox.Items.Add(Strings.T($"status.{key}"));
        StatusBox.SelectedIndex = 0;
        StatusBox.SelectionChanged += (_, _) => ApplyFilter();
        FavoritesOnlyBox.Checked += (_, _) => ApplyFilter();
        FavoritesOnlyBox.Unchecked += (_, _) => ApplyFilter();

        // Dragging out of the picker. PreviewMouseMove rather than MouseMove: the ListBox handles
        // the move itself for its own selection behaviour, so a handler on the bubbling event is
        // reached only sometimes, which made dragging work about half the time.
        CameraList.PreviewMouseLeftButtonDown += (_, e) => _listDragOrigin = e.GetPosition(CameraList);
        CameraList.PreviewMouseMove += OnCameraListDrag;
        SearchBox.TextChanged += (_, _) =>
        {
            // WPF has no placeholder, so the hint is a label over the field that goes as soon as
            // there is anything to read underneath it.
            SearchHint.Visibility = SearchBox.Text.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
            ApplyFilter();
            // ค้นหาแล้วเปิดกลุ่มที่ตรงให้เห็นผลทันที; ล้างคำค้นแล้วกลับไปหุบทุกกลุ่ม
            Dispatcher.BeginInvoke(DispatcherPriority.Loaded,
                new Action(() => SetGroupExpansion(CameraList, SearchBox.Text.Trim().Length > 0)));
        };

        ViewNameBox.TextChanged += (_, _) =>
            ViewNameHint.Visibility = ViewNameBox.Text.Length == 0 ? Visibility.Visible : Visibility.Collapsed;

        GroupBox.SelectionChanged += (_, _) => ApplyFilter();
        /*
          A single click on a camera puts it in the selected cell, then moves the selection to the
          next empty cell - click a cell, click cameras down the list, and the wall fills in order.
          It used to take a double-click, and the selection only stepped to the next index, so
          people clicking once saw nothing happen and assumed the wall always used the first cell.
          Up, not down: the button-down may still become a drag (OnCameraListDrag clears the
          origin when it does), and a drag must not also assign.
        */
        CameraList.PreviewMouseLeftButtonUp += async (_, e) =>
        {
            if (FindAncestor<Button>(e.OriginalSource as DependencyObject) is not null) return;
            if (_listDragOrigin is null) return;
            _listDragOrigin = null;
            var camera = CameraUnderPointer(e.GetPosition(CameraList));
            if (camera is null) return;
            CameraList.SelectedItem = camera;
            await AssignSelectedAsync().ConfigureAwait(true);
        };

        RefreshButton.Click += async (_, _) => await ReloadCamerasAsync().ConfigureAwait(false);
        ClearAllButton.Click += (_, _) => ClearAll();
        FocusBackButton.Click += (_, _) => ExitFocusedCamera();

        SaveViewButton.Click += (_, _) => SaveView();
        DeleteViewButton.Click += (_, _) => DeleteView();
        ViewBox.SelectionChanged += async (_, _) => await LoadSelectedViewAsync().ConfigureAwait(false);

        _poll.Tick += OnPoll;
        WireFocusPtz();

        // Text this page builds in code - the group filter, the scope line, the hint and every
        // row's stream summary - is not bound, so it has to be rebuilt when the language changes.
        // Without this, switching language left half the picker in the language before it.
        Strings.Current.LanguageChanged += OnLanguageChanged;
    }

    /// <summary>Rebuilds the text this page builds in code (see the comment where it is attached).</summary>
    private void OnLanguageChanged(object? sender, EventArgs e)
    {
        CycleButton.Content = Strings.T(_cycling ? "wall.cycleStop" : "wall.cycleStart");
        var selectedStatus = StatusBox.SelectedIndex;
        StatusBox.Items.Clear();
        StatusBox.Items.Add(Strings.T("wall.filterAll"));
        foreach (var key in StatusKeys) StatusBox.Items.Add(Strings.T($"status.{key}"));
        StatusBox.SelectedIndex = selectedStatus;
        RefreshGroups();
        ApplyFilter();
        ScopeText.Text = Strings.T("wall.scopeSimple", _allCameras.Count);
        UpdateCameraSummary();
        if (_focusedTile?.Camera is { } focused) FocusCameraStateText.Text = focused.AvailabilityText;
        HintText.Text = Strings.T("wall.hint");
    }

    /// <summary>
    /// Raised whenever the camera list is (re)loaded.
    ///
    /// The shell keeps the list, because every other page needs it and this page can be closed:
    /// with the wall as the only owner, closing its tab left Home reporting zero cameras and the
    /// map unable to say which camera a pin belonged to.
    /// </summary>
    public event EventHandler<IReadOnlyList<V1Camera>>? CamerasLoaded;

    /// <summary>
    /// The camera highlighted in the picker, if any.
    ///
    /// The shell reads it when the map opens, so switching to the map lands on the camera the
    /// operator was already looking at rather than on the whole fleet's bounding box.
    /// </summary>
    public V1Camera? SelectedCamera => CameraList.SelectedItem as V1Camera;

    public async Task InitialiseAsync()
    {
        RefreshViewList(null);
        ApplyLayout(_settings.WallCells);
        await ReloadCamerasAsync().ConfigureAwait(true);

        /*
          The wall opens empty, on purpose.

          It used to restore the last arrangement, and on a machine that had never had one it
          filled the cells with the first cameras in the list. Both meant that opening the page
          started pulling video nobody had asked for - nine connections to nine cameras because
          someone clicked a tab. What an operator wants on the wall changes with the shift; what
          they had open last week is not a useful guess, and the guess costs bandwidth and decode
          on every open.

          A wall worth keeping gets a name: saved views still restore in full, and they are the
          one place an arrangement survives.
        */
        UpdatePageBar();
        _poll.Start();
    }

    private static readonly string[] StatusKeys = { "online", "offline", "edgeUnavailable", "missing", "awaitingStream", "disabled", "unknown" };

    /// <summary>เริ่มหรือหยุดวนหน้า โดยหยุดทันทีเมื่อผู้ใช้เปลี่ยนหน้าเอง</summary>
    private void SetCycling(bool enabled)
    {
        _cycling = enabled && PageCount > 1;
        if (_cycling) _cycle.Start(); else _cycle.Stop();
        CycleButton.Content = Strings.T(_cycling ? "wall.cycleStop" : "wall.cycleStart");
    }

    public async Task ReloadCamerasAsync()
    {
        try
        {
            _allCameras = await _client.GetCamerasAsync().ConfigureAwait(true);

            // Seed the status dots from what the list already carries, so a client that has just
            // started shows the truth immediately instead of waiting for a camera to change state
            // - the event stream reports transitions only, and a healthy fleet has none.
            foreach (var cam in _allCameras)
            {
                cam.Online = cam.InitialOnline;
            }

            // The list is exactly what the key is scoped to - there is no second scope to
            // reconcile it against, so the count needs no qualifier beyond naming the key.
            ScopeText.Text = Strings.T("wall.scopeSimple", _allCameras.Count);
            RefreshGroups();
            ApplyFilter();
            UpdateCameraSummary();
            CamerasLoaded?.Invoke(this, _allCameras);
        }
        catch (Exception ex)
        {
            ScopeText.Text = Strings.T("wall.loadFailed", ex.Message);
        }
    }

    /// <summary>
    /// Records a status change from the gateway's event stream.
    ///
    /// Only the main stream moves the dot. Sub streams go up and down for reasons that say
    /// nothing about whether the camera can be watched, and a dot that flickers on those is worse
    /// than no dot.
    /// </summary>
    public void ApplyStatus(V1Event evt)
    {
        if (string.IsNullOrEmpty(evt.CameraId))
        {
            return;
        }

        var camera = FindCamera(evt.CameraId!);
        if (camera is null)
        {
            return;
        }

        if (evt.Type == "camera_state") camera.ApplyState(evt.Enabled, evt.Reachable, evt.Streaming);
        else if (evt.Type == "camera_status" && evt.StreamType == "main" && camera.State is null)
            camera.Online = evt.IsOnline;
        UpdateCameraSummary();
        UpdateVisibleGroupSummaries(CameraList);
        if (_focusedTile?.Camera?.Id == camera.Id) FocusCameraStateText.Text = camera.AvailabilityText;
        if (StatusBox.SelectedIndex > 0) ApplyFilter();
    }

    /// <summary>สรุปจำนวนจากสถานะกล้องจริงที่ Central ส่งมา โดยแยกสถานะอื่นจากออฟไลน์</summary>
    private void UpdateCameraSummary()
    {
        var online = _allCameras.Count(c => c.Availability == "online");
        var offline = _allCameras.Count(c => c.IsOfflineForSummary);
        OnlineCountText.Text = Strings.T("wall.countOnline", online);
        OfflineCountText.Text = Strings.T("wall.countOffline", offline);
        OtherCountText.Text = Strings.T("wall.countOther", _allCameras.Count - online - offline);
    }

    /// <summary>
    /// The cameras this key may see, as loaded.
    ///
    /// Shared with the detail page rather than copied: the event stream mutates these instances,
    /// so a second fetch would give that page a list whose status dots stop moving.
    /// </summary>
    public IReadOnlyList<V1Camera> Cameras => _allCameras;

    /// <summary>How many cells the wall is showing, for the landing page's summary.</summary>
    public int CellCount => _tiles.Count;

    /// <summary>How many of those cells have a camera in them.</summary>
    public int FilledCells => _tiles.Count(t => t.Camera is not null);

    /// <summary>The saved view currently loaded, or null when the wall is not one of them.</summary>
    public string? CurrentViewName => (ViewBox.SelectedItem as WallView)?.Name;

    /// <summary>Looks up a camera the wall already loaded - used when the map reports a click.</summary>
    public V1Camera? FindCamera(string cameraId) =>
        _allCameras.FirstOrDefault(c => string.Equals(c.Id, cameraId, StringComparison.OrdinalIgnoreCase));

    private void ApplyFilter()
    {
        var term = SearchBox.Text.Trim();
        var group = GroupBox.SelectedIndex > 0 ? GroupBox.SelectedItem as string : null;
        var status = StatusBox.SelectedIndex > 0 ? StatusKeys[StatusBox.SelectedIndex - 1] : null;

        _visibleCameras.Clear();

        foreach (var cam in _allCameras)
        {
            if (group is not null && !string.Equals(cam.GroupLabel, group, StringComparison.Ordinal))
            {
                continue;
            }

            if (status == "offline" ? !cam.IsOfflineForSummary
                : status is not null && cam.Availability != status) continue;
            if (FavoritesOnlyBox.IsChecked == true && !_settings.FavoriteCameraIds.Contains(cam.Id, StringComparer.OrdinalIgnoreCase)) continue;

            if (term.Length > 0
                && cam.DisplayName.IndexOf(term, StringComparison.OrdinalIgnoreCase) < 0
                && cam.GroupLabel.IndexOf(term, StringComparison.OrdinalIgnoreCase) < 0
                && cam.Id.IndexOf(term, StringComparison.OrdinalIgnoreCase) < 0
                && (cam.GlobalId?.IndexOf(term, StringComparison.OrdinalIgnoreCase) ?? -1) < 0
                && (cam.Origin?.Node?.IndexOf(term, StringComparison.OrdinalIgnoreCase) ?? -1) < 0)
            {
                continue;
            }

            _visibleCameras.Add(cam);
        }

        Dispatcher.BeginInvoke(DispatcherPriority.Loaded,
            new Action(() => UpdateVisibleGroupSummaries(CameraList)));
    }

    /// <summary>กลุ่มที่สร้างใหม่เริ่มหุบ ยกเว้นขณะค้นหาที่ต้องเห็นรายการตรงคำค้นทันที</summary>
    private void OnCameraGroupLoaded(object sender, RoutedEventArgs e)
    {
        if (sender is not Expander group) return;
        UpdateGroupSummary(group);
        if (SearchBox.Text.Trim().Length > 0)
        {
            group.IsExpanded = true;
        }
    }

    /// <summary>แสดงจำนวนออนไลน์ต่อจำนวนทั้งหมดข้างชื่อกลุ่ม แม้รายการถูกกรองอยู่</summary>
    private void UpdateGroupSummary(Expander group)
    {
        if (group.DataContext is not CollectionViewGroup { Name: string name }
            || group.Header is not Grid header) return;

        var cameras = _allCameras.Where(camera => camera.GroupLabel == name).ToList();
        var online = cameras.Count(camera => camera.Availability == "online");
        foreach (var label in header.Children.OfType<TextBlock>())
        {
            if (Equals(label.Tag, "GroupRatio")) label.Text = $"{online}/{cameras.Count}";
        }
    }

    private void UpdateVisibleGroupSummaries(DependencyObject root)
    {
        for (var i = 0; i < VisualTreeHelper.GetChildrenCount(root); i++)
        {
            var child = VisualTreeHelper.GetChild(root, i);
            if (child is Expander { Tag: "CameraGroup" } group) UpdateGroupSummary(group);
            else UpdateVisibleGroupSummaries(child);
        }
    }

    /// <summary>ตั้งรูปดาวตามรายการโปรดที่บันทึกไว้ในเครื่องนี้</summary>
    private void OnFavoriteLoaded(object sender, RoutedEventArgs e)
    {
        if (sender is not Button { Tag: V1Camera camera } button) return;
        var favorite = _settings.FavoriteCameraIds.Contains(camera.Id, StringComparer.OrdinalIgnoreCase);
        button.Content = favorite ? "★" : "☆";
        button.ToolTip = Strings.T(favorite ? "wall.favoriteRemove" : "wall.favoriteAdd");
    }

    private void OnFavoriteClick(object sender, RoutedEventArgs e)
    {
        if (sender is not Button { Tag: V1Camera camera } button) return;
        if (_settings.FavoriteCameraIds.Contains(camera.Id, StringComparer.OrdinalIgnoreCase))
            _settings.FavoriteCameraIds.RemoveAll(id => string.Equals(id, camera.Id, StringComparison.OrdinalIgnoreCase));
        else _settings.FavoriteCameraIds.Add(camera.Id);
        _settings.Save();
        OnFavoriteLoaded(button, e);
        if (FavoritesOnlyBox.IsChecked == true) ApplyFilter();
        e.Handled = true;
    }

    private static T? FindAncestor<T>(DependencyObject? item) where T : DependencyObject
    {
        while (item is not null)
        {
            if (item is T match) return match;
            item = VisualTreeHelper.GetParent(item);
        }
        return null;
    }

    /// <summary>เปิดหรือหุบเฉพาะหัวกลุ่มกล้องที่แสดงอยู่ โดยไม่แตะตัวควบคุมในผังวิดีโอ</summary>
    private static void SetGroupExpansion(DependencyObject root, bool expanded)
    {
        for (var i = 0; i < VisualTreeHelper.GetChildrenCount(root); i++)
        {
            var child = VisualTreeHelper.GetChild(root, i);
            if (child is Expander { Tag: "CameraGroup" } group)
            {
                group.IsExpanded = expanded;
            }
            else
            {
                SetGroupExpansion(child, expanded);
            }
        }
    }

    /// <summary>
    /// Rebuilds the group filter from the groups the gateway actually reported.
    ///
    /// Not a fixed list: groups are Central's, they change there, and a hard-coded set here would
    /// quietly hide a new site's cameras behind a filter that does not mention it.
    /// </summary>
    private void RefreshGroups()
    {
        var chosen = GroupBox.SelectedIndex > 0 ? GroupBox.SelectedItem as string : null;

        var items = new List<string> { Strings.T("wall.allGroups") };
        items.AddRange(_allCameras
            .Select(c => c.GroupLabel)
            .Distinct(StringComparer.Ordinal)
            .OrderBy(g => g, StringComparer.CurrentCulture));

        GroupBox.ItemsSource = items;

        var index = chosen is null ? 0 : items.IndexOf(chosen);
        GroupBox.SelectedIndex = index >= 0 ? index : 0;
    }

    private void ApplyLayout(int cells)
    {
        var side = (int)Math.Ceiling(Math.Sqrt(cells));
        Wall.Rows = side;
        Wall.Columns = side;
        UpdateWallAspect();

        // Cells that fall outside a smaller layout must be torn down, not merely hidden: a
        // collapsed HwndHost is not reliably invisible, and its player would keep decoding.
        while (_tiles.Count > cells)
        {
            var tile = _tiles[^1];
            _tiles.RemoveAt(_tiles.Count - 1);
            Wall.Children.Remove(tile);
            if (ReferenceEquals(_selectedTile, tile))
            {
                _selectedTile = null;
            }

            tile.Dispose();
        }

        while (_tiles.Count < cells)
        {
            var tile = new VideoTile { Margin = new Thickness(5) };
            tile.Attach(_libVlc);
            tile.Selected += (s, _) => SelectTile((VideoTile)s!);
            tile.ClearRequested += (s, _) =>
            {
                SetCycling(false);
                var target = (VideoTile)s!;
                target.Clear();
                SetAssignment(IndexOfCell(target), string.Empty, _wallStream);
            };
            tile.AssignRequested += async (s, _) =>
            {
                SelectTile((VideoTile)s!);
                await AssignSelectedAsync().ConfigureAwait(true);
            };
            tile.StreamTypeRequested += async (s, streamType) =>
            {
                SetCycling(false);
                var target = (VideoTile)s!;
                if (target.Camera is null) return;
                await PlayAsync(target, target.Camera, streamType).ConfigureAwait(true);
                SetAssignment(IndexOfCell(target), target.Camera.Id, streamType);
            };

            tile.DragStarted += (s, _) =>
            {
                var source = (VideoTile)s!;
                if (source.Camera is null) return;

                // The payload is the slot, not the camera: dropping a cell onto another cell
                // swaps the two arrangements, and a payload of "a camera" could not say what to
                // put back where this one came from.
                DragDrop.DoDragDrop(source, new DataObject(CellDragFormat, IndexOfCell(source)), DragDropEffects.Move);
            };

            tile.CellDragOver += (s, e) =>
            {
                var over = (VideoTile)s!;
                // The effect must be one the source allowed: the picker offers Copy and a cell
                // offers Move. Answering Move to a camera from the picker made Windows refuse the
                // drop, which is why dropping from the list only worked some of the time.
                var fromList = e.Data.GetDataPresent(CameraDragFormat);
                var accepted = fromList || e.Data.GetDataPresent(CellDragFormat);
                e.Effects = !accepted ? DragDropEffects.None : fromList ? DragDropEffects.Copy : DragDropEffects.Move;
                over.SetDropTarget(accepted);
                e.Handled = true;
            };

            tile.CellDrop += async (s, e) => await OnCellDropAsync((VideoTile)s!, e).ConfigureAwait(true);
            tile.Activated += (s, _) =>
            {
                var activated = (VideoTile)s!;
                if (activated.Camera is not null)
                {
                    ToggleFocusedCamera(activated);
                }
            };
            _tiles.Add(tile);
            Wall.Children.Add(tile);
        }

        _selectedTile ??= _tiles.FirstOrDefault();
        UpdateSelectionMarker();

        SyncLayoutSegments(cells);
        _settings.WallCells = cells;
        _settings.Save();

        // A smaller grid does not mean fewer cameras any more - it means more pages. Clamping
        // here is what stops a wall that was on page 4 of 4 from landing past the end when the
        // cells per page double.
        _page = Math.Min(_page, PageCount - 1);
        UpdatePageBar();
    }


    /*
      The cell-count control

      Built in code rather than declared, because the option list is one array and a hand-written
      row of five buttons is a second copy of it that drifts. Checking one clears the rest: a
      segmented control has exactly one answer, and WPF has no built-in for that.
    */
    private void BuildLayoutSegments()
    {
        foreach (var option in LayoutOptions)
        {
            var button = new ToggleButton
            {
                Style = (Style)FindResource("SegmentButton"),
                Content = option.ToString(),
                Tag = option,
                IsChecked = option == _settings.WallCells,
            };

            button.Checked += async (s, _) =>
            {
                var cells = (int)((ToggleButton)s!).Tag;
                foreach (var other in _segments.Where(b => !ReferenceEquals(b, s)))
                {
                    other.IsChecked = false;
                }

                if (cells == _tiles.Count)
                {
                    return;
                }

                ApplyLayout(cells);
                SetCycling(false);

                // Same cameras, different number of cells - so the same arrangement, re-paged.
                await RenderPageAsync().ConfigureAwait(true);
            };

            // Clicking the already-selected segment must not leave the control with no answer.
            button.Unchecked += (s, _) =>
            {
                if (_segments.All(b => b.IsChecked != true)) ((ToggleButton)s!).IsChecked = true;
            };

            _segments.Add(button);
            LayoutSegments.Children.Add(button);
        }
    }

    /// <summary>Moves the segmented control to match the wall, without re-triggering a layout.</summary>
    private void SyncLayoutSegments(int cells)
    {
        foreach (var button in _segments)
        {
            button.IsChecked = (int)button.Tag == cells;
        }
    }

    /// <summary>Names the loaded view beside the layout control, or hides the chip when none is.</summary>
    private void ShowViewChip(string? name)
    {
        ViewChip.Visibility = name is null ? Visibility.Collapsed : Visibility.Visible;
        ViewChipText.Text = name ?? string.Empty;
    }

    private void SelectTile(VideoTile tile)
    {
        SetCycling(false);
        _selectedTile = tile;
        UpdateSelectionMarker();
    }

    /// <summary>จัดผังให้อยู่กึ่งกลางและให้แต่ละช่องใกล้สัดส่วน 16:9 โดยไม่ยืดภาพจากกล้อง</summary>
    private void UpdateWallAspect()
    {
        if (_focusedTile is not null)
        {
            WallPanel.Width = double.NaN;
            WallPanel.Height = double.NaN;
            WallPanel.HorizontalAlignment = HorizontalAlignment.Stretch;
            WallPanel.VerticalAlignment = VerticalAlignment.Stretch;
            Wall.Width = double.NaN;
            Wall.Height = double.NaN;
            Wall.HorizontalAlignment = HorizontalAlignment.Stretch;
            Wall.VerticalAlignment = VerticalAlignment.Stretch;
            return;
        }

        const double chrome = 16; // ขอบ 1 px และ padding 7 px ต่อด้าน
        var availableWidth = Math.Max(0, WallStage.ActualWidth - chrome);
        var availableHeight = Math.Max(0, WallStage.ActualHeight - chrome);
        if (availableWidth <= 0 || availableHeight <= 0 || Wall.Rows <= 0 || Wall.Columns <= 0) return;

        var ratio = (16d / 9d) * Wall.Columns / Wall.Rows;
        var width = Math.Min(availableWidth, availableHeight * ratio);
        var height = Math.Min(availableHeight, availableWidth / ratio);
        WallPanel.HorizontalAlignment = HorizontalAlignment.Center;
        WallPanel.VerticalAlignment = VerticalAlignment.Center;
        WallPanel.Width = width + chrome;
        WallPanel.Height = height + chrome;
        Wall.Width = width;
        Wall.Height = height;
        Wall.HorizontalAlignment = HorizontalAlignment.Center;
        Wall.VerticalAlignment = VerticalAlignment.Center;
    }

    /// <summary>ขยายช่องภาพในหน้า Wall เดิม โดยพักช่องอื่นไว้และเก็บผังเดิมสำหรับคืนกลับ</summary>
    private async void ToggleFocusedCamera(VideoTile tile)
    {
        if (_focusedTile is not null)
        {
            ExitFocusedCamera();
            return;
        }

        if (tile.Camera is null) return;
        SetCycling(false);
        _focusedTile = tile;
        FocusCameraNameText.Text = tile.Camera.DisplayName;
        FocusCameraStateText.Text = tile.Camera.AvailabilityText;
        _pickerWidthBeforeFocus = PickerColumn.Width;
        SelectTile(tile);
        foreach (var other in _tiles.Where(other => !ReferenceEquals(other, tile)))
        {
            Wall.Children.Remove(other);
        }
        Wall.Rows = 1;
        Wall.Columns = 1;
        UpdateWallAspect();
        PickerPanel.Visibility = Visibility.Collapsed;
        PickerSplitter.Visibility = Visibility.Collapsed;
        PickerColumn.MinWidth = 0;
        PickerColumn.Width = new GridLength(0);
        PickerDividerColumn.Width = new GridLength(0);
        FocusToolbar.Visibility = Visibility.Visible;
        PageBar.Visibility = Visibility.Collapsed;
        HintText.Visibility = Visibility.Collapsed;
        WallArea.Margin = new Thickness(0);
        WallPanel.Padding = new Thickness(0);
        await LoadFocusPtzAsync(tile.Camera.Id).ConfigureAwait(true);
    }

    /// <summary>คืนผังและตัวควบคุมเดิม; คืน true เมื่อมีภาพที่ขยายอยู่ให้ปิดด้วย Esc</summary>
    public bool ExitFocusedCamera()
    {
        if (_focusedTile is null) return false;
        if (_ptzMoving) StopFocusMove();
        _focusedPtzCameraId = null;
        FocusPtzPanel.Visibility = Visibility.Collapsed;
        FocusPtzColumn.Width = new GridLength(0);
        _focusedTile = null;
        for (var i = 0; i < _tiles.Count; i++)
        {
            if (!Wall.Children.Contains(_tiles[i])) Wall.Children.Insert(i, _tiles[i]);
        }
        var side = (int)Math.Ceiling(Math.Sqrt(_tiles.Count));
        Wall.Rows = side;
        Wall.Columns = side;
        UpdateWallAspect();
        PickerColumn.Width = _pickerWidthBeforeFocus;
        PickerColumn.MinWidth = 240;
        PickerDividerColumn.Width = new GridLength(6);
        PickerPanel.Visibility = Visibility.Visible;
        PickerSplitter.Visibility = Visibility.Visible;
        FocusToolbar.Visibility = Visibility.Collapsed;
        HintText.Visibility = Visibility.Visible;
        WallArea.Margin = new Thickness(12);
        WallPanel.Padding = new Thickness(7);
        UpdatePageBar();
        return true;
    }

    /// <summary>กดค้างเพื่อหมุนและปล่อยเพื่อหยุด แม้เมาส์หลุดออกจากปุ่ม</summary>
    private void WireFocusPtz()
    {
        foreach (var button in FocusPad.Children.OfType<Button>().Concat(FocusZoom.Children.OfType<Button>()))
        {
            if (button.Tag is not string) continue;
            button.PreviewMouseLeftButtonDown += (sender, e) =>
            {
                var pressed = (Button)sender;
                pressed.CaptureMouse();
                StartFocusMove((string)pressed.Tag);
                e.Handled = true;
            };
            button.PreviewMouseLeftButtonUp += (sender, e) =>
            {
                ((Button)sender).ReleaseMouseCapture();
                e.Handled = true;
            };
            button.LostMouseCapture += (_, _) => { if (_ptzMoving) StopFocusMove(); };
        }
        FocusHomeButton.Click += (_, _) => SendFocusPtz(new { action = "home" });
        FocusPresetGo.Click += (_, _) =>
        {
            if (FocusPresetBox.SelectedItem is V1PtzPreset preset)
                SendFocusPtz(new { action = "preset.goto", token = preset.Token });
        };
    }

    /// <summary>แสดง PTZ เมื่อกล้องรองรับและ API key มีสิทธิ์สั่งเท่านั้น</summary>
    private async Task LoadFocusPtzAsync(string cameraId)
    {
        _focusedPtzCameraId = cameraId;
        V1Ptz? ptz;
        try { ptz = await _client.GetPtzAsync(cameraId).ConfigureAwait(true); }
        catch { return; }
        if (_focusedTile?.Camera?.Id != cameraId || ptz is null || !ptz.Supported || !ptz.Allowed) return;
        FocusPad.Visibility = ptz.PanTilt ? Visibility.Visible : Visibility.Collapsed;
        FocusZoom.Visibility = ptz.Zoom ? Visibility.Visible : Visibility.Collapsed;
        FocusPresetSection.Visibility = ptz.PresetError is null && ptz.Presets.Count > 0
            ? Visibility.Visible : Visibility.Collapsed;
        FocusPresetBox.ItemsSource = ptz.Presets;
        FocusPresetBox.SelectedIndex = ptz.Presets.Count > 0 ? 0 : -1;
        FocusPtzColumn.Width = new GridLength(215);
        FocusPtzPanel.Visibility = Visibility.Visible;
    }

    private void StartFocusMove(string tag)
    {
        var parts = tag.Split(',');
        var speed = FocusSpeed.Value;
        double Axis(int i) => double.Parse(parts[i], System.Globalization.CultureInfo.InvariantCulture) * speed;
        _ptzMoving = true;
        SendFocusPtz(new { action = "move", pan = Axis(0), tilt = Axis(1), zoom = Axis(2) });
    }

    private void StopFocusMove()
    {
        _ptzMoving = false;
        SendFocusPtz(new { action = "stop" });
    }

    /// <summary>ส่งคำสั่งเรียงลำดับเพื่อให้ stop ไม่แซง move</summary>
    private void SendFocusPtz(object command)
    {
        var cameraId = _focusedPtzCameraId;
        if (cameraId is null) return;
        _ptzTail = _ptzTail.ContinueWith(async _ =>
        {
            try
            {
                var (ok, error, _) = await _client.SendPtzAsync(cameraId, command).ConfigureAwait(true);
                if (_focusedPtzCameraId == cameraId) FocusPtzStatus.Text = ok ? string.Empty : error ?? string.Empty;
            }
            catch (Exception ex)
            {
                if (_focusedPtzCameraId == cameraId) FocusPtzStatus.Text = ex.Message;
            }
        }, TaskScheduler.FromCurrentSynchronizationContext()).Unwrap();
    }

    private void UpdateSelectionMarker()
    {
        foreach (var tile in _tiles)
        {
            tile.SetSelected(ReferenceEquals(tile, _selectedTile));
        }
    }

    private async Task AssignSelectedAsync()
    {
        if (_selectedTile is null || CameraList.SelectedItem is not V1Camera camera)
        {
            return;
        }

        var filled = _selectedTile;
        await AssignAsync(filled, camera).ConfigureAwait(true);

        // Move to the next empty cell after this one (wrapping), so clicking down the list fills
        // the wall without overwriting what is already arranged. No empty cell = stay put.
        var index = _tiles.IndexOf(filled);
        for (var step = 1; index >= 0 && step < _tiles.Count; step++)
        {
            var candidate = _tiles[(index + step) % _tiles.Count];
            if (candidate.Camera is null)
            {
                SelectTile(candidate);
                break;
            }
        }
    }

    /// <summary>Puts a camera in a cell and records it in the arrangement behind the wall.</summary>
    private async Task AssignAsync(VideoTile tile, V1Camera camera)
    {
        SetCycling(false);
        var streamType = tile.Camera is null ? _wallStream : tile.StreamType;
        await PlayAsync(tile, camera, streamType).ConfigureAwait(true);
        SetAssignment(IndexOfCell(tile), camera.Id, streamType);
    }

    /// <summary>Which slot of the arrangement a cell is showing, given the page it is on.</summary>
    private int IndexOfCell(VideoTile tile)
    {
        var cell = _tiles.IndexOf(tile);
        return cell < 0 ? -1 : (_page * _tiles.Count) + cell;
    }

    /// <summary>Writes one slot, growing the arrangement to reach it.</summary>
    private void SetAssignment(int index, string cameraId, string streamType)
    {
        if (index < 0)
        {
            return;
        }

        while (_assignments.Count <= index)
        {
            _assignments.Add(string.Empty);
            _assignmentStreams.Add(_wallStream);
        }

        _assignments[index] = cameraId;
        _assignmentStreams[index] = streamType;
    }

    /// <summary>How far the arrangement reaches, with its trailing empty slots ignored.</summary>
    private int UsedSlots
    {
        get
        {
            for (var i = _assignments.Count - 1; i >= 0; i--)
            {
                if (!string.IsNullOrEmpty(_assignments[i]))
                {
                    return i + 1;
                }
            }

            return 0;
        }
    }

    private int PageCount =>
        _tiles.Count == 0 ? 1 : Math.Max(1, (int)Math.Ceiling(UsedSlots / (double)_tiles.Count));

    /// <summary>
    /// Shows the page controls only when there is more than one page.
    ///
    /// A wall that fits on one page should look exactly as it did before pages existed: an
    /// operator with nine cameras on nine cells has no page to turn and no reason to read "1/1".
    /// </summary>
    private void UpdatePageBar()
    {
        var pages = PageCount;
        PageBar.Visibility = pages > 1 ? Visibility.Visible : Visibility.Collapsed;
        PageText.Text = Strings.T("wall.page", _page + 1, pages);
        PrevPageButton.IsEnabled = _page > 0;
        NextPageButton.IsEnabled = _page < pages - 1;
        if (pages <= 1 && _cycling) SetCycling(false);
    }

    private async Task GoToPageAsync(int page, bool manual = true)
    {
        if (manual) SetCycling(false);
        if (_renderingPage) return;
        var target = Math.Clamp(page, 0, PageCount - 1);
        if (target == _page)
        {
            return;
        }

        _page = target;
        await RenderPageAsync().ConfigureAwait(true);
    }

    /// <summary>
    /// Fills the cells from the arrangement, for the page that is showing.
    ///
    /// Guarded against re-entry because every path that changes the wall ends here, and two
    /// renders interleaved would leave cells holding cameras from two different pages.
    /// </summary>
    private async Task RenderPageAsync()
    {
        // A newer render takes over: the older loop notices the changed generation and stops.
        // Skipping the new call instead left cells the old loop had already passed showing the
        // previous view's cameras.
        var generation = ++_renderGeneration;
        _renderingPage = true;
        try
        {
            for (var cell = 0; cell < _tiles.Count; cell++)
            {
                if (generation != _renderGeneration)
                {
                    return;
                }

                var index = (_page * _tiles.Count) + cell;
                var id = index < _assignments.Count ? _assignments[index] : string.Empty;
                var camera = string.IsNullOrEmpty(id) ? null : FindCamera(id);

                if (camera is null)
                {
                    // Either an empty slot, or a camera that has been deleted or moved out of
                    // this key's scope since the arrangement was saved. Empty is right for both.
                    _tiles[cell].Clear();
                    continue;
                }

                var streamType = index < _assignmentStreams.Count ? _assignmentStreams[index] : _wallStream;
                await PlayAsync(_tiles[cell], camera, streamType, () => generation != _renderGeneration)
                    .ConfigureAwait(true);
            }
        }
        finally
        {
            if (generation == _renderGeneration)
            {
                _renderingPage = false;
            }
        }

        if (generation == _renderGeneration)
        {
            UpdatePageBar();
        }
    }

    /*
      The wall-wide stream switch

      Built the same way as the layout segments and for the same reason: two fixed choices are
      quicker to hit than a dropdown, and which one is on stays readable without opening anything.
    */
    private void BuildStreamSegments()
    {
        foreach (var option in new[] { "main", "sub" })
        {
            var button = new ToggleButton
            {
                Style = (Style)FindResource("SegmentButton"),
                Content = Strings.T(option == "main" ? "wall.streamMain" : "wall.streamSub"),
                Tag = option,
                IsChecked = option == _wallStream,
            };

            button.Checked += async (sender, _) =>
            {
                var chosen = (string)((ToggleButton)sender!).Tag;
                foreach (var other in _streamSegments.Where(b => !ReferenceEquals(b, sender)))
                {
                    other.IsChecked = false;
                }

                await SetWallStreamAsync(chosen).ConfigureAwait(true);
            };

            button.Unchecked += (sender, _) =>
            {
                if (_streamSegments.All(b => b.IsChecked != true))
                {
                    ((ToggleButton)sender!).IsChecked = true;
                }
            };

            _streamSegments.Add(button);
            StreamSegments.Children.Add(button);
        }
    }

    /// <summary>
    /// Moves every camera on the wall - not just this page - onto one stream.
    ///
    /// Cameras with no substream keep playing main and say so on the cell, and the hint line
    /// counts them: on a wall of Digifort cameras that is every cell, and an operator who asked
    /// for sub deserves to know why nothing looks different.
    /// </summary>
    private async Task SetWallStreamAsync(string streamType)
    {
        SetCycling(false);
        _wallStream = streamType == "main" ? "main" : "sub";
        _settings.WallStreamMode = _wallStream;

        for (var i = 0; i < _assignmentStreams.Count; i++)
        {
            _assignmentStreams[i] = _wallStream;
        }

        await RenderPageAsync().ConfigureAwait(true);

        var fellBack = _tiles.Count(t => t.Camera is not null && t.StreamType != _wallStream);
        HintText.Text = fellBack > 0
            ? Strings.T("wall.streamSwitched", _wallStream) + " · " + Strings.T("wall.noSubFallback", fellBack)
            : Strings.T("wall.streamSwitched", _wallStream);
    }

    /// <summary>
    /// Starts a camera in a cell on the stream it can actually play.
    ///
    /// The stream is settled here rather than inside the URL provider because the cell labels
    /// itself from what it was told to play. Everything behind the Digifort relay has a main
    /// stream only, so a wall set to sub would otherwise show a chip reading "sub" over a main
    /// picture - or, before the gateway client learned to fall back, no picture at all.
    /// </summary>
    private async Task PlayAsync(
        VideoTile tile,
        V1Camera camera,
        string streamType = "sub",
        Func<bool>? isStale = null)
    {
        var requested = streamType;
        var effective = streamType;

        try
        {
            var set = await _client.GetStreamsAsync(camera.Id).ConfigureAwait(true);
            effective = GatewayClient.EffectiveStreamType(set, streamType);
        }
        catch (Exception)
        {
            // Asking failed - the tile's own providers ask again and surface the error there.
            // Playing the requested stream is the honest guess in the meantime.
        }

        // A newer render may have refilled this cell while the stream list was being fetched.
        if (isStale?.Invoke() == true)
        {
            return;
        }

        tile.Show(
            camera,
            effective,
            ct => ResolveUrlAsync(tile, camera, effective, preferPassthrough: true, ct),
            ct => ResolveUrlAsync(tile, camera, effective, preferPassthrough: false, ct),
            effective == requested ? null : Strings.T("wall.chipFellBack", effective));
    }

    /*
      Dragging a camera from the picker onto a cell

      Selecting a cell and double-clicking a camera still works and stays. This is for the other
      way people reach for it: point at the camera, drop it in the cell it belongs in.
    */
    private void OnCameraListDrag(object sender, MouseEventArgs e)
    {
        if (e.LeftButton != MouseButtonState.Pressed || _listDragOrigin is null)
        {
            return;
        }

        // The camera under the pointer, not the selected one: ListBox moves its selection on the
        // same button-down that starts this gesture, so on the first drag after opening the page
        // SelectedItem is still whatever was highlighted before - which would drag the wrong
        // camera into the cell without anything looking wrong.
        var camera = CameraUnderPointer(e.GetPosition(CameraList));
        if (camera is null)
        {
            return;
        }

        // The system threshold, not a number of our own: below it a click that wobbles by a pixel
        // would start a drag instead of selecting a row.
        var moved = e.GetPosition(CameraList) - _listDragOrigin.Value;
        if (Math.Abs(moved.X) < SystemParameters.MinimumHorizontalDragDistance
            && Math.Abs(moved.Y) < SystemParameters.MinimumVerticalDragDistance)
        {
            return;
        }

        _listDragOrigin = null;
        DragDrop.DoDragDrop(CameraList, new DataObject(CameraDragFormat, camera.Id), DragDropEffects.Copy);
    }

    /// <summary>Walks up from whatever was hit to the row it belongs to.</summary>
    private V1Camera? CameraUnderPointer(Point point)
    {
        var hit = CameraList.InputHitTest(point) as DependencyObject;
        while (hit is not null and not ListBoxItem)
        {
            hit = VisualTreeHelper.GetParent(hit);
        }

        return (hit as ListBoxItem)?.DataContext as V1Camera;
    }

    private async Task OnCellDropAsync(VideoTile target, DragEventArgs e)
    {
        SetCycling(false);
        e.Handled = true;

        if (e.Data.GetDataPresent(CameraDragFormat))
        {
            var camera = FindCamera((string)e.Data.GetData(CameraDragFormat)!);
            if (camera is null)
            {
                return;
            }

            SelectTile(target);
            await AssignAsync(target, camera).ConfigureAwait(true);
            HintText.Text = Strings.T("wall.dropped", camera.DisplayName);
            return;
        }

        if (!e.Data.GetDataPresent(CellDragFormat))
        {
            return;
        }

        var from = (int)e.Data.GetData(CellDragFormat)!;
        var to = IndexOfCell(target);
        if (from < 0 || to < 0 || from == to)
        {
            return;
        }

        // Swap, never insert: the wall is a set of positions someone arranged deliberately, and
        // shifting everything after the drop point rearranges cells nobody touched.
        SetAssignment(Math.Max(from, to), string.Empty, _wallStream);
        (_assignments[from], _assignments[to]) = (_assignments[to], _assignments[from]);
        (_assignmentStreams[from], _assignmentStreams[to]) = (_assignmentStreams[to], _assignmentStreams[from]);

        await RenderPageAsync().ConfigureAwait(true);
        HintText.Text = Strings.T("wall.swapped");
    }

    /// <summary>
    /// Asks the gateway for this camera's URLs, every time the tile needs one.
    ///
    /// This is where the client stops knowing anything about streaming. It does not build an
    /// address, does not know the path-naming rule, and does not know which port the streaming
    /// core listens on - it asks /api/v1 and plays what comes back. That is also what makes the
    /// tokens work: they are minted per request and expire in minutes.
    /// </summary>
    private async Task<string?> ResolveUrlAsync(
        VideoTile tile,
        V1Camera camera,
        string streamType,
        bool preferPassthrough,
        CancellationToken ct)
    {
        try
        {
            var set = await _client.GetStreamsAsync(camera.Id, ct).ConfigureAwait(true);
            return GatewayClient.PlayableUrl(set, streamType, preferPassthrough);
        }
        catch (GatewayAuthException ex)
        {
            tile.ShowError(camera, ex.Message);
            return null;
        }
    }

    /// <summary>Reads a per-slot stream type out of a saved array, defaulting to the wall's.</summary>
    private string StreamAt(string[] streams, int index) =>
        index < streams.Length && (streams[index] == "main" || streams[index] == "sub")
            ? streams[index]
            : _wallStream;

    /*
      Playing a whole group

      Filling a site one camera at a time is the most repeated thing an operator does here, and at
      nine cells it is nine round trips through the picker.

      It used to take the layout with it, growing the grid to the smallest size that held the
      group and dropping whatever still did not fit - which for the eighty-five cameras behind the
      Digifort relay meant twenty-five tiny cells and sixty cameras discarded. The layout is a
      decision about how much screen one camera gets, and the size of a group is no reason to
      overrule it, so the group goes on in pages at whatever layout is set.
    */
    private async void OnPlayGroup(object sender, RoutedEventArgs e)
    {
        SetCycling(false);
        if (sender is not FrameworkElement { Tag: string group })
        {
            return;
        }

        // Stop the click from also collapsing the expander it sits in.
        e.Handled = true;

        var cameras = _allCameras
            .Where(c => string.Equals(c.GroupLabel, group, StringComparison.Ordinal))
            .ToList();

        if (cameras.Count == 0)
        {
            return;
        }

        _assignments.Clear();
        _assignmentStreams.Clear();
        foreach (var camera in cameras)
        {
            _assignments.Add(camera.Id);
            _assignmentStreams.Add(_wallStream);
        }

        _page = 0;
        await RenderPageAsync().ConfigureAwait(true);

        // A wall built from a group is not one of the saved views, and saying it is would make the
        // chip lie the moment anything is changed.
        ShowViewChip(null);
        HintText.Text = PageCount > 1
            ? Strings.T("wall.groupPaged", group, cameras.Count, PageCount)
            : Strings.T("wall.groupPlayed", group, cameras.Count);
    }

    /// <summary>
    /// Empties the whole arrangement, not just the page on screen.
    ///
    /// Confirmed, because it discards a wall someone arranged - and now that a wall can be ten
    /// pages deep, most of what it discards is not even visible at the moment it is asked for.
    /// </summary>
    private void ClearAll()
    {
        SetCycling(false);
        if (UsedSlots == 0)
        {
            return;
        }

        if (!ConfirmDialog.Ask(Window.GetWindow(this), Strings.T("wall.clearAll"), Strings.T("wall.clearAllConfirm"), Strings.T("wall.clearAll"), danger: true))
        {
            return;
        }

        _assignments.Clear();
        _assignmentStreams.Clear();
        _page = 0;

        foreach (var tile in _tiles)
        {
            tile.Clear();
        }

        UpdatePageBar();
    }


    /*
      Saved views

      A view is a named arrangement: how many cells, which camera in each, and on which stream.
      They are saved on this machine, not at Central, because a view is about one screen in one
      room - the guard desk and the lobby display share a key and want different walls, and a
      server-side list would make one of them wrong.

      Loading a view is not "the wall now looks like this until I change it": the current wall is
      still saved as the working layout, so switching to a view and back leaves nothing lost.
    */

    /// <summary>Rebuilds the view picker. Selection is set without firing a load.</summary>
    private void RefreshViewList(string? selectId)
    {
        _suppressViewChange = true;
        ViewBox.ItemsSource = null;
        ViewBox.ItemsSource = _settings.WallViews;
        ViewBox.DisplayMemberPath = nameof(WallView.Name);
        ViewBox.SelectedItem = _settings.WallViews.FirstOrDefault(v => v.Id == selectId);
        _suppressViewChange = false;
    }

    private void SaveView()
    {
        var name = ViewNameBox.Text.Trim();
        if (name.Length == 0)
        {
            HintText.Text = Strings.T("wall.viewNeedsName");
            return;
        }

        // Same name replaces, rather than making a second entry nobody can tell apart.
        var existing = _settings.WallViews
            .FirstOrDefault(v => string.Equals(v.Name, name, StringComparison.OrdinalIgnoreCase));

        var view = existing ?? new WallView();
        view.Name = name;
        view.Cells = _tiles.Count;
        // The whole arrangement, every page of it - a view that saved only the visible page would
        // silently shrink a ten-page wall to nine cameras the first time it was reopened.
        view.Cameras = _assignments.ToArray();
        view.Streams = _assignmentStreams.ToArray();

        if (existing is null)
        {
            _settings.WallViews.Add(view);
        }

        _settings.Save();
        RefreshViewList(view.Id);
        ShowViewChip(view.Name);
        HintText.Text = Strings.T("wall.viewSaved", name);
    }

    private void DeleteView()
    {
        if (ViewBox.SelectedItem is not WallView view)
        {
            return;
        }

        if (!ConfirmDialog.Ask(Window.GetWindow(this), Strings.T("wall.deleteView"), Strings.T("wall.deleteViewConfirm", view.Name), Strings.T("wall.deleteView"), danger: true))
        {
            return;
        }

        _settings.WallViews.Remove(view);
        _settings.Save();
        RefreshViewList(null);
        ShowViewChip(null);
        HintText.Text = Strings.T("wall.viewDeleted");
    }

    private async Task LoadSelectedViewAsync()
    {
        if (_suppressViewChange || ViewBox.SelectedItem is not WallView view)
        {
            return;
        }
        SetCycling(false);

        ViewNameBox.Text = view.Name;

        // The cell count comes first: ApplyLayout builds or tears down tiles, and rendering into
        // a tile that is about to be removed wastes a connection to the camera.
        ApplyLayout(view.Cells);

        _assignments.Clear();
        _assignmentStreams.Clear();
        _assignments.AddRange(view.Cameras);
        for (var i = 0; i < view.Cameras.Length; i++)
        {
            _assignmentStreams.Add(StreamAt(view.Streams, i));
        }

        _page = 0;
        await RenderPageAsync().ConfigureAwait(true);
        ShowViewChip(view.Name);
        HintText.Text = Strings.T("wall.viewOpened", view.Name);
    }

    private void OnPoll(object? sender, EventArgs e)
    {
        var now = DateTime.UtcNow;
        var elapsed = (now - _lastPollAt).TotalSeconds;
        _lastPollAt = now;

        foreach (var tile in _tiles)
        {
            tile.Poll(elapsed);
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        Strings.Current.LanguageChanged -= OnLanguageChanged;
        if (_ptzMoving) StopFocusMove();
        _poll.Stop();
        _cycle.Stop();
        foreach (var tile in _tiles)
        {
            tile.Dispose();
        }

        _tiles.Clear();
    }
}
