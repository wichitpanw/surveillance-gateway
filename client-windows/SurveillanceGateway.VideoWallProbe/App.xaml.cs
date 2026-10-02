using System.Windows;

namespace SurveillanceGateway.VideoWallProbe;

public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        // Locates libvlc.dll and its plugins/ tree in the output folder. Must run before
        // any LibVLC object is constructed.
        LibVLCSharp.Shared.Core.Initialize();
        base.OnStartup(e);
    }
}
