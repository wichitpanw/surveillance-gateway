using System;
using System.Linq;
using System.Threading.Tasks;
using SurveillanceGateway.Client.Models;
using SurveillanceGateway.Client.Services;
using SurveillanceGateway.Client.Views;

namespace SurveillanceGateway.Client;

public partial class MainWindow
{
    // ตรวจ catalog ภายใต้ key ปัจจุบันก่อนเปิดภาพจากเหตุการณ์ทุกครั้ง
    private async Task InvestigateEventAsync(V1AiEvent item, bool playback)
    {
        var session = _home;
        try
        {
            _cameras = await _client.GetCamerasAsync();
            foreach (var cam in _cameras)
            {
                cam.Online = cam.InitialOnline;
            }
        }
        catch (Exception) { StatusText.Text = Strings.T("investigation.unavailable"); return; }
        if (session is null || !ReferenceEquals(session, _home)) return;
        var camera = _cameras.FirstOrDefault(c => !string.IsNullOrEmpty(item.GlobalId) && c.GlobalId == item.GlobalId)
            ?? FindCamera(item.CameraId ?? "");
        if (camera is null) { StatusText.Text = Strings.T("investigation.unavailable"); return; }
        if (!playback) { OpenPlayer(camera); return; }
        if (!DateTimeOffset.TryParse(item.Ts, out var at)) return;
        Select(PageKind.Playback);
        if (_playbackView is not null) await _playbackView.OpenEventAsync(camera, at);
    }
}
