using System;
using System.Linq;
using System.Threading.Tasks;
using System.Windows;
using SurveillanceGateway.Client.Models;

namespace SurveillanceGateway.Client.Views;

public partial class PlaybackView
{
    public event EventHandler<V1Camera>? LiveRequested;
    public void FocusCameraSearch() { SearchBox.Focus(); SearchBox.SelectAll(); }
    private void OnWorkspaceLive(object sender, RoutedEventArgs e) { if (_selected is { } camera) LiveRequested?.Invoke(this, camera); }

    // เปิดกล้องที่เลือกใน Live โดยรักษาวันเดิม และไม่เล่นย้อนหลังเองจนกด Play
    public async Task SelectWorkspaceCameraAsync(V1Camera camera)
    {
        camera = _cameras.FirstOrDefault(c => c.Id == camera.Id)!;
        if (camera is null) return;
        if (_disposed || _selected?.Id == camera.Id) return;
        ++_eventNavigation; ClearExportSelection(); StopPlayback(); _position = null;
        _selected = camera; BackLiveButton.IsEnabled = true;
        CameraTitle.Text = camera.DisplayName; CameraSubtitle.Text = camera.GroupLabel;
        await LoadRangesAsync();
    }
}
