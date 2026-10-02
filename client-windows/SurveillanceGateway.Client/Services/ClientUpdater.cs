using System;
using System.Threading.Tasks;
using Velopack;
using Velopack.Sources;

namespace SurveillanceGateway.Client.Services;

/// <summary>
/// Updates the client from the gateway it is connected to.
///
/// The update feed is served by the gateway itself at `/client-updates`, not by a public release
/// host. These machines sit on an operations network with no route to the internet, and the
/// gateway is the one address every client already has, already trusts and is already talking to.
/// Publishing updates is therefore a file copy into `client-updates/` on the server.
///
/// Nothing is installed while the app runs. Velopack stages the new version beside the current
/// one and swaps it in on the next launch, so a wall display never loses its picture because an
/// update arrived mid-shift - the operator restarts when it suits them.
///
/// A build running from source is not installed by Velopack and has no version to compare, so
/// every call here is a no-op. That is checked rather than assumed: <see cref="UpdateManager"/>
/// throws if asked to update an unpackaged app.
/// </summary>
public sealed class ClientUpdater
{
    private readonly string _feedUrl;

    public ClientUpdater(string gatewayBaseUrl)
    {
        _feedUrl = gatewayBaseUrl.TrimEnd('/') + "/client-updates";
    }

    /// <summary>The version waiting to be applied, once one has been downloaded.</summary>
    public string? PendingVersion { get; private set; }

    /// <summary>
    /// Whether this build can update itself at all.
    ///
    /// False for a build run from a folder or from the portable zip: Velopack manages neither, so
    /// "no update available" would be the wrong thing to tell someone about it. Answered by asking
    /// Velopack rather than remembered, because it cannot change while the app runs.
    /// </summary>
    public bool IsUpdatable
    {
        get
        {
            try
            {
                return new UpdateManager(new SimpleWebSource(_feedUrl)).IsInstalled;
            }
            catch (Exception)
            {
                return false;
            }
        }
    }

    /// <summary>
    /// Looks for a newer release and downloads it if there is one.
    ///
    /// Returns false for every ordinary reason there is nothing to do - not installed, no feed on
    /// this gateway, already current - because none of them is a fault the operator can act on.
    /// </summary>
    public async Task<bool> CheckAsync()
    {
        try
        {
            var manager = new UpdateManager(new SimpleWebSource(_feedUrl));
            if (!manager.IsInstalled)
            {
                return false;
            }

            var update = await manager.CheckForUpdatesAsync().ConfigureAwait(false);
            if (update is null)
            {
                return false;
            }

            await manager.DownloadUpdatesAsync(update).ConfigureAwait(false);
            PendingVersion = update.TargetFullRelease.Version.ToString();
            return true;
        }
        catch (Exception)
        {
            // A gateway that serves no updates answers 404, and an older one answers with the
            // SPA's index.html. Neither is a problem worth putting in front of an operator: the
            // client works exactly as well without an update feed.
            return false;
        }
    }

    /// <summary>
    /// Restarts into the downloaded version.
    ///
    /// Only called from an explicit click. An app that restarts itself on a schedule is a camera
    /// wall that goes blank at random.
    /// </summary>
    public void ApplyAndRestart()
    {
        if (PendingVersion is null)
        {
            return;
        }

        var manager = new UpdateManager(new SimpleWebSource(_feedUrl));
        manager.ApplyUpdatesAndRestart(null);
    }
}
