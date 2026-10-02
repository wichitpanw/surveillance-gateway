using System;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Runtime.InteropServices;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;
using LibVLCSharp.Shared;
using SurveillanceGateway.Client.Models;
using SurveillanceGateway.Client.Services;
using SurveillanceGateway.Client.Video;

namespace SurveillanceGateway.Client.Views;

/// <summary>
/// One camera in a window of its own.
///
/// This is how a camera is watched full size now, from the wall and from the map alike. A window
/// per camera means several can be open at once and each can be dragged to its own monitor, which
/// a single embedded page cannot do - and on the map it is the only option at all, since nothing
/// can be drawn over a WebView2.
/// </summary>
public partial class PlayerWindow : Window
{
    private readonly GatewayClient _client;
    private readonly V1Camera _camera;
    private readonly DispatcherTimer _poll = new() { Interval = TimeSpan.FromSeconds(2) };

    private DateTime _lastPollAt = DateTime.UtcNow;
    private bool _isFullScreen;

    public PlayerWindow(GatewayClient client, V1Camera camera, LibVLC libVlc, string streamType = "sub")
    {
        InitializeComponent();

        _client = client;
        _camera = camera;
        Title = camera.DisplayName;

        TitleText.Text = camera.DisplayName;

        Tile.Attach(libVlc);
        // The window is the frame; the tile does not need its own.
        Tile.SetFlush();

        MinimiseButton.Click += (_, _) => WindowState = WindowState.Minimized;
        MaximiseButton.Click += (_, _) => ToggleMaximised();
        CloseButton.Click += (_, _) => Close();
        StateChanged += (_, _) => SyncMaximiseButton();

        MainButton.IsChecked = streamType == "main";
        SubButton.IsChecked = streamType != "main";

        // A segmented pair: checking one clears the other, and the checked one cannot be
        // un-checked, or the window would be playing a stream nothing is claiming.
        SubButton.Checked += (_, _) => { MainButton.IsChecked = false; Reload(); };
        MainButton.Checked += (_, _) => { SubButton.IsChecked = false; Reload(); };
        SubButton.Unchecked += (_, _) => { if (MainButton.IsChecked != true) SubButton.IsChecked = true; };
        MainButton.Unchecked += (_, _) => { if (SubButton.IsChecked != true) MainButton.IsChecked = true; };

        _poll.Tick += (_, _) =>
        {
            var now = DateTime.UtcNow;
            Tile.Poll((now - _lastPollAt).TotalSeconds);
            _lastPollAt = now;

            // The caption's dot repeats what the picture already shows, because the caption is
            // what stays visible when this window sits behind another.
            StateDot.Fill = (Brush)FindResource(Tile.State switch
            {
                VideoState.Playing => "StatusOkBrush",
                VideoState.Retrying => "StatusWarnBrush",
                VideoState.Failed => "StatusCritBrush",
                _ => "FaintForegroundBrush",
            });
        };

        PreviewKeyDown += OnKey;
        WirePtz();

        Loaded += (_, _) =>
        {
            RoundCorners();
            _poll.Start();
            Reload();
            _ = LoadPtzAsync();

            // Keys are handled on this window, so it has to hold the focus - the picture's own
            // child window would otherwise take it and swallow Esc and F11.
            Focus();
        };

        /*
            Hand focus to the shell before this window goes, not after.

            Closing an owned window leaves Windows to pick what to activate next, and with a video
            HWND involved it picks something behind this app - which read as the shell minimising
            itself. Activating the owner afterwards fixed that but showed the swap happening: the
            window behind flashed forward and the shell came back over it. Doing it in Closing
            means the shell is already the active window when this one disappears, so there is
            nothing to see.
        */
        Closing += (_, _) =>
        {
            _poll.Stop();

            // A camera left turning would keep going until its own timeout, in front of
            // everyone else watching it.
            if (_moving) StopMove();

            if (Owner is { } owner)
            {
                if (owner.WindowState == WindowState.Minimized) owner.WindowState = WindowState.Normal;
                owner.Activate();
            }
        };

        // The renderer holds a libvlc player and a pair of timers; letting the window close
        // without disposing it leaves both running for the life of the app, and this window is
        // opened and closed all day.
        //
        // Disposed after the window is gone rather than during the close: stopping libvlc takes
        // long enough to be seen as a stutter if it happens while the frame is still on screen.
        Closed += (_, _) => Dispatcher.BeginInvoke(DispatcherPriority.Background, new Action(Tile.Dispose));
    }

    private void OnKey(object? sender, KeyEventArgs e)
    {
        if (e.Key == Key.F11)
        {
            ToggleFullScreen();
            e.Handled = true;
            return;
        }

        if (e.Key != Key.Escape) return;

        // Esc leaves full screen first and closes only on a second press: closing a full-screen
        // window in one keystroke is how a person loses a camera they meant to keep watching.
        if (_isFullScreen)
        {
            ToggleFullScreen();
        }
        else
        {
            Close();
        }

        e.Handled = true;
    }

    private void ToggleMaximised() =>
        WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;

    /// <summary>Swaps the maximise mark for a restore mark, and the tooltip with it.</summary>
    private void SyncMaximiseButton()
    {
        var maximised = WindowState == WindowState.Maximized;

        // Two overlapping rectangles for restore, one for maximise - the shapes Windows itself
        // uses, because this is the one place in the app where inventing an icon would only make
        // a familiar control unfamiliar.
        MaximiseIcon.Data = Geometry.Parse(maximised
            ? "M7 7 H15 V15 H7 Z M5 12 V5 H12"
            : "M5 5 H15 V15 H5 Z");

        MaximiseButton.ToolTip = Strings.T(maximised ? "player.restore" : "player.maximise");

        // A maximised window sits under the taskbar unless its own border is dropped; WindowChrome
        // leaves that to the window it is on.
        Root.BorderThickness = new Thickness(maximised ? 0 : 1);
    }

    /*
        Rounded corners, where the OS has them.

        Windows 11 rounds a window on request through DWM. Doing it in WPF instead would mean
        AllowsTransparency, which drops the whole window to software rendering and would cost this
        window the hardware-decoded picture it exists for. Windows 10 and Server 2022 have no such
        attribute and return an error, which is why the result is ignored: square corners there are
        the OS's own look, not a defect.
    */
    private const int DwmWindowCornerPreference = 33;
    private const int DwmCornerRound = 2;

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    private void RoundCorners()
    {
        try
        {
            var handle = new WindowInteropHelper(this).Handle;
            if (handle == IntPtr.Zero) return;

            var preference = DwmCornerRound;
            DwmSetWindowAttribute(handle, DwmWindowCornerPreference, ref preference, sizeof(int));
        }
        catch (DllNotFoundException)
        {
            // No dwmapi.dll at all. Nothing to do and nothing worth telling anyone about.
        }
    }

    /// <summary>
    /// Fills the screen with the picture alone.
    ///
    /// The caption is collapsed rather than left in place: this window's own title bar is WPF
    /// content, so unlike a system one it would still be drawn across a full-screen picture.
    /// </summary>
    private void ToggleFullScreen()
    {
        _isFullScreen = !_isFullScreen;

        Caption.Visibility = _isFullScreen ? Visibility.Collapsed : Visibility.Visible;
        CaptionRow.Height = _isFullScreen ? new GridLength(0) : new GridLength(44);
        Root.BorderThickness = new Thickness(_isFullScreen ? 0 : 1);

        if (_isFullScreen)
        {
            // Dropped to Normal first: changing state while already maximised leaves the window
            // sized to the old frame, with a strip of desktop down one edge.
            WindowState = WindowState.Normal;
            WindowState = WindowState.Maximized;
        }
        else
        {
            WindowState = WindowState.Normal;
        }

        // Changing the window style rebuilds the frame and drops the keyboard focus, so the very
        // next Esc went to whatever picked it up instead of leaving full screen.
        Activate();
        Focus();
    }

    private void Reload()
    {
        var streamType = MainButton.IsChecked == true ? "main" : "sub";

        // Always ask for the untranscoded path first, with the transcoded one as the step down.
        // That is the whole reason this client exists, and the tile reports which one it got.
        Tile.Show(
            _camera,
            streamType,
            ct => ResolveUrlAsync(streamType, preferPassthrough: true, ct),
            ct => ResolveUrlAsync(streamType, preferPassthrough: false, ct));
    }

    // ------------------------------------------------------------------ PTZ

    private bool _moving;

    /// <summary>
    /// Tail of the command queue. Press and release send move and stop a few hundred
    /// milliseconds apart; sent in parallel, the stop can overtake the move on the wire and the
    /// camera then turns until its own timeout. Chaining them keeps the order the person pressed.
    /// </summary>
    private Task _ptzTail = Task.CompletedTask;

    private void WirePtz()
    {
        PtzButton.Checked += (_, _) => PtzPanel.Visibility = Visibility.Visible;
        PtzButton.Unchecked += (_, _) => PtzPanel.Visibility = Visibility.Collapsed;

        foreach (var button in HoldButtons())
        {
            button.PreviewMouseLeftButtonDown += (s, e) =>
            {
                var b = (Button)s;
                b.CaptureMouse();
                StartMove((string)b.Tag);
                e.Handled = true;
            };
            button.PreviewMouseLeftButtonUp += (s, e) =>
            {
                ((Button)s).ReleaseMouseCapture();
                e.Handled = true;
            };
            // Fires on release too, and also when the capture is taken away (another window
            // pops up, the mouse leaves the app) - the one place a stop is guaranteed to run.
            button.LostMouseCapture += (_, _) => { if (_moving) StopMove(); };
        }

        HomeButton.Click += (_, _) => Send(new { action = "home" });

        PresetGoButton.Click += (_, _) =>
        {
            if (PresetBox.SelectedItem is V1PtzPreset preset)
                Send(new { action = "preset.goto", token = preset.Token });
        };

        PresetRemoveButton.Click += (_, _) =>
        {
            if (PresetBox.SelectedItem is not V1PtzPreset preset) return;
            if (!ConfirmDialog.Ask(this, _camera.DisplayName, Strings.T("ptz.removeConfirm", preset.Label), danger: true)) return;
            Send(new { action = "preset.remove", token = preset.Token }, reload: true);
        };

        PresetSaveButton.Click += (_, _) =>
        {
            var name = PresetNameBox.Text.Trim();
            if (name.Length == 0) return;
            Send(new { action = "preset.set", name }, reload: true, done: Strings.T("ptz.saved"));
            PresetNameBox.Clear();
        };
    }

    /// <summary>The buttons that move while held, identified by their "pan,tilt,zoom" tag.</summary>
    private System.Collections.Generic.IEnumerable<Button> HoldButtons()
    {
        foreach (var child in PadGrid.Children)
            if (child is Button { Tag: string } b) yield return b;
        foreach (var child in ZoomRow.Children)
            if (child is Button { Tag: string } b) yield return b;
    }

    /// <summary>
    /// Asks the gateway whether this camera turns, and shows the controls only if it does and
    /// this key may turn it. Any failure leaves the window as it was - a player without PTZ.
    /// </summary>
    private async Task LoadPtzAsync()
    {
        V1Ptz? ptz;
        try
        {
            ptz = await _client.GetPtzAsync(_camera.Id).ConfigureAwait(true);
        }
        catch (Exception)
        {
            return;
        }

        if (ptz is null || !ptz.Supported || !ptz.Allowed) return;

        PadGrid.Visibility = ptz.PanTilt ? Visibility.Visible : Visibility.Collapsed;
        ZoomRow.Visibility = ptz.Zoom ? Visibility.Visible : Visibility.Collapsed;

        // A camera that cannot list presets cannot store them either.
        PresetSection.Visibility = ptz.PresetError is null ? Visibility.Visible : Visibility.Collapsed;
        var selected = (PresetBox.SelectedItem as V1PtzPreset)?.Token;
        PresetBox.ItemsSource = ptz.Presets;
        PresetBox.SelectedItem = ptz.Presets.Find(p => p.Token == selected) ?? (ptz.Presets.Count > 0 ? ptz.Presets[0] : null);
        PresetGoButton.IsEnabled = PresetRemoveButton.IsEnabled = ptz.Presets.Count > 0;
        if (ptz.PresetError is null && ptz.Presets.Count == 0) PtzStatus.Text = Strings.T("ptz.noPresets");

        PtzButton.Visibility = Visibility.Visible;
    }

    private void StartMove(string tag)
    {
        var parts = tag.Split(',');
        var speed = SpeedSlider.Value;
        double Axis(int i) => double.Parse(parts[i], System.Globalization.CultureInfo.InvariantCulture) * speed;

        _moving = true;
        Send(new { action = "move", pan = Axis(0), tilt = Axis(1), zoom = Axis(2) });
    }

    private void StopMove()
    {
        _moving = false;
        Send(new { action = "stop" });
    }

    /// <summary>Queues one command. Errors land in the panel's status line, not in a dialog.</summary>
    private void Send(object command, bool reload = false, string? done = null)
    {
        _ptzTail = _ptzTail.ContinueWith(async _ =>
        {
            string? message;
            try
            {
                var (ok, error, _) = await _client.SendPtzAsync(_camera.Id, command).ConfigureAwait(true);
                message = ok ? done ?? string.Empty : error;
            }
            catch (Exception ex)
            {
                message = ex.Message;
            }

            PtzStatus.Text = message ?? string.Empty;
            if (reload) await LoadPtzAsync().ConfigureAwait(true);
        }, TaskScheduler.FromCurrentSynchronizationContext()).Unwrap();
    }

    private async Task<string?> ResolveUrlAsync(string streamType, bool preferPassthrough, CancellationToken ct)
    {
        try
        {
            var set = await _client.GetStreamsAsync(_camera.Id, ct).ConfigureAwait(true);
            return GatewayClient.PlayableUrl(set, streamType, preferPassthrough);
        }
        catch (GatewayAuthException ex)
        {
            Tile.ShowError(_camera, ex.Message);
            return null;
        }
    }
}
