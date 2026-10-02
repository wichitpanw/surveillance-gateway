using System;
using System.Linq;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using SurveillanceGateway.Client.Models;
using SurveillanceGateway.Client.Services;

namespace SurveillanceGateway.Client.Views;

/// <summary>
/// First-run and reconnect screen: an address and an API key, nothing else.
///
/// Two things are checked, in order, so a failure names the thing that actually failed rather
/// than blaming the last field on the form: the address must answer like a gateway, and the key
/// must be accepted by it.
///
/// Saved keys are listed rather than silently replaced. This file is normally the only copy of a
/// key on the machine, and the expensive mistake here is losing one - the gateway can show it
/// again, but only if someone realises that is where to look.
/// </summary>
public partial class ConnectView : UserControl
{
    private readonly GatewayClient _client;
    private readonly AppSettings _settings;

    private bool _loadingProfile;

    public ConnectView(GatewayClient client, AppSettings settings)
    {
        InitializeComponent();
        _client = client;
        _settings = settings;

        RefreshProfiles();

        ProfileBox.SelectionChanged += (_, _) => LoadSelectedProfile();
        ConnectButton.Click += async (_, _) => await ConnectAsync().ConfigureAwait(false);
        ForgetButton.Click += (_, _) => ForgetSelected();

        Loaded += (_, _) =>
        {
            if (ApiKeyBox.Password.Length == 0)
            {
                ApiKeyBox.Focus();
            }
        };
    }

    /// <summary>Raised once the gateway has accepted the key. Carries what it said about it.</summary>
    public event EventHandler<V1Health>? Connected;

    private void RefreshProfiles()
    {
        _loadingProfile = true;

        var hasProfiles = _settings.Profiles.Count > 0;
        ProfilesLabel.Visibility = hasProfiles ? Visibility.Visible : Visibility.Collapsed;
        ProfileBox.Visibility = hasProfiles ? Visibility.Visible : Visibility.Collapsed;
        ForgetButton.Visibility = hasProfiles ? Visibility.Visible : Visibility.Collapsed;

        ProfileBox.ItemsSource = _settings.Profiles
            .Select(p => string.IsNullOrWhiteSpace(p.ClientName)
                ? p.ServerUrl
                : $"{p.ClientName} — {p.ServerUrl}")
            .ToList();

        var active = _settings.Active;
        if (active is not null)
        {
            ProfileBox.SelectedIndex = _settings.Profiles.IndexOf(active);
        }

        _loadingProfile = false;
        LoadSelectedProfile();
    }

    private void LoadSelectedProfile()
    {
        if (_loadingProfile)
        {
            return;
        }

        var index = ProfileBox.SelectedIndex;
        var profile = index >= 0 && index < _settings.Profiles.Count
            ? _settings.Profiles[index]
            : _settings.Active;

        ServerBox.Text = profile?.ServerUrl ?? AppSettings.NormaliseServerUrl("203.0.113.80");

        var key = _settings.GetApiKey(profile);
        ApiKeyBox.Password = key;
        KeyHintText.Text = key.Length > 0
            ? Strings.T("connect.keyHint", AppSettings.KeyHint(key))
            : string.Empty;
    }

    private void ForgetSelected()
    {
        var index = ProfileBox.SelectedIndex;
        if (index < 0 || index >= _settings.Profiles.Count)
        {
            return;
        }

        var profile = _settings.Profiles[index];
        // Confirm by name, because this is the one action in the app that can lose a key. The
        // gateway can still show it again, and the message says so rather than leaving the
        // operator to guess whether it is gone for good.
        if (!ConfirmDialog.Ask(
            Window.GetWindow(this),
            Strings.T("connect.forgetTitle"),
            Strings.T("connect.forgetConfirm", profile.ServerUrl, AppSettings.KeyHint(_settings.GetApiKey(profile))),
            Strings.T("connect.forget"),
            danger: true))
        {
            return;
        }

        _settings.Profiles.RemoveAt(index);
        if (_settings.ActiveProfileId == profile.Id)
        {
            _settings.ActiveProfileId = _settings.Profiles.FirstOrDefault()?.Id;
        }

        _settings.Save();
        RefreshProfiles();
    }

    private async Task ConnectAsync()
    {
        var serverUrl = AppSettings.NormaliseServerUrl(ServerBox.Text);
        if (string.IsNullOrEmpty(serverUrl))
        {
            StatusText.Text = Strings.T("connect.needServer");
            return;
        }

        var apiKey = ApiKeyBox.Password.Trim();
        if (apiKey.Length == 0)
        {
            StatusText.Text = Strings.T("connect.needKey");
            return;
        }

        ConnectButton.IsEnabled = false;
        StatusText.Text = string.Empty;

        try
        {
            ServerBox.Text = serverUrl;
            _client.Configure(serverUrl, apiKey, _settings.InstanceId, Environment.MachineName);

            var health = await _client.CheckAsync().ConfigureAwait(true);

            // Saved only after the gateway accepts it, so a mistyped key never displaces a
            // working one already on this machine.
            var profile = _settings.UpsertProfile(serverUrl, apiKey, health.Client);
            profile.ClientName = health.Client;
            _settings.Save();

            KeyHintText.Text = Strings.T("connect.keyOf", health.Client ?? "-", health.StreamCore ?? "-");
            Connected?.Invoke(this, health);
        }
        catch (GatewayAuthException ex)
        {
            StatusText.Text = ex.Message;
        }
        catch (Exception ex)
        {
            StatusText.Text = Strings.T("connect.unreachable", serverUrl, ex.Message);
        }
        finally
        {
            ConnectButton.IsEnabled = true;
        }
    }
}
