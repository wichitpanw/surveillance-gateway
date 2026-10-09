using System;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using LibVLCSharp.Shared;
using SurveillanceGateway.Client.Models;
using SurveillanceGateway.Client.Services;

namespace SurveillanceGateway.Client.Video;

/// <summary>
/// One cell of the wall: a video surface, its overlay, and the camera currently assigned to it.
///
/// The tile owns its renderer but not its policy. What to play is decided by whoever hosts the
/// tile, and it arrives as a provider rather than a URL - the gateway mints a fresh, short-lived
/// URL per attempt, so there is nothing stable for the tile to hold on to.
/// </summary>
public partial class VideoTile : UserControl, IDisposable
{
    /// <summary>Polls at 2s each, so this is six seconds of a connected stream with no picture.</summary>
    private const int FramelessSamplesBeforeFallback = 3;

    private static readonly Brush OpaqueGround = new SolidColorBrush(Color.FromRgb(0, 0, 0));

    /*
      The ground while a picture is playing: one step off invisible, and that step is the point.

      The overlay is a layered window over the video HWND, and a layered window is click-through
      wherever its alpha is zero. Painted fully transparent, the cell stopped receiving input the
      moment it started playing - no hover controls, no right-click menu, not even selection -
      while an empty cell, whose ground stays opaque, worked perfectly. That is exactly the shape
      of the bug that was reported.

      Alpha 1 is invisible on screen and hit-testable to Windows.
    */
    private static readonly Brush GlassGround = new SolidColorBrush(Color.FromArgb(1, 0, 0, 0));

    private LibVlcVideoRenderer? _renderer;
    private Func<CancellationToken, Task<string?>>? _fallbackProvider;
    private bool _usingFallback;
    private int _framelessSamples;
    private bool _disposed;

    /// <summary>What this cell should be playing while it is on screen. See <see cref="SyncPlayback"/>.</summary>
    private (Func<CancellationToken, Task<string?>> Provider, string Owner)? _play;

    public VideoTile()
    {
        InitializeComponent();

        // The overlay's content is hosted in the VideoView's own window, so it inherits no
        // DataContext from the tile. Setting it here is what lets the markup bind to HasCamera.
        Overlay.DataContext = this;

        // On the overlay, not on the control. The VideoView hosts its content in its own
        // transparent window above the video HWND, so mouse events reach that window and never
        // bubble to the tile - which is why clicking a cell that was playing did nothing, and
        // why "clear cell" acted on whatever had been selected last.
        // Down for the double, up for the single. WPF reports a click count of 2 on the second
        // button-down and never on the button-up, so a double-click test on Up - which is what
        // this used to do - could not fire at all.
        Overlay.MouseLeftButtonDown += (_, e) =>
        {
            ShowMenu(false);
            _dragOrigin = e.GetPosition(Overlay);

            TakeKeyboardFocus();

            if (e.ClickCount == 2)
            {
                Activated?.Invoke(this, EventArgs.Empty);
            }
        };

        Overlay.MouseLeftButtonUp += (_, e) =>
        {
            _dragOrigin = null;
            if (e.ClickCount == 1)
            {
                Selected?.Invoke(this, EventArgs.Empty);
            }
        };

        // Right-click opens the cell's own menu, and selects the cell first so the menu always
        // acts on the one under the pointer.
        Overlay.MouseRightButtonUp += (_, e) =>
        {
            Selected?.Invoke(this, EventArgs.Empty);
            ShowMenu(true);
            e.Handled = true;
        };

        // Leaving the cell dismisses the menu; a click inside it is handled above.
        Overlay.MouseLeave += (_, _) => ShowMenu(false);

        /*
          Dragging cameras onto cells

          Both the source and the target live on the overlay, not on the tile: the overlay's
          content is hosted in the VideoView's own window above the video HWND, so a drop
          registered on the tile itself would never see a pointer that is over the picture.
        */
        Overlay.AllowDrop = true;

        Overlay.MouseMove += (_, e) =>
        {
            if (e.LeftButton != MouseButtonState.Pressed || Camera is null || _dragOrigin is null)
            {
                return;
            }

            // The system drag threshold, not a number of our own: below it a click that wobbles
            // by a pixel would start a drag instead of selecting the cell.
            var moved = e.GetPosition(Overlay) - _dragOrigin.Value;
            if (Math.Abs(moved.X) < SystemParameters.MinimumHorizontalDragDistance
                && Math.Abs(moved.Y) < SystemParameters.MinimumVerticalDragDistance)
            {
                return;
            }

            _dragOrigin = null;
            DragStarted?.Invoke(this, EventArgs.Empty);
        };

        Overlay.DragOver += (_, e) => CellDragOver?.Invoke(this, e);
        // DragLeave is raised as the pointer crosses into any child of the overlay (the caption,
        // the chips), not only when it leaves the cell. Hiding the marker on those made it blink;
        // hide it only when the pointer is really outside.
        Overlay.DragLeave += (_, e) =>
        {
            var p = e.GetPosition(Overlay);
            if (p.X <= 0 || p.Y <= 0 || p.X >= Overlay.ActualWidth || p.Y >= Overlay.ActualHeight)
            {
                SetDropTarget(false);
            }
        };
        Overlay.Drop += (_, e) =>
        {
            SetDropTarget(false);
            CellDrop?.Invoke(this, e);
        };

        StreamButton.Click += (_, _) => RequestStream(StreamType == "main" ? "sub" : "main");
        AudioButton.Click += (_, _) => SetMuted(!(_renderer?.Muted ?? true));
        ExpandButton.Click += (_, _) => Activated?.Invoke(this, EventArgs.Empty);
        ClearButton.Click += (_, _) => ClearRequested?.Invoke(this, EventArgs.Empty);

        MenuOpen.Click += (_, _) => { ShowMenu(false); Activated?.Invoke(this, EventArgs.Empty); };
        MenuAssign.Click += (_, _) => { ShowMenu(false); AssignRequested?.Invoke(this, EventArgs.Empty); };
        MenuClear.Click += (_, _) => { ShowMenu(false); ClearRequested?.Invoke(this, EventArgs.Empty); };
        MenuSub.Click += (_, _) => { ShowMenu(false); RequestStream("sub"); };
        MenuMain.Click += (_, _) => { ShowMenu(false); RequestStream("main"); };

        IsVisibleChanged += (_, _) => SyncPlayback();

    }

    [DllImport("user32.dll")]
    private static extern IntPtr SetFocus(IntPtr hWnd);

    /*
      Keyboard focus, taken back from the picture

      Clicking a cell hands Win32 focus to libvlc's own child window, and a window whose focus sits
      on a child HWND never sees a key in WPF again: Esc and F11 stopped working the moment anyone
      clicked a picture. Window.Focus() is not enough for that - it moves WPF's logical focus, not
      the Win32 one - so the handle is asked directly.
    */
    private void TakeKeyboardFocus()
    {
        var host = Window.GetWindow(this);
        if (host is null)
        {
            return;
        }

        var handle = new WindowInteropHelper(host).Handle;
        if (handle != IntPtr.Zero)
        {
            SetFocus(handle);
        }
    }

    /// <summary>
    /// Shows or hides the cell menu, enabling the items that need a camera.
    ///
    /// "Put the selected camera here" is the one that works on an empty cell - it is how an empty
    /// cell gets filled - so it stays enabled while the rest do not. The stream the cell is
    /// already on is disabled rather than ticked: an item that does nothing should not be
    /// clickable.
    /// </summary>
    private void ShowMenu(bool show)
    {
        CellMenu.Visibility = show && CellChrome ? Visibility.Visible : Visibility.Collapsed;

        if (!show)
        {
            return;
        }

        var hasCamera = Camera is not null;
        MenuOpen.IsEnabled = hasCamera;
        MenuClear.IsEnabled = hasCamera;
        MenuSub.IsEnabled = hasCamera && StreamType != "sub";
        MenuMain.IsEnabled = hasCamera && StreamType != "main";
    }

    /// <summary>
    /// Labels the stream button with the stream this cell is on.
    ///
    /// Whether the controls are shown is a trigger in the markup, on IsMouseOver and HasCamera.
    /// It used to be a pair of MouseEnter/MouseLeave handlers, and they went out of step every
    /// time a cell restarted its stream: the overlay is rebuilt under the pointer, no enter is
    /// raised, and the controls stayed hidden until the pointer left and came back.
    /// </summary>
    private void SyncCellControls()
    {
        HasCamera = Camera is not null;
        AudioButton.Visibility = Camera?.Audio == true ? Visibility.Visible : Visibility.Collapsed;
        StreamButton.Content = Strings.T(StreamType == "main" ? "wall.streamMain" : "wall.streamSub");
    }

    /// <summary>
    /// Asks the host to switch this cell's stream.
    ///
    /// The host does the switching - it holds the gateway client - and the result comes back
    /// through Show(), which is what moves StreamType and relabels the button. Relabelling here
    /// would claim a switch that has not happened yet.
    /// </summary>
    private void RequestStream(string streamType)
    {
        if (Camera is not null && StreamType != streamType)
        {
            StreamTypeRequested?.Invoke(this, streamType);
        }
    }

    /// <summary>Single click - the host uses this to move the selection marker.</summary>
    public event EventHandler? Selected;

    /// <summary>ดับเบิลคลิกหรือกดขยาย เพื่อให้ Wall สลับระหว่างภาพเดี่ยวกับผังเดิม</summary>
    public event EventHandler? Activated;

    /// <summary>"Clear this cell" from the cell's menu.</summary>
    public event EventHandler? ClearRequested;

    /// <summary>"Put the selected camera here" from the cell's menu.</summary>
    public event EventHandler? AssignRequested;

    /// <summary>"sub" or "main", from the cell's menu. Per cell, never per wall.</summary>
    public event EventHandler<string>? StreamTypeRequested;

    /// <summary>The pointer left this cell with its button down and a camera in it.</summary>
    public event EventHandler? DragStarted;

    /// <summary>Something is being dragged over this cell. The wall decides whether it fits.</summary>
    public event DragEventHandler? CellDragOver;

    /// <summary>Something was dropped on this cell.</summary>
    public event DragEventHandler? CellDrop;

    /// <summary>Where the left button went down, so a drag starts only after real movement.</summary>
    private Point? _dragOrigin;

    /// <summary>
    /// Whether this cell holds a camera, as a dependency property so the markup can bind to it.
    ///
    /// <see cref="Camera"/> is a plain property and cannot drive a trigger; this shadows it for
    /// the one thing the markup needs to know.
    /// </summary>
    public static readonly DependencyProperty HasCameraProperty = DependencyProperty.Register(
        nameof(HasCamera), typeof(bool), typeof(VideoTile), new PropertyMetadata(false));

    public bool HasCamera
    {
        get => (bool)GetValue(HasCameraProperty);
        private set => SetValue(HasCameraProperty, value);
    }

    public V1Camera? Camera { get; private set; }

    public string StreamType { get; private set; } = "sub";

    /// <summary>Replaces the stream name on the codec chip. Null means "use StreamType".</summary>
    private string? _streamNote;

    public VideoState State => _renderer?.State ?? VideoState.Idle;

    public void Attach(LibVLC libVlc)
    {
        if (_renderer is not null)
        {
            return;
        }

        _renderer = new LibVlcVideoRenderer(libVlc);
        _renderer.StateChanged += OnRendererStateChanged;
        Video.MediaPlayer = _renderer.Player;
    }

    /// <summary>
    /// Plays a camera, preferring <paramref name="urlProvider"/> and stepping down to
    /// <paramref name="fallbackProvider"/> if the preferred path turns out to carry no picture.
    ///
    /// The fallback is not decoration. A camera fleet is a fleet of firmware, and every brand
    /// gets RTSP subtly wrong in its own way - one NVR here answers a standards-compliant
    /// DESCRIBE with an SDP containing no video track at all, so the stream connects, reports
    /// itself as playing, and shows nothing. Rather than keep a table of which brands need which
    /// workaround, the tile checks what it actually got and steps down when frames do not arrive.
    /// See docs/CAMERA-QUIRKS.md.
    /// </summary>
    /// <param name="streamNote">
    /// What the codec chip should say about the stream instead of <paramref name="streamType"/>.
    /// The wall uses it when a camera has no substream and the cell quietly fell back to main -
    /// the cell is on main, and saying so beats a chip that reads "sub" over a main picture.
    /// </param>
    public void Show(
        V1Camera camera,
        string streamType,
        Func<CancellationToken, Task<string?>> urlProvider,
        Func<CancellationToken, Task<string?>>? fallbackProvider = null,
        string? streamNote = null)
    {
        if (_renderer is null)
        {
            return;
        }

        // A different camera starts muted again; switching sub/main on the same one keeps the choice.
        if (Camera?.Id != camera.Id) SetMuted(true);
        _renderer.AudioAvailable = camera.Audio;
        Camera = camera;
        StreamType = streamType;
        _fallbackProvider = fallbackProvider;
        SyncCellControls();
        _usingFallback = false;
        _framelessSamples = 0;
        NameText.Text = camera.DisplayName;
        SetMessage(null);
        _streamNote = streamNote;
        SetCodec(fallbackProvider is not null ? "codec.direct" : "codec.transcoded", streamType);

        _play = (urlProvider, $"{camera.Id}|{streamType}");
        SyncPlayback();
    }

    /*
      Decoding only while this cell is on screen

      libvlc draws into the window handle the VideoView gives it, and a VideoView that has never
      been shown, or has been taken out of the tree, has no handle. Told to play anyway, libvlc
      does what it does with no target: it opens a window of its own, titled "VLC (Direct3D11
      output)", floating over everything.

      That is not hypothetical. Pages became tabs, so the wall is built and restores its layout
      while Home is the page on screen - three restored cameras meant three VLC windows in the
      operator's face the moment they connected.

      So playback follows visibility: it starts when the cell is shown and stops when it is not.
      Nothing is lost by that, and a good deal is saved - a wall left on another tab was decoding
      nine streams and holding nine connections open for a picture nobody could see. What the cell
      holds on to is the camera and the provider, so the arrangement survives the trip and the
      picture comes back with the tab.
    */
    private void SyncPlayback()
    {
        if (_renderer is null)
        {
            return;
        }

        if (IsVisible && _play is var (provider, owner))
        {
            _renderer.Play(provider, owner);
        }
        else if (!IsVisible)
        {
            _renderer.Stop();
        }
    }

    /// <summary>
    /// Steps down to the fallback path. Playing under a new owner key resets the retry budget,
    /// which is what we want: the fallback deserves its own full set of attempts.
    /// </summary>
    private void UseFallback(string reason)
    {
        if (_renderer is null || Camera is null || _usingFallback || _fallbackProvider is null)
        {
            return;
        }

        _usingFallback = true;
        _framelessSamples = 0;

        // The name stays the name. What changed is the path, and that is what the codec chip is
        // for - appending "· transcoded" to a camera's name made the two read as one label.
        SetCodec("codec.transcoded", StreamType);
        _play = (_fallbackProvider, $"{Camera.Id}|{StreamType}|fallback");
        SyncPlayback();

        System.Diagnostics.Debug.WriteLine(
            $"[VideoTile] {Camera.Id}: {reason} - falling back to the transcoded path");
    }

    private const string SpeakerMuted = "M3 9 H7 L12 5 V19 L7 15 H3 Z M16 9 L21 15 M21 9 L16 15";
    private const string SpeakerOn = "M3 9 H7 L12 5 V19 L7 15 H3 Z M16 8.5 C17.5 10 17.5 14 16 15.5 M19 6 C22 9 22 15 19 18";

    /// <summary>
    /// Mutes or unmutes this cell only. Sound is per cell because a wall plays many cameras at
    /// once, and the operator picks the one to listen to - every cell starts muted.
    /// </summary>
    private void SetMuted(bool muted)
    {
        if (_renderer is not null) _renderer.Muted = muted;
        AudioIcon.Data = Geometry.Parse(muted ? SpeakerMuted : SpeakerOn);
        AudioButton.ToolTip = Strings.T(muted ? "cell.unmute" : "cell.mute");
    }

    /// <summary>Empties the cell. Used when a camera is removed and when the layout shrinks.</summary>
    public void Clear()
    {
        SetMuted(true);
        AudioButton.Visibility = Visibility.Collapsed;
        Camera = null;
        _streamNote = null;
        _fallbackProvider = null;
        _play = null;
        _usingFallback = false;
        _framelessSamples = 0;
        _renderer?.Stop();
        Overlay.Background = OpaqueGround;
        NameText.Text = Services.Strings.T("cell.empty");
        StatsText.Text = string.Empty;
        SetMessage(null);
        CodecChip.Visibility = Visibility.Collapsed;
        HasCamera = false;
        ShowMenu(false);
        StatusDot.Fill = (Brush)FindResource("FaintForegroundBrush");
    }

    /// <summary>Shows why a camera cannot be played - an access refusal, most often.</summary>
    public void ShowError(V1Camera camera, string message)
    {
        Camera = camera;
        _renderer?.Stop();
        Overlay.Background = OpaqueGround;
        NameText.Text = camera.DisplayName;
        SetMessage(message);
        StatsText.Text = string.Empty;
        CodecChip.Visibility = Visibility.Collapsed;
        StatusDot.Fill = (Brush)FindResource("StatusCritBrush");
    }


    /// <summary>
    /// Drops the tile's own frame, for a host that already provides one.
    ///
    /// The wall needs the rounded frame - it separates one cell from the next. A player window is
    /// nothing but this tile, so a rounded border inside a square window draws a frame around a
    /// frame and leaves a strip of chrome colour in each corner.
    /// </summary>
    public void SetFlush()
    {
        Frame.BorderThickness = new Thickness(0);
        Frame.CornerRadius = new CornerRadius(0);

        // A player window carries its own caption controls, so the cell's would be a second set
        // of the same things - and its clear button would empty a window whose only content is
        // that camera.
        CellChrome = false;
    }

    /// <summary>
    /// Whether this tile offers its own hover controls and menu. True on the wall, false in a
    /// player window, which has a caption of its own.
    /// </summary>
    public static readonly DependencyProperty CellChromeProperty = DependencyProperty.Register(
        nameof(CellChrome), typeof(bool), typeof(VideoTile), new PropertyMetadata(true));

    public bool CellChrome
    {
        get => (bool)GetValue(CellChromeProperty);
        private set => SetValue(CellChromeProperty, value);
    }

    /// <summary>
    /// Marks this cell as the selected one.
    ///
    /// The frame is a WPF Border around the HWND, not an overlay over it, so it is one of the few
    /// things that can be drawn on a cell without going through the overlay window - and unlike
    /// the old trick of shrinking the tile's margin, the picture does not move when selection
    /// changes.
    /// </summary>
    /// <summary>
    /// Marks this cell as the one a drop would land in.
    ///
    /// Drawn on the caption rather than the frame: the frame is behind the video HWND, so on a
    /// playing cell a border change is invisible exactly when it matters most.
    /// </summary>
    public void SetDropTarget(bool active)
    {
        DropMarker.Visibility = active ? Visibility.Visible : Visibility.Collapsed;
    }

    public void SetSelected(bool selected)
    {
        Frame.BorderBrush = (Brush)FindResource(selected ? "BrandYellowBrush" : "BorderBrush");
        Frame.BorderThickness = new Thickness(selected ? 2 : 1);
        SelectMarker.Visibility = selected ? Visibility.Visible : Visibility.Collapsed;
    }

    /// <summary>
    /// Shows or hides the message bar.
    ///
    /// Hidden when there is nothing to say, rather than left as an empty strip: a permanent bar
    /// across the bottom of every cell eats picture on a 25-cell wall.
    /// </summary>
    private void SetMessage(string? message)
    {
        MessageText.Text = message ?? string.Empty;
        MessageBar.Visibility = string.IsNullOrEmpty(message) ? Visibility.Collapsed : Visibility.Visible;
    }

    /// <summary>Says which path the picture is arriving on, and on which stream.</summary>
    private void SetCodec(string pathKey, string streamType)
    {
        CodecText.Text = $"{Services.Strings.T(pathKey)} · {_streamNote ?? streamType}";
        CodecChip.Visibility = Visibility.Visible;
    }

    public void Poll(double elapsedSeconds)
    {
        if (_renderer is null || Camera is null)
        {
            return;
        }

        _renderer.Poll(elapsedSeconds);

        if (_renderer.State != VideoState.Playing || _renderer.Player.State != VLCState.Playing)
        {
            _framelessSamples = 0;
            return;
        }

        var fps = _renderer.Fps.ToString("F0", CultureInfo.InvariantCulture);
        var stats = _renderer.LostPictures > 0
            ? $"{fps} fps  lost {_renderer.LostPictures}"
            : $"{fps} fps";

        // Assigning the same string still repaints the overlay window, which sits above the video
        // HWND - that repaint is what makes a tile flicker on every poll.
        if (!string.Equals(StatsText.Text, stats, StringComparison.Ordinal))
        {
            StatsText.Text = stats;
        }

        // Playing with no frames is the audio-only-SDP case: libvlc is decoding a PCM track and
        // there is no video track to show. No error is ever raised, so counting frameless samples
        // is the only way to notice.
        if (_renderer.Fps <= 0)
        {
            _framelessSamples++;
            if (_framelessSamples >= FramelessSamplesBeforeFallback)
            {
                UseFallback("connected but no video track");
            }
        }
        else
        {
            _framelessSamples = 0;
        }
    }

    private void OnRendererStateChanged(object? sender, VideoStateChangedEventArgs e)
    {
        // The other way the preferred path can fail: it never connects at all. One failed attempt
        // is enough to try the fallback - waiting out the whole retry budget first would leave the
        // cell dark for half a minute for no gain.
        if (e.State == VideoState.Retrying && !_usingFallback && _fallbackProvider is not null)
        {
            UseFallback(e.Message ?? "connect failed");
            return;
        }

        SetMessage(e.Message);
        StatusDot.Fill = e.State switch
        {
            VideoState.Playing => (Brush)FindResource("StatusOkBrush"),
            VideoState.Connecting => (Brush)FindResource("MutedForegroundBrush"),
            VideoState.Retrying => (Brush)FindResource("StatusWarnBrush"),
            VideoState.Failed => (Brush)FindResource("StatusCritBrush"),
            _ => (Brush)FindResource("FaintForegroundBrush"),
        };

        // Transparent only once there are frames to show. Any other state leaves the ground
        // opaque, so a stopped or failed cell reads as black rather than as Win32 grey.
        Overlay.Background = e.State == VideoState.Playing
            ? GlassGround
            : OpaqueGround;

        if (e.State != VideoState.Playing)
        {
            StatsText.Text = string.Empty;
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        Video.MediaPlayer = null;
        _renderer?.Dispose();
        _renderer = null;
    }
}
