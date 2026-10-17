using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Interop;
using System.Windows.Shell;
using System.Windows.Threading;
using LibVLCSharp.Shared;
using SurveillanceGateway.Client.Models;
using SurveillanceGateway.Client.Services;
using SurveillanceGateway.Client.Views;

namespace SurveillanceGateway.Client;

/// <summary>
/// The shell: title bar, tab strip, icon rail, one content host, status bar.
///
/// Pages are tabs. A page's view is built once and kept alive whether or not its tab is selected,
/// so a wall someone arranged is still arranged after a trip to the map; closing a tab is what
/// tears the view down, and that is also what stops its decoders.
///
/// The layout partitions the window into regions that never overlap. That is not a style choice:
/// VideoView and WebView2 are both HWND-based and do not take part in WPF composition, so anything
/// WPF draws over them is simply not visible. Keeping them in their own grid cell avoids the
/// problem instead of fighting it.
/// </summary>
public partial class MainWindow : Window
{
    private readonly AppSettings _settings;
    private readonly GatewayClient _client;
    private readonly LibVLC _libVlc;

    private readonly ObservableCollection<PageTabModel> _tabs = new();
    private readonly Dictionary<PageKind, UIElement> _pages = new();

    /// <summary>Open player windows, one per camera id. See <see cref="OpenPlayer"/>.</summary>
    private readonly Dictionary<string, PlayerWindow> _players = new();

    private GatewayEvents? _events;
    private ClientUpdater? _updater;
    private ConnectView? _connect;
    private HomeView? _home;
    private VideoWallView? _wall;
    private CameraDetailView? _detail;
    private MapView? _map;
    private EventsView? _eventsView;
    private PlaybackView? _playbackView;

    /// <summary>Edges central reports as down (node → name). Drives the red chip in the navbar.</summary>
    private readonly Dictionary<string, string> _downEdges = new();

    /// <summary>
    /// The cameras this key may see, held by the shell.
    ///
    /// The wall used to own this list, and every other page read it from there - so closing the
    /// wall's tab left Home reporting zero cameras, the details page with an empty picker and the
    /// map unable to resolve a clicked pin. The shell outlives every page, so it holds the list.
    /// </summary>
    private IReadOnlyList<V1Camera> _cameras = Array.Empty<V1Camera>();

    private bool _isFullScreen;
    private bool _exitConfirmed;
    private WindowState _restoreState = WindowState.Normal;
    private Rect _restoreBounds;
    private const int WmGetMinMaxInfo = 0x0024;
    private const uint MonitorDefaultToNearest = 2;
    private static readonly IntPtr HwndTopmost = new(-1);
    private const uint SwpShowWindow = 0x0040;

    public MainWindow(AppSettings settings, GatewayClient client, LibVLC libVlc)
    {
        InitializeComponent();
        SourceInitialized += (_, _) =>
        {
            if (PresentationSource.FromVisual(this) is HwndSource source)
                source.AddHook(OnWindowMessage);
        };
        _settings = settings;
        _client = client;
        _libVlc = libVlc;
        InitialiseWorkspace();

        TabItems.ItemsSource = _tabs;

        // Named handlers, not lambdas: SyncRail detaches them while it moves the mark, and a
        // lambda cannot be detached.
        HomeNav.Checked += OnHomeNav;
        WallNav.Checked += OnWallNav;
        MapNav.Checked += OnMapNav;
        EventsNav.Checked += OnEventsNav;
        PlaybackNav.Checked += OnPlaybackNav;
        DetailNav.Checked += OnDetailNav;

        CollapseButton.Click += (_, _) => ToggleSidebar();
        SettingsButton.Click += (_, _) => OpenSettings();
        SignOutButton.Click += (_, _) => Disconnect();
        FullScreenButton.Click += (_, _) => ToggleFullScreen();
        MinimizeButton.Click += (_, _) => WindowState = WindowState.Minimized;
        MaximizeButton.Click += (_, _) =>
        {
            if (_isFullScreen) ToggleFullScreen();
            else WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;
        };
        CloseButton.Click += (_, _) => Close();
        UpdateButton.Click += (_, _) =>
        {
            // ตัวอัปเดตปิดโปรแกรมเอง — ผู้ใช้กดอัปเดตแล้ว ไม่ต้องถามยืนยันการออกซ้ำ
            _exitConfirmed = true;
            try
            {
                _updater?.ApplyAndRestart();
            }
            catch (Exception ex)
            {
                // The package failed to apply (file locked, download gone). Stay open on the old
                // build rather than crash - and ask again before exiting, since nothing restarts us.
                _exitConfirmed = false;
                App.LogError("ApplyAndRestart", ex);
                StatusText.Text = Strings.T("shell.updateFailed", ex.Message);
            }
        };

        // ถามก่อนออกทุกทาง (ปุ่มปิด, Alt+F4, ปิดจาก taskbar) — บนจอ wall กดพลาดทีเดียวภาพดับทั้งจอ
        Closing += (_, e) =>
        {
            if (_exitConfirmed) return;
            if (!ConfirmDialog.Ask(this, Strings.T("shell.exitTitle"), Strings.T("shell.exitConfirm"), Strings.T("shell.exit"), danger: true))
            {
                e.Cancel = true;
                return;
            }
            _exitConfirmed = true;
        };
        // Windows กำลัง sign out หรือปิดเครื่อง — ห้ามค้าง dialog ขวางการปิดเครื่อง
        Application.Current.SessionEnding += (_, _) => _exitConfirmed = true;

        // Bound on the window rather than inside a view because the video HWND holds the
        // keyboard focus, so no view ever sees these keys.
        PreviewKeyDown += (_, e) =>
        {
            if (e.Key == Key.F11)
            {
                ToggleFullScreen();
                e.Handled = true;
                return;
            }

            // Esc คืนช่องภาพใน Wall ก่อน แล้วจึงออกจากโหมดเต็มจอของหน้าต่างหลัก
            if (e.Key != Key.Escape) return;

            if (Selected?.Kind == PageKind.Wall && _wall?.ExitFocusedCamera() == true)
            {
                e.Handled = true;
                return;
            }

            if (_isFullScreen)
            {
                ToggleFullScreen();
                e.Handled = true;
                return;
            }

            if (_tabs.Any(t => t.Kind == PageKind.Wall) && Selected?.Kind != PageKind.Wall)
            {
                Select(PageKind.Wall);
                e.Handled = true;
            }
        };

        // 720p is small enough for any screen this runs on, but a 1366x768 laptop with display
        // scaling has less usable space than that, and a window taller than the work area puts
        // its own title bar out of reach.
        Width = Math.Min(Width, SystemParameters.WorkArea.Width);
        Height = Math.Min(Height, SystemParameters.WorkArea.Height);

        Strings.Current.LanguageChanged += (_, _) => RefreshDynamicText();

        Loaded += (_, _) =>
        {
            ShowConnect();
            ToggleSidebar();
        };
        Closed += (_, _) => Teardown();
    }

    private PageTabModel? Selected => _tabs.FirstOrDefault(t => t.IsSelected);

    private void ShowConnect()
    {
        SetChromeVisible(false);

        _connect = new ConnectView(_client, _settings);
        _connect.Connected += async (_, health) =>
        {
            // async void: an exception escaping here would reach the dispatcher and end the app.
            try
            {
                await OnConnectedAsync(health).ConfigureAwait(true);
            }
            catch (Exception ex)
            {
                App.LogError("OnConnectedAsync", ex);
                StatusText.Text = Strings.T("app.unexpectedError", ex.Message);
            }
        };
        ContentHost.Content = _connect;
        StatusText.Text = Strings.T("shell.notConnected");
    }

    private async Task OnConnectedAsync(V1Health health)
    {
        SetChromeVisible(true);
        UserText.Text = Strings.T("shell.key", health.Client ?? "-");
        ServerText.Text = _client.BaseUrl.Replace("http://", string.Empty).Replace("https://", string.Empty);

        // The wall is built first even though Home is the page that opens: Home reports on the
        // wall's own state, and the detail page borrows the wall's camera list rather than
        // fetching a second one.
        _wall = BuildWall();
        _pages[PageKind.Wall] = _wall;

        _home = new HomeView();
        _home.Open += (_, kind) => Open(kind);
        // หน้าต่าง Diagnostics รายงานสตรีมของ wall; ถ้าปิดแท็บ wall ไปแล้วให้เปิดกลับก่อน
        _home.DiagnosticsRequested += (_, _) => { if (_wall is null) Open(PageKind.Wall); _wall?.ShowDiagnostics(); };
        _pages[PageKind.Home] = _home;

        ClearTabs();
        _tabs.Add(new PageTabModel(PageKind.Home, "shell.navHome", canClose: false));
        Select(PageKind.Home);

        await _wall.InitialiseAsync().ConfigureAwait(true);
        RefreshHome();

        StartEvents();
        StatusText.Text = Strings.T("shell.connected", _client.BaseUrl, health.StreamCore ?? "-");
        MonitorWallWindow.Restore(_client, _settings, _libVlc, this);
        CheckBuilds(health);

        // After the pages are up, never before: an update check is the least urgent thing this
        // app does, and it must not delay the first picture on screen.
        _ = CheckForUpdateAsync();
    }

    /// <summary>
    /// Warns on the home page when an edge runs a different build from Central.
    ///
    /// During an upgrade the two sides of /api/v1 can disagree - a camera field Central expects
    /// is missing, a status never arrives - and what the operator sees is a camera that behaves
    /// oddly, with nothing pointing at the cause. The Edge Nodes page on the web says the same;
    /// this is for the people who only ever open the client. An edge that has not reported a
    /// build yet is not a mismatch.
    /// </summary>
    private void CheckBuilds(V1Health health)
    {
        // Edges already down when the client connects: the stream only reports changes after this.
        _downEdges.Clear();
        foreach (var e in health.Edges ?? new List<V1EdgeInfo>())
        {
            if (e.Reachable == false) _downEdges[e.Node ?? e.Name ?? "?"] = e.Name ?? e.Node ?? "?";
        }
        RefreshEdgeChip();

        if (_home is null) return;
        var central = health.Build;
        var odd = string.IsNullOrEmpty(central) || health.Edges is null
            ? new List<V1EdgeInfo>()
            : health.Edges.Where(e => !string.IsNullOrEmpty(e.Build) && e.Build != central).ToList();
        _home.SetBuildWarning(odd.Count == 0
            ? null
            : string.Join(Environment.NewLine, odd.Select(e => Strings.T("home.buildMismatch", e.Name ?? e.Node ?? "?", e.Build!, central!))));
    }

    /// <summary>
    /// Red chip in the navbar while any edge is down (central's edge_state, docs/EDGE-PLAN.md).
    /// Edge 002 was down for two days without anyone looking at the web console noticing - the
    /// client is what operators actually have open, so the warning has to be here too.
    /// </summary>
    private void RefreshEdgeChip()
    {
        if (_downEdges.Count == 0)
        {
            EdgeDownChip.Visibility = Visibility.Collapsed;
            return;
        }
        EdgeDownText.Text = Strings.T("shell.edgeDown", _downEdges.Count);
        EdgeDownChip.ToolTip = Strings.T("shell.edgeDownTip",
            string.Join(Environment.NewLine, _downEdges.Select(kv => $"edge {kv.Key} · {kv.Value}")));
        EdgeDownChip.Visibility = Visibility.Visible;
    }

    /*
      Tabs

      Open() is the single entry point: the rail, the landing cards and a click on a tab all end
      up here. One tab per page kind - a second "Map" tab would be a second WebView2 process
      showing the same map.
    */

    private void Open(PageKind kind)
    {
        if (_tabs.All(t => t.Kind != kind))
        {
            _tabs.Add(new PageTabModel(kind, TitleKeyFor(kind), canClose: kind != PageKind.Home));
        }

        Select(kind);
    }

    private void Select(PageKind kind)
    {
        if (_home is null)
        {
            // Still on the connect screen. The rail is hidden there, so this can only be reached
            // by a stray key event.
            return;
        }

        if (_tabs.All(t => t.Kind != kind))
        {
            Open(kind);
            return;
        }

        foreach (var tab in _tabs)
        {
            tab.IsSelected = tab.Kind == kind;
        }

        SyncRail(kind);
        if (kind != PageKind.Playback) _playbackView?.StopPlayback();

        // Every page but Home shows the camera list in some form.
        if (kind != PageKind.Home)
        {
            _ = EnsureCamerasAsync();
        }

        // Pages are built when they are first shown and rebuilt if they were closed and asked for
        // again. Home is the exception: it exists from the moment there is a connection, because
        // it is what a closed tab falls back to.
        if (kind == PageKind.Wall && _wall is null)
        {
            _wall = BuildWall();
            _pages[PageKind.Wall] = _wall;
            _ = _wall.InitialiseAsync();
        }

        // The detail page is the one that has to be told something changed: it shows the camera
        // list as of the moment it is opened.
        if (kind == PageKind.Devices)
        {
            _detail ??= BuildDetail();
            _detail.SetCameras(_cameras);
            _pages[PageKind.Devices] = _detail;
        }

        if (kind == PageKind.Map && _map is null)
        {
            _map = BuildMap();
            _pages[PageKind.Map] = _map;
        }

        if (kind == PageKind.Events && _eventsView is null)
        {
            _eventsView = new EventsView(_client);
            _eventsView.InvestigationRequested += async (_, request) => await InvestigateEventAsync(request.Event, request.Playback);
            _pages[PageKind.Events] = _eventsView;
            _ = _eventsView.LoadAsync();
        }

        if (kind == PageKind.Playback)
        {
            _playbackView ??= new PlaybackView(_client, _libVlc);
            _playbackView.SetCameras(_cameras);
            _playbackView.LiveRequested -= OnWorkspaceLive;
            _playbackView.LiveRequested += OnWorkspaceLive;
            _pages[PageKind.Playback] = _playbackView;
        }

        if (kind == PageKind.Home)
        {
            RefreshHome();
        }

        var next = _pages.TryGetValue(kind, out var page) ? page : null;
        var changed = !ReferenceEquals(ContentHost.Content, next);
        ContentHost.Content = next;
        if (kind != PageKind.Wall) _wall?.ExitFocusedCamera();
        if (changed) PlayPageTransition(kind);
    }

    /*
      Page transition, the web consoles' fade-transform: slide in from the left while fading up.

      Only for pages drawn by WPF (Home, camera details). The wall's video and the map's WebView2
      are HWNDs: WPF can neither fade nor move them, so animating their host would slide the WPF
      frame around a picture that stays put. Those pages simply appear.
    */
    private void PlayPageTransition(PageKind kind)
    {
        PageShift.BeginAnimation(TranslateTransform.XProperty, null);
        ContentHost.BeginAnimation(OpacityProperty, null);
        PageShift.X = 0;
        ContentHost.Opacity = 1;
        if (kind is PageKind.Wall or PageKind.Map or PageKind.Playback) return;

        var ease = new System.Windows.Media.Animation.CubicEase { EasingMode = System.Windows.Media.Animation.EasingMode.EaseOut };
        var duration = TimeSpan.FromMilliseconds(380);
        PageShift.BeginAnimation(TranslateTransform.XProperty,
            new System.Windows.Media.Animation.DoubleAnimation(-24, 0, duration) { EasingFunction = ease });
        ContentHost.BeginAnimation(OpacityProperty,
            new System.Windows.Media.Animation.DoubleAnimation(0, 1, duration) { EasingFunction = ease });
    }

    private bool _sidebarCollapsed;

    /// <summary>
    /// Folds the sidebar to its icons (64px) and back (220px), as the web consoles do. The labels
    /// and section headings go away rather than being clipped mid-word.
    /// </summary>
    private void ToggleSidebar()
    {
        _sidebarCollapsed = !_sidebarCollapsed;
        var ease = new System.Windows.Media.Animation.CubicEase { EasingMode = System.Windows.Media.Animation.EasingMode.EaseOut };
        Sidebar.Width = _sidebarCollapsed ? 64 : 188;
        CollapseRotate.BeginAnimation(RotateTransform.AngleProperty, new System.Windows.Media.Animation.DoubleAnimation(
            _sidebarCollapsed ? 90 : 0, TimeSpan.FromMilliseconds(280)) { EasingFunction = ease });

        var labels = _sidebarCollapsed ? Visibility.Collapsed : Visibility.Visible;
        foreach (var element in new FrameworkElement[] { BrandText, HomeLabel, WallLabel, MapLabel, EventsLabel, PlaybackLabel, DetailLabel, SettingsRailLabel })
        {
            element.Visibility = labels;
        }

        // Headings become thin rules in the folded rail, like the web sidebar.
        foreach (var heading in new[] { SecOverview, SecMonitoring, SecDevices })
        {
            heading.Visibility = labels;
        }

        foreach (var nav in new[] { HomeNav, WallNav, MapNav, EventsNav, PlaybackNav, DetailNav })
        {
            nav.Padding = _sidebarCollapsed ? new Thickness(23, 0, 0, 0) : new Thickness(20, 0, 12, 0);
        }
        SettingsButton.Padding = _sidebarCollapsed ? new Thickness(15, 0, 0, 0) : new Thickness(12, 0, 12, 0);
    }

    /// <summary>The breadcrumb's section and page for a page kind - the same grouping as the sidebar.</summary>
    private void SyncBreadcrumb(PageKind kind)
    {
        var (section, page) = kind switch
        {
            PageKind.Wall => ("shell.secMonitoring", "shell.navWall"),
            PageKind.Map => ("shell.secMonitoring", "shell.navMap"),
            PageKind.Events => ("shell.secMonitoring", "shell.navEvents"),
            PageKind.Playback => ("shell.secMonitoring", "shell.navPlayback"),
            PageKind.Devices => ("shell.secDevices", "shell.navDetail"),
            _ => ("shell.secOverview", "shell.navHome"),
        };
        var sectionText = Strings.T(section);
        CrumbSection.Text = sectionText.Length > 1
            ? char.ToUpper(sectionText[0]) + sectionText.Substring(1).ToLowerInvariant()
            : sectionText;
        CrumbPage.Text = Strings.T(page);

        // The page name slides in with the page, so the eye follows the change.
        CrumbShift.BeginAnimation(TranslateTransform.XProperty,
            new System.Windows.Media.Animation.DoubleAnimation(-6, 0, TimeSpan.FromMilliseconds(220)));
    }

    private void OnTabClicked(object sender, RoutedEventArgs e)
    {
        if (sender is ToggleButton { Tag: PageTabModel tab })
        {
            // A tab cannot be un-selected by clicking it again - there would be no page left to
            // show - so the toggle is forced back on and treated as a plain selection.
            Select(tab.Kind);
        }
    }

    private void OnTabClose(object sender, RoutedEventArgs e)
    {
        if (sender is not FrameworkElement { Tag: PageTabModel tab } || !tab.CanClose)
        {
            return;
        }

        // Stop the click from also reaching the tab underneath and selecting what is being closed.
        e.Handled = true;

        var index = _tabs.IndexOf(tab);

        // Whether this was the page on screen is read from the content host, not from the tab's
        // own IsSelected: the close button sits inside the tab's ToggleButton, and clicking it
        // toggles that button off first. Trusting IsSelected here left the closed page still
        // displayed - a dead wall with a tab strip that no longer mentioned it.
        var wasShowing = _pages.TryGetValue(tab.Kind, out var page) && ReferenceEquals(ContentHost.Content, page);

        _tabs.Remove(tab);
        tab.Dispose();

        // Closing is what tears the page down: a kept-alive map holds a WebView2 process and a
        // kept-alive wall holds its cameras, and neither is wanted once the operator says close.
        // The page comes off screen before it is disposed, or the disposed visual stays up.
        if (wasShowing)
        {
            ContentHost.Content = null;
        }

        if (_pages.Remove(tab.Kind))
        {
            (page as IDisposable)?.Dispose();
        }

        switch (tab.Kind)
        {
            case PageKind.Wall: _wall = null; break;
            case PageKind.Map: _map = null; break;
            case PageKind.Devices: _detail = null; break;
            case PageKind.Events: _eventsView = null; break;
            case PageKind.Playback: _playbackView = null; break;
        }

        if (wasShowing || _tabs.All(t => !t.IsSelected))
        {
            var next = _tabs.ElementAtOrDefault(Math.Max(0, index - 1)) ?? _tabs.FirstOrDefault();
            if (next is not null) Select(next.Kind);
        }
    }

    private static string TitleKeyFor(PageKind kind) => kind switch
    {
        PageKind.Wall => "shell.navWall",
        PageKind.Map => "shell.navMap",
        PageKind.Events => "shell.navEvents",
        PageKind.Playback => "shell.navPlayback",
        PageKind.Devices => "shell.navDetail",
        _ => "shell.navHome",
    };

    /// <summary>Moves the rail's mark without re-entering <see cref="Select"/> through Checked.</summary>
    private void SyncRail(PageKind kind)
    {
        HomeNav.Checked -= OnHomeNav;
        WallNav.Checked -= OnWallNav;
        MapNav.Checked -= OnMapNav;
        EventsNav.Checked -= OnEventsNav;
        PlaybackNav.Checked -= OnPlaybackNav;
        DetailNav.Checked -= OnDetailNav;

        HomeNav.IsChecked = kind == PageKind.Home;
        WallNav.IsChecked = kind == PageKind.Wall;
        MapNav.IsChecked = kind == PageKind.Map;
        EventsNav.IsChecked = kind == PageKind.Events;
        PlaybackNav.IsChecked = kind == PageKind.Playback;
        DetailNav.IsChecked = kind == PageKind.Devices;

        HomeNav.Checked += OnHomeNav;
        WallNav.Checked += OnWallNav;
        MapNav.Checked += OnMapNav;
        EventsNav.Checked += OnEventsNav;
        PlaybackNav.Checked += OnPlaybackNav;
        DetailNav.Checked += OnDetailNav;

        SyncBreadcrumb(kind);
    }

    private void OnHomeNav(object sender, RoutedEventArgs e) => Open(PageKind.Home);

    private void OnWallNav(object sender, RoutedEventArgs e) => Open(PageKind.Wall);

    private void OnMapNav(object sender, RoutedEventArgs e) => Open(PageKind.Map);

    private void OnEventsNav(object sender, RoutedEventArgs e) => Open(PageKind.Events);

    private void OnPlaybackNav(object sender, RoutedEventArgs e) => Open(PageKind.Playback);

    private void OnDetailNav(object sender, RoutedEventArgs e) => Open(PageKind.Devices);

    private void RefreshHome()
    {
        if (_home is null)
        {
            return;
        }

        _home.SetCameras(
            _cameras,
            _wall?.CellCount ?? _settings.WallCells,
            _wall?.FilledCells ?? 0,
            _wall?.CurrentViewName);
    }

    /// <summary>
    /// Asks the connected gateway whether a newer client is published there.
    ///
    /// The download happens now, the install does not. Restarting is the operator's click,
    /// because this app is often the only thing on a wall display.
    /// </summary>
    private async Task CheckForUpdateAsync()
    {
        _updater = new ClientUpdater(_client.BaseUrl);

        if (!await _updater.CheckAsync().ConfigureAwait(true))
        {
            return;
        }

        UpdateButton.Content = Strings.T("shell.updateTo", _updater.PendingVersion);
        UpdateButton.Visibility = Visibility.Visible;
    }

    /// <summary>
    /// Subscribes to the gateway's camera status stream.
    ///
    /// One connection feeds every view. Each view opening its own would mean several long-lived
    /// connections per client, all carrying the same events, and the gateway counts connections
    /// per key.
    /// </summary>
    private void StartEvents()
    {
        _events = new GatewayEvents(_client, Dispatcher);

        _events.AiEventReceived += (_, evt) => _eventsView?.Add(evt);
        _events.EdgeStateChanged += (_, edge) =>
        {
            var key = edge.Node ?? edge.Name ?? "?";
            if (edge.Reachable) _downEdges.Remove(key);
            else _downEdges[key] = edge.Name ?? key;
            RefreshEdgeChip();
        };

        _events.CameraStatusChanged += (_, evt) =>
        {
            _wall?.ApplyStatus(evt);
            foreach (var camera in _cameras)
            {
                if (string.Equals(camera.Id, evt.CameraId, StringComparison.OrdinalIgnoreCase))
                {
                    if (evt.Type == "camera_state") camera.ApplyState(evt.Enabled, evt.Reachable, evt.Streaming);
                    else if (evt.Type == "camera_status" && evt.StreamType == "main" && camera.State is null)
                        camera.Online = evt.IsOnline;
                }
            }

            _detail?.ApplyStatus(evt);
            RefreshHome();
            if (evt.Type == "camera_status") _home?.AddEvent(evt);
            if (_map is not null)
            {
                _ = _map.ApplyStatusAsync(evt);
            }
        };

        // The dot in the title bar is the one place that says the status on screen is current.
        _events.ConnectionChanged += (_, connected) =>
        {
            FeedDot.Fill = (Application.Current.TryFindResource(connected ? "StatusOkBrush" : "StatusWarnBrush") as Brush)
                ?? Brushes.Gray;
            StatusText.Text = Strings.T(connected ? "shell.eventsUp" : "shell.eventsDown", _client.BaseUrl);
        };

        _events.Start();
    }

    private VideoWallView BuildWall()
    {
        var wall = new VideoWallView(_client, _settings, _libVlc);
        wall.PlaybackRequested += OnWorkspacePlayback;
        wall.CamerasLoaded += (_, cameras) =>
        {
            _cameras = cameras;
            _detail?.SetCameras(_cameras);
            _playbackView?.SetCameras(_cameras);
            RefreshHome();
        };
        return wall;
    }

    private MapView BuildMap()
    {
        var map = new MapView(_client, _settings);
        map.CameraActivated += (_, cameraId) =>
        {
            var camera = FindCamera(cameraId);
            if (camera is not null) OpenPlayer(camera);
        };
        return map;
    }

    private V1Camera? FindCamera(string cameraId) =>
        _cameras.FirstOrDefault(c => string.Equals(c.Id, cameraId, StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// Loads the camera list when no page has done it yet.
    ///
    /// Reached when the map or the details page is the first thing opened after the wall's tab was
    /// closed: those pages show what this list says, and an empty one is indistinguishable from a
    /// key that can see nothing.
    /// </summary>
    private async Task EnsureCamerasAsync()
    {
        if (_cameras.Count > 0)
        {
            return;
        }

        try
        {
            _cameras = await _client.GetCamerasAsync().ConfigureAwait(true);
            foreach (var cam in _cameras)
            {
                cam.Online = cam.InitialOnline;
            }

            _detail?.SetCameras(_cameras);
            _playbackView?.SetCameras(_cameras);
            RefreshHome();
        }
        catch (Exception)
        {
            // The page that asked will show its own empty state; the status bar already reports
            // the connection.
        }
    }

    private CameraDetailView BuildDetail()
    {
        var detail = new CameraDetailView(_client);
        detail.BackRequested += (_, _) => Open(PageKind.Wall);
        detail.PlayRequested += (_, camera) => OpenPlayer(camera);
        detail.MapRequested += (_, camera) =>
        {
            Open(PageKind.Map);
            if (_map is not null) _ = _map.FocusAsync(camera.Id);
        };
        return detail;
    }

    /// <summary>
    /// Opens a camera in its own window, or brings its window forward if it is already open.
    ///
    /// Reusing the window matters: each one holds a libvlc player and its own connection to the
    /// gateway, so double-clicking the same camera five times would open five decoders and five
    /// streams off one camera.
    /// </summary>
    private void OpenPlayer(V1Camera camera)
    {
        if (_players.TryGetValue(camera.Id, out var existing))
        {
            if (existing.WindowState == WindowState.Minimized) existing.WindowState = WindowState.Normal;
            existing.Activate();
            return;
        }

        var window = new PlayerWindow(_client, camera, _libVlc) { Owner = this };
        window.Closed += (_, _) => _players.Remove(camera.Id);
        _players[camera.Id] = window;
        window.Show();
    }

    private void SetChromeVisible(bool visible)
    {
        var state = visible ? Visibility.Visible : Visibility.Collapsed;
        Sidebar.Visibility = state;
        TabStrip.Visibility = state;
        Chrome.Visibility = state;
        CollapseButton.Visibility = state;
        foreach (var crumb in new UIElement[] { CrumbSep1, CrumbSection, CrumbSep2, CrumbPage })
        {
            crumb.Visibility = state;
        }

        // The update button has its own visibility rule - it appears only once an update has
        // actually been downloaded - so showing the chrome must not reveal it.
        if (!visible) UpdateButton.Visibility = Visibility.Collapsed;
    }

    /// <summary>
    /// Fills the screen, and comes back.
    ///
    /// F11 วางหน้าต่างปกติทับขอบจอจริง ส่วนปุ่มขยายใช้พื้นที่ทำงานที่ไม่ทับ taskbar
    /// </summary>
    private void ToggleFullScreen()
    {
        if (_isFullScreen)
        {
            _isFullScreen = false;
            Topmost = false;
            Titlebar.Visibility = Visibility.Visible;
            TitlebarRow.Height = new GridLength(34);
            if (WindowChrome.GetWindowChrome(this) is { } chrome)
            {
                chrome.CaptionHeight = 34;
                chrome.ResizeBorderThickness = new Thickness(6);
            }
            WindowState = WindowState.Normal;
            Left = _restoreBounds.Left;
            Top = _restoreBounds.Top;
            Width = _restoreBounds.Width;
            Height = _restoreBounds.Height;
            WindowState = _restoreState;
            FullScreenButton.ToolTip = Strings.T("shell.fullScreen");
            Activate();
            Focus();
            return;
        }

        _restoreState = WindowState == WindowState.Maximized ? WindowState.Maximized : WindowState.Normal;
        _restoreBounds = _restoreState == WindowState.Maximized
            ? RestoreBounds
            : new Rect(Left, Top, Width, Height);

        WindowState = WindowState.Normal;
        _isFullScreen = true;
        Topmost = true;
        Titlebar.Visibility = Visibility.Collapsed;
        TitlebarRow.Height = new GridLength(0);
        if (WindowChrome.GetWindowChrome(this) is { } fullscreenChrome)
        {
            fullscreenChrome.CaptionHeight = 0;
            fullscreenChrome.ResizeBorderThickness = new Thickness(0);
        }
        ApplyFullScreenBounds();
        // WPF อาจจัดขนาดหน้าต่างซ้ำหลังเปลี่ยน state; ยืนยันขอบจออีกครั้งเมื่อ layout เสร็จ
        Dispatcher.BeginInvoke(DispatcherPriority.Loaded, new Action(() =>
        {
            if (_isFullScreen) ApplyFullScreenBounds();
        }));
        FullScreenButton.ToolTip = Strings.T("shell.exitFullScreen");

        Activate();
        Focus();
    }

    /// <summary>วางหน้าต่างบนขอบจอจริงเป็นพิกเซล โดยไม่ให้กฎ maximize ตัดพื้นที่ taskbar</summary>
    private void ApplyFullScreenBounds()
    {
        var hwnd = new WindowInteropHelper(this).Handle;
        var monitor = MonitorFromWindow(hwnd, MonitorDefaultToNearest);
        var monitorInfo = new MonitorInfo { Size = Marshal.SizeOf<MonitorInfo>() };
        if (monitor == IntPtr.Zero || !GetMonitorInfo(monitor, ref monitorInfo))
            throw new Win32Exception(Marshal.GetLastWin32Error());

        var bounds = monitorInfo.Monitor;
        if (!SetWindowPos(hwnd, HwndTopmost, bounds.Left, bounds.Top,
                bounds.Right - bounds.Left, bounds.Bottom - bounds.Top, SwpShowWindow))
            throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    /// <summary>กำหนดขอบเขตปุ่มขยายตาม work area และขอบเขต F11 ตามจอจริง</summary>
    private IntPtr OnWindowMessage(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (msg != WmGetMinMaxInfo || lParam == IntPtr.Zero) return IntPtr.Zero;

        var monitor = MonitorFromWindow(hwnd, MonitorDefaultToNearest);
        if (monitor == IntPtr.Zero) return IntPtr.Zero;
        var monitorInfo = new MonitorInfo { Size = Marshal.SizeOf<MonitorInfo>() };
        if (!GetMonitorInfo(monitor, ref monitorInfo)) return IntPtr.Zero;

        var bounds = _isFullScreen ? monitorInfo.Monitor : monitorInfo.Work;
        var limits = Marshal.PtrToStructure<MinMaxInfo>(lParam);
        limits.MaxPosition = new NativePoint(
            bounds.Left - monitorInfo.Monitor.Left,
            bounds.Top - monitorInfo.Monitor.Top);
        limits.MaxSize = new NativePoint(bounds.Right - bounds.Left, bounds.Bottom - bounds.Top);
        Marshal.StructureToPtr(limits, lParam, false);
        handled = true;
        return IntPtr.Zero;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativePoint
    {
        public int X, Y;
        public NativePoint(int x, int y) { X = x; Y = y; }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeRect
    {
        public int Left, Top, Right, Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MonitorInfo
    {
        public int Size;
        public NativeRect Monitor;
        public NativeRect Work;
        public uint Flags;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MinMaxInfo
    {
        public NativePoint Reserved;
        public NativePoint MaxSize;
        public NativePoint MaxPosition;
        public NativePoint MinTrackSize;
        public NativePoint MaxTrackSize;
    }

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetWindowPos(IntPtr hwnd, IntPtr insertAfter, int x, int y,
        int width, int height, uint flags);

    /// <summary>Re-renders the few labels that are composed in code, after a language change.</summary>
    private void RefreshDynamicText()
    {
        FullScreenButton.ToolTip = Strings.T(_isFullScreen ? "shell.exitFullScreen" : "shell.fullScreen");
        if (Selected is { } shown) SyncBreadcrumb(shown.Kind);

        if (_updater?.PendingVersion is { } pending)
        {
            UpdateButton.Content = Strings.T("shell.updateTo", pending);
        }

        if (!_client.HasKey)
        {
            StatusText.Text = Strings.T("shell.notConnected");
        }

        RefreshHome();
    }

    private void OpenSettings()
    {
        // The updater is shared, not made again: it holds the release this session has already
        // downloaded, and a second instance would offer to download it a second time.
        _updater ??= new ClientUpdater(_client.BaseUrl);

        var dialog = new SettingsWindow(_settings, _client.BaseUrl, _client.ApiClientName, _updater) { Owner = this };
        dialog.UpdateFound += (_, version) =>
        {
            UpdateButton.Content = Strings.T("shell.updateTo", version);
            UpdateButton.Visibility = Visibility.Visible;
        };

        dialog.ShowDialog();
    }

    /// <summary>
    /// Returns to the connect screen. Saved keys are deliberately left alone - this is 'switch
    /// gateway', not 'forget my key'. Forgetting a key is its own explicit action there.
    /// </summary>
    private void Disconnect()
    {
        Teardown();
        ShowConnect();
    }

    private void Teardown()
    {
        MonitorWallWindow.CloseAll();
        foreach (var window in OwnedWindows.OfType<EventDetailWindow>().ToArray()) window.Close();
        ContentHost.Content = null;

        // Player windows outlive the page they were opened from, so signing out has to close
        // them - otherwise a wall of cameras keeps playing on a key nobody is connected with.
        foreach (var player in _players.Values.ToArray())
        {
            player.Close();
        }

        _players.Clear();

        _events?.Dispose();
        _events = null;

        foreach (var page in _pages.Values)
        {
            (page as IDisposable)?.Dispose();
        }

        _pages.Clear();
        ClearTabs();

        _home = null;
        _detail = null;
        _map = null;
        _wall = null;
        _eventsView = null;
        _playbackView = null;
    }

    /// <summary>
    /// Puts a one-line message in the status bar. Used by App for errors that were caught
    /// globally: a dialog would block a wall display that nobody is standing in front of.
    /// </summary>
    public void ShowNotice(string text) => StatusText.Text = text;

    /// <summary>Empties the tab strip, detaching each tab from the language switch first.</summary>
    private void ClearTabs()
    {
        foreach (var tab in _tabs)
        {
            tab.Dispose();
        }

        _tabs.Clear();
    }
}
