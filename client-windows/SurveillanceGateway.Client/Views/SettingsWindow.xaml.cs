using System;
using System.Reflection;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using SurveillanceGateway.Client.Services;

namespace SurveillanceGateway.Client.Views;

/// <summary>
/// The gear in the title bar: how this machine presents the client.
///
/// Changes apply as they are made and are saved immediately, so there is no OK/Cancel pair to
/// explain - and nothing here is destructive enough to need one. Language and theme both take
/// effect without a restart: the text is bound through <see cref="Strings"/> and the theme swaps
/// a resource dictionary.
/// </summary>
public partial class SettingsWindow : Window
{
    private readonly AppSettings _settings;
    private readonly ClientUpdater? _updater;
    private bool _loading = true;

    public SettingsWindow(AppSettings settings, string gatewayUrl, string? keyName, ClientUpdater? updater)
    {
        InitializeComponent();
        _settings = settings;
        _updater = updater;

        GatewayText.Text = keyName is null ? gatewayUrl : $"{gatewayUrl}\n{Strings.T("shell.key", keyName)}";

        VersionText.Text = "v" + (Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "1.0.0");

        // An update found at startup is already downloaded, so the button offers what it can do
        // rather than offering to look again.
        if (_updater?.PendingVersion is { } pending)
        {
            ShowReady(pending);
        }

        UpdateButton.Click += async (_, _) => await CheckAsync().ConfigureAwait(true);

        LanguageBox.SelectedIndex = settings.Language == "th" ? 1 : 0;
        DarkRadio.IsChecked = settings.Theme != "light";
        LightRadio.IsChecked = settings.Theme == "light";
        _loading = false;

        LanguageBox.SelectionChanged += (_, _) =>
        {
            if (_loading || LanguageBox.SelectedItem is not ComboBoxItem item) return;

            var language = item.Tag as string ?? "en";
            Strings.Current.SetLanguage(language);
            _settings.Language = language;
            _settings.Save();
        };

        DarkRadio.Checked += (_, _) => ApplyTheme("dark");
        LightRadio.Checked += (_, _) => ApplyTheme("light");
        CloseButton.Click += (_, _) => Close();
    }


    /// <summary>
    /// Asks the gateway for a newer release, and downloads one if it is there.
    ///
    /// The install still waits for a restart the operator asks for - but from here that is the
    /// only restart needed, where before it took one to notice a release and a second to apply it.
    /// </summary>
    private async Task CheckAsync()
    {
        if (_updater is null)
        {
            UpdateStatus.Text = Strings.T("settings.notInstalled");
            return;
        }

        if (_updater.PendingVersion is { } already)
        {
            _updater.ApplyAndRestart();
            // Reached only if the restart did not happen, which means the update could not be
            // applied - saying nothing here would look like a dead button.
            UpdateStatus.Text = Strings.T("settings.updateReady", already);
            return;
        }

        UpdateButton.IsEnabled = false;
        UpdateStatus.Text = Strings.T("settings.checking");

        var found = await _updater.CheckAsync().ConfigureAwait(true);

        UpdateButton.IsEnabled = true;

        if (found && _updater.PendingVersion is { } pending)
        {
            ShowReady(pending);
            UpdateFound?.Invoke(this, pending);
            return;
        }

        // "Nothing newer" and "this build can never update itself" are different facts, and an
        // operator told "up to date" on a build run from a folder would be misled.
        UpdateStatus.Text = _updater.IsUpdatable
            ? Strings.T("settings.upToDate")
            : Strings.T("settings.notInstalled");
    }

    private void ShowReady(string version)
    {
        UpdateStatus.Text = Strings.T("settings.updateReady", version);
        UpdateButton.Content = Strings.T("settings.restartNow");
    }

    /// <summary>Raised when a check downloads an update, so the shell can show its own button.</summary>
    public event EventHandler<string>? UpdateFound;

    private void ApplyTheme(string theme)
    {
        if (_loading || _settings.Theme == theme) return;

        _settings.Theme = theme;
        _settings.Save();
        App.ApplyTheme(theme);
    }
}
